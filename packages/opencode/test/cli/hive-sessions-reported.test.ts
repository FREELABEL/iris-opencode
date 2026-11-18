import { describe, expect, test } from "bun:test"
import { REPORT_WINDOW_MS, reportedSessions } from "../../src/cli/cmd/platform-hive-sessions"

// #190653 — a re-registered machine kept old node records whose frozen lists were shown beside its
// real sessions, and made `send-input <full id>` refuse a session listed in both.
const NOW = Date.parse("2026-10-23T00:35:00Z")
const s = (id: string, provider = "opencode") => ({ session_id: id, provider, name: id, status: "idle", model: null, git_branch: null, project_path: null, updated_at: null })
const node = (id: string, name: string, at: string | null, sessions: any[]) => ({ id, name, sessions_updated_at: at, last_heartbeat_at: at, active_sessions: sessions })

describe("reportedSessions", () => {
  const live = node("01a09d2c", "Alexs-MacBook-Pro-11711", "2026-10-23T00:34:48Z", [s("ses_now"), s("ses_both")])
  const dead = node("01a098bd", "Alexs-MacBook-Pro-11711", "2026-09-13T23:48:37Z", [s("ses_old"), s("ses_both")])
  const other = node("019ff510", "MacBookPro", "2026-09-13T03:09:45Z", [s("ses_x")])

  test("a record that has not reported within the window lists nothing, and is named as retired", () => {
    const { entries, retired } = reportedSessions([live, dead, other], NOW)
    expect(entries.map((e) => e.s.session_id).sort()).toEqual(["ses_both", "ses_now"])
    expect(retired.map((r) => [r.name, r.rows])).toEqual([
      ["Alexs-MacBook-Pro-11711", 2],
      ["MacBookPro", 1],
    ])
  })

  test("a session in two current reports appears once, from the newer report", () => {
    const older = node("a", "box", "2026-10-22T00:00:00Z", [s("ses_dup")])
    const newer = node("b", "box", "2026-10-23T00:00:00Z", [s("ses_dup")])
    const { entries } = reportedSessions([older, newer], NOW)
    expect(entries).toHaveLength(1)
    expect(entries[0].node.id).toBe("b")
  })

  test("the same id under two providers is two sessions", () => {
    const n = node("a", "box", "2026-10-23T00:00:00Z", [s("ses_1", "opencode"), s("ses_1", "claude_code")])
    expect(reportedSessions([n], NOW).entries).toHaveLength(2)
  })

  test("a node with no report time is kept — unknown is not old", () => {
    const n = { id: "a", name: "box", active_sessions: [s("ses_1")] }
    expect(reportedSessions([n], NOW).entries).toHaveLength(1)
  })

  test("the window matches the server's SessionRows (7 days)", () => {
    expect(REPORT_WINDOW_MS).toBe(7 * 86400 * 1000)
    const edge = node("a", "box", new Date(NOW - REPORT_WINDOW_MS + 1000).toISOString(), [s("ses_1")])
    expect(reportedSessions([edge], NOW).entries).toHaveLength(1)
  })
})
