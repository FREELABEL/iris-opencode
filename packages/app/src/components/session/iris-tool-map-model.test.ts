import { describe, expect, test } from "bun:test"
import type { Catalog, CatalogTool, Effect } from "./iris-agent-editor-model"
import type { LiveRun, LiveToolCall } from "./iris-agent-live-model"
import { CALL_WINDOW, headerLine, layout, modelLabel, nodeBadge, nodeLine, providerOf, runPill, toolMap, GEO } from "./iris-tool-map-model"

// #192619 — the map must tell the truth about access: used, allowed-but-unused, and refused are
// three different answers, and a held call is not a failed one.

const tool = (id: string, group: string, effect: Effect = "read", extra: Partial<CatalogTool> = {}): CatalogTool => ({
  id,
  aliases: [],
  name: id.replace(/_/g, " "),
  group,
  description: "",
  effect,
  needsApproval: false,
  approval: null,
  isDefault: false,
  alwaysOn: false,
  ...extra,
})

const catalog = (tools: CatalogTool[]): Catalog => ({
  available: true,
  tools,
  groups: [],
  effects: [],
  defaults: [],
  alwaysOn: [],
  approval: { held: [], planned: [] },
  trustLevels: {},
  integrations: [],
})

const call = (t: string, status: LiveToolCall["status"] = "success", durationMs = 500): LiveToolCall => ({
  tool: t,
  iteration: 1,
  args: {},
  fingerprint: t,
  status,
  startedAt: "2026-11-05T10:00:00Z",
  durationMs,
})

const run = (calls: LiveToolCall[], over: Partial<LiveRun> = {}): LiveRun => ({
  runId: "r1",
  agentId: 7,
  status: "running",
  step: null,
  toolCalls: calls,
  takeover: null,
  ...over,
})

const CAT = catalog([
  tool("github_read", "code"),
  tool("github_push", "code", "shared_write"),
  tool("github_delete", "code", "shared_overwrite"),
  tool("stripe_charge", "payments", "payment"),
  tool("web_search", "research", "read", { aliases: ["websearchtool"] }),
  tool("agent_memory", "knowledge", "own_write", { alwaysOn: true }),
])

describe("toolMap", () => {
  test("counts calls per tool, newest status and duration win", () => {
    const m = toolMap(CAT, ["github_read", "web_search"], run([call("github_read", "success", 520), call("github_read", "success", 300)]))
    expect(m.left).toHaveLength(1)
    expect(m.left[0]).toMatchObject({ id: "github_read", kind: "used", calls: 2, lastMs: 300, last: "success" })
    expect(m.calls).toBe(2)
  })

  test("an alias resolves to its catalogue tool, so one tool is one node", () => {
    const m = toolMap(CAT, ["web_search"], run([call("websearchtool"), call("web_search")]))
    expect(m.left.map((n) => [n.id, n.calls])).toEqual([["web_search", 2]])
    expect(m.right.filter((n) => n.kind === "idle")).toHaveLength(0)
  })

  test("allowed but never called is 'not used yet', and is counted as access", () => {
    const m = toolMap(CAT, ["github_read", "web_search"], run([call("github_read")]))
    expect(m.right.find((n) => n.id === "web_search")).toMatchObject({ kind: "idle" })
    expect(m.access).toBe(2)
  })

  test("no access = tools beside its own (same group), riskiest first, never always-on", () => {
    const m = toolMap(CAT, ["github_read"], run([]))
    expect(m.right.filter((n) => n.kind === "none").map((n) => n.id)).toEqual(["github_delete", "github_push"])
    expect(m.right.some((n) => n.id === "stripe_charge")).toBe(false)
  })

  test("an always-on tool is never 'no access', even beside the agent's own", () => {
    const cat = catalog([tool("kb_search", "knowledge"), tool("agent_memory", "knowledge", "own_write", { alwaysOn: true })])
    const m = toolMap(cat, ["kb_search"], run([]))
    expect(m.right.some((n) => n.id === "agent_memory")).toBe(false)
  })

  test("a refused call is no access, not a call", () => {
    const m = toolMap(CAT, ["github_read"], run([call("stripe_charge", "skipped", 0)]))
    expect(m.calls).toBe(0)
    expect(m.left).toHaveLength(0)
    expect(m.right.find((n) => n.id === "stripe_charge")).toMatchObject({ kind: "none", last: "skipped" })
  })

  test("a tool refused once and then run is used, not refused", () => {
    const m = toolMap(CAT, ["github_push"], run([call("github_push", "skipped", 0), call("github_push")]))
    expect(m.left.map((n) => n.id)).toEqual(["github_push"])
    expect(m.right.some((n) => n.id === "github_push")).toBe(false)
  })

  test("with no tool list, nothing is called no access", () => {
    const m = toolMap(CAT, null, run([call("github_read")]))
    expect(m.right).toEqual([])
    expect(m.access).toBe(1)
  })

  test("a tool not in the catalogue still shows, by a readable name", () => {
    const m = toolMap(CAT, null, run([call("executewebsearchtool")]))
    expect(m.left[0]).toMatchObject({ id: "executewebsearchtool", name: "Executewebsearch", effect: "unclassified" })
  })

  test("sides are capped and say how many did not fit", () => {
    const many = Array.from({ length: 9 }, (_, i) => tool(`t${i}`, "g"))
    const m = toolMap(catalog(many), many.map((t) => t.id), run(many.map((t) => call(t.id))), { left: 4, right: 4 })
    expect(m.left).toHaveLength(4)
    expect(m.moreLeft).toBe(5)
  })

  test("the header says when counts cover only the newest calls", () => {
    const calls = Array.from({ length: CALL_WINDOW }, () => call("github_read"))
    expect(headerLine(toolMap(CAT, ["github_read"], run(calls)))).toBe(`1/6 tools · last ${CALL_WINDOW} calls`)
    expect(headerLine(toolMap(CAT, ["github_read"], run([call("github_read")])))).toBe("1/6 tools · 1 call")
  })
})

describe("node words", () => {
  const fmt = (ms: number | undefined) => `${ms}ms`
  test("used, idle, none, refused", () => {
    expect(nodeLine({ id: "a", name: "a", kind: "used", effect: "read", calls: 1, lastMs: 520 }, fmt)).toBe("Last call 520ms")
    expect(nodeLine({ id: "a", name: "a", kind: "idle", effect: "read", calls: 0 }, fmt)).toBe("Not used yet")
    expect(nodeLine({ id: "a", name: "a", kind: "none", effect: "read", calls: 0 }, fmt)).toBe("No access")
    expect(nodeLine({ id: "a", name: "a", kind: "none", effect: "read", calls: 0, last: "skipped" }, fmt)).toBe("Refused")
  })

  test("a failure and a hold are different badges", () => {
    expect(nodeBadge({ id: "a", name: "a", kind: "used", effect: "read", calls: 1, last: "error" })).toEqual({ tone: "fail", text: "Failed" })
    expect(nodeBadge({ id: "a", name: "a", kind: "used", effect: "payment", calls: 1, last: "held" })).toEqual({ tone: "held", text: "Held" })
    expect(nodeBadge({ id: "a", name: "a", kind: "used", effect: "read", calls: 1, last: "success" })).toBeNull()
  })

  test("the card's pill follows the run", () => {
    expect(runPill(null).text).toBe("Idle")
    expect(runPill(run([])).tone).toBe("run")
    expect(runPill(run([], { status: "paused" })).text).toBe("Paused")
    expect(runPill(run([], { status: "completed" })).text).toBe("Done")
  })
})

describe("models", () => {
  test("provider from the id or the name", () => {
    expect(providerOf("anthropic/claude-sonnet-4-5")).toBe("anthropic")
    expect(providerOf("gpt-4o-mini")).toBe("openai")
    expect(providerOf("openrouter/google/gemini-2.5-pro")).toBe("google")
    expect(providerOf("")).toBeUndefined()
  })

  test("labels read like names", () => {
    expect(modelLabel("anthropic/claude-sonnet-4-5")).toBe("Claude Sonnet 4.5")
    expect(modelLabel("gpt-4o-mini")).toBe("GPT-4o mini")
  })
})

describe("layout", () => {
  test("every edge starts at its node and ends at the card's port", () => {
    const g = layout(5, 4, 900)
    expect(g.edgesLeft).toHaveLength(5)
    expect(g.edgesRight).toHaveLength(4)
    for (const [i, d] of g.edgesLeft.entries()) {
      expect(d.startsWith(`M${g.left[i]!.x + GEO.nodeW},${g.left[i]!.y + GEO.nodeH / 2}`)).toBe(true)
      expect(d.endsWith(`H${g.ports.left.x}`)).toBe(true)
    }
    for (const [i, d] of g.edgesRight.entries()) {
      expect(d.startsWith(`M${g.ports.right.x},${g.ports.right.y}`)).toBe(true)
      expect(d.endsWith(`H${g.right[i]!.x}`)).toBe(true)
    }
  })

  test("nothing overlaps the card, even in a narrow pane", () => {
    const g = layout(3, 3, 300)
    expect(g.left[0]!.x + GEO.nodeW).toBeLessThan(g.card.x)
    expect(g.card.x + GEO.cardW).toBeLessThan(g.right[0]!.x)
  })
})
