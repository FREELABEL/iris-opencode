/**
 * One outgoing email, as data — who it goes to, how it threads — before any transport sees it.
 *
 * #191605. `iris mail send <to>` took ONE address, a single `--cc`, no BCC and no way to answer a
 * specific message. On 2026-10-28 a five-person reply-all on the Vanguard thread could not be
 * expressed, so an agent sent it with raw `osascript` on the Mac via `iris hive run`: it went out,
 * it skipped the comms router, nothing logged it and `iris mail audit` could not see it.
 *
 * Pure on purpose (same reason comms-log-group.ts is): the message that comes out — recipients
 * and the In-Reply-To / References it threads on — is the thing the tests hold.
 */

/** What the bridge's GET /api/mail/message (or Gmail's get_email) says about the original. */
export interface MailEnvelope {
  message_id: string
  subject: string
  from: string
  reply_to?: string | null
  to: string[]
  cc: string[]
  references?: string[]
  /** Mail.app only: where the original lives, so the bridge can `reply` to it without a search. */
  account?: string
  mailbox?: string
  /** Gmail only. */
  gmail_id?: string
  thread_id?: string
}

export interface OutgoingMail {
  from?: string
  to: string[]
  cc: string[]
  bcc: string[]
  subject: string
  body: string
  /** The threading headers this message carries. Mail.app writes them itself via `reply`. */
  headers: { "In-Reply-To"?: string; References?: string }
  /** Set for a reply: what the transport must thread on. */
  reply?: { messageId: string; account?: string; mailbox?: string; gmailId?: string; threadId?: string }
  attachments: string[]
  draft: boolean
}

const ADDRESS = /^[^\s@<>"]+@[^\s@<>"]+$/

/** "Ann <a@x.com>" → "a@x.com"; anything else trimmed. */
export function bareAddress(s: string): string {
  const m = String(s ?? "").match(/<([^>]+)>/)
  return (m ? m[1] : String(s ?? "")).trim()
}

/**
 * Every recipient value a person might type — repeated flags, comma lists, "Name <addr>" — as one
 * clean list, first spelling wins, duplicates (case-insensitive) dropped.
 */
export function splitAddresses(...values: unknown[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const walk = (v: unknown) => {
    if (v == null || v === false) return
    if (Array.isArray(v)) return v.forEach(walk)
    // Split on commas/semicolons that are not inside a quoted display name.
    for (const part of String(v).split(/[,;](?=(?:[^"]*"[^"]*")*[^"]*$)/)) {
      const a = bareAddress(part)
      if (!a) continue
      const k = a.toLowerCase()
      if (seen.has(k)) continue
      seen.add(k)
      out.push(a)
    }
  }
  values.forEach(walk)
  return out
}

/** `<abc@x>`, `abc@x`, `rfc822_<abc@x>` → `abc@x`. */
export function normalizeMessageId(id: unknown): string {
  return String(id ?? "")
    .trim()
    .replace(/^rfc822_/i, "")
    .replace(/^<|>$/g, "")
    .trim()
}

/** A Gmail API id is 16+ hex characters with no "@"; an RFC Message-ID always has an "@". */
export function isGmailId(id: unknown): boolean {
  return /^[0-9a-f]{12,24}$/i.test(String(id ?? "").trim())
}

const lower = (s: string) => s.trim().toLowerCase()

/**
 * Who a reply goes to. To: the original's Reply-To (or From); with `all`, plus its To, and its CC
 * stays CC. Yourself — every address this machine sends as — is removed. If that empties To (you
 * are replying to your own sent message), the original's To becomes the To, as mail clients do.
 */
export function replyRecipients(orig: MailEnvelope, me: string[], all: boolean): { to: string[]; cc: string[] } {
  const mine = new Set(me.map(lower))
  const notMe = (a: string) => !mine.has(lower(a))
  const sender = splitAddresses(orig.reply_to || orig.from)
  let to = splitAddresses(sender, all ? orig.to : []).filter(notMe)
  if (to.length === 0) to = splitAddresses(orig.to).filter(notMe)
  const inTo = new Set(to.map(lower))
  const cc = all ? splitAddresses(orig.cc).filter(notMe).filter((a) => !inTo.has(lower(a))) : []
  return { to, cc }
}

export function replySubject(subject: string): string {
  const s = String(subject ?? "").trim()
  return /^re:/i.test(s) ? s : `Re: ${s}`
}

export interface ComposeInput {
  to: string[]
  cc?: string[]
  bcc?: string[]
  from?: string
  subject?: string
  body: string
  attachments?: string[]
  draft?: boolean
  /** The message being answered. Present → this is a threaded reply. */
  original?: MailEnvelope
}

/** Build the message, or say why it cannot be built. */
export function composeOutgoing(input: ComposeInput): { ok: true; mail: OutgoingMail } | { ok: false; error: string } {
  const to = splitAddresses(input.to)
  const inTo = new Set(to.map(lower))
  // An address appears once: To beats CC beats BCC.
  const cc = splitAddresses(input.cc).filter((a) => !inTo.has(lower(a)))
  const inToCc = new Set([...inTo, ...cc.map(lower)])
  const bcc = splitAddresses(input.bcc).filter((a) => !inToCc.has(lower(a)))

  if (!to.length) return { ok: false, error: "no To address" }
  const bad = [...to, ...cc, ...bcc].filter((a) => !ADDRESS.test(a))
  if (bad.length) return { ok: false, error: `not an email address: ${bad.join(", ")}` }
  if (!String(input.body ?? "").trim()) return { ok: false, error: "empty body" }

  const orig = input.original
  const subject = input.subject?.trim() ? input.subject : orig ? replySubject(orig.subject) : ""
  if (!subject) return { ok: false, error: "no subject" }

  const headers: OutgoingMail["headers"] = {}
  let reply: OutgoingMail["reply"]
  if (orig) {
    const id = normalizeMessageId(orig.message_id)
    if (!id) return { ok: false, error: "the original message has no Message-ID to thread on" }
    const refs = splitRefs([...(orig.references ?? []), id])
    headers["In-Reply-To"] = `<${id}>`
    headers.References = refs.map((r) => `<${r}>`).join(" ")
    reply = { messageId: id, account: orig.account, mailbox: orig.mailbox, gmailId: orig.gmail_id, threadId: orig.thread_id }
  }

  return {
    ok: true,
    mail: {
      ...(input.from ? { from: input.from } : {}),
      to,
      cc,
      bcc,
      subject,
      body: input.body,
      headers,
      ...(reply ? { reply } : {}),
      attachments: (input.attachments ?? []).filter(Boolean),
      draft: Boolean(input.draft),
    },
  }
}

function splitRefs(refs: string[]): string[] {
  const out: string[] = []
  for (const r of refs) {
    for (const one of String(r).match(/<[^>]+>/g) ?? [r]) {
      const id = normalizeMessageId(one)
      if (id && !out.includes(id)) out.push(id)
    }
  }
  return out
}

/** The bridge's POST /api/mail/send body (iris-daemon lib/mail-compose.js parses it). */
export function toBridgePayload(m: OutgoingMail): Record<string, unknown> {
  const p: Record<string, unknown> = {
    // A one-element list stays a plain string: an older bridge understands only that.
    to_email: m.to.length === 1 ? m.to[0] : m.to,
    subject: m.subject,
    body_text: m.body,
  }
  if (m.cc.length) p.cc_email = m.cc
  if (m.bcc.length) p.bcc_email = m.bcc
  if (m.from) p.from_email = m.from
  if (m.attachments.length) p.attachments = m.attachments
  if (m.draft) p.draft = true
  if (m.reply) {
    p.in_reply_to = m.headers["In-Reply-To"]
    p.reply_account = m.reply.account
    p.reply_mailbox = m.reply.mailbox
  }
  return p
}

/**
 * Which bridge capabilities this message depends on. An older bridge ignores fields it does not
 * know: it would send to the first To only, drop the BCC, start a new thread — and say "sent".
 */
export function requiredCapabilities(m: OutgoingMail): Array<"multi_to" | "bcc" | "reply"> {
  const need: Array<"multi_to" | "bcc" | "reply"> = []
  if (m.to.length > 1) need.push("multi_to")
  if (m.bcc.length) need.push("bcc")
  if (m.reply) need.push("reply")
  return need
}

/** Every address on the message, with the field it is in — what lead resolution walks. */
export function allRecipients(m: OutgoingMail): Array<{ address: string; field: "to" | "cc" | "bcc" }> {
  return [
    ...m.to.map((address) => ({ address, field: "to" as const })),
    ...m.cc.map((address) => ({ address, field: "cc" as const })),
    ...m.bcc.map((address) => ({ address, field: "bcc" as const })),
  ]
}
