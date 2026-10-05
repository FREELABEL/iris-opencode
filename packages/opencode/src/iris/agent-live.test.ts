import { describe, expect, test } from "bun:test"
import { readLiveRun, readToolCall, readTakeover } from "./agent-live"

// #187921 — the sidecar's reading of iris-api's live view. Pure, so no network.

const body = {
  run_id: "9b2e",
  workflow_id: "wf-1",
  agent_id: 7,
  status: "running",
  started_at: "2026-09-28T10:00:00+00:00",
  finished_at: null,
  last_event_at: "2026-09-28T11:15:00+00:00",
  seconds_since_last_event: 4,
  current_step: { iteration: 212, phase: "tool", tool: "drive_rename", since: "x", max_iterations: 500, seconds_on_step: 2 },
  recent_tool_calls: [
    {
      tool: "drive_rename",
      iteration: 211,
      args: { file_id: "string(33)", name: "string(18)" },
      args_fingerprint: "a1b2c3d4",
      status: "error",
      error: "Drive refused: token=[redacted]",
      started_at: "2026-09-28T11:14:58.120+00:00",
      duration_ms: 2140,
    },
  ],
  takeover: { id: 3, status: "pause_requested", paused_at_iteration: null },
}

describe("readLiveRun", () => {
  test("maps the server's snake_case view", () => {
    const r = readLiveRun(body)!
    expect(r.runId).toBe("9b2e")
    expect(r.step).toEqual({ iteration: 212, maxIterations: 500, phase: "tool", tool: "drive_rename", since: "x", secondsOnStep: 2 })
    expect(r.secondsSinceLastEvent).toBe(4)
    expect(r.finishedAt).toBeUndefined()
    expect(r.toolCalls[0]).toEqual({
      tool: "drive_rename",
      iteration: 211,
      args: { file_id: "string(33)", name: "string(18)" },
      fingerprint: "a1b2c3d4",
      status: "error",
      error: "Drive refused: token=[redacted]",
      startedAt: "2026-09-28T11:14:58.120+00:00",
      durationMs: 2140,
    })
    expect(r.takeover).toEqual({ id: 3, status: "pause_requested", pausedAtIteration: undefined })
  })
  test("no run is null, not an empty run", () => {
    expect(readLiveRun(null)).toBeNull()
    expect(readLiveRun({})).toBeNull()
  })
  test("unknown statuses do not pass through as if known", () => {
    expect(readToolCall({ tool: "x", status: "weird" }).status).toBe("running")
    expect(readTakeover({ id: 1, status: "weird" })).toBeNull()
  })
})
