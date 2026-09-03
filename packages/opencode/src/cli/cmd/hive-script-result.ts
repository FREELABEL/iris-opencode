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
  /**
   * Where the exit code came from. `error_text` means it was RECOVERED FROM PROSE and is
   * not a value the node reported structurally — callers must label it as inferred rather
   * than present it as a reported code.
   */
  exit_code_source?: "metadata" | "result" | "error_text" | null
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

/**
 * The shape iris-api returns for a Hive TASK (`iris hive run`), as opposed to the
 * script-push result this module was originally written for.
 */
export interface HiveTaskLike {
  status?: string
  error?: string | null
  duration_ms?: number
  metadata?: { exit_code?: number | null } | null
  result?: {
    output?: string
    stdout?: string
    stderr?: string
    exit_code?: number | null
    exitCode?: number | null
  } | null
}

/**
 * Normalise a Hive task into the ScriptRunResult this module's rules operate on.
 *
 * Exists because `iris hive run` re-derived these decisions inline and got two of them
 * wrong (#182016):
 *
 *   1. THE EXIT CODE WAS READ FROM THE WRONG FIELD. The daemon submits it under
 *      `metadata.exit_code` (coding-agent-bridge task-executor.js, submitResult). The CLI
 *      read `result.exit_code`, which nothing sets — so it printed "exit=?" on every run,
 *      including successful ones, and the caller could never branch on it.
 *
 *   2. "succeeded" IS iris-api's WORD; the contract's word is "completed". Only that one
 *      synonym is normalised here. Any other unrecognised status is deliberately left
 *      alone so exitCodeForResult() fails it closed — widening the accepted set is exactly
 *      how an unknown state becomes a pass.
 */
export function fromHiveTask(task: HiveTaskLike | null | undefined): ScriptRunResult {
  const t = task ?? {}
  const r = t.result ?? {}
  let reported: number | null = null
  let source: ScriptRunResult["exit_code_source"] = null

  if (typeof t.metadata?.exit_code === "number") {
    reported = t.metadata.exit_code
    source = "metadata"
  } else if (typeof r.exit_code === "number") {
    reported = r.exit_code
    source = "result"
  } else if (typeof r.exitCode === "number") {
    reported = r.exitCode
    source = "result"
  } else {
    // LAST RESORT, and deliberately last. The daemon's tmux path rejects with
    // `new Error("Process exited with code N")` when N is non-zero, which means the error
    // path posts NO metadata at all — so on exactly the runs where the exit code matters
    // most, the only surviving copy of it is that English sentence (#182004, cause 4).
    //
    // Recovering it is strictly more information than discarding it, but it is PROSE, not
    // a contract: if the daemon reworded that message this silently stops matching. So it
    // is tagged `error_text` and must be displayed as inferred, never as reported. Delete
    // this branch once #182004 makes the daemon post metadata on the failure path.
    const m = /\bexited with code\s+(\d{1,3})\b/i.exec(String(t.error ?? ""))
    if (m) {
      reported = Number(m[1])
      source = "error_text"
    }
  }

  return {
    status: t.status === "succeeded" ? "completed" : t.status,
    exit_code: reported,
    exit_code_source: source,
    // PREFER the separated stream. This read `r.output ?? r.stdout`, so the merged field —
    // which every node sends and which contains BOTH streams — always won, and the
    // "streams come back separate" assertion could never pass however correct the node was.
    // `output` remains the fallback for nodes that predate separated streams.
    stdout: r.stdout ?? r.output ?? "",
    stderr: r.stderr ?? "",
    duration_ms: t.duration_ms,
    timed_out: t.status === "timeout" || /timed out/i.test(String(t.error ?? "")),
  }
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
