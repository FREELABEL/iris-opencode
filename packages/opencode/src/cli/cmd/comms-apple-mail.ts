/**
 * A lead's Apple Mail thread, read through the bridge — the one place pulse, sync-comms,
 * atlas:comms and inbox get it from (#189941).
 *
 * WHAT WAS WRONG, measured 2026-10-19 on lead #29285 (5 inbound + 3 outbound, all in
 * `[Gmail]/All Mail`): `iris leads pulse` said "Apple Mail (0)" and `sync-comms` ingested 0,
 * while `iris mail search` listed every message. The mailbox was never the problem — the
 * Envelope Index reads All Mail fine. Two things were:
 *
 *   1. Every lead caller read `data.messages`. The bridge has answered `{ emails }` since the
 *      Envelope Index rewrite (see mail-response.ts, which fixed `iris mail search` and nothing
 *      else). So Apple Mail was empty for every lead on every machine, reported as a normal 0.
 *   2. They asked `from=<lead>`: the SENDER. Our replies are a recipient match, so even a
 *      working read showed one side of the conversation and could never say "you replied".
 *
 * This module asks `participant=` (sender OR recipient, bridge returns direction), dedupes a
 * message that Gmail stores in INBOX + All Mail + Sent, and turns a failure into an error
 * rather than a zero.
 */
import { mailRows } from "./mail-response"

export type MailDirection = "inbound" | "outbound" | "other"

export interface LeadMail {
  date: string | null
  subject: string
  sender: string
  sender_name?: string
  direction: MailDirection
  from_me?: boolean
  role?: string
  message_id: string | null
  mailbox?: string
  mailboxes?: string[]
  to?: string[]
  cc?: string[]
  body?: string
}

/** Lowercase, plus-tag folded: `HPK+crm@M42.com` and `hpk@m42.com` are one mailbox. */
export function addressKey(addr: string): string {
  const a = String(addr ?? "").trim().toLowerCase()
  const at = a.lastIndexOf("@")
  if (at <= 0) return a
  return `${a.slice(0, at).split("+")[0]}@${a.slice(at + 1)}`
}

/** Rows from whichever bridge answered, with a direction relative to `addr`. Throws on an unknown shape. */
export function leadMailRows(data: any, addr: string): LeadMail[] {
  const rows = mailRows(data)
  const me = addressKey(addr)
  return rows.map((r: any) => {
    const sender = String(r?.sender ?? r?.from ?? "")
    const direction: MailDirection =
      r?.direction === "inbound" || r?.direction === "outbound" || r?.direction === "other"
        ? r.direction
        : sender && addressKey(sender) === me
          ? "inbound"
          : "outbound"
    const mailbox = r?.mailbox ? String(r.mailbox) : undefined
    return {
      date: r?.date ?? r?.date_sent ?? null,
      subject: r?.subject == null ? "(no subject)" : String(r.subject),
      sender,
      sender_name: r?.sender_name || undefined,
      direction,
      from_me: typeof r?.from_me === "boolean" ? r.from_me : direction === "outbound",
      role: r?.role,
      message_id: r?.message_id != null && String(r.message_id) !== "" ? String(r.message_id) : null,
      mailbox,
      mailboxes: Array.isArray(r?.mailboxes) ? r.mailboxes.map(String) : mailbox ? [mailbox] : [],
      to: Array.isArray(r?.to) ? r.to.map(String) : undefined,
      cc: Array.isArray(r?.cc) ? r.cc.map(String) : undefined,
      body: typeof r?.body === "string" ? r.body : undefined,
    }
  })
}

export function mailDedupeKey(m: LeadMail): string {
  if (m.message_id) return `mid:${m.message_id}`
  return `env:${m.sender.toLowerCase()}|${m.date ?? ""}|${m.subject}`
}

/** One row per physical message, newest first. Mailbox lists are unioned. */
export function mergeLeadMail(lists: LeadMail[][]): LeadMail[] {
  const byKey = new Map<string, LeadMail>()
  for (const list of lists) {
    for (const m of list) {
      const k = mailDedupeKey(m)
      const prev = byKey.get(k)
      if (!prev) {
        byKey.set(k, { ...m, mailboxes: [...(m.mailboxes ?? [])] })
        continue
      }
      for (const mb of m.mailboxes ?? []) if (!prev.mailboxes!.includes(mb)) prev.mailboxes!.push(mb)
      if (!prev.body && m.body) prev.body = m.body
    }
  }
  return [...byKey.values()].sort((a, b) => new Date(b.date ?? 0).getTime() - new Date(a.date ?? 0).getTime())
}

export interface LeadMailRead {
  messages: LeadMail[]
  errors: string[]
  /** The bridge is older than participant= — inbound only; outbound was NOT looked at. */
  outboundBlind: boolean
}

type Fetcher = (url: string) => Promise<Response>

async function errorText(res: Response): Promise<string> {
  const t = await res.text().catch(() => "")
  try {
    const j = JSON.parse(t)
    if (j?.error) return String(j.error)
  } catch {}
  return t.slice(0, 200) || `HTTP ${res.status}`
}

/**
 * Read every address of a lead. `fetcher` receives a PATH+QUERY (`/api/mail/search?...`) — the
 * caller prefixes its bridge URL and adds auth.
 */
export async function fetchLeadMail(
  addresses: string[],
  opts: { days: number; limit: number; includeBody?: boolean; maxBody?: number },
  fetcher: Fetcher,
): Promise<LeadMailRead> {
  const seen = new Set<string>()
  const addrs = addresses.map((a) => String(a ?? "").trim()).filter((a) => {
    if (!a) return false
    const k = addressKey(a)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
  const lists: LeadMail[][] = []
  const errors: string[] = []
  let outboundBlind = false

  const qs = (key: "participant" | "from", addr: string) => {
    const p = new URLSearchParams({ [key]: addr, days: String(opts.days), limit: String(opts.limit) })
    if (opts.includeBody) {
      p.set("include_body", "1")
      if (opts.maxBody) p.set("max_body", String(opts.maxBody))
    }
    return `/api/mail/search?${p}`
  }

  await Promise.all(
    addrs.map(async (addr) => {
      try {
        let res = await fetcher(qs("participant", addr))
        let legacy = false
        if (res.status === 400) {
          // A bridge older than participant= ignores it and answers "from is required".
          legacy = true
          res = await fetcher(qs("from", addr))
        }
        if (!res.ok) {
          errors.push(`${addr}: ${await errorText(res)}`)
          return
        }
        const data = (await res.json()) as any
        if (legacy || !Array.isArray(data?.capabilities) || !data.capabilities.includes("participant")) outboundBlind = true
        lists.push(leadMailRows(data, addr))
      } catch (e: any) {
        errors.push(`${addr}: ${String(e?.message ?? e).slice(0, 200)}`)
      }
    }),
  )

  return { messages: mergeLeadMail(lists), errors, outboundBlind }
}

/**
 * The ledger id. Deliberately the SAME formula `atlas:comms ingest` has used since the Envelope
 * Index bridge (bridgeMailItems): sender + time + subject, which is identical for every mailbox
 * copy of one message. Changing it would re-file every message already in the ledger.
 */
export function mailExternalId(m: LeadMail, addr: string): string {
  return `mailenv_${String(m.sender || addr).toLowerCase()}_${m.date}_${m.subject ?? ""}`
}

/** Ledger items for /api/v1/atlas/comms/ingest. Third-party thread mail is not the lead's comms. */
export function appleMailLedgerItems(messages: LeadMail[], addr: string, source: string): any[] {
  return messages
    .filter((m) => m.direction !== "other")
    .map((m) => ({
      direction: m.direction,
      from_identifier: m.sender || (m.direction === "inbound" ? addr : "me"),
      subject: m.subject,
      body: m.body || m.subject || "",
      sent_at: m.date,
      external_message_id: mailExternalId(m, addr),
      metadata: {
        source,
        channel_source: "apple_mail",
        matched_address: addr,
        mailboxes: m.mailboxes,
        ...(m.to?.length ? { to: m.to } : {}),
        ...(m.cc?.length ? { cc: m.cc } : {}),
      },
    }))
}

/**
 * Their message is the last word and it has sat for `thresholdHours`. Third-party mail on the
 * thread ("other") neither answers them nor counts as theirs. Returns the run of unanswered
 * messages, or null.
 */
export function unansweredInbound(
  msgs: Array<{ date: string | null; isOutbound: boolean; direction?: MailDirection }>,
  now: Date = new Date(),
  thresholdHours = 48,
): { count: number; since: string; last: string; ageHours: number } | null {
  const directional = msgs
    .filter((m) => m.date && m.direction !== "other" && !Number.isNaN(new Date(m.date).getTime()))
    .sort((a, b) => new Date(a.date!).getTime() - new Date(b.date!).getTime())
  if (directional.length === 0) return null
  let i = directional.length - 1
  while (i >= 0 && !directional[i].isOutbound) i--
  const run = directional.slice(i + 1)
  if (run.length === 0) return null
  const last = run[run.length - 1].date!
  const ageHours = (now.getTime() - new Date(last).getTime()) / 3600_000
  if (ageHours < thresholdHours) return null
  return { count: run.length, since: run[0].date!, last, ageHours }
}
