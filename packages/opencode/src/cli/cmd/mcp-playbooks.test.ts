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
    integrations: [],
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

// ============================================================================
// #183406 — silent-success defects in the playbook engine
//
// Every test below started as a reproduction. The common shape: the engine did something
// wrong and reported it the same way it reports doing something right — an empty
// substitution, a dropped code block, a run of nothing that printed "✓ completed" and
// exited 0. The assertions are therefore mostly about what is SAID, not what is computed;
// that is the layer where each of these was invisible.
// ============================================================================

import {
  parseSteps,
  interpolate,
  splitPlaybookArgv,
  unknownPlaybookFlags,
  resolveArgs,
  validatePlan,
} from "../../skill/executor"

const FENCE = "\x60\x60\x60"

describe("#183406 defect 3 — an unset arg renders as nothing, silently", () => {
  test("the empty substitution is UNCHANGED — 94 playbooks depend on it", () => {
    // The fix reports; it does not rewrite. A visible <placeholder> would change what the
    // shell actually executes for every playbook that relies on an optional arg being blank.
    expect(interpolate("iris hive enroll ${{args.target}}", {}, {})).toBe("iris hive enroll ")
  })

  test("but the caller is now told which arg went missing", () => {
    const missing: string[] = []
    interpolate("iris hive enroll ${{args.target}}", {}, {}, { onMissing: (n) => missing.push(n) })
    expect(missing).toEqual(["target"])
  })

  test("a provided value renders as before and reports nothing", () => {
    const missing: string[] = []
    const out = interpolate("enroll ${{args.target}}", { target: "dev-mini" }, {}, { onMissing: (n) => missing.push(n) })
    expect(out).toBe("enroll dev-mini")
    expect(missing).toEqual([])
  })

  test("an explicitly blank value counts — it produces the same broken command", () => {
    const missing: string[] = []
    interpolate("enroll ${{args.target}}", { target: "" }, {}, { onMissing: (n) => missing.push(n) })
    expect(missing).toEqual(["target"])
  })

  test("`test` flags an arg reference the playbook cannot ever satisfy", () => {
    // A typo'd name is not a missing VALUE, it is a missing DECLARATION: no invocation can
    // fill it, so it is a static fact and belongs in validation rather than only at runtime.
    const issues = validatePlan(
      plan({
        args: { target: { type: "string", required: false } },
        steps: [step({ id: "enroll", code: "iris hive enroll ${{args.tagret}}" })],
      }),
    )
    const issue = issues.find((i) => i.message.includes("tagret"))
    expect(issue).toBeDefined()
    // A warning, not an error — it must not start failing `iris playbook test` for the
    // existing playbooks.
    expect(issue!.level).toBe("warning")
    expect(issue!.message).toContain("does not declare")
  })

  test("a declared reference is not flagged", () => {
    const issues = validatePlan(
      plan({
        args: { target: { type: "string", required: false } },
        steps: [step({ id: "enroll", code: "iris hive enroll ${{args.target}}" })],
      }),
    )
    expect(issues.filter((i) => i.message.includes("args.target"))).toEqual([])
  })
})

describe("#183406 defect 4 — the documented --flag form could not work", () => {
  const declared = { node: { type: "string" }, brand: { type: "string" }, force: { type: "boolean" } }

  test("`--node dev-mini` binds — the reported case", () => {
    const { flagArgs, positional } = splitPlaybookArgv(["--node", "dev-mini"], declared)
    expect(flagArgs).toEqual({ node: "dev-mini" })
    expect(positional).toEqual([])
  })

  test("the space form and the = form are the same thing", () => {
    expect(splitPlaybookArgv(["--node", "x"], declared).flagArgs).toEqual(
      splitPlaybookArgv(["--node=x"], declared).flagArgs,
    )
  })

  test("positional binding is untouched — the form 94 playbooks already use", () => {
    const { flagArgs, positional } = splitPlaybookArgv(["dev-mini", "freelabel"], declared)
    expect(flagArgs).toEqual({})
    expect(positional).toEqual(["dev-mini", "freelabel"])
  })

  test("a declared BOOLEAN never swallows the next token", () => {
    // Otherwise `--force somepositional` would silently eat the positional.
    const { flagArgs, positional } = splitPlaybookArgv(["--force", "somepositional"], declared)
    expect(flagArgs).toEqual({ force: true })
    expect(positional).toEqual(["somepositional"])
  })

  test("an UNDECLARED --flag does not swallow the next token either", () => {
    const { flagArgs, positional } = splitPlaybookArgv(["--nodee", "dev-mini"], declared)
    expect(flagArgs).toEqual({ nodee: true })
    expect(positional).toEqual(["dev-mini"])
  })

  test("and it is reported, so a typo cannot bind its value to the wrong arg", () => {
    // This is the strictness yargs can no longer apply: `playbook run` must accept unknown
    // options to see `--node` at all, so the check moves to where the declarations are.
    const { flagArgs } = splitPlaybookArgv(["--nodee", "dev-mini"], declared)
    expect(unknownPlaybookFlags(flagArgs, declared)).toEqual(["nodee"])
  })

  test("a legitimate flag is not reported", () => {
    const { flagArgs } = splitPlaybookArgv(["--node", "dev-mini"], declared)
    expect(unknownPlaybookFlags(flagArgs, declared)).toEqual([])
  })

  test("PRECEDENCE: a named value beats a positional one", () => {
    const schema = { node: { type: "string" as const, required: false }, brand: { type: "string" as const, required: false } }
    const { flagArgs, positional } = splitPlaybookArgv(["positional-node", "--node", "flag-node"], schema)
    expect(resolveArgs(schema, positional, flagArgs).node).toBe("flag-node")
  })

  test("a value that itself looks like a flag is left for the next token", () => {
    const { flagArgs, positional } = splitPlaybookArgv(["--node", "--brand", "freelabel"], declared)
    expect(flagArgs).toEqual({ node: true, brand: "freelabel" })
    expect(positional).toEqual([])
  })
})

describe("#183406 defect 6 — fenced blocks vanish from a human step", () => {
  const doc = [
    "### step:setup Do it by hand",
    "",
    FENCE + "yaml",
    "mode: human",
    FENCE,
    "",
    "Run the discovery commands:",
    "",
    FENCE + "bash",
    "iris hive nodes",
    "iris hive status",
    FENCE,
    "",
    "Then install:",
    "",
    FENCE + "bash",
    "iris hive install",
    FENCE,
    "",
    "Done.",
  ].join("\n")

  test("REPRODUCTION: body strips every fence and code keeps only the first", () => {
    // Not a regression guard — a record of the mechanism. `body` + `code` is what the human
    // renderer used to print, and between them the second block does not exist anywhere.
    const [s] = parseSteps(doc)
    expect(s.body).not.toContain("iris hive nodes")
    expect(s.code).toContain("iris hive nodes")
    expect(s.code).not.toContain("iris hive install")
    expect(`${s.body}\n${s.code}`).not.toContain("iris hive install")
  })

  test("instructions keeps every block, in order, with the prose that introduces it", () => {
    const [s] = parseSteps(doc)
    expect(s.instructions).toContain("iris hive nodes")
    expect(s.instructions).toContain("iris hive status")
    expect(s.instructions).toContain("iris hive install")
    expect(s.instructions!.indexOf("Run the discovery commands")).toBeLessThan(
      s.instructions!.indexOf("iris hive nodes"),
    )
    expect(s.instructions!.indexOf("Then install")).toBeLessThan(s.instructions!.indexOf("iris hive install"))
  })

  test("the ```yaml header is the ONLY thing removed", () => {
    const [s] = parseSteps(doc)
    expect(s.instructions).not.toContain("mode: human")
    expect(s.instructions).toContain(FENCE + "bash")
  })

  test("body and code are unchanged, so shell and ai steps behave exactly as before", () => {
    const shellDoc = [
      "### step:build Build",
      "",
      FENCE + "yaml",
      "mode: shell",
      FENCE,
      "",
      "Some prose.",
      "",
      FENCE + "bash",
      "make build",
      FENCE,
    ].join("\n")
    const [s] = parseSteps(shellDoc)
    expect(s.code).toBe("make build")
    expect(s.body).toBe("Some prose.")
  })
})
