/**
 * Send one email to several people, and put it on EVERY matching lead's record — the half of
 * `iris mail send` / `iris mail reply` that decides and books, with every outside call injected.
 *
 * #191605. The send assumed one recipient, so a reply-all to Richard and Sean (both leads) with
 * three non-lead CCs could not be logged as one message — `atlas:comms log --cc` could, by hand.
 * This does what that command does, at send time: one message group, one timestamp, one copy per
 * lead, the non-lead addresses recorded on every copy. A copy that does not land is spooled for
 * `iris mail audit`, never just printed.
 *
 * Nothing in here can reach Mail.app, Gmail or the API on its own: the transport, the lead
 * resolver and the log writer are all parameters, which is what lets the tests use fakes.
 */
import { basename } from "node:path"
import type { LeadResolution, UnloggedSend } from "./comms-send"
import { buildLogPayloads, checkLogged, type LogOutcome, type Recipient } from "./comms-log-group"
import {
  allRecipients,
  requiredCapabilities,
  toBridgePayload,
  normalizeMessageId,
  bareAddress,
  splitAddresses,
  type MailEnvelope,
  type OutgoingMail,
} from "./mail-compose"

// ─────────────────────────────────────────────────────────────────────────────
// WHO is it for — every address, answered before anything is sent
// ─────────────────────────────────────────────────────────────────────────────

export interface LeadPlan {
  /** One per lead, with the address it was reached at. */
  leads: Recipient[]
  /** Addresses that are nobody's lead — recorded on every copy, logged to no one. */
  nonLeads: string[]
  /** Addresses more than one lead owns, with no --lead to break the tie. */
  ambiguous: Array<{ address: string; matches: LeadResolution["matches"] }>
  /** Addresses the lead lookup could not answer for (API down). Unknown is not "not a lead". */
  unresolved: Array<{ address: string; error: string }>
}

/**
 * Resolve every recipient. `explicit` (--lead) ids are always logged to, and break a tie for an
 * address they are among the candidates of — the same rule as before, for many addresses.
 */
export async function planLeads(
  m: OutgoingMail,
  resolve: (address: string) => Promise<LeadResolution>,
  explicit: number[] = [],
): Promise<LeadPlan> {
  const plan: LeadPlan = { leads: [], nonLeads: [], ambiguous: [], unresolved: [] }
  const byId = new Map<number, Recipient>()
  const add = (id: number, name: string | null, email: string | null) => {
    const r = byId.get(id)
    if (r) {
      if (!r.email && email) r.email = email
      if (!r.name && name) r.name = name
      return
    }
    const rec: Recipient = { lead_id: id, name, email }
    byId.set(id, rec)
    plan.leads.push(rec)
  }
  for (const id of explicit) add(Number(id), null, null)

  for (const { address } of allRecipients(m)) {
    const r = await resolve(address)
    if (r.reason === "ok" && r.leadId != null) {
      add(r.leadId, r.matches[0]?.name ?? null, address)
    } else if (r.reason === "ambiguous") {
      const pick = r.matches.find((x) => explicit.includes(x.id))
      if (pick) add(pick.id, pick.name ?? null, address)
      else plan.ambiguous.push({ address, matches: r.matches })
    } else if (r.reason === "none") {
      plan.nonLeads.push(address)
    } else {
      plan.unresolved.push({ address, error: r.error ?? "lead lookup failed" })
    }
  }
  return plan
}

/** Why this send must not go out, or null. A refusal sends nothing. */
export function planRefusal(plan: LeadPlan, force: boolean): string | null {
  if (plan.ambiguous.length) {
    const lines = plan.ambiguous.map(
      (a) => `${a.address} matches ${a.matches.length} leads: ${a.matches.map((x) => `--lead ${x.id} (${x.name ?? "no name"})`).join(", ")}`,
    )
    // --force does NOT break a tie: it means "not a lead", and these are leads.
    return `say which lead with --lead <id>:\n  ${lines.join("\n  ")}`
  }
  if (plan.unresolved.length && !force) {
    return `could not check whether ${plan.unresolved.map((u) => u.address).join(", ")} ${plan.unresolved.length === 1 ? "is a lead" : "are leads"} (${plan.unresolved[0].error}). Retry, give --lead <id>, or --force to send unattributed.`
  }
  if (!plan.leads.length && !force) {
    return `no recipient is a lead (${plan.nonLeads.join(", ")}). Attach it with --lead <id>, or send unattributed with --force.`
  }
  return null
}

// ─────────────────────────────────────────────────────────────────────────────
// HOW it goes out — a transport is anything that can deliver an OutgoingMail
// ─────────────────────────────────────────────────────────────────────────────

export interface Delivery {
  ok: boolean
  mode?: "sent" | "draft"
  error?: string
  /** The transport's own answer, for --json. */
  detail?: unknown
  /** The address it actually went out from, when the transport knows (Gmail: the connected mailbox). */
  from?: string | null
  /** The provider's id for the sent message (Gmail message/thread id). Mail.app returns none. */
  messageId?: string | null
  threadId?: string | null
}

export interface Transport {
  name: "apple_mail" | "gmail"
  deliver(m: OutgoingMail): Promise<Delivery>
}

type FetchLike = (path: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<Response>

/**
 * The Mac's IRIS bridge. Checks GET /api/mail/capabilities first whenever the message needs more
 * than the old one-To contract: an older bridge would quietly send a smaller, unthreaded message.
 */
export function bridgeTransport(bridgeFetch: FetchLike): Transport {
  return {
    name: "apple_mail",
    async deliver(m) {
      const need = requiredCapabilities(m)
      if (need.length) {
        const caps = (await bridgeFetch("/api/mail/capabilities")
          .then(async (r) => (r.ok ? ((await r.json().catch(() => null)) as Record<string, unknown> | null) : null))
          .catch(() => null)) as Record<string, unknown> | null
        const missing = need.filter((k) => caps?.[k] !== true)
        if (missing.length) {
          return {
            ok: false,
            error: `the IRIS bridge on this Mac cannot do ${missing.join(", ")} yet — nothing was sent. Update it (iris daemon restart after updating iris-daemon), or send via Gmail with --via gmail.`,
          }
        }
      }
      const res = await bridgeFetch("/api/mail/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(toBridgePayload(m)),
      }).catch((e: any) => ({ ok: false, status: 0, text: async () => String(e?.message ?? e), json: async () => null }) as unknown as Response)
      if (!res.ok) return { ok: false, error: `${await res.text().catch(() => "unknown error")}` }
      const body = (await res.json().catch(() => ({}))) as { mode?: string; message_id?: string; from_email?: string }
      // The bridge's own `mode`, not our intent: only it knows whether Mail sent or opened a window.
      return {
        ok: true,
        mode: body.mode === "draft" ? "draft" : "sent",
        detail: body,
        // --from is checked against Mail.app's accounts by the bridge (a 422 otherwise), so the
        // address asked for is the address it went from. Without --from, Mail's default account
        // sent it and the bridge does not say which: recorded as unknown, never guessed.
        from: body.from_email ?? m.from ?? null,
        messageId: body.message_id ?? null,
      }
    },
  }
}

type GmailExec = (action: string, params: Record<string, unknown>) => Promise<any>

/**
 * Gmail through the API (Composio GMAIL_REPLY_TO_THREAD / GMAIL_CREATE_EMAIL_DRAFT on the server).
 * Does not need the Mac. A Gmail reply always goes To the original's sender — the server sets it
 * — so every other recipient rides as CC, and a different first To is refused, not rewritten.
 */
export function gmailTransport(exec: GmailExec, mailbox: () => string | null | undefined = () => null): Transport {
  return {
    name: "gmail",
    async deliver(m) {
      if (m.attachments.length) return { ok: false, error: "the Gmail route cannot attach files yet — use the Mac route" }
      if (m.from) return { ok: false, error: "the Gmail route sends from the connected mailbox; choose it with iris gmail --account, not --from" }
      try {
        if (m.draft) {
          const r = await exec("create_draft", {
            to: m.to.join(", "),
            cc: m.cc.join(", "),
            bcc: m.bcc.join(", "),
            subject: m.subject,
            body: m.body,
            ...(m.reply?.gmailId ? { message_id: m.reply.gmailId } : {}),
          })
          if (r?.success === false) return { ok: false, error: String(r.error ?? "create_draft failed") }
          return { ok: true, mode: "draft", detail: r }
        }
        if (!m.reply?.gmailId) {
          return { ok: false, error: "the Gmail route can only send a reply in a thread (or a draft) — give --reply-to, or add --draft" }
        }
        const r = await exec("reply_to_email", {
          message_id: m.reply.gmailId,
          body: m.body,
          // To[0] is the original sender (checked by the caller); everyone else is CC.
          cc: [...m.to.slice(1), ...m.cc].join(", "),
          bcc: m.bcc.join(", "),
        })
        if (r?.success === false) return { ok: false, error: String(r.error ?? "reply_to_email failed") }
        return {
          ok: true,
          mode: "sent",
          detail: r,
          from: mailbox() ?? null,
          messageId: r?.message_id ?? r?.id ?? null,
          threadId: r?.thread_id ?? null,
        }
      } catch (e: any) {
        return { ok: false, error: String(e?.message ?? e) }
      }
    },
  }
}

/** Gmail's reply goes To the original sender. Say so before sending, rather than send something else. */
export function gmailReplyMismatch(m: OutgoingMail, orig: MailEnvelope | undefined): string | null {
  if (!orig || m.draft) return null
  const sender = splitAddresses(orig.reply_to || orig.from)[0]
  if (sender && m.to[0]?.toLowerCase() !== sender.toLowerCase()) {
    return `a Gmail reply always goes To the original sender (${sender}); put ${m.to[0]} in --cc, or use the Mac route`
  }
  return null
}

// ─────────────────────────────────────────────────────────────────────────────
// SEND, then BOOK — one message, one group, a copy per lead
// ─────────────────────────────────────────────────────────────────────────────

export interface LogSink {
  post(body: Record<string, unknown>): Promise<{ status: number; payload: any }>
  spool(entry: UnloggedSend): Promise<string | null>
}

export interface SendReport {
  sent: boolean
  drafted: boolean
  error?: string
  transport: Transport["name"]
  groupId: string
  sentAt: string
  results: Array<{ lead_id: number; name: string | null; outcome: LogOutcome; error?: string }>
  /** Copies that went out but are not on the record — each one is in the spool. */
  spooled: Array<{ lead_id?: number; path: string | null; reason: string }>
  detail?: unknown
}

export async function sendAndLog(
  m: OutgoingMail,
  plan: LeadPlan,
  deps: { transport: Transport; log: LogSink; now: () => string; groupId: string; origin: string },
): Promise<SendReport> {
  const sentAt = deps.now()
  const report: SendReport = {
    sent: false,
    drafted: false,
    transport: deps.transport.name,
    groupId: deps.groupId,
    sentAt,
    results: [],
    spooled: [],
  }

  const d = await deps.transport.deliver(m)
  report.detail = d.detail
  if (!d.ok) {
    report.error = d.error ?? "send failed"
    return report
  }
  if (d.mode === "draft") {
    // Nothing went anywhere. Logging a draft would put a message on a lead's record they never got.
    report.drafted = true
    return report
  }
  report.sent = true

  // #184795 / #183515 / #181928: the record is of what was SENT — who it was from, every
  // recipient, the files on it and the provider's id — not only of who it was for. Before this,
  // --from and --attachment reached the bridge and never the comms row.
  const from = d.from ?? m.from ?? null
  const logInput = {
    channel: deps.transport.name,
    direction: "outbound",
    body: m.body,
    subject: m.subject,
    sentAt,
    groupId: deps.groupId,
    cc: plan.nonLeads,
    toIdentifiers: m.to,
    fromIdentifier: from,
    loggedVia: deps.origin,
    metadata: {
      ...(from ? { from } : {}),
      to: m.to,
      cc_all: m.cc,
      ...(m.bcc.length ? { bcc: m.bcc } : {}),
      // Names only: a local path says nothing to anyone reading the lead and leaks the sender's disk.
      ...(m.attachments.length ? { attachments: m.attachments.map((a) => basename(a)) } : {}),
      ...(m.headers["In-Reply-To"] ? { in_reply_to: m.headers["In-Reply-To"], references: m.headers.References } : {}),
      provider: deps.transport.name,
      ...(d.messageId ? { provider_message_id: d.messageId } : {}),
      ...(d.threadId ? { provider_thread_id: d.threadId } : {}),
    },
  }

  // The spool keeps the exact row that should have been written, so `iris mail audit --backfill`
  // writes THAT (same group id — idempotent per lead), not a thinner copy without from/cc/files.
  const spoolEntry = (leadId: number | undefined, reason: string, payload: Record<string, unknown>): UnloggedSend => ({
    at: sentAt,
    channel: deps.transport.name,
    to: [...m.to, ...m.cc, ...m.bcc].join(", "),
    subject: m.subject,
    message: m.body,
    ...(leadId != null ? { leadId } : {}),
    reason,
    origin: deps.origin,
    ...(from ? { from } : {}),
    payload,
  })

  if (!plan.leads.length) {
    // No lead to hang it on: the row is kept whole, lead-less, for `iris mail audit --backfill --lead <id>`.
    const [template] = buildLogPayloads([{ lead_id: 0, name: null, email: null }], logInput)
    const { lead_id: _none, ...payload } = template
    payload.metadata = { ...payload.metadata, recipients: [] }
    const path = await deps.log.spool(spoolEntry(undefined, "sent with --force and no lead to attach it to", payload))
    report.spooled.push({ path, reason: "no lead" })
    return report
  }

  const payloads = buildLogPayloads(plan.leads, logInput)

  for (const body of payloads) {
    const who = plan.leads.find((r) => r.lead_id === body.lead_id)!
    let status = 0
    let payload: any = null
    try {
      ;({ status, payload } = await deps.log.post(body))
    } catch (e: any) {
      payload = { error: `could not reach the comms API: ${e?.message ?? e}` }
    }
    const outcome = checkLogged(body.lead_id, status, payload?.data?.record ?? payload?.data)
    const error = outcome === "failed" || outcome === "wrong_lead" ? String(payload?.error ?? payload?.message ?? `HTTP ${status}`) : undefined
    report.results.push({ lead_id: body.lead_id, name: who.name, outcome, ...(error ? { error } : {}) })
    if (error) {
      const path = await deps.log.spool(spoolEntry(body.lead_id, outcome === "wrong_lead" ? "server returned another lead's record" : error, body))
      report.spooled.push({ lead_id: body.lead_id, path, reason: error })
    }
  }
  return report
}

// ─────────────────────────────────────────────────────────────────────────────
// The original message — for a reply
// ─────────────────────────────────────────────────────────────────────────────

/** Bridge GET /api/mail/message → envelope. */
export async function lookupOnMac(bridgeFetch: FetchLike, messageId: string, account?: string): Promise<MailEnvelope | { error: string }> {
  const q = new URLSearchParams({ id: normalizeMessageId(messageId) })
  if (account) q.set("account", account)
  let res: Response
  try {
    res = await bridgeFetch(`/api/mail/message?${q}`)
  } catch (e: any) {
    return { error: `could not reach the IRIS bridge: ${e?.message ?? e}` }
  }
  const body = (await res.json().catch(() => null)) as any
  if (res.status === 404 && !body?.error) return { error: "this IRIS bridge has no message lookup — update iris-daemon" }
  if (!res.ok || !body?.ok) return { error: body?.error ?? `HTTP ${res.status}` }
  return {
    message_id: normalizeMessageId(body.message_id),
    subject: String(body.subject ?? ""),
    from: bareAddress(String(body.from ?? "")),
    reply_to: body.reply_to ? bareAddress(String(body.reply_to)) : null,
    to: splitAddresses(body.to),
    cc: splitAddresses(body.cc),
    references: Array.isArray(body.references) ? body.references.map(normalizeMessageId) : [],
    account: body.account,
    mailbox: body.mailbox,
  }
}

/** Gmail get_email (server GmailMessageParser shape) → envelope. */
export function envelopeFromGmail(e: any): MailEnvelope {
  return {
    message_id: normalizeMessageId(e?.message_id_header ?? ""),
    subject: String(e?.subject ?? ""),
    from: bareAddress(String(e?.from ?? "")),
    reply_to: e?.reply_to ? bareAddress(String(e.reply_to)) : null,
    to: splitAddresses(e?.to),
    cc: splitAddresses(e?.cc),
    references: String(e?.references ?? "").match(/<[^>]+>/g)?.map(normalizeMessageId) ?? [],
    gmail_id: String(e?.id ?? ""),
    thread_id: String(e?.thread_id ?? ""),
  }
}
