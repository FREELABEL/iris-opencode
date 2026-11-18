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
  selectRoster,
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

// #189970: the file used to carry only the name and a pointer ("ask the cloud agent"), so the
// local agent was nobody in particular. It now carries who the agent IS and what it is FOR.
describe("a generated agent carries the real IRIS agent (#189970)", () => {
  const full = {
    ...patty,
    initial_prompt: "Every morning, list intake forms missing a signature.",
    settings: { system_prompt: "You are PATTY. You triage intake: never give medical advice.\n---\nKeep answers short." },
    config: { tools: ["get_overdue_followups", "bloqItems"] },
  }

  test("its identity, mission and IRIS tool scope reach the loaded prompt", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, ".opencode", "agent", "iris-patty.md"), renderDesktopAgent(full))
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const a = await Agent.get("iris-patty")
        expect(a).toBeDefined()
        expect(a!.prompt).toContain("never give medical advice")
        expect(a!.prompt).toContain("Keep answers short.") // a "---" inside the prompt does not end it
        expect(a!.prompt).toContain("list intake forms missing a signature")
        expect(a!.prompt).toContain("get_overdue_followups")
        expect(a!.prompt).toContain("agent id 791") // still knows where grounded facts come from
      },
    })
  })

  test("an agent with no prompt says so instead of inventing one", () => {
    const out = renderDesktopAgent(patty)
    expect(out).not.toContain("## Who you are")
    expect(out).toContain("agent id 791")
  })

  test("an empty IRIS tool list is called what it is", () => {
    const out = renderDesktopAgent({ ...full, config: { tools: [] } })
    expect(out).toContain("no tool allowlist")
  })

  test("a very long prompt is cut, and says it was", () => {
    const out = renderDesktopAgent({ ...full, settings: { system_prompt: "x".repeat(50_000) } })
    expect(out.length).toBeLessThan(30_000)
    expect(out).toContain("[cut")
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

describe("the picker cap (epic #189448 S1)", () => {
  const many = Array.from({ length: 40 }, (_, i) => ({
    id: i + 1,
    name: `Agent ${i + 1}`,
    last_active_at: `2026-10-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z`,
  }))

  test("a small account gets every agent", () => {
    expect(selectRoster(many.slice(0, 10)).size).toBe(10)
  })

  test("a large account gets 25, most recently active first", () => {
    const r = selectRoster(many)
    expect(r.size).toBe(25)
    // day 28 is the most recent; agent 28 must be in, the oldest-day agents must not
    expect(r.has(28)).toBe(true)
    expect(r.has(1)).toBe(false)
  })

  test("pins always make it, even when old", () => {
    const r = selectRoster(many, 25, new Set([1, 2]))
    expect(r.has(1) && r.has(2)).toBe(true)
    expect(r.size).toBe(25)
  })

  test("0 means no cap", () => {
    expect(selectRoster(many, 0).size).toBe(40)
  })

  test("an agent the cap drops loses its generated file, never a hand-written one", () => {
    const existing = new Map([
      ["iris-agent-1.md", renderDesktopAgent(many[0])],
      ["iris-agent-2.md", "---\ndescription: mine\n---\nx"],
    ])
    const plan = planDesktopSync(many, existing, undefined, selectRoster(many))
    expect(plan.remove).toContain("iris-agent-1.md")
    expect(plan.remove).not.toContain("iris-agent-2.md")
    expect(plan.write.length).toBe(25)
  })
})
