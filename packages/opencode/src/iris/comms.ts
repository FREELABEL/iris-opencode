import { FL_API, irisFetch, resolveUserId, tokenSource, type PlatformResult } from "./platform"

/**
 * THE PEOPLE INBOX (#192688) — conversations with leads, across every channel the platform logs.
 *
 * Desktop's other inbox (`/iris/inbox`) is the Hive inbox: messages between your own computers. This
 * one reads fl-api's unified comms log (`lead_comms`, `GET /api/v1/atlas/comms`) — the table Elon's
 * UnifiedInboxTimeline draws. Elon asks `/atlas/comms/inbox`, which answered 500 unfiltered on
 * 2026-11-06 (its Redis path); the paged index answers, filters by direction / channel / board / date,
 * and carries every field a thread needs.
 *
 * READS: inbound messages in the window → one conversation per lead (or per sender, for a contact
 * form with no lead yet). For each, the lead's latest messages in every direction — that is what
 * decides "needs reply" (the last word was theirs) — and the lead's card for its name. Cached for a
 * minute; a send clears it.
 *
 * WRITES: a send is the only one, and it is refused unless the caller says `confirm: true` — the
 * panel's confirm dialog is the person's yes. An AI-drafted text is also refused until the person
 * approved it (`origin: "ai"` needs `approved: true`). Drafting sends nothing.
 */

/** The seam a test replaces: the platform call and who is signed in. */
export const commsDeps = {
  fetch: (path: string, init?: RequestInit) => irisFetch(path, FL_API, init),
  userId: () => resolveUserId(),
  now: () => Date.now(),
}

export type Direction = "inbound" | "outbound"
export interface CommsMessage {
  id: number
  leadId?: number
  bloqId?: number
  channel: string
  direction: Direction
  from?: string
  to: string[]
  subject?: string
  body: string
  sentAt: string
  /** Who filled a contact form, when the platform recorded it. */
  senderName?: string
}

export interface Conversation {
  /** `lead:<id>`, or `from:<identifier>` for a sender who is not a lead yet. */
  key: string
  leadId?: number
  bloqId?: number
  name: string
  /** Where the last message went or came from. */
  channel: string
  channels: string[]
  lastAt: string
  lastDirection: Direction
  preview: string
  subject?: string
  /** The newest message they sent, which is what "unread" is measured against on this computer. */
  lastInboundAt?: string
  inbound: number
  outbound: number
  /** Their message was the last one. */
  needsReply: boolean
  /** The lead is assigned to the signed-in person (lead assignees). */
  assigned: boolean
  status?: string
}

export interface ConversationsResult {
  conversations: Conversation[]
  /** Conversations found in the window, before the list was capped. */
  total: number
  days: number
  /** The inbound scan stopped at its page cap: older messages in the window were not read. */
  truncated: boolean
  counts: { all: number; needsReply: number; assigned: number; channels: Record<string, number> }
}

const PER_PAGE = 100
const MAX_INBOUND_PAGES = 5
/** Conversations whose lead is read in full (latest messages + card). The rest are not listed. */
export const MAX_CONVERSATIONS = 60
const THREAD_TAIL = 25
const CACHE_MS = 60_000
const LEAD_CACHE_MS = 10 * 60_000

const str = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v : undefined)
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : undefined)

export function commsRow(r: any): CommsMessage {
  const to = Array.isArray(r?.to_identifiers) ? r.to_identifiers.filter((x: unknown): x is string => typeof x === "string") : []
  return {
    id: Number(r?.id),
    leadId: num(r?.lead_id),
    bloqId: num(r?.bloq_id),
    channel: str(r?.channel) ?? "other",
    direction: r?.direction === "outbound" ? "outbound" : "inbound",
    from: str(r?.from_identifier),
    to,
    subject: str(r?.subject),
    body: String(r?.body ?? ""),
    sentAt: String(r?.sent_at ?? r?.created_at ?? ""),
    senderName: str(r?.metadata?.submitter_name),
  }
}

/** A lead's name the way Leads shows it. */
export function leadName(l: any): string | undefined {
  return str(l?.nickname) ?? str(l?.name) ?? str(l?.first_name) ?? str(l?.email)
}

/** Group messages (any order) into conversations, newest first. Pure: the tests drive it directly. */
export function groupConversations(
  messages: CommsMessage[],
  leads: Map<number, any>,
  assignedIds: Set<number>,
): Conversation[] {
  const by = new Map<string, CommsMessage[]>()
  for (const m of messages) {
    const key = m.leadId ? `lead:${m.leadId}` : `from:${(m.from ?? m.senderName ?? `comm-${m.id}`).toLowerCase()}`
    const list = by.get(key) ?? []
    if (!list.some((x) => x.id === m.id)) list.push(m)
    by.set(key, list)
  }
  return [...by.entries()]
    .map(([key, list]) => {
      const sorted = list.slice().sort((a, b) => b.sentAt.localeCompare(a.sentAt) || b.id - a.id)
      const last = sorted[0]
      const lastIn = sorted.find((m) => m.direction === "inbound")
      const lead = last.leadId ? leads.get(last.leadId) : undefined
      return {
        key,
        leadId: last.leadId,
        bloqId: last.bloqId ?? sorted.find((m) => m.bloqId)?.bloqId,
        name: leadName(lead) ?? lastIn?.senderName ?? (last.leadId ? `Lead #${last.leadId}` : (lastIn?.from ?? "Unknown")),
        channel: last.channel,
        channels: [...new Set(sorted.map((m) => m.channel))],
        lastAt: last.sentAt,
        lastDirection: last.direction,
        preview: last.body.replace(/\s+/g, " ").trim().slice(0, 160),
        subject: last.subject ?? lastIn?.subject,
        lastInboundAt: lastIn?.sentAt,
        inbound: sorted.filter((m) => m.direction === "inbound").length,
        outbound: sorted.filter((m) => m.direction === "outbound").length,
        needsReply: last.direction === "inbound",
        assigned: !!last.leadId && assignedIds.has(last.leadId),
        status: str(lead?.status),
      } satisfies Conversation
    })
    .sort((a, b) => b.lastAt.localeCompare(a.lastAt))
}

export function countConversations(list: Conversation[]): ConversationsResult["counts"] {
  const channels: Record<string, number> = {}
  for (const c of list) for (const ch of c.channels) channels[ch] = (channels[ch] ?? 0) + 1
  return {
    all: list.length,
    needsReply: list.filter((c) => c.needsReply).length,
    assigned: list.filter((c) => c.assigned).length,
    channels,
  }
}

async function getJson(path: string): Promise<{ ok: boolean; status: number; body: any }> {
  try {
    const res = await commsDeps.fetch(path)
    return { ok: res.ok, status: res.status, body: await res.json().catch(() => null) }
  } catch (e) {
    return { ok: false, status: 0, body: { error: e instanceof Error ? e.message : String(e) } }
  }
}
const why = (r: { status: number; body: any }) => r.body?.error ?? r.body?.message ?? (r.status ? `fl-api ${r.status}` : "fl-api unreachable")
const pageOf = (body: any) => (body?.data?.data ?? body?.data ?? []) as any[]

/** A few at a time: a lead read per conversation is how the platform answers, so it is bounded. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++
        out[i] = await fn(items[i])
      }
    }),
  )
  return out
}

const leadCache = new Map<number, { at: number; lead: any }>()
async function readLead(id: number): Promise<any | undefined> {
  const hit = leadCache.get(id)
  if (hit && commsDeps.now() - hit.at < LEAD_CACHE_MS) return hit.lead
  const r = await getJson(`/api/v1/leads/${id}`)
  if (!r.ok) return undefined
  const lead = r.body?.data ?? r.body
  leadCache.set(id, { at: commsDeps.now(), lead })
  return lead
}

async function readAssigned(userId: number): Promise<Set<number>> {
  const ids = new Set<number>()
  for (let page = 1; page <= 4; page++) {
    const r = await getJson(`/api/v1/users/${userId}/assigned-leads?per_page=100&page=${page}`)
    if (!r.ok) break
    const rows = pageOf(r.body)
    for (const l of rows) {
      const id = num(l?.id) ?? num(l?.lead_id)
      if (id) ids.add(id)
    }
    const last = num(r.body?.data?.last_page) ?? 1
    if (page >= last || rows.length === 0) break
  }
  return ids
}

let listCache: { key: string; at: number; result: PlatformResult<ConversationsResult> } | undefined
export function clearCommsCache() {
  listCache = undefined
}

export async function fetchConversations(q: { days?: number; bloqId?: number; refresh?: boolean }): Promise<PlatformResult<ConversationsResult>> {
  const days = Math.min(Math.max(Math.round(q.days ?? 14), 1), 90)
  const empty: ConversationsResult = { conversations: [], total: 0, days, truncated: false, counts: { all: 0, needsReply: 0, assigned: 0, channels: {} } }
  const userId = await commsDeps.userId()
  if (!userId) return { measured: false, reason: `not signed in (token: ${tokenSource()})`, data: empty }
  const key = `${userId}:${days}:${q.bloqId ?? ""}`
  if (!q.refresh && listCache?.key === key && commsDeps.now() - listCache.at < CACHE_MS) return listCache.result

  const from = new Date(commsDeps.now() - days * 86_400_000).toISOString().slice(0, 19).replace("T", " ")
  const base = new URLSearchParams({ direction: "inbound", from, per_page: String(PER_PAGE) })
  if (q.bloqId) base.set("bloq_id", String(q.bloqId))
  const inbound: CommsMessage[] = []
  let truncated = false
  for (let page = 1; page <= MAX_INBOUND_PAGES; page++) {
    base.set("page", String(page))
    const r = await getJson(`/api/v1/atlas/comms?${base}`)
    if (!r.ok) {
      if (page === 1) return { measured: false, reason: why(r), data: empty }
      truncated = true
      break
    }
    inbound.push(...pageOf(r.body).map(commsRow))
    const last = num(r.body?.data?.last_page) ?? 1
    if (page >= last) break
    if (page === MAX_INBOUND_PAGES) truncated = true
  }

  // The newest conversations first; only those are read in full.
  const firstPass = groupConversations(inbound, new Map(), new Set())
  const shown = firstPass.slice(0, MAX_CONVERSATIONS)
  const leadIds = shown.flatMap((c) => (c.leadId ? [c.leadId] : []))
  const [tails, leadRows, assigned] = await Promise.all([
    mapLimit(leadIds, 8, async (id) => {
      const r = await getJson(`/api/v1/atlas/comms?lead_id=${id}&per_page=${THREAD_TAIL}`)
      return r.ok ? pageOf(r.body).map(commsRow) : []
    }),
    mapLimit(leadIds, 8, readLead),
    readAssigned(userId),
  ])
  const leads = new Map<number, any>()
  leadIds.forEach((id, i) => leadRows[i] && leads.set(id, leadRows[i]))
  const shownKeys = new Set(shown.map((c) => c.key))
  const messages = [...inbound.filter((m) => shownKeys.has(m.leadId ? `lead:${m.leadId}` : `from:${(m.from ?? m.senderName ?? `comm-${m.id}`).toLowerCase()}`)), ...tails.flat()]
  const conversations = groupConversations(messages, leads, assigned)
  const result: PlatformResult<ConversationsResult> = {
    measured: true,
    data: { conversations, total: firstPass.length, days, truncated, counts: countConversations(conversations) },
  }
  listCache = { key, at: commsDeps.now(), result }
  return result
}

// ─── One conversation ──────────────────────────────────────────────────────────

export interface LeadCard {
  id: number
  name: string
  status?: string
  email?: string
  phone?: string
  company?: string
  website?: string
  instagram?: string
  city?: string
  country?: string
  hasReplied: boolean
  repliedAt?: string
  score?: number
  value?: number
  source?: string
  createdAt?: string
}

export interface SequenceStep {
  id: number
  title: string
  type?: string
  order?: number
  done: boolean
  dueDate?: string
  completedAt?: string
  automation?: string
}

export interface AiMessage {
  id: number
  type?: string
  direction: Direction
  status?: string
  text: string
  subject?: string
  at?: string
  account?: string
}

export interface ThreadResult {
  lead?: LeadCard
  messages: CommsMessage[]
  /** The lead's outreach sequence, in order. `current` is the first step not done. */
  steps: SequenceStep[]
  progress?: { total: number; completed: number; percent: number }
  currentStep?: SequenceStep
  /** Messages the platform records as written by AI, newest first (Elon kept these in the browser). */
  aiHistory: AiMessage[]
  outreachStats?: { total: number; outbound: number; inbound: number; replied: number }
  /** Where a reply can go, from the lead's card: email address, phone, Instagram handle. */
  replyTo: { email?: string; sms?: string; instagram?: string }
}

export function leadCard(l: any): LeadCard | undefined {
  const id = num(l?.id)
  if (!id) return undefined
  const ig = str(l?.contact_info?.instagram)?.replace(/^@/, "")
  return {
    id,
    name: leadName(l) ?? `Lead #${id}`,
    status: str(l?.status),
    email: str(l?.email),
    phone: str(l?.phone),
    company: str(l?.company),
    website: str(l?.website),
    instagram: ig,
    city: str(l?.city),
    country: str(l?.country),
    hasReplied: !!l?.has_replied,
    repliedAt: str(l?.replied_at),
    score: num(l?.lead_score),
    value: num(l?.price_bid),
    source: str(l?.source),
    createdAt: str(l?.created_at),
  }
}

export function sequenceOf(body: any): Pick<ThreadResult, "steps" | "progress" | "currentStep"> {
  const d = body?.data ?? body
  const raw = (Array.isArray(d) ? d : (d?.steps ?? [])) as any[]
  const steps = raw
    .map(
      (s): SequenceStep => ({
        id: Number(s?.id),
        title: str(s?.title) ?? str(s?.type) ?? "Step",
        type: str(s?.type),
        order: num(s?.order),
        done: !!s?.is_completed || !!s?.completed_at,
        dueDate: str(s?.due_date),
        completedAt: str(s?.completed_at),
        automation: str(s?.automation_status),
      }),
    )
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  const st = d?.stats
  const progress = st && num(st.total) !== undefined
    ? { total: num(st.total)!, completed: num(st.completed) ?? 0, percent: num(st.progress_percent) ?? 0 }
    : steps.length
      ? { total: steps.length, completed: steps.filter((s) => s.done).length, percent: Math.round((steps.filter((s) => s.done).length / steps.length) * 100) }
      : undefined
  return { steps, progress, currentStep: steps.find((s) => !s.done) }
}

export function aiHistoryOf(body: any): AiMessage[] {
  const rows = (body?.messages ?? body?.data ?? []) as any[]
  return rows
    .filter((m) => !!m?.generated_by_ai)
    .map((m) => ({
      id: Number(m.id),
      type: str(m.type),
      direction: m.direction === "inbound" ? ("inbound" as const) : ("outbound" as const),
      status: str(m.status),
      text: String(m.message ?? "").replace(/<[^>]+>/g, "").trim(),
      subject: str(m.subject),
      at: str(m.sent_at) ?? str(m.created_at),
      account: str(m.channel_account),
    }))
}

export async function fetchThread(leadId: number): Promise<PlatformResult<ThreadResult>> {
  const empty: ThreadResult = { messages: [], steps: [], aiHistory: [], replyTo: {} }
  const [comms, lead, steps, outreach] = await Promise.all([
    getJson(`/api/v1/atlas/comms?lead_id=${leadId}&per_page=100`),
    getJson(`/api/v1/leads/${leadId}`),
    getJson(`/api/v1/leads/${leadId}/outreach-steps`),
    getJson(`/api/v1/leads/${leadId}/outreach/messages?limit=50`),
  ])
  if (!comms.ok) return { measured: false, reason: why(comms), data: empty }
  const card = lead.ok ? leadCard(lead.body?.data ?? lead.body) : undefined
  const st = outreach.body?.stats
  return {
    measured: true,
    reason: lead.ok ? undefined : `lead card: ${why(lead)}`,
    data: {
      lead: card,
      // Oldest first, the way a thread reads.
      messages: pageOf(comms.body).map(commsRow).sort((a, b) => a.sentAt.localeCompare(b.sentAt) || a.id - b.id),
      ...(steps.ok ? sequenceOf(steps.body) : { steps: [] }),
      aiHistory: outreach.ok ? aiHistoryOf(outreach.body) : [],
      outreachStats: outreach.ok && st ? { total: num(st.total) ?? 0, outbound: num(st.outbound) ?? 0, inbound: num(st.inbound) ?? 0, replied: num(st.replied) ?? 0 } : undefined,
      replyTo: { email: card?.email, sms: card?.phone, instagram: card?.instagram },
    },
  }
}

// ─── Drafting: sends nothing ─────────────────────────────────────────────────

export type ReplyChannel = "email" | "sms" | "instagram"
export const REPLY_CHANNELS: ReplyChannel[] = ["email", "sms", "instagram"]
export interface Draft {
  tone?: string
  subject?: string
  text: string
}
export interface DraftResult {
  drafts: Draft[]
  /** The platform could not reach its model and answered with its canned lines. */
  fallback: boolean
}

const DEFAULT_PROMPT = "Write a short, friendly reply to their latest message. Answer what they asked and suggest one next step."

/** The channel a conversation's last message was on, as a channel a reply can go out on. */
export function replyChannelFor(channel: string): ReplyChannel | undefined {
  if (channel === "instagram") return "instagram"
  if (channel === "sms" || channel === "imessage" || channel === "whatsapp") return "sms"
  if (/mail/.test(channel) || channel === "contact_form") return "email"
  return undefined
}

async function postJson(path: string, body: unknown): Promise<{ ok: boolean; status: number; body: any }> {
  try {
    const res = await commsDeps.fetch(path, { method: "POST", body: JSON.stringify(body) })
    return { ok: res.ok, status: res.status, body: await res.json().catch(() => null) }
  } catch (e) {
    return { ok: false, status: 0, body: { error: e instanceof Error ? e.message : String(e) } }
  }
}

export async function draftReply(a: { leadId: number; channel: ReplyChannel; prompt?: string }): Promise<PlatformResult<DraftResult>> {
  const empty = { drafts: [], fallback: false }
  const prompt = str(a.prompt) ?? DEFAULT_PROMPT
  const lead = `/api/v1/leads/${a.leadId}/outreach`
  const r =
    a.channel === "instagram"
      ? await postJson(`${lead}/reply-suggestions`, {})
      : a.channel === "sms"
        ? await postJson(`${lead}/generate-sms`, { prompt: prompt.slice(0, 500) })
        : await postJson(`${lead}/generate-email`, { prompt: prompt.slice(0, 1000), tone: "friendly", max_length: "short" })
  if (!r.ok || r.body?.success === false) return { measured: false, reason: why(r), data: empty }
  if (a.channel === "instagram") {
    const drafts = ((r.body?.suggestions ?? []) as any[]).flatMap((s) => (str(s?.text) ? [{ tone: str(s?.tone), text: String(s.text) }] : []))
    return { measured: true, data: { drafts, fallback: !!r.body?.fallback } }
  }
  const d = r.body?.draft
  const text = String(d?.body ?? "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>\s*<p>/gi, "\n\n").replace(/<[^>]+>/g, "").trim()
  if (!text) return { measured: false, reason: "The platform answered with an empty draft", data: empty }
  return { measured: true, data: { drafts: [{ subject: str(d?.subject), text }], fallback: false } }
}

// ─── Sending: the only write, behind a yes ───────────────────────────────────

export interface SendInput {
  leadId: number
  channel: ReplyChannel
  text: string
  to?: string
  subject?: string
  /** Who wrote the text: the person, or an AI draft they took. */
  origin: "person" | "ai"
  /** The person approved the AI draft before it was put in the composer. */
  approved?: boolean
  /** The person said yes in the panel's confirm. Without it, nothing is sent. */
  confirm?: boolean
  bloqId?: number
}
export interface SendResult {
  ok: boolean
  reason?: string
  channel: ReplyChannel
  /** What the platform said, for the panel to show. */
  detail?: string
}

/** Why a send must not go, or undefined. Pure: the panel uses the same words before it asks. */
export function sendRefusal(a: Pick<SendInput, "channel" | "text" | "to" | "subject" | "origin" | "approved" | "confirm">): string | undefined {
  if (!a.text?.trim()) return "Nothing to send: the message is empty."
  if (a.origin === "ai" && a.approved !== true) return "Not sent: an AI draft has to be approved by you before it can be sent."
  if (a.confirm !== true) return "Not sent: a send needs your confirmation."
  if (a.channel === "email" && !str(a.to)) return "Not sent: this lead has no email address."
  if (a.channel === "email" && !str(a.subject)) return "Not sent: an email needs a subject."
  if (a.channel === "sms" && !str(a.to)) return "Not sent: this lead has no phone number."
  if (a.channel === "sms" && a.text.length > 1600) return "Not sent: an SMS is at most 1,600 characters."
  if (a.channel === "instagram" && a.text.length > 2000) return "Not sent: an Instagram reply is at most 2,000 characters."
  return undefined
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

export async function sendReply(a: SendInput): Promise<PlatformResult<SendResult>> {
  const refused = sendRefusal(a)
  if (refused) return { measured: true, data: { ok: false, reason: refused, channel: a.channel } }
  const lead = `/api/v1/leads/${a.leadId}/outreach`
  const text = a.text.trim()
  const r =
    a.channel === "email"
      ? await postJson(`${lead}/send-email`, {
          to_email: a.to,
          subject: a.subject,
          body_text: text,
          body_html: escapeHtml(text).replace(/\n/g, "<br>"),
          plain_text_only: true,
        })
      : a.channel === "sms"
        ? await postJson(`${lead}/send-sms`, { to_phone: a.to, body: text })
        : await postJson(`${lead}/send-dm-reply`, { message: text, ...(a.bloqId ? { bloq_id: a.bloqId } : {}), ...(a.to ? { handle: a.to.replace(/^@/, "") } : {}) })
  clearCommsCache()
  if (!r.ok || r.body?.success === false) return { measured: true, data: { ok: false, reason: why(r), channel: a.channel } }
  return { measured: true, data: { ok: true, channel: a.channel, detail: str(r.body?.message) } }
}
