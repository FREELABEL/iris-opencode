import { test, expect } from "bun:test"
import { latestExecId, pickFreshExecution, isExecutionObserved } from "./platform-schedules"

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
