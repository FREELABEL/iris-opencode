/**
 * How a Hive script's remote result becomes a local exit code and a readable report.
 *
 * WHY THIS IS A MODULE. These decisions were inline in the `hive script push` handler, where
 * nothing could reach them, and both were wrong:
 *
 *   1. EXIT CODE. The handler never set `process.exitCode` for a script that failed remotely.
 *      Measured 2026-08-05: a script ending `exit 42` on the node returned `iris` exit 0. Every
 *      Hive script in a CI pipeline or a `&&` chain was therefore a no-op check — it could only
 *      fail if the HTTP call itself threw, never if the work failed.
 *
 *   2. TRUNCATION. Output was cut with `.slice(0, 50)` and no marker, so a run whose result was
 *      silently halved looked exactly like a run that finished early. That is how a timed-out
 *      two-probe smoke test read as "the first probe passed" with the second simply absent.
 *
 * Both are the same underlying failure: a result that is worse than it appears, reported as if
 * it were fine.
 */

export interface ScriptRunResult {
  status?: string
  exit_code?: number | null
  signal?: string | null
  stdout?: string
  stderr?: string
  stdout_truncated?: boolean
  stderr_truncated?: boolean
  duration_ms?: number
  timed_out?: boolean
  script_path?: string | null
  machine?: string | null
}

/** Exit code used when the remote run failed but reported no usable code of its own. */
export const GENERIC_FAILURE = 1
/** Exit code for a run the node killed on its timeout — distinct so CI can retry only these. */
export const TIMEOUT_EXIT = 124 // matches coreutils `timeout`

/**
 * The local exit code for a remote result.
 *
 * The contract: `iris hive script push` exits 0 IF AND ONLY IF the script succeeded on the node.
 * Anything else — non-zero exit, timeout, killed by signal, unparseable response — is non-zero
 * here, because a caller writing `iris hive script push deploy.sh && ship` is entitled to assume
 * the `&&` means something.
 */
export function exitCodeForResult(result: ScriptRunResult | null | undefined): number {
  if (!result) return GENERIC_FAILURE

  // A timeout is its own outcome. `timeout` reports 124 and CI can treat it as retryable, where
  // a genuine non-zero exit usually is not.
  if (result.timed_out === true || result.status === "timeout") return TIMEOUT_EXIT

  const code = result.exit_code
  if (typeof code === "number") return code

  // A null code with a signal means it was killed. Never report that as success.
  if (result.signal) return GENERIC_FAILURE

  // Fall back to the status word. An unrecognised status is a failure, not a pass — defaulting
  // an unknown state to 0 is how silent success gets manufactured.
  return result.status === "completed" ? 0 : GENERIC_FAILURE
}

/** A one-word verdict for the spinner, derived from the same rule as the exit code. */
export function verdictForResult(result: ScriptRunResult | null | undefined): "completed" | "timeout" | "failed" {
  if (result?.timed_out === true || result?.status === "timeout") return "timeout"
  return exitCodeForResult(result) === 0 ? "completed" : "failed"
}

export interface RenderedOutput {
  lines: string[]
  /** Lines dropped by the display limit here in the CLI. */
  droppedLines: number
  /** The node reported that it had already dropped output before sending it. */
  truncatedUpstream: boolean
  notice: string | null
}

/**
 * Prepare captured output for display, keeping the TAIL and saying what it dropped.
 *
 * Two different truncations can apply and they must not be confused: the node caps what it
 * sends, and the CLI caps what it prints. A reader who cannot tell them apart cannot tell
 * whether re-running with a larger limit would help.
 */
export function renderOutput(text: string | undefined | null, limit: number, truncatedUpstream = false): RenderedOutput {
  const raw = String(text ?? "").trim()
  if (!raw) {
    return { lines: [], droppedLines: 0, truncatedUpstream, notice: truncatedUpstream ? "the node truncated this output before sending it" : null }
  }

  const all = raw.split("\n")
  // Keep the END. The failure is almost always at the bottom of a log, and the old `slice(0, 50)`
  // kept the head — so a long run showed its startup banner and hid its error.
  const lines = all.length > limit ? all.slice(-limit) : all
  const droppedLines = all.length - lines.length

  const parts: string[] = []
  if (droppedLines > 0) parts.push(`${droppedLines} earlier line${droppedLines === 1 ? "" : "s"} hidden`)
  if (truncatedUpstream) parts.push("the node also truncated this output before sending it")

  return {
    lines,
    droppedLines,
    truncatedUpstream,
    notice: parts.length ? parts.join("; ") : null,
  }
}
