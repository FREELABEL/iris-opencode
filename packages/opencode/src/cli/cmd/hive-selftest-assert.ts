/**
 * What a Hive transport round-trip must prove (#182018).
 *
 * WHY THE ASSERTIONS LIVE IN THEIR OWN MODULE, AND WHY THEY DO NOT REUSE `hive run`.
 *
 * Every failure in this epic shared one property: it could not be distinguished from success
 * by any check that was running. #182004 sat broken while the node reported online, 147 tasks
 * completed, heartbeat 5s. #181633 filed the same symptom two days earlier and nothing caught
 * it in between, because nothing tested the seam.
 *
 * A harness that shares code with the thing it tests cannot detect a bug in the shared part.
 * So the selftest talks to the task API directly rather than calling through the `hive run`
 * handler — if that handler starts mis-reading a field, this must still notice.
 *
 * THE MARKERS ARE THE POINT. Grepping for a symbol, or eyeballing that "output looked fine",
 * is what produced three false positives in one session on 2026-08-12 (see
 * PRODUCTION_DEBUGGING_GUIDE). A marker minted fresh for this run, injected on one side and
 * asserted on the other, cannot be satisfied by text that was already there.
 */

/** Text a correct transport would never insert into a program's output. */
const WRAPPER_SIGNS = [
  "task-script.sh",
  "tmux -L",
  "wait-for -S",
  "/bin/bash /",
]

// CSI / OSC escape sequences. A pipe carries bytes; a PTY carries a terminal session.
const ANSI = /\[[0-?]*[ -/]*[@-~]|\][^]*(?:|\\)/

export interface RoundTripObserved {
  /** Which node the result says actually executed it. Null when the node did not say. */
  executedByNodeId?: string | null
  executedByNodeName?: string | null
  stdout: string
  stderr: string
  /** The exit code as a NUMBER the node reported structurally, or null if it did not. */
  reportedExit: number | null
  /** Where that number came from — "error_text" means it was recovered from prose. */
  exitSource: string | null
  status: string
  durationMs: number | null
  timedOut: boolean
}

export interface RoundTripExpected {
  /** The node this run was ADDRESSED to. */
  targetNodeId?: string | null
  targetNodeName?: string | null
  stdoutMarker: string
  stderrMarker: string
  exitCode: number
  /** Roughly how long the remote command should take, in ms. */
  expectedMs: number
}

export interface Assertion {
  id: string
  /** What this proves, in one line, phrased so a failure is actionable. */
  claim: string
  pass: boolean
  detail: string
  /** A known-broken assertion, tied to the ticket that will fix it. */
  knownIssue?: string
}

/**
 * Score one round-trip. Pure — every assertion is a function of what came back, so the rules
 * can be tested without a node, and a node run cannot quietly change what "pass" means.
 */
export function assessRoundTrip(exp: RoundTripExpected, obs: RoundTripObserved): Assertion[] {
  const a: Assertion[] = []
  const out = obs.stdout ?? ""
  const err = obs.stderr ?? ""
  const both = out + "\n" + err

  // FIRST, because every other assertion is about a machine, and if this one fails they are
  // all describing the wrong one. Measured 2026-08-24: a task addressed to MacBookPro executed
  // elsewhere, and three consecutive selftest scores turned out to describe two different
  // computers (#182312).
  if (exp.targetNodeId) {
    const ran = obs.executedByNodeId ?? null
    const matched = ran !== null && String(ran) === String(exp.targetNodeId)
    a.push({
      id: "ran-on-the-targeted-node",
      claim: "the task executed on the node it was addressed to",
      pass: matched,
      detail: ran === null
        ? "the result does not say which machine ran it — so every assertion below describes an UNKNOWN node"
        : matched
          ? `ran on ${obs.executedByNodeName ?? ran}`
          : `ADDRESSED to ${exp.targetNodeName ?? exp.targetNodeId}, RAN ON ${obs.executedByNodeName ?? ran}`,
      knownIssue: matched ? undefined : "#182312 — a daemon that does not know its own node_id can claim another machine's work; a job needing a permission only the target holds then returns an empty result",
    })
  }

  a.push({
    id: "stdout-arrives",
    claim: "a unique marker written to stdout on the node comes back",
    pass: both.includes(exp.stdoutMarker),
    detail: both.includes(exp.stdoutMarker) ? "present" : `marker ${exp.stdoutMarker} absent from the entire response`,
  })

  a.push({
    id: "stderr-arrives",
    claim: "a different marker written to stderr comes back",
    pass: both.includes(exp.stderrMarker),
    detail: both.includes(exp.stderrMarker) ? "present" : `marker ${exp.stderrMarker} absent from the entire response`,
  })

  // Separation is a STRONGER claim than arrival, and it is the one a caller depends on to
  // tell an error message from a result.
  const separated = out.includes(exp.stdoutMarker) && err.includes(exp.stderrMarker) && !out.includes(exp.stderrMarker)
  a.push({
    id: "streams-separated",
    claim: "stdout and stderr come back as separate streams",
    pass: separated,
    detail: separated
      ? "separated"
      : err === ""
        ? "everything arrived on ONE stream — a caller cannot tell an error from a result"
        : "the two streams are interleaved",
    knownIssue: separated ? undefined : "#182004 — output is read from the tmux pipe-pane log, which is a PTY, so the streams are merged before anything can separate them",
  })

  const exitOk = obs.reportedExit === exp.exitCode
  const structural = obs.exitSource !== null && obs.exitSource !== "error_text"
  a.push({
    id: "exit-code-value",
    claim: `the exit code comes back as ${exp.exitCode}`,
    pass: exitOk,
    detail: exitOk ? `${obs.reportedExit}` : `got ${obs.reportedExit === null ? "nothing" : obs.reportedExit}`,
  })

  a.push({
    id: "exit-code-structural",
    claim: "the exit code is reported as DATA, not recovered from a sentence",
    pass: exitOk && structural,
    detail: !exitOk
      ? "no usable exit code at all"
      : structural
        ? `reported in ${obs.exitSource}`
        : "recovered by parsing the node's error prose — one reword and this silently stops working",
    knownIssue: exitOk && structural ? undefined : "#182004 — the tmux path rejects on non-zero, so the success payload never runs and no metadata is posted",
  })

  const wrapper = WRAPPER_SIGNS.filter((s) => both.includes(s))
  a.push({
    id: "no-wrapper-text",
    claim: "the response contains no text from the transport's own machinery",
    pass: wrapper.length === 0,
    detail: wrapper.length === 0 ? "clean" : `found: ${wrapper.join(", ")}`,
    knownIssue: wrapper.length === 0 ? undefined : "#182004 — the pipe-pane log records the PTY, including the wrapper command line the shell echoed",
  })

  const ansi = ANSI.test(both)
  a.push({
    id: "no-terminal-escapes",
    claim: "the response contains no terminal control sequences",
    pass: !ansi,
    detail: ansi ? "ANSI/OSC escapes present — this is a terminal session, not a pipe" : "clean",
    knownIssue: ansi ? "#182004 — same cause as no-wrapper-text" : undefined,
  })

  // A completion signal that never fires shows up as a plausible-looking duration rather than
  // as the timeout it is, so the wall clock is itself a reading worth asserting on.
  const d = obs.durationMs
  const plausible = !obs.timedOut && d !== null && d < exp.expectedMs + 20_000
  a.push({
    id: "duration-plausible",
    claim: "wall-clock is near the command's real duration, so a stuck completion signal shows up as one",
    pass: plausible,
    detail: obs.timedOut
      ? `timed out (status ${obs.status})`
      : d === null
        ? "no duration reported"
        : `${d}ms for a command expected to take about ${exp.expectedMs}ms`,
    knownIssue: plausible ? undefined : "#182004 — the tmux wait-for channel does not always fire, so runs ride to their timeout",
  })

  return a
}

export interface SelftestSummary {
  passed: number
  failed: number
  knownIssues: number
  /** True only when every assertion passed. */
  ok: boolean
}

export function summarise(assertions: Assertion[]): SelftestSummary {
  const failed = assertions.filter((x) => !x.pass)
  return {
    passed: assertions.length - failed.length,
    failed: failed.length,
    knownIssues: failed.filter((x) => x.knownIssue).length,
    ok: failed.length === 0,
  }
}
