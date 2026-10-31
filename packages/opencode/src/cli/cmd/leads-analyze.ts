/**
 * `iris leads analyze` — what the report shows, as data, so the table and --json cannot drift.
 *
 * #191701 — --json printed `quota: {}` and `messages: []` (hard-coded) while the table showed
 * both. #191706 — "Recent Messages Sent" was the last N ever, under a period-scoped header,
 * beside a period-scoped "DMs Sent: 0". Both are fixed by building one report and rendering it.
 */

export type AnalyzePeriod = { start_date?: string; end_date?: string }

export type SentMessage = {
  date: string
  channel: string
  lead_id: number | string | null
  lead_name: string
  text: string
}

/** YYYY-MM-DD of an ISO-ish timestamp, or "" if it has none. */
function dayOf(ts: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(ts ?? "")
  return m ? m[1] : ""
}

/**
 * The server's own window (metrics.period, inclusive dates). A message with no date, or one
 * outside the window, is not "sent in this period". No window from the server → no filter,
 * and the caller labels the list as unscoped rather than pretending.
 */
export function inPeriod(ts: string, period: AnalyzePeriod | undefined): boolean {
  if (!period?.start_date || !period?.end_date) return true
  const d = dayOf(ts)
  return !!d && d >= period.start_date && d <= period.end_date
}

/** Period-scoped, newest first, capped. */
export function messagesInPeriod(msgs: SentMessage[], period: AnalyzePeriod | undefined, limit: number): SentMessage[] {
  return msgs
    .filter((m) => inPeriod(m.date, period))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
    .slice(0, limit)
}

export function messagesHeader(period: AnalyzePeriod | undefined, limit: number): string {
  return period?.start_date && period?.end_date
    ? `Messages Sent ${period.start_date} → ${period.end_date} (latest ${limit}):`
    : `Recent Messages Sent — all time, no period from the server (latest ${limit}):`
}

/** The --json payload: every section the table renders, from the same values. */
export function analyzeJson(r: {
  boardId: number
  periodName: string
  metrics: Record<string, any>
  quota: { quotas?: any; progress?: any; percent?: any } | null
  messages: SentMessage[] | null
}) {
  return {
    board_id: r.boardId,
    period: { name: r.periodName, ...(r.metrics.period ?? {}) },
    metrics: r.metrics.summary ?? {},
    quota: r.quota ? { quotas: r.quota.quotas ?? {}, progress: r.quota.progress ?? {}, percent: r.quota.percent ?? {} } : {},
    messages: r.messages ?? [],
    by_type: r.metrics.by_type ?? {},
  }
}
