import { describe, expect, test } from "bun:test"
import fx from "./fixtures/heartbeats.json"
import { stateOf, type HeartbeatRow } from "../src/heartbeats"
import { parseSince, queryHeartbeats, stateSince, BEAT_STATES } from "../src/query"

// The anonymised 18-heartbeat snapshot the golden test uses; "now" is when it was captured.
const rows = fx.heartbeats as unknown as HeartbeatRow[]
const now = Date.parse(fx.capturedAt)
const byName = (name: string) => rows.find((r) => r.agentName === name)!

describe("queryHeartbeats — one stateOf, filtered", () => {
  test("no filter returns every row, with the panel's own state", () => {
    const q = queryHeartbeats(rows, { now })
    expect(q.matches.length).toBe(18)
    for (const m of q.matches) expect(m.state).toBe(stateOf(m.row, now))
    expect(q.counts).toEqual({ late: 0, silent: 6, failing: 2, running: 0, ok: 10, paused: 0 })
  })

  test("states filters by the same state the panel draws", () => {
    const q = queryHeartbeats(rows, { now, states: ["silent", "failing"] })
    expect(q.matches.length).toBe(8)
    expect(new Set(q.matches.map((m) => m.state))).toEqual(new Set(["silent", "failing"]))
    // counts describe everything read, not just what matched — so "0 late" is a measurement
    expect(q.counts.ok).toBe(10)
  })

  test("a state that does not exist is refused, not matched against nothing", () => {
    expect(() => queryHeartbeats(rows, { now, states: ["held" as any] })).toThrow(/held.*late, silent, failing, running, ok, paused/)
    expect(BEAT_STATES).toEqual(["late", "silent", "failing", "running", "ok", "paused"])
  })

  test("agents match by id or by name, case-insensitively", () => {
    const q = queryHeartbeats(rows, { now, agents: [604, "chief"] })
    expect(q.matches.map((m) => m.row.agentName).sort()).toEqual(["Chief of Staff", "Market Watch Agent"])
  })

  test("since keeps rows whose state began inside the window — and keeps the ones nobody can date", () => {
    const q = queryHeartbeats(rows, { now, states: ["silent", "failing"], since: "1d" })
    const names = q.matches.map((m) => m.row.agentName)
    // Oversight Agent has been silent since 7 Oct: older than a day, so it is out
    expect(names).not.toContain("Oversight Agent")
    // never beat: when the silence began is unknown, so it is not excluded on a guess
    expect(names).toContain("Sales Agent")
    expect(q.matches.find((m) => m.row.agentName === "Sales Agent")!.since).toBeNull()
    expect(q.matches.length).toBe(7)
  })

  test("each match carries the panel's line and problems, so a script and the panel cannot disagree", () => {
    const m = queryHeartbeats(rows, { now, agents: ["Newsroom Agent"] }).matches[0]
    expect(m.state).toBe("failing")
    expect(m.line.length).toBeGreaterThan(0)
    expect(m.problems.map((p) => p.kind)).toContain("failing")
  })
})

describe("stateSince — when the current state began", () => {
  test("failing: the first failure of the current streak", () => {
    // Chief of Staff: fail on 12 Oct, ok on 21 Aug before it — the streak began on 12 Oct
    expect(stateSince(byName("Chief of Staff"), now)?.slice(0, 13)).toBe("2026-10-12T15")
  })
  test("ok: the first success of the current streak, not the newest beat", () => {
    // Newsletter Agent: ok 12 Oct, ok 9 May, fail 9 May — ok since 9 May
    // to the minute: a failure at 15:21 sits between this streak and an older ok at 02:48
    expect(stateSince(byName("Newsletter Agent"), now)?.slice(0, 16)).toBe("2026-05-09T15:27")
  })
  test("silent: its last real beat; never beat is unknown", () => {
    expect(stateSince(byName("Music Curator"), now)).toBe("2026-10-12T13:05:23+00:00")
    expect(stateSince(byName("Article Writer"), now)).toBeNull()
  })
  test("paused: unknown — the record does not say when", () => {
    expect(stateSince({ ...byName("Lead Monitor"), status: "paused" }, now)).toBeNull()
  })
})

describe("parseSince", () => {
  test("durations count back from now", () => {
    expect(parseSince("7d", now)).toBe(now - 7 * 86_400_000)
    expect(parseSince("24h", now)).toBe(now - 86_400_000)
    expect(parseSince("30m", now)).toBe(now - 30 * 60_000)
    expect(parseSince("2w", now)).toBe(now - 14 * 86_400_000)
  })
  test("an instant is taken as written", () => {
    expect(parseSince("2026-10-01T00:00:00Z", now)).toBe(Date.parse("2026-10-01T00:00:00Z"))
    expect(parseSince(1_700_000_000_000, now)).toBe(1_700_000_000_000)
  })
  test("anything else is an error — a filter that cannot be read must not quietly match everything", () => {
    expect(() => parseSince("banana", now)).toThrow(/since/)
    expect(() => parseSince("", now)).toThrow(/since/)
  })
})
