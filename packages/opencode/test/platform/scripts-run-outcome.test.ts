/**
 * `iris scripts run` — the exit code and the reason (#186174).
 *
 * MEASURED FAILURE, 2026-09-18. A saved script whose task FAILED on the node:
 *
 *     iris scripts run deal-scenarios --node <node>; echo $?
 *     Script failed on Alexs-MacBook-Pro-11711
 *     0
 *
 * The handler printed an error and returned without setting process.exitCode: on a failed
 * script, a timeout, an offline node, a failed dispatch and a failed poll. So every
 * `iris scripts run … && next` treated failure as success. It also never said WHY: the
 * daemon's reason ("could not prepare assets … HTTP 422") was in the task and never printed.
 *
 * `iris hive run` already had the right rules in hive-script-result.ts; scripts run re-derived
 * them inline and got them wrong. These tests pin the shared decision both now use.
 */
import { describe, test, expect } from "bun:test"
import { scriptTaskOutcome, TIMEOUT_EXIT } from "../../src/cli/cmd/hive-script-result"

describe("scriptTaskOutcome", () => {
  test("a completed task exits 0", () => {
    expect(scriptTaskOutcome({ status: "completed", metadata: { exit_code: 0 } }).exitCode).toBe(0)
  })

  test("iris-api's 'succeeded' is success too", () => {
    expect(scriptTaskOutcome({ status: "succeeded" }).exitCode).toBe(0)
  })

  test("a failed task is non-zero, and carries the daemon's reason", () => {
    const o = scriptTaskOutcome({
      status: "failed",
      error: "could not prepare assets for 'deal-scenarios': asset fetch failed: HTTP 422",
    })
    expect(o.exitCode).not.toBe(0)
    expect(o.reason).toContain("HTTP 422")
  })

  test("the script's own exit code is passed through", () => {
    expect(scriptTaskOutcome({ status: "failed", metadata: { exit_code: 42 } }).exitCode).toBe(42)
  })

  test("a node-side timeout is 124, like coreutils timeout", () => {
    expect(scriptTaskOutcome({ status: "timeout" }).exitCode).toBe(TIMEOUT_EXIT)
  })

  test("no task at all (the CLI gave up waiting) is 124, never 0", () => {
    expect(scriptTaskOutcome(null).exitCode).toBe(TIMEOUT_EXIT)
  })

  test("an unknown status fails closed", () => {
    expect(scriptTaskOutcome({ status: "weird" }).exitCode).not.toBe(0)
  })
})
