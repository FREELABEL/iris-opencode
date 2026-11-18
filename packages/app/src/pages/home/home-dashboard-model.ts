import { lastBeatAt, periodOf, restOf, sortBeats, stateOf, stripOf, type BeatKind, type BeatState, type HeartbeatRow } from "@/components/session/iris-heartbeats-model"

/**
 * Home (#192222): the operator view — your agents' heartbeats first, then machines and inbox.
 *
 * Health comes from the Heartbeats panel's own `stateOf`, so Home and Agents › Heartbeats can never
 * disagree about the same agent. That model already knows working hours, recorded skips and the
 * history cut-over; a second copy here would drift.
 */

/** `idle` (#192647): an agent with no heartbeat — it runs when someone asks it to, not on a schedule. */
export type Indicator = "ok" | "running" | "resting" | "stopped" | "late" | "failing" | "paused" | "idle"
export const indicatorOf = (s: BeatState): Indicator => (s === "silent" ? "stopped" : s)
/** The indicator for a row, resting included: skipping by choice, and the platform will run it again soon. */
export const indicatorFor = (r: HeartbeatRow, now: number): Indicator => (restOf(r, now) ? "resting" : indicatorOf(stateOf(r, now)))

export type Tab = "attention" | "active" | "all"
export const TABS: Tab[] = ["attention", "active", "all"]
export const PER_PAGE = 6

const needs = (r: HeartbeatRow, now: number) => {
  const s = stateOf(r, now)
  return (s === "silent" || s === "late" || s === "failing") && !restOf(r, now)
}

export type AgentRow = {
  jobId: number
  agentId: number
  name: string
  indicator: Indicator
  why: string
  every: string
  strip: BeatKind[]
  last: string
  lastAt: string | null
  model: string | null
  runCount: number
}

/** "1h", "8h", "1d" — the cadence in as few characters as the eye needs. */
export function shortEvery(frequency: string | null | undefined): string {
  const p = periodOf(frequency)
  if (!p) return "—"
  if (p % 604_800_000 === 0) return `${p / 604_800_000}w`
  if (p % 86_400_000 === 0) return `${p / 86_400_000}d`
  if (p % 3_600_000 === 0) return `${p / 3_600_000}h`
  return `${Math.round(p / 60_000)}m`
}

export function shortAgo(iso: string | null | undefined, now: number): string {
  if (!iso) return "—"
  const ms = now - Date.parse(iso)
  if (!Number.isFinite(ms)) return "—"
  if (ms < 3_600_000) return `${Math.max(1, Math.round(ms / 60_000))}m`
  if (ms < 48 * 3_600_000) return `${Math.round(ms / 3_600_000)}h`
  return `${Math.floor(ms / 86_400_000)}d`
}

const WHY: Record<Indicator, string> = {
  ok: "Healthy",
  running: "Running now",
  resting: "Resting by choice",
  stopped: "Not running",
  late: "Late — past its time and has not fired",
  failing: "Last run failed",
  paused: "Paused",
  idle: "No schedule — it runs when someone asks it to",
}

export function rowOf(r: HeartbeatRow, now: number): AgentRow {
  const indicator = indicatorFor(r, now)
  const rest = restOf(r, now)
  const skip =
    indicator === "resting" && rest
      ? ` — skipped ${rest.skipped} in a row; runs again within ${rest.left} beat${rest.left === 1 ? "" : "s"}`
      : indicator === "stopped" && r.lastSkip?.reason
        ? ` — skipped: ${r.lastSkip.reason}`
        : ""
  const at = lastBeatAt(r)
  return {
    jobId: r.jobId,
    agentId: r.agentId,
    name: r.agentName,
    indicator,
    why: WHY[indicator] + skip,
    every: shortEvery(r.frequency),
    strip: stripOf(r, 12),
    last: shortAgo(at, now),
    lastAt: at,
    model: r.runs[0]?.model ?? null,
    runCount: r.runCount,
  }
}

export function tabRows(rows: readonly HeartbeatRow[], tab: Tab, now: number): HeartbeatRow[] {
  if (tab === "attention") return sortBeats(rows, now).filter((r) => needs(r, now))
  if (tab === "active") return rows.filter((r) => stateOf(r, now) !== "paused").sort((a, b) => b.runCount - a.runCount)
  return sortBeats(rows, now)
}

export function tabCount(rows: readonly HeartbeatRow[], tab: Tab, now: number): number {
  return tabRows(rows, tab, now).length
}

/** An agent as /iris/agents-mine returns it. */
export type AgentLite = { id: number; name: string }

/** A row for an agent that has no heartbeat (#192647). */
export function unscheduledRow(a: AgentLite): AgentRow {
  return {
    jobId: 0,
    agentId: a.id,
    name: a.name,
    indicator: "idle",
    why: WHY.idle,
    every: "—",
    strip: [],
    last: "—",
    lastAt: null,
    model: null,
    runCount: 0,
  }
}

/**
 * The Agents list (#192647). It used to be built from heartbeats alone, so an account with 56
 * agents and no schedules saw the card say 56 and the list say nothing. "All" now lists every
 * agent — scheduled ones first, with their state, then the rest as "No schedule". The other tabs
 * are about schedules and stay heartbeat-only.
 */
export function listRows(beats: readonly HeartbeatRow[], agents: readonly AgentLite[], tab: Tab, now: number): AgentRow[] {
  const scheduled = tabRows(beats, tab, now).map((r) => rowOf(r, now))
  if (tab !== "all") return scheduled
  const hasBeat = new Set(beats.map((b) => b.agentId))
  const rest = agents
    .filter((a) => !hasBeat.has(a.id))
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(unscheduledRow)
  return [...scheduled, ...rest]
}

/** What an empty list should say — the truth for that tab, not one sentence for every case. */
export function emptyText(tab: Tab, scheduled: number, agents: number): string {
  if (agents === 0 && scheduled === 0) return "No agents yet — create one and it shows here."
  if (scheduled === 0)
    return tab === "all"
      ? "No agents yet — create one and it shows here."
      : `None of your ${agents} agent${agents === 1 ? "" : "s"} runs on a schedule yet — give one a heartbeat to see it here.`
  if (tab === "attention") return "Nothing needs attention — every scheduled agent is beating."
  if (tab === "active") return "No scheduled agent has run yet."
  return "No agents yet."
}

export type Page<T> = { items: T[]; page: number; pages: number; from: number; to: number; total: number }
export function pageOf<T>(all: readonly T[], page: number, per = PER_PAGE): Page<T> {
  const pages = Math.max(1, Math.ceil(all.length / per))
  const p = Math.min(Math.max(1, page), pages)
  const start = (p - 1) * per
  const items = all.slice(start, start + per)
  return { items, page: p, pages, from: all.length ? start + 1 : 0, to: start + items.length, total: all.length }
}

export type Overview = {
  scheduled: number
  healthy: number
  resting: number
  stopped: number
  failing: number
  paused: number
  runsToday: number
  tokensToday: number
}

/** "Today" is the viewer's local day, since that is the day they mean. */
export function overviewOf(rows: readonly HeartbeatRow[], now: number, dayStart: number): Overview {
  const s = rows.map((r) => indicatorFor(r, now))
  const today = rows.flatMap((r) => r.runs).filter((x) => Date.parse(x.startedAt ?? x.completedAt ?? "") >= dayStart)
  return {
    scheduled: s.filter((x) => x !== "paused").length,
    healthy: s.filter((x) => x === "ok" || x === "running").length,
    resting: s.filter((x) => x === "resting").length,
    stopped: s.filter((x) => x === "stopped" || x === "late").length,
    failing: s.filter((x) => x === "failing").length,
    paused: s.filter((x) => x === "paused").length,
    runsToday: today.length,
    tokensToday: today.reduce((n, x) => n + (x.tokens ?? 0), 0),
  }
}

export function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return String(n)
}

export function greetingOf(hour: number): string {
  return hour < 5 ? "Good evening" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening"
}
