import { describe, expect, test } from "bun:test"
import type { HeartbeatRow, HeartbeatRun } from "@/components/session/iris-heartbeats-model"
import { compact, greetingOf, overviewOf, pageOf, rowOf, shortAgo, shortEvery, tabCount, tabRows } from "./home-dashboard-model"

const NOW = Date.parse("2026-11-02T16:00:00Z")
const DAY = Date.parse("2026-11-02T00:00:00Z")
const run = (startedAt: string, status = "completed", tokens = 1000): HeartbeatRun =>
  ({ id: Date.parse(startedAt), status, startedAt, completedAt: startedAt, durationMs: 1, tokens, model: "m", preview: null, error: null }) as HeartbeatRun
const beat = (o: Partial<HeartbeatRow> & { agentName: string }): HeartbeatRow =>
  ({
    jobId: 1, agentId: 1, bloqId: null, bloqName: null, mode: "autonomous", frequency: "every_6_hours", status: "scheduled",
    agentActive: true, nextRunAt: "2026-11-02T18:00:00Z", lastRunAt: "2026-11-02T12:00:00Z", runCount: 10, consecutiveFailures: 0,
    lastOk: true, lastError: null, reportTo: 0, tools: 0, workingDays: null, schedule: null, settingsFrequency: null, timezone: null,
    lastSkip: null, runs: [run("2026-11-02T12:00:00Z")], runsMeasured: true, ...o,
  }) as HeartbeatRow

// Shapes from the account's real heartbeats on 2026-11-02: a healthy agent, one that skipped
// itself for a week on a repetition rule, one paused, one whose last run failed.
const healthy = beat({ agentName: "Healthy", runCount: 300 })
const stuck = beat({
  agentName: "Stuck", runCount: 1600, frequency: "hourly", lastRunAt: "2026-10-27T00:53:00Z",
  runs: [run("2026-10-27T00:53:00Z")], lastSkip: { at: "2026-11-02T15:00:00Z", reason: "Repetition detected — same situation as last N heartbeats", kind: null } as any,
})
const paused = beat({ agentName: "Paused", status: "paused", runCount: 900 })
const failed = beat({ agentName: "Failed", runCount: 50, runs: [run("2026-11-02T12:00:00Z", "failed", 0)], lastOk: false })
const rows = [healthy, stuck, paused, failed]

describe("#192222 Home › agents", () => {
  test("indicators come from the Heartbeats model, and a stopped agent says why", () => {
    const r = rows.map((x) => rowOf(x, NOW))
    expect(r.map((x) => [x.name, x.indicator])).toEqual([["Healthy", "ok"], ["Stuck", "stopped"], ["Paused", "paused"], ["Failed", "failing"]])
    expect(r[1].why).toBe("Not running — skipped: Repetition detected — same situation as last N heartbeats")
    expect(r[1].last).toBe("6d")
  })
  test("tabs: needs attention, most active by runs (no paused), all", () => {
    expect(tabRows(rows, "attention", NOW).map((x) => x.agentName)).toEqual(["Stuck", "Failed"])
    expect(tabRows(rows, "active", NOW).map((x) => x.agentName)).toEqual(["Stuck", "Healthy", "Failed"])
    expect(tabCount(rows, "all", NOW)).toBe(4)
  })
  test("overview counts and today's runs and tokens", () => {
    expect(overviewOf(rows, NOW, DAY)).toEqual({ scheduled: 3, healthy: 1, resting: 0, stopped: 1, failing: 1, paused: 1, runsToday: 3, tokensToday: 2000 })
  })
  test("pagination clamps the page and reports the range", () => {
    const all = Array.from({ length: 16 }, (_, i) => i)
    expect(pageOf(all, 2)).toMatchObject({ items: [6, 7, 8, 9, 10, 11], page: 2, pages: 3, from: 7, to: 12, total: 16 })
    expect(pageOf(all, 9)).toMatchObject({ page: 3, from: 13, to: 16 })
    expect(pageOf([], 1)).toMatchObject({ page: 1, pages: 1, from: 0, to: 0 })
  })
  test("short forms", () => {
    expect([shortEvery("hourly"), shortEvery("every_8_hours"), shortEvery("daily"), shortEvery(null)]).toEqual(["1h", "8h", "1d", "—"])
    expect([shortAgo("2026-11-02T15:16:00Z", NOW), shortAgo("2026-11-02T05:00:00Z", NOW), shortAgo(null, NOW)]).toEqual(["44m", "11h", "—"])
    expect([compact(697_000), compact(1_250_000), compact(12)]).toEqual(["697k", "1.3M", "12"])
    expect([greetingOf(9), greetingOf(14), greetingOf(20)]).toEqual(["Good morning", "Good afternoon", "Good evening"])
  })
})

describe("#192251 Home › resting", () => {
  const wake = (at: string) => ({ at, dueAt: at, outcome: "skipped", kind: "skipped", reason: "Repetition detected.", heldUntil: null }) as any
  const resting = beat({
    agentName: "Resting", frequency: "hourly", lastRunAt: "2026-11-02T14:00:00Z", runs: [run("2026-11-02T14:00:00Z")],
    lastSkip: { at: "2026-11-02T15:00:00Z", reason: "Repetition detected.", kind: "skipped" } as any,
    wakes: [wake("2026-11-02T15:00:00Z")], ledgerSince: "2026-10-26T00:00:00Z",
  } as any)
  test("a resting agent gets the moon, not the stop, and leaves Needs attention", () => {
    expect(rowOf(resting, NOW)).toMatchObject({ indicator: "resting", why: "Resting by choice — skipped 1 in a row; runs again within 5 beats" })
    expect(tabRows([resting, stuck], "attention", NOW).map((x) => x.agentName)).toEqual(["Stuck"])
    expect(overviewOf([resting, stuck], NOW, DAY)).toMatchObject({ resting: 1, stopped: 1 })
  })
})
