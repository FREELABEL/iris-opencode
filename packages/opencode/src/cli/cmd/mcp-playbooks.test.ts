import { describe, test, expect } from "bun:test"
import {
  toolNameFor,
  needsApproval,
  inputSchemaFor,
  descriptionFor,
  toolsFor,
  resourcesFor,
  PLAYBOOK_URI_PREFIX,
} from "./mcp-playbooks"
import type { SkillPlan, StepDef } from "../../skill/executor"

function plan(over: Partial<SkillPlan> = {}): SkillPlan {
  return {
    name: "deploy",
    version: 2,
    description: "Ship it",
    args: {},
    steps: [],
    includes: [],
    confirm: [],
    onError: "ask",
    timeout: 300,
    integrations: [],
    location: "/tmp/pb/deploy/PLAYBOOK.md",
    ...over,
  }
}

function step(over: Partial<StepDef> = {}): StepDef {
  return {
    id: "s1", title: "Step", mode: "shell", body: "", code: "echo hi",
    confirm: false, depends: null, retry: 0, delay: 0, condition: null,
    model: null, node: null, skillRef: null, skillArgs: null,
    workflowId: null, webhook: null, cron: null, input: null,
    ...over,
  }
}

describe("tool naming", () => {
  test("prefixes and sanitizes to the MCP name charset", () => {
    expect(toolNameFor("deploy")).toBe("playbook_deploy")
    expect(toolNameFor("lead health sweep")).toBe("playbook_lead-health-sweep")
    expect(toolNameFor("a/b:c")).toBe("playbook_a-b-c")
  })

  test("stays within the 64-char limit", () => {
    expect(toolNameFor("x".repeat(200)).length).toBe(64)
  })
})

describe("args become a JSON Schema", () => {
  test("type, description and enum carry over; required is collected", () => {
    const schema = inputSchemaFor(
      plan({
        args: {
          action: { type: "string", required: true, enum: ["scan", "fix"], description: "What to do" },
          limit: { type: "number", required: false },
        },
      }),
    ) as any
    expect(schema.type).toBe("object")
    expect(schema.properties.action).toMatchObject({ type: "string", enum: ["scan", "fix"], description: "What to do" })
    expect(schema.properties.limit).toMatchObject({ type: "number" })
    expect(schema.required).toEqual(["action"])
  })

  test("a default is stated in prose as well as in the schema", () => {
    const schema = inputSchemaFor(plan({ args: { n: { type: "number", required: false, default: 5 } } })) as any
    expect(schema.properties.n.default).toBe(5)
    expect(schema.properties.n.description).toContain("Defaults to 5")
  })
})

describe("the approval gate", () => {
  test("a plan-level confirm glob gates the playbook", () => {
    expect(needsApproval(plan({ confirm: ["deploy-*"] }))).toBe(true)
  })

  test("a single confirm:true step gates the playbook", () => {
    expect(needsApproval(plan({ steps: [step(), step({ id: "s2", confirm: true })] }))).toBe(true)
  })

  test("an ungated playbook has no confirm argument", () => {
    const schema = inputSchemaFor(plan({ steps: [step()] })) as any
    expect(schema.properties.confirm).toBeUndefined()
    expect(schema.required).toEqual([])
  })

  test("a gated playbook requires confirm, so the client's approval dialog shows it", () => {
    const schema = inputSchemaFor(plan({ confirm: ["*"] })) as any
    expect(schema.properties.confirm.type).toBe("boolean")
    expect(schema.required).toContain("confirm")
  })
})

describe("descriptions tell the model what it is calling", () => {
  test("steps are listed in order with their modes", () => {
    const d = descriptionFor(plan({ steps: [step({ id: "build" }), step({ id: "ship", mode: "prompt" })] }))
    expect(d).toContain("build (shell) → ship (prompt)")
  })

  test("a human step is announced, since the call will come back paused", () => {
    const d = descriptionFor(plan({ steps: [step({ id: "sign", mode: "human" })] }))
    expect(d).toContain("pauses")
    expect(d).toContain("iris playbook resume")
  })

  test("every tool points at its own SOP resource", () => {
    expect(descriptionFor(plan())).toContain(`${PLAYBOOK_URI_PREFIX}deploy`)
  })
})

describe("what is exposed as what", () => {
  const entries = [
    { plan: plan({ name: "runnable", steps: [step()] }), callable: true },
    { plan: plan({ name: "written-sop", version: 1 as const, steps: [] }), callable: false },
  ]

  test("only executable playbooks become tools", () => {
    expect(toolsFor(entries).map((t) => t.name)).toEqual(["playbook_runnable"])
  })

  test("but every playbook is readable — the document IS the artefact", () => {
    expect(resourcesFor(entries).map((r) => r.uri)).toEqual([
      `${PLAYBOOK_URI_PREFIX}runnable`,
      `${PLAYBOOK_URI_PREFIX}written-sop`,
    ])
  })

  test("a v2 plan with no steps is not callable", () => {
    expect(toolsFor([{ plan: plan({ name: "empty", version: 2 }), callable: false }])).toEqual([])
  })
})
