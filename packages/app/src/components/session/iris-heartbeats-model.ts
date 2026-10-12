/**
 * Agents › Heartbeats (#189110) — the pure half.
 *
 * One row per agent heartbeat: is it beating, when did it last beat and did that work, when is
 * the next one. The rule that matters most is LATE: fl-api keeps saying `scheduled` for a job the
 * scheduler stopped picking up, so "late" is computed from the clock, never read from a status.
 *
 * TWO THINGS THE RECORDS SAY THAT ARE NOT TRUE (#189127), and how this file refuses them:
 *  - #189113: when iris-api SKIPS a beat (outside hours, gated, nothing to do) fl-api still moves
 *    `last_run_at` forward and writes no run. So `last_run_at` means "woke up", never "beat"; a
 *    beat is a run row, and a wake with no run behind it is a SKIP.
 *  - #189114: a run whose model call failed (OpenRouter 402/403, provider 401) is saved as
 *    `completed` with the error text as its reply. A reply that IS an error is a failed beat.
 * Both are server bugs; until they are fixed, the panel must not draw a green beat that never ran.
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
  response?: string | null
  error: string | null
  itemId?: number | null
  deliverableId?: number | null
  publicUrl?: string | null
  emailSent?: boolean | null
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
  workingDays?: string[] | null
  schedule?: { timezone: string; days: string[]; hours: { start: string; end: string } | null } | null
  settingsFrequency?: string | null
  timezone?: string | null
  lastSkip?: { at: string | null; reason: string | null; kind: string | null } | null
  runs: HeartbeatRun[]
  runsMeasured: boolean
}

export type BeatState = "late" | "silent" | "failing" | "running" | "ok" | "paused"


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

/** How far apart its wakes are, or null when the words do not say. `daily_430pm` is daily. */
export function periodOf(frequency: string | null | undefined): number | null {
  if (!frequency) return null
  const f = frequency.toLowerCase()
  if (NAMED[f]) return NAMED[f][0] || null
  if (/^daily_/.test(f)) return 86_400_000
  const m = /^every_(\d+)_([a-z]+)$/.exec(f)
  if (m && UNITS[m[2]]) return Number(m[1]) * UNITS[m[2]][0]
  return null
}

const PARTS = new Map<string, Intl.DateTimeFormat>()
/** Weekday ("tue") and minute-of-day of an instant, in a timezone. */
export function partsIn(ms: number, tz: string): { dow: string; minutes: number } {
  let f = PARTS.get(tz)
  if (!f) {
    try {
      f = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    } catch {
      f = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    }
    PARTS.set(tz, f)
  }
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]))
  return { dow: String(p.weekday).slice(0, 3).toLowerCase(), minutes: Number(p.hour) * 60 + Number(p.minute) }
}

const hm = (s: string) => {
  const [h, m] = s.split(":").map(Number)
  return (h || 0) * 60 + (m || 0)
}

/**
 * May it ACT at this instant? The gate iris-api enforces (checkAgentSchedule): working days and
 * active hours in the schedule's own timezone. A wake outside it is skipped by design — never a
 * miss. No schedule → every wake may act. Mirrors the server's rule exactly: start inclusive,
 * end exclusive, days by name.
 */
export function mayAct(r: HeartbeatRow, ms: number): boolean {
  const sc = r.schedule
  if (!sc) return true
  const { dow, minutes } = partsIn(ms, sc.timezone)
  if (sc.days.length && !sc.days.includes(dow)) return false
  if (sc.hours && (minutes < hm(sc.hours.start) || minutes >= hm(sc.hours.end))) return false
  return true
}

/** A skip whose reason is the schedule gate — by design, not a fault. */
export const byDesign = (reason: string | null | undefined) => !!reason && /^Outside (working days|active hours)/i.test(reason)

/** The time a run happened at — what the timeline and the week place it by. */
export const runAt = (x: HeartbeatRun): number => t(x.startedAt ?? x.completedAt)

const ERROR_REPLY = /^\s*(?:Error:|AI API error)/i

/** #189114: a "completed" run whose reply is an error message. Counted as failed, labelled as such. */
export function laundered(x: HeartbeatRun): boolean {
  if (x.status === "failed" || x.status === "error" || x.error) return false
  return ERROR_REPLY.test(x.response ?? x.preview ?? "")
}

export type BeatKind = "ok" | "fail" | "run"
export function kindOf(x: HeartbeatRun): BeatKind {
  if (x.status === "running" || x.status === "pending") return "run"
  return failed(x) ? "fail" : "ok"
}

/** Why it failed, in one line — the stored error, or the error its reply turned out to be. */
export function errorOf(x: HeartbeatRun): string | null {
  if (x.error) return oneLine(x.error)
  if (laundered(x)) return oneLine((x.response ?? x.preview ?? "").replace(/^\s*Error:\s*/i, "").replace(/\s*-\s*\{[\s\S]*$/, ""))
  return null
}

/** The newest finished beat, if any — what "last beat" means on screen. */
export function lastRun(r: HeartbeatRow): HeartbeatRun | undefined {
  return r.runs.find((x) => x.status !== "running" && x.status !== "pending")
}

/**
 * When it last BEAT: the newest run row, and nothing else. `last_run_at` moves on a skip too
 * (#189113), so it says when it last woke up — shown as that, never as a beat.
 */
export function lastBeatAt(r: HeartbeatRow): string | null {
  const x = lastRun(r)
  return x?.completedAt ?? x?.startedAt ?? null
}

/**
 * Wakes that should have acted and produced nothing since its last real beat (#189113).
 *
 * Two sources, newest first:
 *  - fl-api's skip record (last_result.skipped), once it writes one: its reason decides — a skip
 *    "Outside working days/active hours" is the schedule doing its job, anything else is silence.
 *  - Otherwise the clock: last_run_at moved past the newest run. Silent only if at least one wake
 *    in that gap was INSIDE the enforced schedule — a 16:00–17:00 agent woken at 04:00 by an
 *    8-hourly job did nothing because it may not, not because it is broken (#189170).
 * Never-ran counts: a job that keeps waking with no run at all is the purest case.
 */
export function silentSince(r: HeartbeatRow): string | null {
  if (!r.runsMeasured) return null
  const beatIso = lastBeatAt(r)
  const beat = t(beatIso)
  const skip = r.lastSkip
  if (skip && Number.isFinite(t(skip.at)) && !(t(skip.at) <= beat)) {
    return byDesign(skip.reason) ? null : (beatIso ?? "never")
  }
  const woke = t(r.lastRunAt)
  if (!Number.isFinite(woke)) return null
  const period = periodOf(r.frequency) ?? 86_400_000
  const from = Number.isFinite(beat) ? beat : woke - 7 * 86_400_000
  if (woke - from <= Math.max(LATE_AFTER_MS, Number.isFinite(beat) ? period / 2 : 0)) return null
  // walk the wakes the scheduler made in (beat, woke] — anchored on the last one it made
  for (let k = woke, n = 0; k > from + LATE_AFTER_MS && n < 2000; k -= period, n++) if (mayAct(r, k)) return beatIso ?? "never"
  return null
}

/** The cadence the editors show disagrees with the one that fires (#189170). */
export function cadenceDrift(r: HeartbeatRow): string | null {
  const a = r.settingsFrequency
  if (!a || !r.frequency || a === r.frequency) return null
  // "daily_6am" is a daily cadence with a time of day; the job carries the time separately
  if (/^daily(_|$)/.test(a) && r.frequency === "daily") return null
  return a
}

/** "Tue–Thu · 07:00–16:00 ET" — the enforced hours, in words. */
export function hoursOf(r: HeartbeatRow): string | null {
  const sc = r.schedule
  if (!sc) return null
  const order = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
  const days = order.filter((d) => sc.days.includes(d))
  const label = (d: string) => d[0].toUpperCase() + d.slice(1)
  const dayTxt =
    !days.length || days.length === 7
      ? "Every day"
      : days.length === 5 && days.join() === "mon,tue,wed,thu,fri"
        ? "Weekdays"
        : days.every((d, i) => i === 0 || order.indexOf(d) === order.indexOf(days[i - 1]) + 1) && days.length > 2
          ? `${label(days[0])}–${label(days[days.length - 1])}`
          : days.map(label).join(", ")
  const tz = sc.timezone === "America/New_York" ? "ET" : sc.timezone === "UTC" ? "UTC" : sc.timezone.split("/").pop()!.replace(/_/g, " ")
  return sc.hours ? `${dayTxt} · ${sc.hours.start}–${sc.hours.end} ${tz}` : `${dayTxt} · ${tz}`
}

const failed = (x: HeartbeatRun): boolean =>
  x.status === "failed" || x.status === "error" || !!x.error || ERROR_REPLY.test(x.response ?? x.preview ?? "")

export function stateOf(r: HeartbeatRow, now: number): BeatState {
  // Only the JOB's status pauses a heartbeat. An agent switched off (`active: false`) still beats:
  // measured 2026-10-12, an inactive agent beat at 19:30 that day. Calling it paused
  // would tell you it is quiet while it keeps running and spending.
  if (r.status === "paused") return "paused"
  if (r.status === "running" || r.runs[0]?.status === "running") return "running"
  const next = t(r.nextRunAt)
  if (r.status === "scheduled" && Number.isFinite(next) && now - next > LATE_AFTER_MS) return "late"
  if (silentSince(r)) return "silent"
  const last = lastRun(r)
  if (r.status === "failed" || (last ? failed(last) : r.lastOk === false)) return "failing"
  return "ok"
}

export type Problem = { kind: "late" | "silent" | "failing" | "stopped" | "config"; text: string; fix: string }

export function problemsOf(r: HeartbeatRow, now: number): Problem[] {
  const out: Problem[] = []
  const s = stateOf(r, now)
  if (s === "late")
    out.push({
      kind: "late",
      text: `Missed its beat — due ${ago(r.nextRunAt, now)}`,
      fix: "The scheduler has not picked it up, though it still says scheduled. Run it now; if it stays late, pause and resume it to reschedule.",
    })
  const quiet = silentSince(r)
  const why = r.lastSkip && !byDesign(r.lastSkip.reason) ? r.lastSkip.reason : null
  if (s === "silent" && quiet)
    out.push({
      kind: "silent",
      text:
        (quiet === "never"
          ? `Wakes up but has never done anything — woke ${ago(r.lastSkip?.at ?? r.lastRunAt, now)}`
          : `Wakes up but does nothing — last real beat ${ago(quiet, now)}`) + (why ? ` · ${oneLine(why)}` : ""),
      fix: why
        ? r.lastSkip?.kind === "circuit_breaker"
          ? "It was paused after repeated failures. Fix the cause in its last failed beat, then Run now to resume."
          : "That is the reason the platform gave for its last skipped wake."
        : "Its schedule moves on, but no run is recorded during its working hours: the beats are being skipped (gated, or no projects to watch). Run now shows the reason; the platform records it once #189113 lands.",
    })
  const drift = cadenceDrift(r)
  if (drift)
    out.push({
      kind: "config",
      text: `Its settings say ${cadenceOf(drift).toLowerCase()}; it actually wakes ${cadenceOf(r.frequency).toLowerCase()}`,
      fix: "The heartbeat editor shows one cadence and the scheduler fires on another (#189170). Save the schedule again in the editor so both agree.",
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
      text: `Last beat failed${errorOf(last) ? `: ${errorOf(last)}` : ""}`,
      fix:
        (laundered(last) ? "It was recorded as a success — the model call failed and its error became the reply (#189114). " : "") +
        (fails > 1 ? `${fails} of the last ${r.runs.length} beats failed.` : "The beat before it worked."),
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
  if (s === "silent") {
    const why = r.lastSkip && !byDesign(r.lastSkip.reason) && r.lastSkip.reason ? ` · ${oneLine(r.lastSkip.reason).slice(0, 60)}` : ""
    return `Wakes but does nothing · ${last ? `last real beat ${ago(last, now)}` : "never ran"}${why}`
  }
  if (s === "failing") return `Last beat failed · next ${untilOf(r.nextRunAt, now)}`
  return `Next ${untilOf(r.nextRunAt, now)} · ${lastTxt}`
}

const RANK: Record<BeatState, number> = { late: 0, silent: 1, failing: 2, running: 3, ok: 4, paused: 5 }

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
    attention: states.filter((s) => s === "late" || s === "silent" || s === "failing").length,
    paused: states.filter((s) => s === "paused").length,
  }
}

/** The strip: oldest → newest, one tick per beat, so the eye reads it left to right like a trace. */
export function stripOf(r: HeartbeatRow, n = 12): BeatKind[] {
  return r.runs.slice(0, n).reverse().map(kindOf)
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

// ── the week (#189127) ─────────────────────────────────────────────────────────────────────────

const DAY = 86_400_000
const DOW = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]
const DOW_LABEL: Record<string, string> = { sun: "Sun", mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat" }

export type WeekView = {
  start: number
  end: number
  days: { at: number; label: string; on: boolean }[]
  /** When the schedule says it should have woken, inside the window. */
  expected: number[]
  beats: { at: number; kind: BeatKind; id: number }[]
  /** Expected wakes with no beat near them — skips the records do not show. */
  missed: number[]
  /** Due wakes before its newest kept run — not kept by the platform (#189132), so not judged. */
  unknown: number
  /** Wakes the scheduler made outside the enforced hours — skipped by design, not counted. */
  outside: number
  next: number | null
  period: number | null
}

/**
 * The last seven days, ending now: every wake the schedule called for, every beat that actually
 * happened, and the gap between them. Expected wakes are walked back from `next_run_at` by the
 * cadence — the scheduler's own anchor — and dropped on days the agent does not work.
 */
export function weekOf(r: HeartbeatRow, now: number): WeekView {
  const end = now
  const start = now - 7 * DAY
  const startOfDay = (ms: number) => {
    const d = new Date(ms)
    d.setHours(0, 0, 0, 0)
    return d.getTime()
  }
  // the ENFORCED gate decides which wakes count as due (#189170), not the editors' working days
  const works = (ms: number) => mayAct(r, ms)
  const worksDay = (ms: number) => !r.schedule?.days.length || r.schedule.days.includes(partsIn(ms + 12 * 3_600_000, r.schedule.timezone).dow)
  const days: WeekView["days"] = []
  for (let d = startOfDay(start + DAY); d <= end; d += DAY) days.push({ at: d, label: DOW_LABEL[DOW[new Date(d).getDay()]], on: worksDay(d) })
  const period = periodOf(r.frequency)
  const next = t(r.nextRunAt)
  const expected: number[] = []
  let outside = 0
  if (period && Number.isFinite(next) && r.status !== "paused") {
    let k = next
    while (k > end) k -= period
    for (; k > start && expected.length < 400; k -= period) {
      if (works(k)) expected.unshift(k)
      else outside++
    }
    // LATE: the scheduler stopped at next_run_at, so every wake it owed since is due and missing.
    for (let f = next + period; f <= end && expected.length < 400; f += period) {
      if (works(f)) expected.push(f)
      else outside++
    }
  }
  const beats = r.runs
    .map((x) => ({ at: runAt(x), kind: kindOf(x), id: x.id }))
    .filter((b) => Number.isFinite(b.at) && b.at >= start && b.at <= end)
    .reverse()
  // A SKIP can only be claimed where the records could show one: after its newest kept run and
  // up to when it last woke (#189113). Before that the history is overwritten every beat
  // (#189132) — an earlier wake with no row may well have run — so it stays a plain "due" tick.
  const newest = Number.isFinite(t(lastBeatAt(r))) ? t(lastBeatAt(r)) : -Infinity
  const woke = t(r.lastRunAt)
  const near = (period ?? DAY) / 2
  const late = Number.isFinite(next) && r.status === "scheduled" && now - next > LATE_AFTER_MS
  const upTo = Math.max(Number.isFinite(woke) ? woke + LATE_AFTER_MS : -Infinity, late ? now - LATE_AFTER_MS : -Infinity)
  const missed = expected.filter((e) => e > newest + near && e <= upTo && !beats.some((b) => Math.abs(b.at - e) <= near))
  const unknown = expected.filter((e) => e < newest - near && !beats.some((b) => Math.abs(b.at - e) <= near)).length
  return { start, end, days, expected, beats, missed, unknown, outside, next: Number.isFinite(next) ? next : null, period }
}

/** What this agent got done this week, in one line's worth of numbers. */
export function rollupOf(r: HeartbeatRow, now: number) {
  const w = weekOf(r, now)
  const runs = r.runs.filter((x) => Number.isFinite(runAt(x)) && runAt(x) >= w.start)
  const tools = new Map<string, number>()
  for (const x of runs) for (const tool of toolsOf(x.response)) tools.set(tool.name, (tools.get(tool.name) ?? 0) + 1)
  return {
    expected: w.expected.length,
    beats: runs.filter((x) => kindOf(x) === "ok").length,
    failed: runs.filter((x) => kindOf(x) === "fail").length,
    missed: w.missed.length,
    unknown: w.unknown,
    outside: w.outside,
    outputs: runs.filter((x) => x.itemId || x.deliverableId || x.publicUrl).length,
    tokens: runs.reduce((n, x) => n + (x.tokens ?? 0), 0),
    tools: [...tools.entries()].sort((a, b) => b[1] - a[1]),
  }
}

// ── one beat, opened (#189127) ─────────────────────────────────────────────────────────────────

export type ReportSection = { title: string; body: string }

/**
 * A beat's report, split on its own bold headings — "**Status** — …", "**What Changed** — …".
 * The agent writes them; nothing here invents a section. The `TASKS: []` / `NEXT_STEPS: []`
 * trailer is plumbing, not prose, and is dropped.
 */
export function sectionsOf(report: string | null | undefined): ReportSection[] {
  if (!report || ERROR_REPLY.test(report)) return []
  const text = report.replace(/^\s*(?:TASKS|NEXT_STEPS):\s*\[[^\]]*\]\s*$/gm, "").trim()
  const re = /^\*\*([^*\n]{2,40})\*\*\s*(?:[—:–-]\s*)?/gm
  const heads = [...text.matchAll(re)]
  if (!heads.length) return text ? [{ title: "Report", body: text }] : []
  const out: ReportSection[] = []
  const lead = text.slice(0, heads[0].index).trim()
  if (lead) out.push({ title: "Report", body: lead })
  heads.forEach((h, i) => {
    const from = h.index! + h[0].length
    const to = i + 1 < heads.length ? heads[i + 1].index! : text.length
    const title = h[1].replace(/[:\s—–-]+$/, "").trim()
    const body = text.slice(from, to).trim()
    if (title === "Workflow Complete" && !body) return
    out.push({ title, body })
  })
  return out.filter((x) => x.body || x.title !== "Report")
}

/** "- ✓ **agent_memory**: 10 memories retrieved" → { name, did }. */
export function toolsOf(report: string | null | undefined): { name: string; did: string; ok: boolean }[] {
  if (!report) return []
  const out: { name: string; did: string; ok: boolean }[] = []
  for (const m of report.matchAll(/^\s*[-•]\s*([✓✗])\s*\*\*([^*]+)\*\*\s*:?\s*(.*)$/gm))
    out.push({ ok: m[1] === "✓", name: m[2].trim(), did: m[3].trim() })
  return out
}

/** The four questions a person asks of a beat, answered from its sections where the agent wrote them. */
export function beatStory(x: HeartbeatRun) {
  const secs = sectionsOf(x.response)
  const pick = (...names: string[]) => secs.find((s) => names.some((n) => s.title.toLowerCase() === n.toLowerCase()))
  const used = new Set<ReportSection>()
  const take = (...names: string[]) => {
    const s = pick(...names)
    if (s) used.add(s)
    return s?.body ?? null
  }
  const happened = take("Status", "Summary", "Report")
  const changed = take("What Changed", "Changes", "What changed since last")
  const did = take("Actions", "What I did", "Actions Taken")
  const numbers = take("Key Numbers", "Numbers", "Metrics")
  take("Tools Used")
  const rest = secs.filter((s) => !used.has(s) && s.title !== "Workflow Complete")
  return { happened, changed, did, numbers, tools: toolsOf(x.response), rest, error: errorOf(x), laundered: laundered(x) }
}
