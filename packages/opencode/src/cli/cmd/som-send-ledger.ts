// The SOM send ledger as the server holds it (#193485).
//
// `iris som ledger` reads ~/.iris/som-ledger on the machine that sent. `iris som ledger --server`
// reads GET /api/v1/som/send-events/summary instead: every machine's sends, sent today per account
// against the daily cap, and replies per campaign. Pure here (query + formatting), so it is tested
// without a network or a terminal.

export type ServerLedgerAccount = {
  account: string
  channel: string
  date: string
  timezone: string
  timezone_source: "owner" | "utc_default"
  sent_today: number
  failed_today: number
  cap: number | null
  remaining: number | null
}

export type ServerLedgerCampaign = {
  account: string
  channel: string
  campaign: string
  campaign_id: number | null
  sent_today: number
  failed_today: number
  sent: number
  failed: number
  skipped: number
  undeliverable: number
  leads_sent: number
  replies: number
  replies_untimed: number
  reply_rate: number | null
  first_sent_at: string | null
  last_event_at: string | null
}

export type ServerLedgerSummary = {
  bloq_id: number | null
  campaign: string | null
  since: string | null
  caps: Record<string, number>
  accounts: ServerLedgerAccount[]
  campaigns: ServerLedgerCampaign[]
  generated_at: string
}

export function serverLedgerPath(opts: { bloq?: number | string; campaign?: string; since?: string }): string {
  const q = new URLSearchParams()
  if (opts.bloq !== undefined && opts.bloq !== "") q.set("bloq", String(opts.bloq))
  if (opts.campaign) q.set("campaign", opts.campaign)
  if (opts.since) q.set("since", opts.since)
  const qs = q.toString()
  return `/api/v1/som/send-events/summary${qs ? `?${qs}` : ""}`
}

const pct = (r: number | null) => (r === null ? "—" : `${(r * 100).toFixed(1)}%`)

/** Plain lines (no colour) for the terminal. The first line always says this is the server's view. */
export function formatServerLedger(s: ServerLedgerSummary): string[] {
  const scope = s.bloq_id ? `board ${s.bloq_id}` : "your reported sends"
  const out: string[] = [`Showing: SERVER ledger (${scope}${s.campaign ? `, campaign ${s.campaign}` : ""}${s.since ? `, since ${s.since}` : ""})`]

  if (!s.accounts.length) {
    out.push("  No sends reported to the server yet. The local ledger (iris som ledger) may still have them.")
    return out
  }

  out.push("", "Sent today per account")
  for (const a of s.accounts) {
    const tz = a.timezone_source === "owner" ? a.timezone : "UTC (no timezone set)"
    const cap = a.cap === null ? "no cap" : `${a.remaining} of ${a.cap} left`
    const near = a.cap !== null && a.remaining !== null && a.remaining <= Math.ceil(a.cap * 0.1) ? "  ← near the cap" : ""
    out.push(`  @${a.account.padEnd(22)} ${a.channel.padEnd(9)} ${String(a.sent_today).padStart(3)} sent  ${String(a.failed_today).padStart(3)} failed  ${cap}  [${a.date} ${tz}]${near}`)
  }

  out.push("", "Per campaign")
  for (const c of s.campaigns) {
    const untimed = c.replies_untimed ? ` (${c.replies_untimed} without a reply time)` : ""
    out.push(
      `  ${c.campaign.padEnd(24)} @${c.account.padEnd(18)} today ${c.sent_today}/${c.failed_today}  total ${c.sent} sent, ${c.failed} failed, ${c.undeliverable} undeliverable  replies ${c.replies}/${c.leads_sent} ${pct(c.reply_rate)}${untimed}`,
    )
  }
  return out
}
