/**
 * Agents › Heartbeats (#189110) — the pure half.
 *
 * One row per agent heartbeat: is it beating, when did it last beat and did that work, when is
 * the next one. The rule that matters most is LATE: fl-api keeps saying `scheduled` for a job the
 * scheduler stopped picking up, so "late" is computed from the clock, never read from a status.
 */
import { ago, shortAgo } from "./iris-hive-scripts-model"

export type HeartbeatRun = {
  id: number
  status: string
  startedAt: string | null
  completedAt: string | null
  durationMs: number | null
  tokens: number | null
  model: string | null
  preview: string | null
  error: string | null
}

export type HeartbeatRow = {
  jobId: number
  agentId: number
  agentName: string
  bloqId: number | null
  bloqName: string | null
  mode: string | null
  frequency: string | null
  status: string
  agentActive: boolean | null
  nextRunAt: string | null
  lastRunAt: string | null
  runCount: number
  consecutiveFailures: number
  lastOk: boolean | null
  lastError: string | null
  reportTo: number
  tools: number
  runs: HeartbeatRun[]
  runsMeasured: boolean
}

export type BeatState = "late" | "failing" | "running" | "ok" | "paused"

/** A beat this far past its time is late, not "about to run". The scheduler ticks every minute. */
export const LATE_AFTER_MS = 15 * 60_000

const UNITS: Record<string, [number, string]> = {
  minute: [60_000, "minute"],
  minutes: [60_000, "minute"],
  hour: [3_600_000, "hour"],
  hours: [3_600_000, "hour"],
  day: [86_400_000, "day"],
  days: [86_400_000, "day"],
  week: [604_800_000, "week"],
  weeks: [604_800_000, "week"],
}
const NAMED: Record<string, [number, string]> = {
  hourly: [3_600_000, "Every hour"],
  daily: [86_400_000, "Every day"],
  weekly: [604_800_000, "Every week"],
  weekdays: [86_400_000, "Weekdays"],
  monthly: [2_592_000_000, "Every month"],
  once: [0, "Once"],
}

/** "every_8_hours" → "Every 8 hours"; unknown words are shown as written, never dropped. */
export function cadenceOf(frequency: string | null | undefined): string {
  if (!frequency) return "No schedule"
  const f = frequency.toLowerCase()
  if (NAMED[f]) return NAMED[f][1]
  const m = /^every_(\d+)_([a-z]+)$/.exec(f)
  if (m && UNITS[m[2]]) {
    const n = Number(m[1])
    const unit = UNITS[m[2]][1]
    return n === 1 ? `Every ${unit}` : `Every ${n} ${unit}s`
  }
  return frequency.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase())
}

const t = (iso: string | null | undefined) => (iso ? Date.parse(iso) : NaN)

/** The newest finished beat, if any — what "last beat" means on screen. */
export function lastRun(r: HeartbeatRow): HeartbeatRun | undefined {
  return r.runs.find((x) => x.status !== "running" && x.status !== "pending")
}

/**
 * When it last beat: the NEWER of the job's `last_run_at` and the newest recorded run. Neither
 * alone is right — fl-api does not write an execution row for every beat (measured 2026-10-12:
 * one agent's newest execution was 5 days old while its job had run that afternoon), and a
 * run row can be newer than the job when a beat is still being written back.
 */
export function lastBeatAt(r: HeartbeatRow): string | null {
  const x = lastRun(r)
  const cands = [r.lastRunAt, x?.completedAt ?? x?.startedAt ?? null].filter((v): v is string => !!v && Number.isFinite(Date.parse(v)))
  return cands.sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null
}

const failed = (x: HeartbeatRun) => x.status === "failed" || x.status === "error" || !!x.error

export function stateOf(r: HeartbeatRow, now: number): BeatState {
  // Only the JOB's status pauses a heartbeat. An agent switched off (`active: false`) still beats:
  // measured 2026-10-12, an inactive agent beat at 19:30 that day. Calling it paused
  // would tell you it is quiet while it keeps running and spending.
  if (r.status === "paused") return "paused"
  if (r.status === "running" || r.runs[0]?.status === "running") return "running"
  const next = t(r.nextRunAt)
  if (r.status === "scheduled" && Number.isFinite(next) && now - next > LATE_AFTER_MS) return "late"
  const last = lastRun(r)
  if (r.status === "failed" || (last ? failed(last) : r.lastOk === false)) return "failing"
  return "ok"
}

export type Problem = { kind: "late" | "failing" | "stopped"; text: string; fix: string }

export function problemsOf(r: HeartbeatRow, now: number): Problem[] {
  const out: Problem[] = []
  const s = stateOf(r, now)
  if (s === "late")
    out.push({
      kind: "late",
      text: `Missed its beat — due ${ago(r.nextRunAt, now)}`,
      fix: "The scheduler has not picked it up, though it still says scheduled. Run it now; if it stays late, pause and resume it to reschedule.",
    })
  const last = lastRun(r)
  const fails = r.runs.filter(failed).length
  if (r.status === "failed")
    out.push({
      kind: "stopped",
      text: "Stopped after failing",
      fix: "fl-api gave up retrying. Read the last error, fix the cause, then Run now.",
    })
  else if (last && failed(last))
    out.push({
      kind: "failing",
      text: `Last beat failed${last.error ? `: ${oneLine(last.error)}` : ""}`,
      fix: fails > 1 ? `${fails} of the last ${r.runs.length} beats failed.` : "The beat before it worked.",
    })
  else if (!last && r.lastOk === false)
    out.push({ kind: "failing", text: `Last beat failed${r.lastError ? `: ${oneLine(r.lastError)}` : ""}`, fix: "" })
  return out
}

const oneLine = (s: string) => {
  const l = s.replace(/\s+/g, " ").trim()
  return l.length > 140 ? `${l.slice(0, 139)}…` : l
}

/** "in 3h" / "3h ago" — the next beat is in the future, everything else in the past. */
export function untilOf(iso: string | null | undefined, now: number): string {
  const at = t(iso)
  if (!Number.isFinite(at)) return "—"
  const d = at - now
  if (d <= 0) return shortAgo(iso, now) === "now" ? "now" : `${shortAgo(iso, now)} ago`
  const m = Math.round(d / 60_000)
  if (m < 60) return `in ${Math.max(1, m)}m`
  const h = Math.round(m / 60)
  if (h < 48) return `in ${h}h`
  return `in ${Math.round(h / 24)}d`
}

/** The line under an agent's name. */
export function lineOf(r: HeartbeatRow, now: number): string {
  const s = stateOf(r, now)
  const last = lastBeatAt(r)
  const lastTxt = last ? `last beat ${ago(last, now)}` : "never beat"
  if (s === "paused") return `Paused · ${lastTxt}`
  if (s === "running") return "Beating now"
  if (s === "late") return `Late · due ${ago(r.nextRunAt, now)}`
  return `Next ${untilOf(r.nextRunAt, now)} · ${lastTxt}`
}

const RANK: Record<BeatState, number> = { late: 0, failing: 1, running: 2, ok: 3, paused: 4 }

/** Problems first; then the next beat soonest; paused last. Stable by name. */
export function sortBeats(rows: readonly HeartbeatRow[], now: number): HeartbeatRow[] {
  return [...rows].sort((a, b) => {
    const r = RANK[stateOf(a, now)] - RANK[stateOf(b, now)]
    if (r) return r
    const na = t(a.nextRunAt)
    const nb = t(b.nextRunAt)
    if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb
    return a.agentName.localeCompare(b.agentName)
  })
}

export function beatSummary(rows: readonly HeartbeatRow[], now: number) {
  const states = rows.map((r) => stateOf(r, now))
  return {
    total: rows.length,
    beating: states.filter((s) => s === "ok" || s === "running").length,
    attention: states.filter((s) => s === "late" || s === "failing").length,
    paused: states.filter((s) => s === "paused").length,
  }
}

/** The strip: oldest → newest, one tick per beat, so the eye reads it left to right like a trace. */
export function stripOf(r: HeartbeatRow): ("ok" | "fail" | "run")[] {
  return [...r.runs].reverse().map((x) => (x.status === "running" || x.status === "pending" ? "run" : failed(x) ? "fail" : "ok"))
}

export function modeOf(mode: string | null | undefined): string {
  switch (mode) {
    case "autonomous":
      return "Acts on its own"
    case "reactive":
      return "Reacts to changes"
    case "passive":
      return "Watches and reports"
    case "briefing":
      return "Sends a briefing"
    default:
      return mode ? mode : "—"
  }
}

export function durationOf(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "—"
  if (ms < 1000) return `${ms}ms`
  const s = Math.round(ms / 1000)
  return s < 120 ? `${s}s` : `${Math.round(s / 60)}m`
}

export function tokensOf(n: number | null | undefined): string {
  if (n == null) return "—"
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n)
}

/** A run's text as a sentence: markdown marks and blank lines out, so four lines say something. */
export function previewOf(text: string | null | undefined): string {
  if (!text) return ""
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[*`#>]+/g, "")
    .replace(/^\s*(?:[-•✓✗]\s*)+/gm, "")
    .replace(/\s+/g, " ")
    .trim()
}
