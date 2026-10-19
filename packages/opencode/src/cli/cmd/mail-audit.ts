/**
 * `iris mail audit` beyond the spool, and routed `--cc` (#189942).
 *
 * The spool only knows about sends the CLI made and failed to log. It cannot see a message sent
 * from Mail.app directly — which is exactly what happened on 2026-10-19 when `--sender` refused
 * `--cc` and three lead emails went out by hand. The audit said "Clean". This reconciles what
 * Mail actually SENT (every account, Gmail's labelled-Sent included) against the comms ledger.
 */
import { addressKey } from "./comms-apple-mail"

const EMAIL = /^[^\s@,;<>"']+@[^\s@,;<>"']+\.[^\s@,;<>"']+$/

/** `--cc a@b.co,c@d.co` or repeated `--cc`. Anything that is not an address is refused, not dropped. */
export function parseCcList(raw: unknown): { list: string[] } | { error: string } {
  const parts = (Array.isArray(raw) ? raw : raw == null ? [] : [raw])
    .flatMap((v) => String(v).split(/[\s,]+/))
    .map((s) => s.trim())
    .filter(Boolean)
  const bad = parts.filter((p) => !EMAIL.test(p))
  if (bad.length) return { error: `--cc: not an email address: ${bad.join(", ")}` }
  return { list: [...new Set(parts.map((p) => p.toLowerCase()))] }
}

/**
 * Did the API APPLY the cc list? Only an echo counts. An API that predates cc runs Laravel's
 * validate(), which silently drops unknown keys — it would send the email WITHOUT the cc and
 * report success. A plan or result that does not echo every address is not confirmation.
 */
export function routedCcConfirmed(planOrResult: any, cc: string[]): boolean {
  const echoed = Array.isArray(planOrResult?.cc) ? planOrResult.cc.map((a: any) => String(a).toLowerCase()) : null
  if (!echoed) return false
  return cc.every((a) => echoed.includes(a.toLowerCase()))
}

export interface SentMail {
  message_id: string | null
  subject: string
  sender: string
  date: string
  to: string[]
  cc: string[]
  body?: string
  mailbox?: string
}

export interface LedgerRow {
  subject?: string | null
  sent_at?: string | null
  external_message_id?: string | null
}

export interface UnloggedSent extends SentMail {
  /** Leads this message reached (To first, then Cc), deduped. Empty when every match was ambiguous. */
  leadIds: number[]
  /** Recipient addresses that match more than one lead — reported, never guessed. */
  ambiguous: string[]
}

export function subjectKey(s: string | null | undefined): string {
  let t = String(s ?? "").trim()
  for (;;) {
    const next = t.replace(/^(re|fwd?|fw|aw|sv)\s*:\s*/i, "")
    if (next === t) break
    t = next
  }
  return t.replace(/\s+/g, " ").trim().toLowerCase()
}

const LOGGED_WINDOW_MS = 36 * 3600_000

function isLogged(m: SentMail, rows: LedgerRow[]): boolean {
  const key = subjectKey(m.subject)
  const t = new Date(m.date).getTime()
  const envId = `mailenv_${m.sender.toLowerCase()}_${m.date}_${m.subject}`
  return rows.some((r) => {
    if (r.external_message_id && r.external_message_id === envId) return true
    if (subjectKey(r.subject) !== key) return false
    const rt = new Date(r.sent_at ?? "").getTime()
    return Number.isFinite(rt) && Number.isFinite(t) && Math.abs(rt - t) <= LOGGED_WINDOW_MS
  })
}

/**
 * Pure: which sent messages reached a lead and have no ledger row on ANY lead they reached.
 * "Logged once per message" — a CC'd send is logged on the To lead with the cc list in metadata,
 * so a row on any recipient lead covers the message.
 */
export function reconcileSent(sent: SentMail[], leadsByAddress: Map<string, number[]>, ledgerByLead: Map<number, LedgerRow[]>): UnloggedSent[] {
  const out: UnloggedSent[] = []
  for (const m of sent) {
    const leadIds: number[] = []
    const ambiguous: string[] = []
    for (const addr of [...m.to, ...m.cc]) {
      const ids = leadsByAddress.get(addressKey(addr)) ?? []
      if (ids.length > 1) ambiguous.push(addr.toLowerCase())
      else if (ids.length === 1 && !leadIds.includes(ids[0])) leadIds.push(ids[0])
    }
    if (leadIds.length === 0 && ambiguous.length === 0) continue
    if (leadIds.some((id) => isLogged(m, ledgerByLead.get(id) ?? []))) continue
    out.push({ ...m, leadIds, ambiguous })
  }
  return out
}

export interface AuditDeps {
  /** GET a bridge path, e.g. `/api/mail/search?from_me=1…`. */
  bridge: (path: string) => Promise<Response>
  /** Lead ids whose email (or alternates) is exactly this address. */
  resolveLead: (address: string) => Promise<number[]>
  /** Outbound ledger rows for a lead since `sinceIso`. Throws on failure. */
  ledger: (leadId: number, sinceIso: string) => Promise<LedgerRow[]>
}

export interface SentAudit {
  scanned: number
  /** The bridge returned `limit` rows — older sent mail in the window was NOT examined. */
  truncated: boolean
  unlogged: UnloggedSent[]
  /** Distinct recipient addresses NOT checked against leads because of maxLookups. */
  unresolvedAddresses: number
  ledgerErrors: string[]
  error?: string
}

export async function auditSentMail(
  opts: { days: number; limit: number; maxLookups?: number; includeBody?: boolean; now?: Date },
  deps: AuditDeps,
): Promise<SentAudit> {
  const empty: SentAudit = { scanned: 0, truncated: false, unlogged: [], unresolvedAddresses: 0, ledgerErrors: [] }
  const params = new URLSearchParams({ from_me: "1", days: String(opts.days), limit: String(opts.limit) })
  if (opts.includeBody) {
    params.set("include_body", "1")
    params.set("max_body", "4000")
  }
  let data: any
  try {
    const res = await deps.bridge(`/api/mail/search?${params}`)
    data = await res.json().catch(() => ({}))
    if (!res.ok || !Array.isArray(data?.capabilities) || !data.capabilities.includes("from_me")) {
      return {
        ...empty,
        error: `the IRIS bridge cannot list sent mail (${data?.error ?? `HTTP ${res.status}`}) — update the daemon; sent mail was NOT audited`,
      }
    }
  } catch (e: any) {
    return { ...empty, error: `the IRIS bridge is not reachable: ${String(e?.message ?? e).slice(0, 160)} — sent mail was NOT audited` }
  }

  const rows: any[] = Array.isArray(data?.emails) ? data.emails : []
  const sent: SentMail[] = rows.map((r) => ({
    message_id: r.message_id ?? null,
    subject: String(r.subject ?? ""),
    sender: String(r.sender ?? ""),
    date: String(r.date_sent ?? r.date ?? ""),
    to: Array.isArray(r.to) ? r.to.map(String) : [],
    cc: Array.isArray(r.cc) ? r.cc.map(String) : [],
    body: typeof r.body === "string" ? r.body : undefined,
    mailbox: r.mailbox,
  }))

  // Distinct recipients, newest message first, capped.
  const maxLookups = opts.maxLookups ?? 150
  const addrs: string[] = []
  for (const m of sent) for (const a of [...m.to, ...m.cc]) {
    const k = addressKey(a)
    if (k && !addrs.includes(k)) addrs.push(k)
  }
  const toLookup = addrs.slice(0, maxLookups)
  const leadsByAddress = new Map<string, number[]>()
  const pool = 6
  for (let i = 0; i < toLookup.length; i += pool) {
    await Promise.all(
      toLookup.slice(i, i + pool).map(async (a) => {
        try {
          leadsByAddress.set(a, await deps.resolveLead(a))
        } catch {
          /* unresolvable address → not a lead finding; counted below */
        }
      }),
    )
  }

  const now = opts.now ?? new Date()
  const since = new Date(now.getTime() - (opts.days + 2) * 86400_000).toISOString()
  const leadIds = [...new Set([...leadsByAddress.values()].filter((v) => v.length === 1).map((v) => v[0]))]
  const ledgerByLead = new Map<number, LedgerRow[]>()
  const ledgerErrors: string[] = []
  await Promise.all(
    leadIds.map(async (id) => {
      try {
        ledgerByLead.set(id, await deps.ledger(id, since))
      } catch (e: any) {
        ledgerErrors.push(`lead #${id}: ledger unreadable (${String(e?.message ?? e).slice(0, 120)})`)
      }
    }),
  )

  // A lead whose ledger could not be read is neither logged nor unlogged — drop it from findings.
  const readable = new Map([...leadsByAddress].map(([a, ids]) => [a, ids.filter((id) => ids.length > 1 || ledgerByLead.has(id))]))
  return {
    scanned: sent.length,
    truncated: rows.length >= opts.limit,
    unlogged: reconcileSent(sent, readable, ledgerByLead),
    unresolvedAddresses: addrs.length - toLookup.length,
    ledgerErrors,
  }
}
