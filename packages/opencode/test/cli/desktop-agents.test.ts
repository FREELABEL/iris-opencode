import { test, expect, describe } from "bun:test"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Agent } from "../../src/agent/agent"
import { PermissionNext } from "../../src/permission/next"
import {
  DESKTOP_AGENT_MARKER,
  fileStems,
  planDesktopSync,
  renderDesktopAgent,
  slugify,
} from "../../src/cli/lib/desktop-agents"

const patty = { id: 791, name: "PATTY", description: "Patient intake and case triage for Pathways." }

// The generated file has to survive opencode's REAL loader and resolve to the permissions we
// mean. On 2026-10-14 a hand-written `permissions:` (plural) loaded cleanly and resolved every
// deny to allow, and a list under `permission:` stopped the Desktop app from opening at all.
// Asserting on the rendered string would have passed both.
describe("a generated agent, loaded by opencode", () => {
  test("has full local tools and asks only before irreversible commands", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, ".opencode", "agent", "iris-patty.md"), renderDesktopAgent(patty))
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const a = await Agent.get("iris-patty")
        expect(a).toBeDefined()
        const p = (tool: string, pattern = "*") => PermissionNext.evaluate(tool, pattern, a!.permission).action
        // Local data work is the point — no friction.
        for (const tool of ["read", "edit", "glob", "grep", "list", "webfetch", "websearch", "task"]) {
          expect(p(tool, "patients/intake.csv")).toBe("allow")
        }
        expect(p("bash", "python3 clean.py")).toBe("allow")
        expect(p("bash", "iris agents chat 791 hi")).toBe("allow")
        // Only what cannot be undone confirms.
        expect(p("bash", "rm -rf build")).toBe("ask")
        expect(p("bash", "git push origin main")).toBe("ask")
        expect(p("bash", "git reset --hard HEAD~1")).toBe("ask")
        expect(a!.prompt).toContain("agent id 791")
        expect(a!.prompt).not.toContain(DESKTOP_AGENT_MARKER)
      },
    })
  })

  test("a description with quotes, colons and newlines still parses", async () => {
    const tricky = { id: 5, name: 'Ops: "Night" Shift', description: "Line one:\nline two — with # hash" }
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, ".opencode", "agent", "iris-ops.md"), renderDesktopAgent(tricky))
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const a = await Agent.get("iris-ops")
        expect(a?.description).toContain('Ops: "Night" Shift (IRIS agent #5)')
      },
    })
  })
})

describe("planDesktopSync", () => {
  const human = { id: 2, name: "Jane Doe", type: "human" }
  const bench = { id: 3, name: "Model Bench gpt-5-nano" }
  const inactive = { id: 4, name: "Old Agent", active: false }

  test("skips humans, inactive and scratch agents", () => {
    const plan = planDesktopSync([patty, human, bench, inactive], new Map())
    expect(plan.write.map((w) => w.file)).toEqual(["iris-patty.md"])
  })

  test("never overwrites a hand-written file at the same path", () => {
    const plan = planDesktopSync([patty], new Map([["iris-patty.md", "---\ndescription: mine\n---\nhand made"]]))
    expect(plan.write).toEqual([])
    expect(plan.handWritten).toEqual(["iris-patty.md"])
  })

  test("removes generated files for agents that are gone, never hand-written ones", () => {
    const existing = new Map([
      ["iris-gone.md", `---\n${DESKTOP_AGENT_MARKER}\n---\nx`],
      ["iris-mine.md", "---\ndescription: mine\n---\nx"],
      ["review.md", "---\ndescription: unrelated\n---\nx"],
    ])
    expect(planDesktopSync([patty], existing).remove).toEqual(["iris-gone.md"])
  })

  test("a filtered sync deletes nothing", () => {
    const existing = new Map([["iris-gone.md", `---\n${DESKTOP_AGENT_MARKER}\n---\nx`]])
    expect(planDesktopSync([patty], existing, new Set([791])).remove).toEqual([])
  })

  test("an unchanged file is not rewritten", () => {
    const existing = new Map([["iris-patty.md", renderDesktopAgent(patty)]])
    expect(planDesktopSync([patty], existing).write).toEqual([])
  })
})

test("file names are stable, safe and unique", () => {
  expect(slugify("Pathways Legal Assistant")).toBe("pathways-legal-assistant")
  expect(slugify("Café / Ops!!")).toBe("cafe-ops")
  const stems = fileStems([
    { id: 1, name: "Sales" },
    { id: 2, name: "sales" },
    { id: 3, name: "日本" },
  ])
  expect([...stems.values()]).toEqual(["iris-sales-1", "iris-sales-2", "iris-agent-3"])
})
