/**
 * Payment search / filter / sort / drill-down (#178595, #178599).
 *
 * WHY THIS EXISTS: `iris imessage read` requires a text body
 * (lib/imessage.ts:227 `AND (m.text IS NOT NULL OR m.attributedBody IS NOT NULL)`
 * and again at :298 `if (!text) return null`). An Apple Cash transfer has no
 * text — it is a balloon payload — so 149 payments sat in chat.db and the CLI
 * confidently reported none. That is how a real $50 payout to Flo went missing.
 *
 * THREE CONSTRAINTS THIS MODULE IS BUILT AROUND, all verified against live data:
 *
 *  1. THE AMOUNT IS NOT IN THE DATABASE. Confirmed by comparing a $50 screenshot
 *     against that payment's own DB row: not in `text`, not in
 *     `message_summary_info` (a bplist carrying only a state flag), not
 *     extractable from `payload_data`. Apple withholds it. So `amount` is
 *     optional, defaults to undefined, and `summarise()` refuses to produce a
 *     total when nothing is known. Never invent it.
 *
 *  2. A PAYMENT'S MEANING LIVES IN A NEIGHBOURING MESSAGE. The only label a
 *     transfer carries is free text sent seconds around it —
 *     "IRIS BUG BOUNTY #001 - FLO SMITH". That convention is already in use by
 *     hand, so we parse it rather than inventing a new one.
 *
 *  3. ONE HUMAN, MANY CARDS. The money went to the "Flozzel Smith" card while
 *     every lookup for "Flo" resolves to "Flo Smith". Matching is therefore
 *     substring and case-insensitive across BOTH name and handle, and a label
 *     naming a different person than the receiving card is surfaced as drift
 *     rather than smoothed over.
 */

import { query, parseAttributedBody, isAvailable } from "./imessage"
import { resolveFromAddressBook } from "./address-book"

export type Direction = "sent" | "received"

export interface Payment {
  /** Messages DB ROWID. */
  id: string
  /** Local time, ISO-ish: YYYY-MM-DDTHH:MM:SS */
  date: string
  direction: Direction
  handle: string
  /** Resolved contact card name, when Contacts knows the handle. */
  contact?: string
  rail: "apple_cash" | "cash_app" | "manual"
  /** Parsed from the adjacent label message. */
  reference?: string
  sequence?: number
  claimedRecipient?: string
  /** Cents. NEVER populated from chat.db — see constraint 1. */
  amount?: number
}

export interface RawMessage {
  id: string
  date: string
  from_me: boolean
  handle: string
  text: string
}

export interface PaymentFilter {
  contact?: string
  direction?: Direction
  since?: string
  until?: string
  reference?: string
  labelled?: boolean
}

export interface PaymentSort {
  sort?: "date" | "contact" | "reference"
  order?: "asc" | "desc"
}

// ── Label parsing ────────────────────────────────────────────────────────────

export interface ParsedLabel {
  reference: string
  sequence: number
  claimedRecipient?: string
}

// "IRIS BUG BOUNTY #001 - FLO SMITH" — tolerant of case, run-on spaces, and
// hyphen/en-dash/em-dash, because a human types this into Messages by hand.
const LABEL_RE = /iris\s+bug\s+bounty\s*#\s*(\d+)\s*(?:[-–—]\s*(.+))?$/i

export function parseLabel(text: string): ParsedLabel | null {
  if (typeof text !== "string") return null
  const trimmed = text.trim()
  if (!trimmed) return null

  const m = LABEL_RE.exec(trimmed)
  if (!m) return null

  const digits = m[1]
  const recipient = m[2]?.trim()
  return {
    // Preserve the operator's own formatting (leading zeros included) so the
    // reference round-trips back to what they typed.
    reference: `IRIS BUG BOUNTY #${digits}`,
    sequence: parseInt(digits, 10),
    claimedRecipient: recipient && recipient.length > 0 ? recipient : undefined,
  }
}

// ── Attaching labels ─────────────────────────────────────────────────────────

function toEpoch(d: string): number {
  const t = Date.parse(d)
  return Number.isNaN(t) ? 0 : t
}

/** Compare only the digits, so "+18175269825" and "8175269825" are one handle. */
function digitsOf(h: string): string {
  return (h ?? "").replace(/\D/g, "")
}

/**
 * Attach the nearest label message to each payment.
 *
 * Only label-shaped messages are considered, which is both correct — an
 * ordinary "thanks for the work" must never become a payment's purpose — and
 * what keeps this fast: the candidate set collapses from every message in the
 * thread to the handful that match the convention.
 *
 * Returns new objects; inputs are never mutated.
 */
export function attachLabels(
  payments: Payment[],
  messages: RawMessage[],
  opts: { windowSeconds?: number } = {},
): Payment[] {
  const windowMs = (opts.windowSeconds ?? 120) * 1000

  // Pre-filter to labels once, then bucket by counterparty.
  const byHandle = new Map<string, Array<{ at: number; label: ParsedLabel }>>()
  for (const m of messages) {
    const label = parseLabel(m.text)
    if (!label) continue
    const key = digitsOf(m.handle)
    if (!key) continue
    let bucket = byHandle.get(key)
    if (!bucket) byHandle.set(key, (bucket = []))
    bucket.push({ at: toEpoch(m.date), label })
  }
  for (const bucket of byHandle.values()) bucket.sort((a, b) => a.at - b.at)

  return payments.map((p) => {
    const at = toEpoch(p.date)
    const key = digitsOf(p.handle)
    const candidates = byHandle.get(key)
    if (!candidates?.length) return { ...p }

    let best: { at: number; label: ParsedLabel } | undefined
    let bestGap = Infinity
    for (const c of candidates) {
      const gap = Math.abs(c.at - at)
      if (gap > windowMs) continue
      if (gap < bestGap) {
        bestGap = gap
        best = c
      }
    }
    if (!best) return { ...p }

    return {
      ...p,
      reference: best.label.reference,
      sequence: best.label.sequence,
      claimedRecipient: best.label.claimedRecipient,
    }
  })
}

// ── Filtering ────────────────────────────────────────────────────────────────

/** Date-only bounds are inclusive: `until: "2026-07-30"` includes all of that day. */
function dayEnd(d: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d}T23:59:59` : d
}

export function filterPayments(payments: Payment[], f: PaymentFilter): Payment[] {
  return payments.filter((p) => {
    if (f.direction && p.direction !== f.direction) return false

    if (f.contact) {
      const q = f.contact.trim().toLowerCase()
      const qDigits = digitsOf(q)
      const nameHit = (p.contact ?? "").toLowerCase().includes(q)
      // Substring, not equality — "Flo" MUST reach "Flozzel Smith", which is
      // the exact match that hid a real payment.
      const handleHit = qDigits.length > 0 && digitsOf(p.handle).includes(qDigits)
      if (!nameHit && !handleHit) return false
    }

    if (f.since && toEpoch(p.date) < toEpoch(f.since)) return false
    if (f.until && toEpoch(p.date) > toEpoch(dayEnd(f.until))) return false

    if (f.reference) {
      const q = f.reference.trim().toLowerCase()
      if (!(p.reference ?? "").toLowerCase().includes(q)) return false
    }

    if (f.labelled !== undefined) {
      const has = Boolean(p.reference)
      if (has !== f.labelled) return false
    }

    return true
  })
}

// ── Sorting ──────────────────────────────────────────────────────────────────

export function sortPayments(payments: Payment[], s: PaymentSort): Payment[] {
  const key = s.sort ?? "date"
  // Newest-first is the useful default for money.
  const dir = (s.order ?? (key === "date" ? "desc" : "asc")) === "asc" ? 1 : -1

  // Array.prototype.sort is stable in every engine we target, so equal keys keep
  // input order and repeated runs render identically.
  return [...payments].sort((a, b) => {
    let cmp = 0
    switch (key) {
      case "date":
        cmp = toEpoch(a.date) - toEpoch(b.date)
        break
      case "contact":
        cmp = (a.contact ?? a.handle).localeCompare(b.contact ?? b.handle)
        break
      case "reference":
        cmp = (a.sequence ?? -1) - (b.sequence ?? -1)
        break
    }
    return cmp * dir
  })
}

// ── Pagination ───────────────────────────────────────────────────────────────

export interface Page<T> {
  items: T[]
  total: number
  offset: number
  limit: number
  hasMore: boolean
}

export function paginate<T>(items: T[], opts: { limit?: number; offset?: number }): Page<T> {
  const limit = Math.max(1, opts.limit ?? 50)
  const offset = Math.max(0, opts.offset ?? 0)
  const slice = items.slice(offset, offset + limit)
  return {
    items: slice,
    total: items.length,
    offset,
    limit,
    hasMore: offset + slice.length < items.length,
  }
}

// ── Summary ──────────────────────────────────────────────────────────────────

export interface PaymentSummary {
  count: number
  sent: number
  received: number
  amountKnownCount: number
  amountUnknownCount: number
  /** Undefined when NO amount is known — a total of 0 would be a lie. */
  totalCents?: number
}

export function summarise(payments: Payment[]): PaymentSummary {
  const known = payments.filter((p) => typeof p.amount === "number")
  return {
    count: payments.length,
    sent: payments.filter((p) => p.direction === "sent").length,
    received: payments.filter((p) => p.direction === "received").length,
    amountKnownCount: known.length,
    amountUnknownCount: payments.length - known.length,
    totalCents: known.length ? known.reduce((s, p) => s + (p.amount ?? 0), 0) : undefined,
  }
}

// ── Reconciliation ───────────────────────────────────────────────────────────

export type IssueKind = "recipient_mismatch" | "duplicate_reference" | "sequence_gap" | "unlabelled"

export interface ReconcileIssue {
  kind: IssueKind
  paymentId?: string
  detail: string
}

function normaliseName(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ")
}

/**
 * Surface drift rather than smoothing it. Every issue here is a real one seen
 * in the live data, not a hypothetical.
 */
export function reconcile(payments: Payment[]): ReconcileIssue[] {
  const issues: ReconcileIssue[] = []

  // The label names one person; the money reached another card. This is exactly
  // how Flo's $50 became unattachable.
  for (const p of payments) {
    if (p.claimedRecipient && p.contact) {
      if (normaliseName(p.claimedRecipient) !== normaliseName(p.contact)) {
        issues.push({
          kind: "recipient_mismatch",
          paymentId: p.id,
          detail: `label names "${p.claimedRecipient}" but the payment reached "${p.contact}"`,
        })
      }
    }
  }

  // Same reference twice = a real payment booked twice, or two payments sharing
  // an id. Either way nobody can reconcile it.
  const byRef = new Map<string, Payment[]>()
  for (const p of payments) {
    if (!p.reference) continue
    const k = p.reference.toLowerCase()
    byRef.set(k, [...(byRef.get(k) ?? []), p])
  }
  for (const [ref, group] of byRef) {
    if (group.length > 1) {
      issues.push({
        kind: "duplicate_reference",
        detail: `${group.length} payments share reference ${ref}: ${group.map((g) => g.id).join(", ")}`,
      })
    }
  }

  // A hole in the sequence means a payment went out and was never labelled.
  const seqs = payments.map((p) => p.sequence).filter((n): n is number => typeof n === "number")
  if (seqs.length > 1) {
    const sorted = [...new Set(seqs)].sort((a, b) => a - b)
    const missing: number[] = []
    for (let n = sorted[0]; n < sorted[sorted.length - 1]; n++) {
      if (!sorted.includes(n)) missing.push(n)
    }
    if (missing.length) {
      issues.push({
        kind: "sequence_gap",
        detail: `missing reference number(s): ${missing.join(", ")}`,
      })
    }
  }

  // Money left with no stated purpose. Inbound needs no purpose from us, so it
  // is deliberately exempt.
  for (const p of payments) {
    if (p.direction === "sent" && !p.reference) {
      issues.push({
        kind: "unlabelled",
        paymentId: p.id,
        detail: `sent payment ${p.id} on ${p.date} has no label`,
      })
    }
  }

  return issues
}

// ── chat.db reader ───────────────────────────────────────────────────────────

/** Apple Cash transfers carry this balloon type. */
const PEER_PAYMENT = "PeerPaymentMessagesExtension"

/** Unit separator — cannot occur in message text, unlike sqlite's default "|". */
const SEP = String.fromCharCode(31)

/**
 * Two lessons from the first real-data run are baked into these queries, and
 * both are easy to get wrong:
 *
 *  1. COUNTERPARTY COMES FROM THE CHAT, NOT THE HANDLE. An outbound message has
 *     handle_id 0, so joining only `handle` silently drops every payment YOU
 *     sent — which, for a payer, is all of them.
 *  2. TEXT LIVES IN attributedBody. Modern macOS leaves `message.text` NULL and
 *     stores content in a binary blob. Filtering on `text` found 0 of 2 real
 *     labels while both sat in the database.
 */
// The joins every query needs: chat first (an outbound message has no handle),
// handle as the fallback for inbound.
const JOINS = `FROM message m
  LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
  LEFT JOIN chat ch ON ch.ROWID = cmj.chat_id
  LEFT JOIN handle h ON m.handle_id = h.ROWID`.replace(/\n\s*/g, " ")

const WHEN = `datetime(m.date/1000000000 + 978307200, 'unixepoch', 'localtime')`
const WHO = `COALESCE(ch.chat_identifier, COALESCE(h.id, ''))`
// CAST is load-bearing: strftime returns TEXT, and SQLite orders every INTEGER
// below every TEXT, so an uncast comparison silently matches nothing.
const since = (d: number) => `m.date/1000000000 + 978307200 > CAST(strftime('%s','now','-${d} days') AS INTEGER)`

/**
 * Fields are joined with char(31) INSIDE SQL rather than via sqlite's
 * `.separator` dot-command, which does not survive the shell escaping in
 * imessage.query(). Splitting on "|" — sqlite's default — would corrupt any row
 * whose message text contains a pipe.
 */
function paymentRowsSql(sinceDays: number, limit: number): string {
  return `SELECT m.ROWID || char(31) || ${WHEN} || char(31) || m.is_from_me || char(31) || ${WHO} ${JOINS} WHERE m.balloon_bundle_id LIKE '%${PEER_PAYMENT}%' AND ${since(sinceDays)} ORDER BY m.date DESC LIMIT ${limit};`
}

/** Local "YYYY-MM-DDTHH:MM:SS" → Apple's nanoseconds-since-2001 epoch. */
function toAppleNs(localIso: string): number {
  const ms = Date.parse(localIso)
  if (Number.isNaN(ms)) return 0
  return Math.round((ms / 1000 - 978307200) * 1e9)
}

/**
 * Only the moments around a payment can contain that payment's label, so scan
 * those windows instead of the whole history.
 *
 * This is what makes the command scale: cost is proportional to the number of
 * PAYMENTS, not to how many messages you have. Selecting hex(attributedBody)
 * across a year of messages overflowed the subprocess buffer outright — the
 * blobs are enormous.
 */
function labelRowsSql(payments: Payment[], windowSeconds: number, limit: number): string {
  const halfNs = windowSeconds * 1e9
  const ranges = payments
    .map((p) => toAppleNs(p.date))
    .filter((n) => n > 0)
    .map((n) => [n - halfNs, n + halfNs] as [number, number])
    .sort((a, b) => a[0] - b[0])

  // Merge overlapping windows so a burst of payments does not produce a
  // thousand redundant clauses.
  const merged: Array<[number, number]> = []
  for (const r of ranges) {
    const last = merged[merged.length - 1]
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1])
    else merged.push([...r] as [number, number])
  }

  const windows = merged.map(([a, b]) => `(m.date BETWEEN ${a} AND ${b})`).join(" OR ")

  // Text last, so a stray separator inside a message cannot shift earlier fields.
  return `SELECT m.ROWID || char(31) || ${WHEN} || char(31) || m.is_from_me || char(31) || ${WHO} || char(31) || COALESCE(hex(m.attributedBody),'') || char(31) || REPLACE(REPLACE(COALESCE(m.text,''), char(10), ' '), char(13), ' ') ${JOINS} WHERE (${windows}) AND (m.text IS NOT NULL OR m.attributedBody IS NOT NULL) ORDER BY m.date DESC LIMIT ${limit};`
}

function runRows(sql: string, fields: number): string[][] {
  return query(sql)
    .split("\n")
    .map((l) => l.replace(/\r$/, ""))
    .filter((l) => l.includes(SEP))
    .map((l) => {
      const parts = l.split(SEP)
      // Re-join any overflow into the final field rather than dropping it.
      if (parts.length > fields) {
        return [...parts.slice(0, fields - 1), parts.slice(fields - 1).join(SEP)]
      }
      return parts
    })
}

export interface ReadOptions {
  /** How far back to look. */
  days?: number
  /** Hard cap on payment rows. */
  limit?: number
  /** How close a label must sit to count as this payment's label. */
  windowSeconds?: number
  /** Skip contact resolution (faster; handles only). */
  skipContacts?: boolean
}

export interface ReadResult {
  payments: Payment[]
  /** Rows scanned for labels — lets the caller report cost at scale. */
  messagesScanned: number
  available: boolean
  reason?: string
}

/**
 * Read Apple Cash payments from the local Messages database and attach the
 * label each one carries in a neighbouring message.
 *
 * `amount` is deliberately never set — it is not in the database. See the
 * module header.
 */
export function readPayments(opts: ReadOptions = {}): ReadResult {
  if (!isAvailable()) {
    return {
      payments: [],
      messagesScanned: 0,
      available: false,
      reason:
        process.platform !== "darwin"
          ? "Apple Cash payments are macOS-only."
          : "Cannot read Messages — grant Full Disk Access, then: iris permissions grant full-disk-access",
    }
  }

  const days = opts.days ?? 365
  const limit = opts.limit ?? 1000

  const payments: Payment[] = runRows(paymentRowsSql(days, limit), 4).map((r) => ({
    id: r[0],
    date: (r[1] ?? "").replace(" ", "T"),
    direction: r[2] === "1" ? "sent" : "received",
    handle: r[3] ?? "",
    rail: "apple_cash" as const,
  }))

  const windowSeconds = opts.windowSeconds ?? 300

  // Only scan for labels when there is something to label.
  let messages: RawMessage[] = []
  if (payments.length) {
    messages = runRows(labelRowsSql(payments, windowSeconds, 20000), 6)
      .map((r) => {
        // Prefer the text column; fall back to decoding attributedBody, which
        // is where modern macOS actually keeps it.
        const text = (r[5] ?? "").trim() || (r[4] ? parseAttributedBody(r[4]) : "")
        return { id: r[0], date: (r[1] ?? "").replace(" ", "T"), from_me: r[2] === "1", handle: r[3] ?? "", text }
      })
      .filter((m) => m.text)
  }

  let linked = attachLabels(payments, messages, { windowSeconds })

  if (!opts.skipContacts) {
    // Resolve once per distinct handle, not once per payment.
    const cache = new Map<string, string | null>()
    linked = linked.map((p) => {
      if (!p.handle) return p
      if (!cache.has(p.handle)) cache.set(p.handle, resolveFromAddressBook(p.handle))
      const name = cache.get(p.handle)
      return name ? { ...p, contact: name } : p
    })
  }

  return { payments: linked, messagesScanned: messages.length, available: true }
}
