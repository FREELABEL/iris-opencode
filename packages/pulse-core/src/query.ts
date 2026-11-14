/**
 * HeartbeatQuery (#189245) — "which of my agents are late, silent or failing, and since when?"
 *
 * It answers with the panel's own rules: every state here is `stateOf`, every line `lineOf`,
 * every problem `problemsOf`. Nothing is re-derived, so a script, the CLI and the Heartbeats
 * panel cannot disagree about an agent. Pure — callers fetch the rows (see `read.ts`).
 *
 * Two refusals, both so that a query that cannot be answered does not answer "nothing":
 *  - a state name that does not exist ("held", "skipping") throws, listing the real ones;
 *  - a `since` that cannot be read throws, instead of quietly matching everything.
 */
import {
  firesAt,
  kindOf,
  LATE_AFTER_MS,
  lineOf,
  problemsOf,
  runAt,
  silentSince,
  sortBeats,
  stateOf,
  type BeatState,
  type HeartbeatRow,
  type Problem,
} from "./heartbeats"

export const BEAT_STATES: readonly BeatState[] = ["late", "silent", "failing", "running", "ok", "paused"]

export type HeartbeatQuery = {
  /** Keep only these states. Omitted = every state. */
  states?: readonly BeatState[]
  /**
   * Keep only rows whose current state BEGAN at or after this instant: a duration back from now
   * ("30m", "24h", "7d", "2w"), an ISO time, or epoch ms. A row whose start cannot be dated (never
   * beat, paused) is kept — excluding it would be a guess.
   */
  since?: string | number
  /** Agent ids, or case-insensitive pieces of agent names. Omitted = every agent. */
  agents?: readonly (number | string)[]
  /** The clock. Defaults to Date.now(); pass it to make a query reproducible. */
  now?: number
}

export type HeartbeatMatch = {
  row: HeartbeatRow
  state: BeatState
  /** When the current state began, or null when the record cannot say. */
  since: string | null
  line: string
  problems: Problem[]
}

export type HeartbeatQueryResult = {
  now: string
  /** Every row read, by state — not just the matches, so "0 late" is a measurement. */
  counts: Record<BeatState, number>
  matches: HeartbeatMatch[]
}

const UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }

export function parseSince(v: string | number, now: number): number {
  if (typeof v === "number" && Number.isFinite(v)) return v
  const s = String(v).trim()
  const m = /^(\d+)\s*([mhdw])$/i.exec(s)
  if (m) return now - Number(m[1]) * UNIT_MS[m[2].toLowerCase()]
  const at = /^\d{4}-\d{2}-\d{2}/.test(s) ? Date.parse(s) : NaN
  if (Number.isFinite(at)) return at
  throw new Error(`since: cannot read "${s}" — use a duration (30m, 24h, 7d, 2w) or an ISO time`)
}

const iso = (ms: number): string | null => (Number.isFinite(ms) ? new Date(ms).toISOString() : null)

/** The earliest run of the newest unbroken streak of `kind` — when "ok" or "failing" began. */
function streakStart(r: HeartbeatRow, kind: "ok" | "fail"): string | null {
  let first: HeartbeatRow["runs"][number] | null = null
  for (const x of r.runs) {
    const k = kindOf(x)
    if (k === "run") continue
    if (k !== kind) break
    first = x
  }
  return first ? (first.startedAt ?? first.completedAt) : null
}

/** When the current state began, best evidence only. Null means the record does not say. */
export function stateSince(r: HeartbeatRow, now: number): string | null {
  switch (stateOf(r, now)) {
    case "paused":
      return null
    case "running": {
      const x = r.runs.find((x) => kindOf(x) === "run")
      return x ? iso(runAt(x)) : null
    }
    case "late": {
      const due = firesAt(r, Date.parse(r.nextRunAt ?? ""))
      return iso(due + LATE_AFTER_MS)
    }
    case "silent": {
      const s = silentSince(r, now)
      return s && s !== "never" ? s : null
    }
    case "failing":
      return streakStart(r, "fail")
    case "ok":
      return streakStart(r, "ok")
  }
}

export function queryHeartbeats(rows: readonly HeartbeatRow[], q: HeartbeatQuery = {}): HeartbeatQueryResult {
  const now = q.now ?? Date.now()
  for (const s of q.states ?? []) {
    if (!BEAT_STATES.includes(s)) throw new Error(`state "${s}" does not exist — states are ${BEAT_STATES.join(", ")}`)
  }
  const from = q.since === undefined ? null : parseSince(q.since, now)
  const wanted = q.states?.length ? new Set(q.states) : null
  const agents = q.agents?.length ? q.agents : null
  const isAgent = (r: HeartbeatRow) =>
    !agents ||
    agents.some((a) => (typeof a === "number" || /^\d+$/.test(a) ? r.agentId === Number(a) : r.agentName.toLowerCase().includes(a.toLowerCase())))

  const counts = Object.fromEntries(BEAT_STATES.map((s) => [s, 0])) as Record<BeatState, number>
  const matches: HeartbeatMatch[] = []
  for (const row of sortBeats(rows, now)) {
    const state = stateOf(row, now)
    counts[state]++
    if (wanted && !wanted.has(state)) continue
    if (!isAgent(row)) continue
    const since = stateSince(row, now)
    if (from !== null && since !== null && Date.parse(since) < from) continue
    matches.push({ row, state, since, line: lineOf(row, now), problems: problemsOf(row, now) })
  }
  return { now: new Date(now).toISOString(), counts, matches }
}
