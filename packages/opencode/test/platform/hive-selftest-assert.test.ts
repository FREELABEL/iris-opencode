/**
 * What a Hive transport round-trip must prove (#182018).
 *
 * The assertions are tested against BOTH shapes: a transport that works, and the exact
 * payload the transport actually returned on 2026-08-23. The second is the important one —
 * it pins the current failure so that a change which "fixes" it by loosening the check is
 * caught, and so the day it genuinely goes green is unambiguous.
 */

import { describe, test, expect } from "bun:test"
import { assessRoundTrip, summarise, type RoundTripObserved } from "../../src/cli/cmd/hive-selftest-assert"

const EXPECT = { stdoutMarker: "IRIS_SELFTEST_OUT_abc123", stderrMarker: "IRIS_SELFTEST_ERR_abc123", exitCode: 42, expectedMs: 3000 }

const byId = (as: ReturnType<typeof assessRoundTrip>, id: string) => as.find((a) => a.id === id)!

/** What a correct transport would return. */
const WORKING: RoundTripObserved = {
  stdout: "IRIS_SELFTEST_OUT_abc123\n",
  stderr: "IRIS_SELFTEST_ERR_abc123\n",
  reportedExit: 42,
  exitSource: "metadata",
  status: "completed",
  durationMs: 3400,
  timedOut: false,
}

/**
 * What the transport ACTUALLY returned, measured 2026-08-23. Both markers survive, buried in
 * the tmux wrapper's own command line and terminal escapes, on a single merged stream, with
 * the exit code available only as prose.
 */
const AS_MEASURED: RoundTripObserved = {
  stdout:
    "/bin/bash /Users/mayoalexander/.iris/data/tasks/01a03059/task-script.sh; echo $? > /Users/mayoalexander/.iris/tmux-exit/iris-sandbox_execute-01a03059.exit; tmux -L iris wait-for -S iris-sandbox_execute-01a03059-done; exit\n" +
    "[1m[7m%[27m[1m[0m   [01;32m→  [36mproject[00m\n" +
    "IRIS_SELFTEST_OUT_abc123\nIRIS_SELFTEST_ERR_abc123\n",
  stderr: "",
  reportedExit: 42,
  exitSource: "error_text",
  status: "failed",
  durationMs: 14000,
  timedOut: false,
}

describe("assessRoundTrip — a working transport", () => {
  test("passes every assertion", () => {
    const s = summarise(assessRoundTrip(EXPECT, WORKING))
    expect(s.ok).toBe(true)
    expect(s.failed).toBe(0)
  })
})

describe("assessRoundTrip — the transport as measured on 2026-08-23", () => {
  const a = assessRoundTrip(EXPECT, AS_MEASURED)

  test("the markers DO survive — arrival is not the problem", () => {
    expect(byId(a, "stdout-arrives").pass).toBe(true)
    expect(byId(a, "stderr-arrives").pass).toBe(true)
  })

  test("but the streams are merged, so an error cannot be told from a result", () => {
    const x = byId(a, "streams-separated")
    expect(x.pass).toBe(false)
    expect(x.detail).toContain("ONE stream")
    expect(x.knownIssue).toContain("#182004")
  })

  test("the exit VALUE is right while its PROVENANCE is not — these are separate assertions", () => {
    // Conflating them is how "we get the exit code" hid the fact that it is parsed from an
    // English sentence and breaks on a reword.
    expect(byId(a, "exit-code-value").pass).toBe(true)
    expect(byId(a, "exit-code-structural").pass).toBe(false)
    expect(byId(a, "exit-code-structural").detail).toContain("prose")
  })

  test("names the transport's own machinery in the output", () => {
    const x = byId(a, "no-wrapper-text")
    expect(x.pass).toBe(false)
    expect(x.detail).toContain("task-script.sh")
    expect(x.detail).toContain("tmux -L")
  })

  test("detects the terminal escapes that prove this is a PTY, not a pipe", () => {
    expect(byId(a, "no-terminal-escapes").pass).toBe(false)
  })

  test("scores 4 of 8, and every failure is ticketed", () => {
    const s = summarise(a)
    expect(s.passed).toBe(4)
    expect(s.failed).toBe(4)
    // A failing assertion with no known issue is an unexplained regression, and must not
    // hide among the expected ones.
    expect(s.knownIssues).toBe(4)
  })
})

describe("assessRoundTrip — failures that must not be laundered into passes", () => {
  test("a missing marker fails, however healthy the status word looks", () => {
    const a = assessRoundTrip(EXPECT, { ...WORKING, stdout: "", stderr: "" })
    expect(byId(a, "stdout-arrives").pass).toBe(false)
    expect(byId(a, "stderr-arrives").pass).toBe(false)
    expect(summarise(a).ok).toBe(false)
  })

  test("a wrong exit code fails even when one was reported structurally", () => {
    const a = assessRoundTrip(EXPECT, { ...WORKING, reportedExit: 0 })
    expect(byId(a, "exit-code-value").pass).toBe(false)
    expect(byId(a, "exit-code-structural").pass).toBe(false)
  })

  test("no exit code at all is a failure, not a default of 0", () => {
    const a = assessRoundTrip(EXPECT, { ...WORKING, reportedExit: null, exitSource: null })
    expect(byId(a, "exit-code-value").pass).toBe(false)
    expect(byId(a, "exit-code-structural").detail).toContain("no usable exit code")
  })

  test("a timeout fails the duration assertion and says so plainly", () => {
    const a = assessRoundTrip(EXPECT, { ...WORKING, timedOut: true, status: "timeout", durationMs: 36000 })
    const x = byId(a, "duration-plausible")
    expect(x.pass).toBe(false)
    expect(x.detail).toContain("timed out")
  })

  test("an absurd wall-clock fails even when the task did not formally time out", () => {
    // This is the shape that hid a never-firing completion signal: not a timeout, just a
    // duration nobody looked at.
    const a = assessRoundTrip(EXPECT, { ...WORKING, durationMs: 300_000 })
    expect(byId(a, "duration-plausible").pass).toBe(false)
  })

  test("markers arriving only on the WRONG stream is not separation", () => {
    const a = assessRoundTrip(EXPECT, {
      ...WORKING,
      stdout: "IRIS_SELFTEST_OUT_abc123\nIRIS_SELFTEST_ERR_abc123\n",
      stderr: "IRIS_SELFTEST_ERR_abc123\n",
    })
    expect(byId(a, "streams-separated").pass).toBe(false)
  })
})

/**
 * The task must run on the machine it was addressed to (#182312).
 *
 * MEASURED 2026-08-24: `iris hive selftest MacBookPro` placed a task on MacBookPro and it
 * executed on a different machine — MacBookPro had no files for it; the other node's log did.
 * Three consecutive runs scored 6/8, 0/1 and 4/8, and at least two of those numbers described
 * different computers.
 *
 * This assertion is emitted FIRST on purpose: every other assertion is about a machine, and if
 * this one fails they are all describing the wrong one.
 */
describe("ran-on-the-targeted-node", () => {
  const EXPECT_T = { ...EXPECT, targetNodeId: "node-A", targetNodeName: "MacBookPro" }
  const byId = (as: ReturnType<typeof assessRoundTrip>, id: string) => as.find((a) => a.id === id)

  test("passes when the executing node matches the target", () => {
    const a = assessRoundTrip(EXPECT_T, { ...WORKING, executedByNodeId: "node-A", executedByNodeName: "MacBookPro" })
    expect(byId(a, "ran-on-the-targeted-node")!.pass).toBe(true)
  })

  test("FAILS when it ran somewhere else, and names both machines", () => {
    const a = assessRoundTrip(EXPECT_T, { ...WORKING, executedByNodeId: "node-B", executedByNodeName: "AlexMaysnow1063" })
    const x = byId(a, "ran-on-the-targeted-node")!
    expect(x.pass).toBe(false)
    expect(x.detail).toContain("MacBookPro")
    expect(x.detail).toContain("AlexMaysnow1063")
    expect(x.knownIssue).toContain("#182312")
  })

  test("a result that does not say which machine ran it is a FAILURE, not a pass", () => {
    // Silence here is the pre-fix state. Treating it as "probably fine" is what let three
    // scores describe two computers.
    const a = assessRoundTrip(EXPECT_T, { ...WORKING, executedByNodeId: null })
    const x = byId(a, "ran-on-the-targeted-node")!
    expect(x.pass).toBe(false)
    expect(x.detail).toContain("UNKNOWN")
  })

  test("it is asserted FIRST — the other assertions are meaningless if it fails", () => {
    const a = assessRoundTrip(EXPECT_T, WORKING)
    expect(a[0].id).toBe("ran-on-the-targeted-node")
  })

  test("omitted when no target was supplied, so old callers do not gain a phantom failure", () => {
    const a = assessRoundTrip(EXPECT, WORKING)
    expect(byId(a, "ran-on-the-targeted-node")).toBeUndefined()
  })
})
