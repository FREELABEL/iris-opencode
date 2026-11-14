import { cadenceDrift, lineOf, nextFireAt, problemsOf, silentSince, stateOf, weekOf, type HeartbeatRow } from "../src/heartbeats"

export const OFFSETS_H = [0, 6, 30] as const

/** What the model says about every row at capturedAt, +6h and +30h. */
export function goldenOf(snap: { capturedAt: string; heartbeats: HeartbeatRow[] }) {
  const base = Date.parse(snap.capturedAt)
  return {
    capturedAt: snap.capturedAt,
    at: OFFSETS_H.map((h) => {
      const now = base + h * 3_600_000
      return {
        offsetHours: h,
        now: new Date(now).toISOString(),
        rows: snap.heartbeats.map((r) => {
          const w = weekOf(r, now)
          return {
            jobId: r.jobId,
            state: stateOf(r, now),
            silentSince: silentSince(r, now),
            problems: problemsOf(r, now).map((p) => p.kind),
            drift: cadenceDrift(r),
            nextFireAt: nextFireAt(r),
            line: lineOf(r, now),
            week: {
              expected: w.expected.length,
              beats: w.beats.length,
              missed: w.missed.length,
              unknown: w.unknown,
              outside: w.outside,
              skips: w.skips.length,
            },
          }
        }),
      }
    }),
  }
}
