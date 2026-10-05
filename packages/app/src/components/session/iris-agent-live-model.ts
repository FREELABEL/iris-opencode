/**
 * The pure half of Agents › Live (#187921): turning a run's live view into the one line that
 * answers "is it stuck?", and deciding which control the panel offers.
 *
 * On 28 Sep a Pathways user asked three times whether her agent was stuck during a 75-minute
 * Drive rename loop; her screen said "Thinking". The facts that answer it — which step, how long
 * on it, how long since the run did anything, and whether it keeps making the same call — all
 * come from the server; this file only words them. Kept apart from the component so the wording
 * is tested without a DOM.
 */

export type LiveToolCall = {
  tool: string
  iteration: number
  args: Record<string, string>
  fingerprint: string
  status: "running" | "success" | "error" | "held" | "skipped"
  error?: string
  startedAt: string
  durationMs?: number
}

export type LiveRun = {
  runId: string
  agentId?: number
  status: string
  secondsSinceLastEvent?: number
  step: {
    iteration: number
    maxIterations?: number
    phase: string
    tool?: string
    secondsOnStep?: number
  } | null
  toolCalls: LiveToolCall[]
  takeover: { id: number; status: string; pausedAtIteration?: number } | null
}

export type Verdict = { tone: "ok" | "warn" | "paused" | "idle"; text: string }

/** No event for this long while "running" is worth saying out loud. */
export const QUIET_WARN_SECONDS = 120
/** The same call (same tool, same arguments) this many times in a row reads as a loop. */
export const REPEAT_WARN = 3

export function fmtSeconds(s: number | undefined): string {
  if (s === undefined || !Number.isFinite(s)) return "—"
  if (s < 60) return `${Math.round(s)}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${Math.round(s % 60)}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

export function fmtDuration(ms: number | undefined): string {
  if (ms === undefined) return "…"
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

/** How many of the newest calls are the identical call (tool + argument fingerprint). */
export function repeatedTail(calls: LiveToolCall[]): { count: number; tool?: string } {
  const last = calls[calls.length - 1]
  if (!last) return { count: 0 }
  let n = 0
  for (let i = calls.length - 1; i >= 0; i--) {
    const c = calls[i]
    if (c.tool !== last.tool || c.fingerprint !== last.fingerprint) break
    n++
  }
  return { count: n, tool: last.tool }
}

export function stepLabel(run: LiveRun): string {
  const s = run.step
  if (!s) return ""
  return s.maxIterations ? `step ${s.iteration} of ${s.maxIterations}` : `step ${s.iteration}`
}

/**
 * One line, most important fact first. A paused run says who is driving; a loop or a long
 * silence is a warning; otherwise it says what the agent is doing and for how long — never
 * just "Thinking".
 */
export function verdict(run: LiveRun | null | undefined): Verdict {
  if (!run) return { tone: "idle", text: "Nothing is running for this agent right now." }

  if (run.status === "paused" || run.takeover?.status === "paused")
    return { tone: "paused", text: `Paused after ${stepLabel(run) || "a step"} — you have the wheel.` }
  if (run.takeover?.status === "pause_requested")
    return { tone: "paused", text: "Pausing after the step it is on finishes…" }
  if (run.takeover?.status === "resuming") return { tone: "ok", text: "Handed back — resuming…" }
  if (run.status === "awaiting_approval") return { tone: "paused", text: "Waiting for your approval of a held action." }
  if (run.status !== "running") return { tone: "idle", text: `Finished (${run.status}) at ${stepLabel(run)}.` }

  const repeat = repeatedTail(run.toolCalls)
  if (repeat.count >= REPEAT_WARN)
    return {
      tone: "warn",
      text: `Looping? The same ${repeat.tool} call ${repeat.count} times in a row. Take over to steer it.`,
    }

  const quiet = run.secondsSinceLastEvent
  if (quiet !== undefined && quiet >= QUIET_WARN_SECONDS)
    return { tone: "warn", text: `No activity for ${fmtSeconds(quiet)} — it may be stuck. Take over to check.` }

  const s = run.step
  const on = fmtSeconds(s?.secondsOnStep)
  if (s?.phase === "tool") return { tone: "ok", text: `Running ${s.tool ?? "a tool"} for ${on} (${stepLabel(run)}).` }
  if (s?.phase === "thinking") return { tone: "ok", text: `Deciding the next action for ${on} (${stepLabel(run)}).` }
  return { tone: "ok", text: `Working — ${stepLabel(run) || "starting"}.` }
}

/** One tool call, as a row: name · status · duration · argument keys (never values). */
export function callLine(c: LiveToolCall): string {
  const keys = Object.keys(c.args).filter((k) => k !== "…")
  const parts = [c.tool, c.status === "success" ? "ok" : c.status, fmtDuration(c.durationMs)]
  if (keys.length) parts.push(keys.join(", "))
  return parts.join(" · ")
}

/**
 * The one control the panel shows. "withdraw" is a hand-back before the boundary: the agent
 * never stopped, so there is nothing to type to it.
 */
export function control(run: LiveRun | null | undefined): "take-over" | "hand-back" | "withdraw" | null {
  if (!run) return null
  const t = run.takeover?.status
  if (t === "paused" || run.status === "paused") return "hand-back"
  if (t === "pause_requested") return "withdraw"
  if (t === "resuming") return null
  return run.status === "running" ? "take-over" : null
}
