import { describe, expect, test } from "bun:test"
import { applyFilters, mergeRows, optionsOf, sourceCounts, type CloudCopy, type Filters, type FleetNode, type IndexedSession } from "./sessions-model"

// #191497 — one Sessions list for this machine, other machines and cloud copies.
const s = (sessionId: string, label: string, updatedAt: string, provider = "opencode", status = "idle") => ({
  sessionId, provider, label, status, activity: null, model: null, branch: null, updatedAt,
})
const nodes: FleetNode[] = [
  { id: "n-here", name: "iris-hive-001", report: "fresh", self: true, sessions: [s("ses_here", "Billing webhook", "2026-10-28T02:00:00Z"), s("cc_1", "IRIS Desktop via Claude", "2026-10-28T03:00:00Z", "claude_code", "active")] },
  { id: "n-mac", name: "Alexs-MacBook-Pro", report: "fresh", sessions: [s("ses_mac", "Hive chat fixes verified under load", "2026-10-26T17:44:00Z")] },
]
const copies: CloudCopy[] = [
  { id: "c1", url: "https://heyiris.io/share/c1", sessionId: "ses_mac", title: "Hive chat fixes verified under load", machine: "Alexs-MacBook-Pro", messages: 165, updatedAt: "2026-10-26T18:00:00Z" },
  { id: "c2", url: "https://heyiris.io/share/c2", sessionId: "ses_gone", title: "Launch newsletter draft", machine: "Alexs-iMac", messages: 12, updatedAt: "2026-10-20T10:00:00Z" },
]
const base: Filters = { source: "all", machine: "", app: "", status: "", query: "", sort: "recent" }

describe("mergeRows", () => {
  test("one row per chat: a chat that runs somewhere AND has a cloud copy is one row with both", () => {
    const rows = mergeRows(nodes, copies)
    expect(rows.map((r) => r.sessionId).sort()).toEqual(["cc_1", "ses_gone", "ses_here", "ses_mac"])
    const mac = rows.find((r) => r.sessionId === "ses_mac")!
    expect(mac.machine?.name).toBe("Alexs-MacBook-Pro")
    expect(mac.copy?.id).toBe("c1")
  })

  test("a chat known only from its cloud copy still shows, with no machine", () => {
    const gone = mergeRows(nodes, copies).find((r) => r.sessionId === "ses_gone")!
    expect(gone.machine).toBeNull()
    expect(gone.copy?.machine).toBe("Alexs-iMac")
  })

  test("a machine registered twice keeps the fresher row", () => {
    const twice: FleetNode[] = [
      { id: "old", name: "Mac", report: "stale", sessions: [s("x", "Old title", "2026-09-01T00:00:00Z")] },
      { id: "new", name: "Mac", report: "fresh", sessions: [s("x", "New title", "2026-10-28T00:00:00Z")] },
    ]
    const rows = mergeRows(twice, [])
    expect(rows).toHaveLength(1)
    expect(rows[0].title).toBe("New title")
  })
})

describe("history from the session index", () => {
  const ix = (sessionId: string, title: string, nodeId: string, machine: string, self = false): IndexedSession => ({
    sessionId, provider: "opencode", title, nodeId, machine, self, branch: null, model: null, updatedAt: "2026-10-26T17:17:00Z",
  })
  test("a chat that fell out of a machine's live report still shows, as earlier, on that machine", () => {
    const rows = mergeRows(nodes, [], [ix("ses_old", "Hive chat fixes verified under load and tickets closed", "n-mac", "Alexs-MacBook-Pro")])
    const old = rows.find((r) => r.sessionId === "ses_old")!
    expect(old.status).toBe("earlier")
    expect(old.machine).toEqual({ id: "n-mac", name: "Alexs-MacBook-Pro", self: false })
    expect(applyFilters(rows, { ...base, source: "other", query: "what did we verify about hive chat fixes" }).map((r) => r.sessionId)).toContain("ses_old")
  })

  test("the live row wins over the index: it alone knows the chat is working now", () => {
    const rows = mergeRows(nodes, [], [ix("ses_here", "Stale title", "n-here", "iris-hive-001", true)])
    const here = rows.filter((r) => r.sessionId === "ses_here")
    expect(here).toHaveLength(1)
    expect(here[0].title).toBe("Billing webhook")
    expect(here[0].status).toBe("idle")
  })

  test("an indexed chat on this machine counts under This machine; its cloud copy attaches", () => {
    const rows = mergeRows([], [{ ...copies[0], sessionId: "ses_mine" }], [ix("ses_mine", "Mine", "n-here", "iris-hive-001", true)])
    expect(applyFilters(rows, { ...base, source: "this" }).map((r) => r.sessionId)).toEqual(["ses_mine"])
    expect(rows[0].copy?.id).toBe("c1")
  })
})

describe("filters", () => {
  const rows = mergeRows(nodes, copies)
  test("source: this machine, other machines, cloud copies", () => {
    expect(applyFilters(rows, { ...base, source: "this" }).map((r) => r.sessionId)).toEqual(["cc_1", "ses_here"])
    expect(applyFilters(rows, { ...base, source: "other" }).map((r) => r.sessionId)).toEqual(["ses_mac"])
    expect(applyFilters(rows, { ...base, source: "cloud" }).map((r) => r.sessionId)).toEqual(["ses_mac", "ses_gone"])
  })

  test("counts per source follow the other filters", () => {
    expect(sourceCounts(rows, base)).toEqual({ all: 4, this: 2, other: 1, cloud: 2 })
    expect(sourceCounts(rows, { ...base, app: "Claude Code" })).toEqual({ all: 1, this: 1, other: 0, cloud: 0 })
  })

  test("machine filter also matches a cloud copy's origin", () => {
    expect(applyFilters(rows, { ...base, machine: "Alexs-iMac" }).map((r) => r.sessionId)).toEqual(["ses_gone"])
  })

  test("search ignores filler words and finds word forms", () => {
    expect(applyFilters(rows, { ...base, query: "what did we verify about hive chat fixes" }).map((r) => r.sessionId)).toEqual(["ses_mac"])
    expect(applyFilters(rows, { ...base, query: "newsletters" }).map((r) => r.sessionId)).toEqual(["ses_gone"])
  })

  test("sort: recent first by default; by title; by machine", () => {
    expect(applyFilters(rows, base).map((r) => r.sessionId)).toEqual(["cc_1", "ses_here", "ses_mac", "ses_gone"])
    expect(applyFilters(rows, { ...base, sort: "title" })[0].title).toBe("Billing webhook")
    expect(applyFilters(rows, { ...base, sort: "machine" })[0].machine?.name ?? "").toBe("")
  })

  test("filter options come from the rows", () => {
    const o = optionsOf(rows)
    expect(o.machines).toEqual(["Alexs-MacBook-Pro", "Alexs-iMac", "iris-hive-001"])
    expect(o.apps).toEqual(["Claude Code", "IRIS"])
  })
})
