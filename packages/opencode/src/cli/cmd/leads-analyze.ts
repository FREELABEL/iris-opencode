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

/**
 * #191709 — "DMs Sent" and the messages listed must come from the same rows. The server's
 * summary.total_completed counts completed outreach STEPS, which record-dm never writes, so the
 * report said "DMs Sent: 0" above 8 listed DMs. fl-api now returns `dms` (count + newest
 * messages) from ONE query; this reads it. null = a server without it — the caller must then
 * not call the step count "DMs Sent".
 */
export type DmLedger = { sent: number; previous_period: number | null; avg_per_day: number | null; messages: SentMessage[] }

const DM_CHANNEL: Record<string, string> = { instagram_dm: "IG", linkedin_dm: "LI", linkedin_message: "LI", whatsapp_message: "WA", twitter_dm: "X" }

export function dmLedger(metrics: Record<string, any> | null | undefined, limit: number): DmLedger | null {
  const d = metrics?.dms
  if (!d || typeof d.sent !== "number" || !Array.isArray(d.messages)) return null
  const messages: SentMessage[] = d.messages.slice(0, Math.max(0, limit)).map((m: any) => ({
    date: String(m.sent_at ?? ""),
    channel: DM_CHANNEL[m.type] ?? String(m.type ?? ""),
    lead_id: m.lead_id ?? null,
    lead_name: String(m.lead_name || (m.lead_id != null ? `#${m.lead_id}` : "Unknown")),
    text: String(m.message ?? ""),
  }))
  return {
    sent: d.sent,
    previous_period: typeof d.previous_period === "number" ? d.previous_period : null,
    avg_per_day: typeof d.avg_per_day === "number" ? d.avg_per_day : null,
    messages,
  }
}

/** The headline row: a DM count only when it is one; otherwise say it is a step count. */
export function sentHeadline(summary: Record<string, any>, ledger: DmLedger | null): { label: string; value: number } {
  return ledger
    ? { label: "DMs Sent", value: ledger.sent }
    : { label: "Steps Completed", value: Number(summary?.total_completed ?? 0) }
}

/** Trend of the DM count vs the previous period of the same length (same rule as the server's step trend). */
export function dmTrend(ledger: DmLedger | null): { trend: "up" | "down" | "stable"; percent: number } | null {
  if (!ledger || ledger.previous_period === null) return null
  const prev = ledger.previous_period
  const percent = prev > 0 ? Math.round(((ledger.sent - prev) / prev) * 1000) / 10 : ledger.sent > 0 ? 100 : 0
  return { trend: percent > 0 ? "up" : percent < 0 ? "down" : "stable", percent }
}

/** The --json payload: every section the table renders, from the same values. */
export function analyzeJson(r: {
  boardId: number
  periodName: string
  metrics: Record<string, any>
  quota: { quotas?: any; progress?: any; percent?: any } | null
  messages: SentMessage[] | null
  ledger?: DmLedger | null
}) {
  return {
    // Same number the table prints as "DMs Sent"; null when the server cannot say (#191709).
    dms_sent: r.ledger ? r.ledger.sent : null,
    board_id: r.boardId,
    period: { name: r.periodName, ...(r.metrics.period ?? {}) },
    metrics: r.metrics.summary ?? {},
    quota: r.quota ? { quotas: r.quota.quotas ?? {}, progress: r.quota.progress ?? {}, percent: r.quota.percent ?? {} } : {},
    messages: r.messages ?? [],
    by_type: r.metrics.by_type ?? {},
  }
}
