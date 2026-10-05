import { test, expect } from "bun:test"
import { latestExecId, pickFreshExecution, isExecutionObserved, timeSince } from "./platform-schedules"

// latestExecId — baseline before triggering
test("latestExecId: returns the max id, 0 for empty/odd input", () => {
  expect(latestExecId([{ id: 3 }, { id: 7 }, { id: 5 }])).toBe(7)
  expect(latestExecId([])).toBe(0)
  expect(latestExecId(undefined as any)).toBe(0)
})

// pickFreshExecution — detect the run we just dispatched (#146511)
test("pickFreshExecution: returns the newest execution past the baseline", () => {
  const runs = [{ id: 10, status: "queued" }, { id: 11, status: "running" }, { id: 9, status: "completed" }]
  expect(pickFreshExecution(runs, 9)?.id).toBe(11)
})

test("pickFreshExecution: null when nothing is newer than the baseline (worker idle)", () => {
  const runs = [{ id: 8, status: "completed" }, { id: 9, status: "completed" }]
  expect(pickFreshExecution(runs, 9)).toBeNull()
  expect(pickFreshExecution([], 0)).toBeNull()
})

// isExecutionObserved — proves the worker actually picked it up
test("isExecutionObserved: true once the run reaches a worker-touched state", () => {
  expect(isExecutionObserved({ status: "running" })).toBe(true)
  expect(isExecutionObserved({ status: "completed" })).toBe(true)
  expect(isExecutionObserved({ status: "failed" })).toBe(true)
})

test("isExecutionObserved: false while still queued or absent (the stall case)", () => {
  expect(isExecutionObserved({ status: "queued" })).toBe(false)
  expect(isExecutionObserved({ status: "pending" })).toBe(false)
  expect(isExecutionObserved(null)).toBe(false)
})

// timeSince — #183124. `schedules list --latest` printed "just now" for 350 of 350 rows and
// `schedules history` said the same for runs 114 days apart, because both fed a PAST timestamp
// into timeUntil(), whose `diff < 0` branch returns the bare string "overdue" with no magnitude.
// These cases pin the magnitude against fixed offsets so the two questions — how long until, how
// long since — cannot be conflated again.
test("timeSince: reports elapsed magnitude, not a fixed string", () => {
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
  expect(timeSince(ago(30_000))).toBe("just now")
  expect(timeSince(ago(5 * 60_000))).toBe("5m ago")
  expect(timeSince(ago(3 * 3600_000))).toBe("3h ago")
  expect(timeSince(ago(4.2 * 86400_000))).toBe("4.2d ago")
  expect(timeSince(ago(21 * 86400_000))).toBe("21d ago")
  // The regression itself: a run from ~114 days ago must not read as recent.
  expect(timeSince(ago(114 * 86400_000))).toBe("4mo ago")
})

test("timeSince: two runs months apart never render identically", () => {
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
  expect(timeSince(ago(60_000))).not.toBe(timeSince(ago(114 * 86400_000)))
})

test("timeSince: empty for missing or unparseable input, never a wrong number", () => {
  expect(timeSince(null)).toBe("")
  expect(timeSince(undefined)).toBe("")
  expect(timeSince("not-a-date")).toBe("")
})
