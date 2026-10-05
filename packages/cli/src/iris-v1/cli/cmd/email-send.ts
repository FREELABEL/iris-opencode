/**
 * `iris email` — pure helpers for the per-recipient sender (epic #187455).
 *
 * Why: a chapter newsletter was sent by hand on 2026-09-30, one message per member, through
 * Mailjet. The rules that survived that send are enforced by fl-iris-api's EmailSender; this
 * module is the CLI's half of the same rules, so the person sees the list exactly as the server
 * will — before anything goes out:
 *  - every address the file contained is accounted for: kept, or skipped WITH A REASON;
 *  - a live send names the count it expects, and a mismatch refuses;
 *  - "sent" means the provider ACCEPTED the message. Delivery is a separate question, answered
 *    only by asking the provider later (`iris email status <run> --refresh`).
 *
 * No I/O here. The command module (platform-email.ts) does the calls.
 */

/** Same shape the server checks (EmailSender::EMAIL). Agreeing with it is the point. */
export const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$/

/** EmailSender::TEST_MAX — a test goes to a handful of people, never a list. */
export const TEST_MAX = 10

export type SkipReason = "invalid" | "duplicate" | "blank"

export interface Skipped {
  input: string
  reason: SkipReason
  /** 1-based line in the source file, when there was one */
  line?: number
}

export interface RecipientList {
  /** lower-cased, trimmed, unique, in first-seen order */
  recipients: string[]
  skipped: Skipped[]
}

/**
 * Split one CSV line, honouring double quotes ("Smith, Jo",jo@x.com). Enough CSV for a member
 * export; not a general parser.
 */
export function splitCsvLine(line: string): string[] {
  const out: string[] = []
  let cur = ""
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"'
        i++
      } else if (c === '"') quoted = false
      else cur += c
    } else if (c === '"') quoted = true
    else if (c === ",") {
      out.push(cur)
      cur = ""
    } else cur += c
  }
  out.push(cur)
  return out.map((s) => s.trim())
}

export interface ParsedFile {
  entries: Array<{ value: string; line: number }>
  /** set when the file is a CSV that has no usable email column */
  error?: string
}

/**
 * Read a recipient file. Two shapes:
 *  - plain list: one address per line (blank lines and `#` comments ignored);
 *  - CSV: a header row containing a column named `email` (any case, also `e-mail` /
 *    `email address`). Only that column is read — a CSV whose header has commas but no email
 *    column is an ERROR, never "use the first column", because the first column of a member
 *    export is usually a name and would turn the whole list into "invalid" skips.
 */
export function parseRecipientFile(text: string, filename = ""): ParsedFile {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/)
  const firstIdx = lines.findIndex((l) => l.trim() !== "" && !l.trim().startsWith("#"))
  if (firstIdx < 0) return { entries: [] }
  const first = lines[firstIdx]
  const isCsv = /\.csv$/i.test(filename) || first.includes(",")

  if (!isCsv) {
    const entries: ParsedFile["entries"] = []
    lines.forEach((l, i) => {
      const t = l.trim()
      if (t === "" || t.startsWith("#")) return
      entries.push({ value: t, line: i + 1 })
    })
    return { entries }
  }

  const header = splitCsvLine(first).map((h) => h.toLowerCase().replace(/[\s_-]+/g, ""))
  let col = header.findIndex((h) => h === "email" || h === "emailaddress")
  if (col < 0) {
    // A one-column CSV whose first row IS an address (no header) — read it as a list.
    if (header.length === 1 && EMAIL_RE.test(splitCsvLine(first)[0])) {
      return parseRecipientFile(text, "")
    }
    return {
      entries: [],
      error: `No "email" column in the CSV header (found: ${splitCsvLine(first).join(", ") || "nothing"}). Name the column "email".`,
    }
  }
  const entries: ParsedFile["entries"] = []
  for (let i = firstIdx + 1; i < lines.length; i++) {
    if (lines[i].trim() === "") continue
    const cells = splitCsvLine(lines[i])
    entries.push({ value: cells[col] ?? "", line: i + 1 })
  }
  return { entries }
}

/**
 * Normalise, validate and dedupe. Nothing disappears silently: every input is either a
 * recipient or a skip with a reason, so `recipients.length + skipped.length` always equals the
 * number of inputs.
 */
export function buildRecipientList(inputs: Array<string | { value: string; line?: number }>): RecipientList {
  const seen = new Set<string>()
  const recipients: string[] = []
  const skipped: Skipped[] = []
  for (const raw of inputs) {
    const value = typeof raw === "string" ? raw : raw.value
    const line = typeof raw === "string" ? undefined : raw.line
    const at = line !== undefined ? { line } : {}
    // "Jo Smith <jo@x.com>" — take the address.
    const angle = value.match(/<([^>]+)>/)
    const email = (angle ? angle[1] : value).trim().toLowerCase()
    if (email === "") {
      skipped.push({ input: value, reason: "blank", ...at })
      continue
    }
    if (!EMAIL_RE.test(email)) {
      skipped.push({ input: value, reason: "invalid", ...at })
      continue
    }
    if (seen.has(email)) {
      skipped.push({ input: value, reason: "duplicate", ...at })
      continue
    }
    seen.add(email)
    recipients.push(email)
  }
  return { recipients, skipped }
}

/** `--to a@b,c@d --to e@f` → one flat list. */
export function flattenToArgs(to: unknown): string[] {
  const arr = Array.isArray(to) ? to : to === undefined || to === null ? [] : [to]
  return arr.flatMap((v) => String(v).split(/[,;]/)).filter((s) => s.trim() !== "")
}

export type ModeCheck = { ok: true; mode: "test" | "live" } | { ok: false; error: string }

/**
 * Decide test vs live and refuse anything ambiguous. A live send must state how many people it
 * expects to reach, and that number must equal the unique valid recipients — so the wrong file
 * cannot reach the wrong 400 people.
 */
export function checkMode(opts: { test?: boolean; live?: boolean; confirmCount?: number; unique: number }): ModeCheck {
  if (opts.test && opts.live) return { ok: false, error: "Pick one: --test or --live." }
  if (!opts.test && !opts.live) return { ok: false, error: "Say --test (subject prefixed [TEST]) or --live --confirm-count N." }
  if (opts.unique === 0) return { ok: false, error: "No valid recipients — nothing to send." }
  if (opts.test) {
    if (opts.unique > TEST_MAX)
      return { ok: false, error: `A test send goes to at most ${TEST_MAX} people; this list has ${opts.unique}. Use --live --confirm-count ${opts.unique}.` }
    return { ok: true, mode: "test" }
  }
  if (opts.confirmCount === undefined || opts.confirmCount === null || Number.isNaN(opts.confirmCount))
    return { ok: false, error: `A live send needs --confirm-count ${opts.unique} (the number of unique valid recipients).` }
  if (Number(opts.confirmCount) !== opts.unique)
    return {
      ok: false,
      error: `--confirm-count ${opts.confirmCount} does not match ${opts.unique} unique valid recipient${opts.unique === 1 ? "" : "s"}. Nothing was sent.`,
    }
  return { ok: true, mode: "live" }
}

/** The subject the recipient will see. Mirrors the server: never double-prefix. */
export function testSubject(subject: string): string {
  return subject.startsWith("[TEST") ? subject : `[TEST] ${subject}`
}

// ── status ──────────────────────────────────────────────────────────────────

/** Delivery states that mean the message did not (or will not) arrive. */
export const DELIVERY_BAD = new Set(["bounced", "complained", "blocked", "failed", "canceled"])

/** After a refresh, these mean the provider has still told us nothing about arrival. */
export const UNCONFIRMED = new Set(["accepted", "unknown"])

/** The send attempt, labelled so nobody reads "sent" as "delivered". */
export function sendLabel(m: StatusMessage): string {
  return m.status === "sent" ? "sent (accepted)" : m.status
}

export interface StatusMessage {
  email: string
  /** the send attempt: pending | sent (= accepted by provider) | failed */
  status: string
  provider_message_id?: string | null
  delivery_status?: string | null
  last_event?: string | null
  delivery_checked_at?: string | null
  delivery_error?: string | null
  error?: string | null
  sent_at?: string | null
}

/**
 * The one word shown per message. A message the server never asked the provider about is
 * "accepted" — never "sent", never "delivered" — because acceptance is all that is known.
 */
export function effectiveStatus(m: StatusMessage): string {
  if (m.status === "failed") return "failed"
  if (m.status === "pending") return "pending"
  return (m.delivery_status && String(m.delivery_status)) || "accepted"
}

export function statusTotals(messages: StatusMessage[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const m of messages) {
    const s = effectiveStatus(m)
    out[s] = (out[s] ?? 0) + 1
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)))
}

export interface StatusVerdict {
  exitCode: 0 | 1
  /** why it is non-zero; empty when 0 */
  reasons: string[]
}

/**
 * Exit non-zero when any message failed or bounced, when nothing was accepted at all, and —
 * after a refresh — when every accepted message is STILL only "accepted" (the provider has told
 * us nothing, which is not the same as "delivered").
 */
export function statusVerdict(messages: StatusMessage[], opts: { refreshed: boolean; refreshUnsupported?: boolean }): StatusVerdict {
  const reasons: string[] = []
  const totals = statusTotals(messages)
  const bad = Object.entries(totals).filter(([s]) => DELIVERY_BAD.has(s))
  for (const [s, n] of bad) reasons.push(`${n} ${s}`)
  const accepted = messages.filter((m) => m.status === "sent")
  const pending = messages.filter((m) => m.status === "pending").length
  if (pending) reasons.push(`${pending} still pending — the send has not finished`)
  if (messages.length === 0 || (accepted.length === 0 && !pending)) reasons.push("nothing was accepted by the provider")
  if (opts.refreshUnsupported) reasons.push("delivery status not available from server yet")
  else if (opts.refreshed && accepted.length > 0 && accepted.every((m) => UNCONFIRMED.has(effectiveStatus(m))))
    reasons.push("every message is still only 'accepted' — the provider has not confirmed delivery")
  return { exitCode: reasons.length ? 1 : 0, reasons }
}
