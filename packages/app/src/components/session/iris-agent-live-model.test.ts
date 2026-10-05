import { describe, expect, test } from "bun:test"
import { callLine, control, fmtSeconds, repeatedTail, verdict, type LiveRun, type LiveToolCall } from "./iris-agent-live-model"

// #187921 — the panel must answer "is it stuck?" in words, never just "Thinking".

const call = (tool: string, fingerprint: string, extra: Partial<LiveToolCall> = {}): LiveToolCall => ({
  tool,
  iteration: 1,
  args: { file_id: "string(2)", name: "string(12)" },
  fingerprint,
  status: "success",
  startedAt: "2026-09-28T10:00:00Z",
  durationMs: 2100,
  ...extra,
})

const run = (over: Partial<LiveRun> = {}): LiveRun => ({
  runId: "r1",
  agentId: 7,
  status: "running",
  secondsSinceLastEvent: 3,
  step: { iteration: 12, maxIterations: 50, phase: "tool", tool: "drive_rename", secondsOnStep: 2 },
  toolCalls: [call("drive_rename", "aa"), call("drive_rename", "bb")],
  takeover: null,
  ...over,
})

describe("verdict", () => {
  test("says what it is doing and for how long, with the step", () => {
    expect(verdict(run())).toEqual({ tone: "ok", text: "Running drive_rename for 2s (step 12 of 50)." })
  })
  test("the model call is 'deciding the next action', with a duration — not a bare 'Thinking'", () => {
    const v = verdict(run({ step: { iteration: 3, phase: "thinking", secondsOnStep: 75 } }))
    expect(v.text).toBe("Deciding the next action for 1m 15s (step 3).")
  })
  test("the same call three times in a row is flagged as a loop (the 28 Sep case)", () => {
    const v = verdict(run({ toolCalls: [call("drive_rename", "aa"), call("drive_rename", "aa"), call("drive_rename", "aa")] }))
    expect(v.tone).toBe("warn")
    expect(v.text).toContain("same drive_rename call 3 times")
  })
  test("different arguments are progress, not a loop", () => {
    expect(verdict(run({ toolCalls: ["a", "b", "c", "d"].map((f) => call("drive_rename", f)) })).tone).toBe("ok")
  })
  test("long silence while running is a warning", () => {
    const v = verdict(run({ secondsSinceLastEvent: 600 }))
    expect(v).toEqual({ tone: "warn", text: "No activity for 10m 0s — it may be stuck. Take over to check." })
  })
  test("paused and pausing say who is driving", () => {
    expect(verdict(run({ status: "paused", takeover: { id: 1, status: "paused" } })).text).toBe(
      "Paused after step 12 of 50 — you have the wheel.",
    )
    expect(verdict(run({ takeover: { id: 1, status: "pause_requested" } })).text).toContain("Pausing after the step")
  })
  test("nothing running and finished runs are idle", () => {
    expect(verdict(null).tone).toBe("idle")
    expect(verdict(run({ status: "completed" })).text).toBe("Finished (completed) at step 12 of 50.")
  })
})

describe("control — one button at a time", () => {
  test("running → take over; pausing → withdraw; paused → hand back; finished → none", () => {
    expect(control(run())).toBe("take-over")
    expect(control(run({ takeover: { id: 1, status: "pause_requested" } }))).toBe("withdraw")
    expect(control(run({ status: "paused", takeover: { id: 1, status: "paused" } }))).toBe("hand-back")
    expect(control(run({ takeover: { id: 1, status: "resuming" } }))).toBeNull()
    expect(control(run({ status: "completed" }))).toBeNull()
    expect(control(null)).toBeNull()
  })
  test("a run handed back earlier can be taken over again", () => {
    expect(control(run({ takeover: { id: 1, status: "resumed" } }))).toBe("take-over")
  })
})

describe("rows", () => {
  test("callLine shows name, status, duration and argument NAMES only", () => {
    expect(callLine(call("drive_rename", "aa"))).toBe("drive_rename · ok · 2.1s · file_id, name")
    expect(callLine(call("drive_rename", "aa", { status: "running", durationMs: undefined, args: {} }))).toBe(
      "drive_rename · running · …",
    )
  })
  test("repeatedTail counts only the identical newest calls", () => {
    expect(repeatedTail([call("x", "1"), call("y", "2"), call("y", "2")])).toEqual({ count: 2, tool: "y" })
    expect(repeatedTail([])).toEqual({ count: 0 })
  })
  test("fmtSeconds", () => {
    expect(fmtSeconds(undefined)).toBe("—")
    expect(fmtSeconds(42)).toBe("42s")
    expect(fmtSeconds(4500)).toBe("1h 15m")
  })
})
