import { describe, expect, test } from "bun:test"
import raw from "./heartbeats.raw.json"
import { isHeartbeatJob, readHeartbeat, readRun, readWakes } from "../../src/iris/heartbeats"

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
  test("tool calls come from functions_executed (#189238); an empty list is none recorded", () => {
    const r = readRun({ id: 1, status: "completed", functions_executed: [
      { tool: "agent_memory", ok: true, status: "success", duration_ms: 538, args_summary: "action=retrieve", error: null },
      { tool: "send_email", ok: false, status: "error", duration_ms: 12, error: "no recipient" },
    ] })
    expect(r.toolCalls).toEqual([
      { tool: "agent_memory", ok: true, durationMs: 538, args: "action=retrieve", error: null },
      { tool: "send_email", ok: false, durationMs: 12, args: null, error: "no recipient" },
    ])
    expect(readRun({ id: 2, status: "completed", functions_executed: [] }).toolCalls).toBeNull()
  })
  test("continuity is read as measured (#189239), null when the beat predates it", () => {
    const c = { loaded: true, referenced: true, anchors_total: 12, anchors_matched: 4, previous_entry_at: "2026-10-13T02:01:26+00:00" }
    expect(readRun({ id: 1, status: "completed", continuity: c }).continuity).toEqual({ loaded: true, referenced: true, matched: 4, total: 12, previousAt: "2026-10-13T02:01:26+00:00" })
    expect(readRun({ id: 1, status: "completed" }).continuity).toBeNull()
  })
  test("the wake ledger keeps only held and skipped rows — executions are already runs (#189237)", () => {
    const l = readWakes({ ledger_since: "2026-10-13T03:36:15+00:00", data: [
      { at: "2026-10-13T03:35:00+00:00", due_at: "2026-10-13T03:35:00+00:00", outcome: "held", source: "scheduler", reason: "Outside its working days or active hours", held_until: "2026-10-13T13:00:00+00:00" },
      { at: "2026-10-12T13:04:00+00:00", outcome: "worked", source: "execution", execution_id: 9 },
    ] })
    expect(l!.ledgerSince).toBe("2026-10-13T03:36:15+00:00")
    expect(l!.wakes).toEqual([{ at: "2026-10-13T03:35:00+00:00", dueAt: "2026-10-13T03:35:00+00:00", outcome: "held", kind: null, reason: "Outside its working days or active hours", heldUntil: "2026-10-13T13:00:00+00:00" }])
    expect(readWakes({ message: "Not found" })).toBeNull()
  })
})
