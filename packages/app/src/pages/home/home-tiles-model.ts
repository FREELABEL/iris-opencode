import type { HeartbeatRow } from "@/components/session/iris-heartbeats-model"

/**
 * Home's tiles: the change since yesterday, counted only from what Home already reads.
 *
 * Every list Home reads is one capped page. A count of "yesterday" from a page that stops before
 * yesterday began is a guess, so it is null instead — the tile then shows no change at all rather
 * than a number that looks measured and is not.
 */

/** Local midnight of the day before `dayStart` (a local midnight). setDate keeps it right across DST. */
export function yesterdayOf(dayStart: number): number {
  const d = new Date(dayStart)
  d.setDate(d.getDate() - 1)
  return d.getTime()
}

export type DayChange = { today: number; yesterday: number }

/**
 * How many of `times` fall today, and yesterday. `capped`: the list is a full page, so it may stop
 * short — then it counts only if its oldest entry is from before yesterday.
 */
export function changeOf(
  times: readonly (string | null | undefined)[],
  dayStart: number,
  opts: { capped: boolean },
): DayChange | null {
  const y = yesterdayOf(dayStart)
  const ms = times.map((t) => (t ? Date.parse(t) : NaN)).filter((n) => Number.isFinite(n))
  if (opts.capped && !(ms.length && Math.min(...ms) < y)) return null
  return {
    today: ms.filter((t) => t >= dayStart).length,
    yesterday: ms.filter((t) => t >= y && t < dayStart).length,
  }
}

/** The engine reads at most this many runs per heartbeat (heartbeats.ts RUNS_PER_ROW). */
export const RUNS_PER_ROW = 50

/** Heartbeat runs today and yesterday, across every heartbeat — null if any row cannot say. */
export function runChangeOf(rows: readonly HeartbeatRow[], dayStart: number, cap = RUNS_PER_ROW): DayChange | null {
  if (!rows.length) return null
  let today = 0
  let yesterday = 0
  for (const r of rows) {
    if (!r.runsMeasured) return null
    const c = changeOf(
      r.runs.map((x) => x.startedAt ?? x.completedAt),
      dayStart,
      { capped: r.runs.length >= cap },
    )
    if (!c) return null
    today += c.today
    yesterday += c.yesterday
  }
  return { today, yesterday }
}
