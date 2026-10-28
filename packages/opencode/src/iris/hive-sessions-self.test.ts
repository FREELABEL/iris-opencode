import { describe, expect, test } from "bun:test"
import { cloudCopiesOf, markSelf, type HiveSessionNode, indexedSessionsOf } from "./hive-sessions"

const node = (id: string, name: string): HiveSessionNode => ({
  id, name, online: true, lastHeartbeat: null, report: "fresh", reportedAt: null, incomplete: [], sessions: [],
})

// #191497 — the Sessions view needs to know which node IS this machine.
describe("markSelf", () => {
  test("marks the node whose id is this machine's node_id", () => {
    const r = markSelf([node("a", "Mac"), node("b", "iris-hive-001")], "b", "whatever")
    expect(r.map((n) => n.self)).toEqual([false, true])
  })
  test("without a node_id, matches the hostname (with or without .local)", () => {
    expect(markSelf([node("a", "Alexs-MacBook-Pro"), node("b", "hive")], null, "Alexs-MacBook-Pro.local").map((n) => n.self)).toEqual([true, false])
  })
  test("a hostname shared by two records marks neither: guessing is worse than not marking", () => {
    expect(markSelf([node("a", "Mac"), node("b", "Mac")], null, "Mac").map((n) => n.self)).toEqual([false, false])
  })
})

describe("cloudCopiesOf", () => {
  test("reads GET /api/v6/shares rows", () => {
    const c = cloudCopiesOf({ data: [{ id: "01m6", url: "https://heyiris.io/share/01m6", session_id: "ses_a", title: "Hive chat fixes", machine: "Mac", messages: 3, updated_at: "2026-10-28T03:00:00Z" }, { nope: 1 }] })
    expect(c).toEqual([{ id: "01m6", url: "https://heyiris.io/share/01m6", sessionId: "ses_a", title: "Hive chat fixes", machine: "Mac", messages: 3, updatedAt: "2026-10-28T03:00:00Z" }])
  })
})

test("indexedSessionsOf: reads the server's hit shape and marks this machine by node id", () => {
  const json = {
    data: [
      { session_id: "ses_old", provider: "opencode", title: "Hive chat fixes", node: "Alexs-MacBook-Pro", node_id: "n-mac", git_branch: null, model: "x", created_at: "2026-10-26T17:17:11Z" },
      { session_id: "ses_mine", provider: "claude_code", title: null, node: "iris-hive-001", node_id: "n-here", git_branch: "main", model: null, created_at: null },
      { session_id: "no_node" },
    ],
  }
  const rows = indexedSessionsOf(json, "n-here")
  expect(rows.map((r) => [r.sessionId, r.self, r.machine])).toEqual([["ses_old", false, "Alexs-MacBook-Pro"], ["ses_mine", true, "iris-hive-001"]])
  expect(rows[0].updatedAt).toBe("2026-10-26T17:17:11Z")
  expect(indexedSessionsOf(json, null).some((r) => r.self)).toBe(false)
})
