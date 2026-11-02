import { lastBeatAt, periodOf, sortBeats, stateOf, stripOf, type BeatKind, type BeatState, type HeartbeatRow } from "@/components/session/iris-heartbeats-model"

/**
 * Home (#192222): the operator view — your agents' heartbeats first, then machines and inbox.
 *
 * Health comes from the Heartbeats panel's own `stateOf`, so Home and Agents › Heartbeats can never
 * disagree about the same agent. That model already knows working hours, recorded skips and the
 * history cut-over; a second copy here would drift.
 */

export type Indicator = "ok" | "running" | "stopped" | "late" | "failing" | "paused"
export const indicatorOf = (s: BeatState): Indicator => (s === "silent" ? "stopped" : s)

export type Tab = "attention" | "active" | "all"
export const TABS: Tab[] = ["attention", "active", "all"]
export const PER_PAGE = 6

const needs = (s: BeatState) => s === "silent" || s === "late" || s === "failing"

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
  stopped: "Not running",
  late: "Late — past its time and has not fired",
  failing: "Last run failed",
  paused: "Paused",
}

export function rowOf(r: HeartbeatRow, now: number): AgentRow {
  const indicator = indicatorOf(stateOf(r, now))
  const skip = indicator === "stopped" && r.lastSkip?.reason ? ` — skipped: ${r.lastSkip.reason}` : ""
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
  if (tab === "attention") return sortBeats(rows, now).filter((r) => needs(stateOf(r, now)))
  if (tab === "active") return rows.filter((r) => stateOf(r, now) !== "paused").sort((a, b) => b.runCount - a.runCount)
  return sortBeats(rows, now)
}

export function tabCount(rows: readonly HeartbeatRow[], tab: Tab, now: number): number {
  return tabRows(rows, tab, now).length
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
  stopped: number
  failing: number
  paused: number
  runsToday: number
  tokensToday: number
}

/** "Today" is the viewer's local day, since that is the day they mean. */
export function overviewOf(rows: readonly HeartbeatRow[], now: number, dayStart: number): Overview {
  const s = rows.map((r) => indicatorOf(stateOf(r, now)))
  const today = rows.flatMap((r) => r.runs).filter((x) => Date.parse(x.startedAt ?? x.completedAt ?? "") >= dayStart)
  return {
    scheduled: s.filter((x) => x !== "paused").length,
    healthy: s.filter((x) => x === "ok" || x === "running").length,
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
