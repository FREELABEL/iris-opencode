import { describe, expect, test } from "bun:test"
import raw from "./heartbeats.raw.json"
import { isHeartbeatJob, readHeartbeat, readRun } from "../../src/iris/heartbeats"

// fl-api's own scheduled-job + execution rows for account #193, 2026-10-12 (names, boards, run text and emails anonymised — this repo is public).
describe("heartbeats sidecar", () => {
  test("reads every live heartbeat job into a row", () => {
    const rows = raw.rows.map((o: any) => readHeartbeat(o.job, o.runs))
    expect(rows.length).toBe(18)
    const delo = rows.find((r) => r.agentName === "Market Watch Agent")!
    expect(delo).toMatchObject({ status: "scheduled", frequency: "every_8_hours", mode: "autonomous", reportTo: 2, runsMeasured: true })
    expect(delo.tools).toBeGreaterThan(5)
    expect(rows.find((r) => r.agentName === "Article Writer")).toMatchObject({
      lastOk: false,
      lastError: "Heartbeat Stage 3 endpoint unavailable",
    })
    // working days ride along from the agent's settings; the beat keeps its report and outputs
    expect(rows.find((r) => r.agentName === "Music Curator")!.workingDays).toEqual(["mon", "tue", "wed", "thu", "fri"])
    const beat = rows.find((r) => r.agentName === "Newsletter Agent")!.runs[0]
    expect(beat.response).toStartWith("**Status**")
    expect(beat).toMatchObject({ itemId: null, deliverableId: null, publicUrl: null })
  })
  test("runs that could not be read are NOT READ, not 'never ran'", () => {
    const r = readHeartbeat(raw.rows[0].job, null)
    expect(r.runs).toEqual([])
    expect(r.runsMeasured).toBe(false)
  })
  test("only agent heartbeats are heartbeats", () => {
    expect(isHeartbeatJob({ agent_id: 1, task_name: "heartbeat" })).toBe(true)
    expect(isHeartbeatJob({ agent_id: 1, task_name: "x", data: { type: "heartbeat" } })).toBe(true)
    expect(isHeartbeatJob({ agent_id: null, task_name: "heartbeat" })).toBe(false)
    expect(isHeartbeatJob({ agent_id: 2, task_name: "Write a post" })).toBe(false)
  })
  test("only the newest beats keep their full report — the rest feed the week", () => {
    const runs = Array.from({ length: 14 }, (_, i) => ({ id: i, status: "completed", response: "**Status** — ok" }))
    const r = readHeartbeat(raw.rows[0].job, runs)
    expect(r.runs.filter((x) => x.response).length).toBe(10)
  })
  test("a run's duration comes from ms, or seconds when that is all there is", () => {
    expect(readRun({ id: 1, status: "completed", duration_ms: 1500 }).durationMs).toBe(1500)
    expect(readRun({ id: 1, status: "completed", duration_seconds: 3 }).durationMs).toBe(3000)
    expect(readRun({ id: 1, status: "failed", error_message: "x" })).toMatchObject({ error: "x", durationMs: null })
  })
})
