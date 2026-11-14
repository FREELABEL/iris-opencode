/**
 * Input guards for `iris imessage` (#193251, #193253, #193254).
 *
 * Every number and date here ends up interpolated into SQL against chat.db. Before these guards:
 *   - `--since garbage` became NaN, the query died inside sqlite3, and the command printed
 *     "No messages" and exited 0 — a failed query that looked exactly like an empty inbox.
 *   - `--last -1` / `--limit -1` became `LIMIT -1`, which SQLite reads as "no limit".
 *   - `--days -1` was echoed back as "in the last -1 days".
 *   - `--since` was honoured but the message still said "in the last 30 days".
 *
 * So: reject bad input before it reaches SQL, and describe the window the query actually used.
 * Pure functions, no I/O — testable without a Messages database.
 */

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string }

export interface Window {
  cutoffSeconds: number
  /** Human phrase for the window actually queried, e.g. "since 2026-10-01" or "in the last 30 days". */
  label: string
}

/** A whole number ≥ 1. yargs hands us NaN for `--limit abc`, so NaN must fail here too. */
export function positiveInt(name: string, value: unknown): Checked<number> {
  const n = typeof value === "number" ? value : Number(value)
  if (!Number.isInteger(n) || n < 1) {
    return { ok: false, error: `--${name} must be a whole number of 1 or more (got ${String(value)})` }
  }
  return { ok: true, value: n }
}

/**
 * Resolve --since / --days into a cutoff. --since wins when given (#58884).
 * --since must be a real calendar date in YYYY-MM-DD, not in the future; it is read as local
 * midnight, which is what a person typing a date means.
 */
export function resolveWindow(opts: { since?: unknown; days?: unknown }, now = Date.now()): Checked<Window> {
  if (opts.since !== undefined && opts.since !== null) {
    const raw = String(opts.since).trim()
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw)
    const bad = { ok: false as const, error: `--since must be a date in YYYY-MM-DD form (got "${raw}")` }
    if (!m) return bad
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
    const at = new Date(y, mo - 1, d)
    // Round-trip check: rejects 2026-02-30, 2026-13-01 etc., which Date would silently roll over.
    if (at.getFullYear() !== y || at.getMonth() !== mo - 1 || at.getDate() !== d) return bad
    if (at.getTime() > now) return { ok: false, error: `--since ${raw} is in the future` }
    return { ok: true, value: { cutoffSeconds: Math.floor((now - at.getTime()) / 1000), label: `since ${raw}` } }
  }
  const days = positiveInt("days", opts.days)
  if (!days.ok) return days
  return {
    ok: true,
    value: {
      cutoffSeconds: days.value * 86400,
      label: `in the last ${days.value} day${days.value === 1 ? "" : "s"}`,
    },
  }
}
