/**
 * `iris hive script push` — exit codes and output truncation.
 *
 * MEASURED FAILURE, 2026-08-05. A script ending `exit 42` on the node produced `iris` exit 0:
 *
 *     printf '#!/usr/bin/env bash\necho fail\nexit 42\n' > fail42.sh
 *     iris hive script push ./fail42.sh >/dev/null 2>&1; echo $?   # -> 0
 *
 * The push handler set `process.exitCode` only when the HTTP call threw, never when the SCRIPT
 * failed. So every Hive script in CI or in an `&&` chain was a no-op check that could not fail.
 *
 * The second failure in the same handler: output was cut with `.slice(0, 50)` and no marker, so
 * a halved result was indistinguishable from a short one — which is exactly how a timed-out
 * two-probe smoke test read as "the first probe passed", with the second silently absent.
 *
 * These test the real exported decisions rather than grepping the source, so they fail if the
 * behaviour regresses even when the source still contains the right-looking strings.
 */
import { describe, test, expect } from "bun:test"
import {
  exitCodeForResult,
  verdictForResult,
  renderOutput,
  GENERIC_FAILURE,
  TIMEOUT_EXIT,
  type ScriptRunResult,
} from "../../src/cli/cmd/hive-script-result"

describe("exit code propagation (#179063)", () => {
  test("a script that exits 42 makes the CLI exit 42 — the measured bug", () => {
    expect(exitCodeForResult({ status: "failed", exit_code: 42 })).toBe(42)
  })

  test("a successful script exits 0", () => {
    expect(exitCodeForResult({ status: "completed", exit_code: 0 })).toBe(0)
  })

  test("exit 0 IF AND ONLY IF the script succeeded", () => {
    // The contract that makes `push deploy.sh && ship` mean something. Anything that is not a
    // clean success must be non-zero, including states this code has never seen.
    const notSuccess: ScriptRunResult[] = [
      { status: "failed", exit_code: 1 },
      { status: "failed", exit_code: 127 },
      { status: "timeout", exit_code: null },
      { status: "failed", exit_code: null, signal: "SIGKILL" },
      { status: "some_future_status" },
      { status: undefined },
      {},
    ]
    for (const r of notSuccess) {
      expect(exitCodeForResult(r)).not.toBe(0)
    }
  })

  test("an unrecognised status is a FAILURE, never a pass", () => {
    // Defaulting an unknown state to 0 is how silent success gets manufactured.
    expect(exitCodeForResult({ status: "wat" })).toBe(GENERIC_FAILURE)
  })

  test("a null response is a failure, not a success", () => {
    expect(exitCodeForResult(null)).toBe(GENERIC_FAILURE)
    expect(exitCodeForResult(undefined)).toBe(GENERIC_FAILURE)
  })

  test("a timeout gets its own code so CI can retry only those", () => {
    // A timeout usually means the node was slow; a non-zero exit usually means the work is
    // wrong. Collapsing them makes a flaky node look like a broken script.
    expect(exitCodeForResult({ status: "timeout", exit_code: null, timed_out: true })).toBe(TIMEOUT_EXIT)
    expect(exitCodeForResult({ status: "failed", exit_code: 1 })).not.toBe(TIMEOUT_EXIT)
  })

  test("killed-by-signal is a failure even with a null exit code", () => {
    expect(exitCodeForResult({ status: "failed", exit_code: null, signal: "SIGKILL" })).toBe(GENERIC_FAILURE)
  })

  test("the spinner verdict agrees with the exit code", () => {
    // Two independent code paths deciding "did this pass" is how a green banner ends up above a
    // non-zero exit.
    const cases: ScriptRunResult[] = [
      { status: "completed", exit_code: 0 },
      { status: "failed", exit_code: 42 },
      { status: "timeout", timed_out: true },
      { status: "bogus" },
    ]
    for (const r of cases) {
      expect(verdictForResult(r) === "completed").toBe(exitCodeForResult(r) === 0)
    }
  })
})

describe("output truncation is announced (#179063)", () => {
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `line-${i + 1}`).join("\n")

  test("keeps the TAIL, where the failure is", () => {
    // The old `.slice(0, 50)` kept the HEAD, so a long run showed its startup banner and hid the
    // error that ended it.
    const r = renderOutput(lines(200), 50)
    expect(r.lines).toHaveLength(50)
    expect(r.lines.at(-1)).toBe("line-200")
    expect(r.lines).not.toContain("line-1")
  })

  test("says how many lines it hid", () => {
    const r = renderOutput(lines(200), 50)
    expect(r.droppedLines).toBe(150)
    expect(r.notice).toContain("150")
  })

  test("says NOTHING when nothing was dropped", () => {
    // A notice that is always present teaches people to ignore it.
    const r = renderOutput(lines(10), 50)
    expect(r.droppedLines).toBe(0)
    expect(r.notice).toBeNull()
    expect(r.lines).toHaveLength(10)
  })

  test("distinguishes the NODE's truncation from the CLI's", () => {
    // Two different caps apply. A reader who cannot tell them apart cannot tell whether
    // re-running with a bigger limit would help.
    const cliOnly = renderOutput(lines(200), 50, false)
    expect(cliOnly.notice).toContain("hidden")
    expect(cliOnly.notice).not.toContain("node")

    const both = renderOutput(lines(200), 50, true)
    expect(both.notice).toContain("hidden")
    expect(both.notice).toContain("node")
  })

  test("reports upstream truncation even when the visible output is short", () => {
    // The nastiest case: the node dropped megabytes, what survived fits on screen, and without
    // this the result looks complete.
    const r = renderOutput("just one line", 50, true)
    expect(r.lines).toHaveLength(1)
    expect(r.droppedLines).toBe(0)
    expect(r.notice).toContain("node")
  })

  test("handles empty and whitespace output without inventing a line", () => {
    for (const empty of ["", "   \n  ", undefined, null]) {
      const r = renderOutput(empty as string | undefined, 50)
      expect(r.lines).toHaveLength(0)
    }
  })

  test("a limit of exactly the line count drops nothing", () => {
    // Off-by-one here silently eats the last line of every full-length run.
    const r = renderOutput(lines(50), 50)
    expect(r.lines).toHaveLength(50)
    expect(r.droppedLines).toBe(0)
    expect(r.notice).toBeNull()
    expect(r.lines.at(-1)).toBe("line-50")
  })
})
