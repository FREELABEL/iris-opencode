import { kindOf, nextFireAt, type HeartbeatRow } from "./iris-heartbeats-model"
import type { GalleryAgent } from "./iris-agent-gallery-model"

/**
 * What an agent card says it did (#194505): its last run and how that went, its runs this week,
 * and when it beats next — from the two reads the Agents panel already makes (/iris/agents and
 * /iris/heartbeats). "Never used" only when neither has anything.
 *
 * A heartbeat's RUN rows are what it did. The job's last_run_at (`lastRun` on the agent) also moves
 * when a beat is skipped (#189113), so it is used only for an agent with no heartbeat row to read.
 */
export type AgentActivity = {
  /** When it last did something: a run, else the last time someone used it. */
  lastAt?: string
  /** Is lastAt a run (a beat), or only a use (a chat)? */
  lastKind?: "run" | "used"
  /** How its newest run went, when lastAt is a run whose rows were read. */
  result?: "ok" | "fail" | "run"
  /** Runs started in the last 7 days; null when the runs read may not reach back that far. */
  week: number | null
  /** Its next heartbeat, when it has one scheduled and is not paused. */
  nextAt: string | null
}

export const WEEK_MS = 7 * 86_400_000
/** The engine reads at most this many runs per heartbeat (heartbeats.ts RUNS_PER_ROW). */
const RUNS_READ = 50

const ms = (iso: string | null | undefined) => (iso ? Date.parse(iso) : NaN)

export function activityOf(
  agent: Pick<GalleryAgent, "lastUsedAt" | "active"> & { lastRun?: string },
  beat: HeartbeatRow | undefined,
  now: number,
): AgentActivity {
  const runs = beat?.runsMeasured ? beat.runs : []
  const newest = runs[0]
  const runAt = newest ? (newest.startedAt ?? newest.completedAt ?? undefined) : beat ? undefined : agent.lastRun
  const used = agent.lastUsedAt
  const runFirst = Number.isFinite(ms(runAt)) && !(ms(used) > ms(runAt))
  const lastAt = runFirst ? runAt : Number.isFinite(ms(used)) ? used : undefined
  const lastKind = !lastAt ? undefined : runFirst ? "run" : "used"

  let week: number | null = null
  if (beat?.runsMeasured) {
    const since = now - WEEK_MS
    const times = runs.map((x) => ms(x.startedAt ?? x.completedAt)).filter((n) => Number.isFinite(n))
    const reaches = runs.length < RUNS_READ || (times.length > 0 && Math.min(...times) < since)
    week = reaches ? times.filter((t) => t >= since).length : null
  }

  const paused = agent.active === false || beat?.agentActive === false || (beat ? /paus/i.test(beat.status) : false)
  const next = beat && !paused ? nextFireAt(beat) : null
  return {
    lastAt,
    lastKind,
    result: lastKind === "run" && newest ? kindOf(newest) : undefined,
    week,
    nextAt: next && ms(next) > now - 60_000 ? next : null,
  }
}

/** Heartbeat rows by agent id. An agent with two jobs keeps the one that ran most recently. */
export function beatsByAgent(rows: readonly HeartbeatRow[]): Map<number, HeartbeatRow> {
  const out = new Map<number, HeartbeatRow>()
  for (const r of rows) {
    const had = out.get(r.agentId)
    const at = (x?: HeartbeatRow) => ms(x?.runs[0]?.startedAt ?? x?.lastRunAt) || 0
    if (!had || at(r) > at(had)) out.set(r.agentId, r)
  }
  return out
}

/** "3h ago" / "in 2h" — short, for a card's footer. */
export function relative(iso: string, now: number): string {
  const d = ms(iso) - now
  const s = Math.abs(d) / 1000
  const n =
    s < 60 ? "" : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`
  if (!n) return d > 0 ? "in a moment" : "just now"
  return d > 0 ? `in ${n}` : `${n} ago`
}
