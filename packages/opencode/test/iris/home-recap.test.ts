import { describe, expect, test } from "bun:test"
import { REFRESH_MS, cleanOf, hashOf, inputOf, stale } from "../../src/iris/home-recap"

const NOW = Date.parse("2026-11-26T18:00:00Z")
const DAY = Date.parse("2026-11-26T06:00:00Z")
const fresh = "2026-11-26T17:59:00Z"

const node = (id: string, name: string, sessions: any[], reported = fresh) => ({
  id,
  name,
  sessions_updated_at: reported,
  last_heartbeat_at: reported,
  sessions_report: "fresh",
  active_sessions: sessions,
})
const row = (over: any) => ({
  session_id: "s1",
  provider: "claude_code",
  agent: "claude_code",
  agent_name: "Claude Code",
  status: "idle",
  updated_at: "2026-11-26T15:00:00Z",
  project_path: "/home/a/work/fl-iris-api",
  git_branch: "main",
  label: "fix chromebook",
  digest: { first_ask: "fix the Chromebook button", last_ask: "ship it", last_reply: "Merged PR #452." },
  ...over,
})

describe("inputOf", () => {
  const items = [
    { id: 1, title: "EPIC · Shared workspaces", bloqId: 652, bloqName: "IRIS Feature Requests", listName: "Accepted", createdAt: "2026-11-26T14:00:00Z", updatedAt: "2026-11-26T14:47:00Z" },
    { id: 2, title: "2026-11-26", bloqId: 9, bloqName: "Client A", listName: "Daily Diary", createdAt: "2026-11-26T13:00:00Z", updatedAt: "2026-11-26T13:00:30Z" },
    { id: 3, title: "old", bloqId: 9, bloqName: "Client A", listName: "Todo", createdAt: "2026-11-25T13:00:00Z", updatedAt: "2026-11-25T23:00:00Z" },
  ]

  test("today's board items only, with your work told apart from agents' diaries", () => {
    const i = inputOf(items, { nodes: [] }, DAY, NOW)
    expect(i.board_items).toEqual([
      { title: "EPIC · Shared workspaces", project: "IRIS Feature Requests", list: "Accepted", by: "you", change: "edited" },
      { title: "2026-11-26", project: "Client A", list: "Daily Diary", by: "agent", change: "created" },
    ])
  })

  test("sessions from every machine and agent, with their digests, newest first", () => {
    const json = {
      nodes: [
        node("n1", "iris-hive-001", [row({})]),
        node("n2", "build-box", [
          row({ session_id: "c1", provider: "codex", agent: "codex", agent_name: "Codex CLI", updated_at: "2026-11-26T16:40:00Z", status: "needs_you", digest: { first_ask: "EU cards fail", last_ask: null, last_reply: "Mock or skip?" } }),
        ]),
      ],
    }
    const s = inputOf([], json, DAY, NOW).sessions
    expect(s.map((x) => [x.agent, x.machine, x.project, x.status, x.first_ask, x.last_reply])).toEqual([
      ["Codex CLI", "build-box", "fl-iris-api", "needs_you", "EU cards fail", "Mock or skip?"],
      ["Claude Code", "iris-hive-001", "fl-iris-api", "idle", "fix the Chromebook button", "Merged PR #452."],
    ])
  })

  test("a session with no digest still counts, from its label", () => {
    const s = inputOf([], { nodes: [node("n1", "m", [row({ provider: "opencode", agent: "opencode", agent_name: "opencode", digest: null })])] }, DAY, NOW).sessions
    expect(s[0]).toMatchObject({ agent: "opencode", first_ask: "fix chromebook", last_reply: null })
  })

  test("yesterday's sessions, a retired machine and the second copy of a session are left out", () => {
    const json = {
      nodes: [
        node("n1", "a", [row({}), row({ session_id: "old", updated_at: "2026-11-25T20:00:00Z" })]),
        node("n2", "b", [row({})], "2026-11-26T17:00:00Z"), // same session, older report: Hive keeps n1's
        node("n3", "gone", [row({ session_id: "z" })], "2026-11-18T00:00:00Z"), // retired: no report for over 7 days (REPORT_WINDOW_MS)
      ],
    }
    const s = inputOf([], json, DAY, NOW).sessions
    expect(s.map((x) => x.machine)).toEqual(["a"])
  })
})

describe("caching", () => {
  const base = inputOf([], { nodes: [node("n1", "a", [row({})])] }, DAY, NOW)

  test("a new heartbeat with the same work is the same input", () => {
    const later = { ...base, sessions: base.sessions.map((s) => ({ ...s, last_active: "2026-11-26T17:00:00Z" })) }
    expect(hashOf(later)).toBe(hashOf(base))
    const changed = { ...base, sessions: base.sessions.map((s) => ({ ...s, last_reply: "Reverted." })) }
    expect(hashOf(changed)).not.toBe(hashOf(base))
  })

  test("written again for a new day, or new work once the last one is old enough — not every minute", () => {
    const c = { day: "2026-11-26", hash: "h1", text: "t", model: "m", at: NOW }
    expect(stale(null, "2026-11-26", "h1", NOW)).toBe(true)
    expect(stale(c, "2026-11-27", "h1", NOW)).toBe(true)
    expect(stale(c, "2026-11-26", "h1", NOW + 10 * REFRESH_MS)).toBe(false)
    expect(stale(c, "2026-11-26", "h2", NOW + REFRESH_MS - 1)).toBe(false)
    expect(stale(c, "2026-11-26", "h2", NOW + REFRESH_MS)).toBe(true)
  })
})

describe("cleanOf", () => {
  test("one plain paragraph out of whatever the model returned", () => {
    expect(cleanOf("## Today\n**You** merged the fix and\n- shipped `it` to everyone today.")).toBe("You merged the fix and shipped it to everyone today.")
    expect(cleanOf('"You merged the Chromebook fix today."')).toBe("You merged the Chromebook fix today.")
  })
  test("nothing usable is null, not an empty paragraph", () => {
    expect(cleanOf("")).toBeNull()
    expect(cleanOf("ok")).toBeNull()
    expect(cleanOf(undefined)).toBeNull()
  })
})
