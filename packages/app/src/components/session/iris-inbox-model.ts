/**
 * THE PEOPLE INBOX, as pure functions (#192688). Elon's UnifiedInboxTimeline / LeadOutreachTab
 * behaviour — conversations across channels, filters with counts, a thread, AI-drafted replies — with
 * the rules written where a test can hold them: what "unread" means without a platform read flag, what
 * each filter counts, and the one gate that matters, that nothing goes out without the person.
 *
 * The engine routes are /iris/comms, /iris/comms/thread/:id, /iris/comms/draft and /iris/comms/send
 * (packages/opencode/src/iris/comms.ts). Not the Hive inbox, which is /iris/inbox (Inbox › Computers).
 */

export type Direction = "inbound" | "outbound"
export type ReplyChannel = "email" | "sms" | "instagram"

export interface Conversation {
  key: string
  leadId?: number
  bloqId?: number
  name: string
  channel: string
  channels: string[]
  lastAt: string
  lastDirection: Direction
  preview: string
  subject?: string
  lastInboundAt?: string
  inbound: number
  outbound: number
  needsReply: boolean
  assigned: boolean
  status?: string
}
export interface ConversationsAnswer {
  measured: boolean
  reason?: string
  conversations: Conversation[]
  total: number
  days: number
  truncated: boolean
  counts: { all: number; needsReply: number; assigned: number; channels: Record<string, number> }
}
export interface CommsMessage {
  id: number
  leadId?: number
  channel: string
  direction: Direction
  from?: string
  to: string[]
  subject?: string
  body: string
  sentAt: string
  senderName?: string
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
export interface ThreadAnswer {
  measured: boolean
  reason?: string
  lead?: LeadCard
  messages: CommsMessage[]
  steps: SequenceStep[]
  progress?: { total: number; completed: number; percent: number }
  currentStep?: SequenceStep
  aiHistory: AiMessage[]
  outreachStats?: { total: number; outbound: number; inbound: number; replied: number }
  replyTo: { email?: string; sms?: string; instagram?: string }
}
export interface Draft {
  tone?: string
  subject?: string
  text: string
}

// ─── Channels ──────────────────────────────────────────────────────────────────

/** fl-api logs Gmail four ways (gmail, gmail_api, email, apple_mail). A person reads them as one: Email. */
export type ChannelGroup = "email" | "instagram" | "sms" | "imessage" | "whatsapp" | "form" | "other"
export const CHANNEL_GROUPS: { id: ChannelGroup; label: string }[] = [
  { id: "email", label: "Email" },
  { id: "instagram", label: "Instagram" },
  { id: "sms", label: "SMS" },
  { id: "imessage", label: "iMessage" },
  { id: "whatsapp", label: "WhatsApp" },
  { id: "form", label: "Forms" },
  { id: "other", label: "Other" },
]
export function channelGroup(channel: string): ChannelGroup {
  if (channel === "gmail" || channel === "gmail_api" || channel === "email" || channel === "apple_mail") return "email"
  if (channel === "contact_form") return "form"
  if (channel === "instagram" || channel === "sms" || channel === "imessage" || channel === "whatsapp") return channel
  return "other"
}
export const channelLabel = (channel: string) => CHANNEL_GROUPS.find((g) => g.id === channelGroup(channel))!.label

/** Which way a reply can go, from the channel the conversation is on. iMessage needs the Mac bridge: not here yet. */
export function replyChannelFor(channel: string): ReplyChannel | undefined {
  const g = channelGroup(channel)
  if (g === "email" || g === "form") return "email"
  if (g === "instagram") return "instagram"
  if (g === "sms" || g === "whatsapp") return "sms"
  return undefined
}
export const REPLY_LABEL: Record<ReplyChannel, string> = { email: "Email", sms: "SMS", instagram: "Instagram DM" }

/**
 * The scanner logs a shared post or a reaction as a bracketed token ("[message_inline_share]"). A
 * person reads what happened, not the token.
 */
export function readableBody(body: string): string {
  const t = body.trim()
  const m = t.match(/^\[([a-z_]+)\]$/)
  if (!m) return t
  const k = m[1]
  if (k.includes("reaction")) return "Reacted to a message"
  if (k.includes("whats_app")) return "Shared a WhatsApp number"
  if (k.includes("montage") || k.includes("reel") || k.includes("clip")) return "Shared a reel"
  if (k.includes("story")) return "Replied to a story"
  if (k.includes("share")) return "Shared a post"
  return "Sent an attachment"
}

// ─── Unread, on this computer ─────────────────────────────────────────────────

/**
 * UNREAD IS THIS COMPUTER'S, said so on screen. lead_comms has no read flag (measured 2026-11-06), so
 * a conversation is unread when they wrote after you last opened it here. Keyed by conversation, the
 * value is the newest inbound message you have seen.
 */
export const SEEN_KEY = "iris.inbox.seen"
export type Seen = Record<string, string>
export const isUnread = (c: Conversation, seen: Seen) => !!c.lastInboundAt && !(seen[c.key] && seen[c.key] >= c.lastInboundAt)
export function markSeen(seen: Seen, c: Conversation): Seen {
  if (!c.lastInboundAt || !isUnread(c, seen)) return seen
  return { ...seen, [c.key]: c.lastInboundAt }
}
export function markUnread(seen: Seen, c: Conversation): Seen {
  const next = { ...seen }
  delete next[c.key]
  return next
}
export function parseSeen(raw: string | null): Seen {
  try {
    const v = JSON.parse(raw ?? "{}")
    if (!v || typeof v !== "object" || Array.isArray(v)) return {}
    return Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === "string"))
  } catch {
    return {}
  }
}
/** Seen markers for conversations no longer in the list are dropped, so the store stays small. */
export const pruneSeen = (seen: Seen, list: Conversation[]): Seen => {
  const keys = new Set(list.map((c) => c.key))
  return Object.fromEntries(Object.entries(seen).filter(([k]) => keys.has(k)))
}
export const unreadCount = (list: Conversation[], seen: Seen) => list.filter((c) => isUnread(c, seen)).length

// ─── Filters ───────────────────────────────────────────────────────────────────

export type InboxFilter = "all" | "unread" | "needsReply" | "assigned"
export const FILTERS: { id: InboxFilter; label: string; hint: string }[] = [
  { id: "all", label: "All", hint: "Every conversation in the window" },
  { id: "unread", label: "Unread", hint: "They wrote since you last opened it on this computer" },
  { id: "needsReply", label: "Needs reply", hint: "Their message is the last one" },
  { id: "assigned", label: "Assigned to me", hint: "Leads assigned to you" },
]
export interface InboxQuery {
  filter: InboxFilter
  channel?: ChannelGroup
  search: string
}
export const NO_QUERY: InboxQuery = { filter: "all", search: "" }

const matchesFilter = (c: Conversation, f: InboxFilter, seen: Seen) =>
  f === "all" || (f === "unread" ? isUnread(c, seen) : f === "needsReply" ? c.needsReply : c.assigned)
const matchesChannel = (c: Conversation, ch?: ChannelGroup) => !ch || c.channels.some((x) => channelGroup(x) === ch)
const matchesSearch = (c: Conversation, s: string) => {
  const q = s.trim().toLowerCase()
  return !q || [c.name, c.preview, c.subject ?? ""].some((x) => x.toLowerCase().includes(q))
}

export function applyQuery(list: Conversation[], q: InboxQuery, seen: Seen): Conversation[] {
  return list.filter((c) => matchesFilter(c, q.filter, seen) && matchesChannel(c, q.channel) && matchesSearch(c, q.search))
}

/**
 * The counts beside each filter answer "how many would I see if I clicked it": each filter's count is
 * taken inside the chosen channel and search, and each channel's inside the chosen filter and search.
 */
export function queryCounts(list: Conversation[], q: InboxQuery, seen: Seen) {
  const inChannel = list.filter((c) => matchesChannel(c, q.channel) && matchesSearch(c, q.search))
  const inFilter = list.filter((c) => matchesFilter(c, q.filter, seen) && matchesSearch(c, q.search))
  const filters = Object.fromEntries(FILTERS.map((f) => [f.id, inChannel.filter((c) => matchesFilter(c, f.id, seen)).length])) as Record<InboxFilter, number>
  const channels = Object.fromEntries(
    CHANNEL_GROUPS.map((g) => [g.id, inFilter.filter((c) => matchesChannel(c, g.id)).length]),
  ) as Record<ChannelGroup, number>
  return { filters, channels, any: inFilter.length }
}

// ─── Time ──────────────────────────────────────────────────────────────────────

const DAY = 86_400_000
const startOfDay = (t: number) => {
  const d = new Date(t)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}
export function dayLabel(iso: string, now: number): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return "Earlier"
  const diff = Math.round((startOfDay(now) - startOfDay(t)) / DAY)
  if (diff <= 0) return "Today"
  if (diff === 1) return "Yesterday"
  return new Date(t).toLocaleDateString(undefined, { weekday: diff < 7 ? "long" : undefined, month: "short", day: "numeric" })
}
export function timeLabel(iso: string, now: number): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ""
  const mins = Math.floor((now - t) / 60000)
  if (mins < 1) return "now"
  if (mins < 60) return `${mins}m`
  if (startOfDay(t) === startOfDay(now)) return new Date(t).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
  const days = Math.round((startOfDay(now) - startOfDay(t)) / DAY)
  if (days < 7) return `${days}d`
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" })
}
/** The list in day groups, Elon's timeline headings ("Today", "Yesterday", "Tuesday", "Oct 30"). */
export function groupByDay<T>(list: T[], at: (t: T) => string, now: number): { label: string; items: T[] }[] {
  const out: { label: string; items: T[] }[] = []
  for (const item of list) {
    const label = dayLabel(at(item), now)
    const last = out.at(-1)
    if (last && last.label === label) last.items.push(item)
    else out.push({ label, items: [item] })
  }
  return out
}

// ─── The composer, and the gate ───────────────────────────────────────────────

/**
 * A reply being written. An AI draft is never typed into this by the machine: the person approves a
 * draft, which puts it here with `origin: "ai", approved: true`. Only then can Send be pressed, and
 * Send still asks. The engine checks the same two things (sendRefusal in comms.ts).
 */
export interface Composer {
  channel: ReplyChannel
  to?: string
  subject: string
  text: string
  origin: "person" | "ai"
  approved: boolean
}
export function newComposer(channel: ReplyChannel, thread: Pick<ThreadAnswer, "replyTo" | "messages">): Composer {
  const lastSubject = [...thread.messages].reverse().find((m) => m.subject)?.subject
  return {
    channel,
    to: thread.replyTo[channel === "sms" ? "sms" : channel],
    subject: channel === "email" ? (lastSubject ? (/^re:/i.test(lastSubject) ? lastSubject : `Re: ${lastSubject}`) : "") : "",
    text: "",
    origin: "person",
    approved: false,
  }
}
export function switchChannel(c: Composer, channel: ReplyChannel, thread: Pick<ThreadAnswer, "replyTo" | "messages">): Composer {
  const fresh = newComposer(channel, thread)
  return { ...fresh, text: c.text, origin: c.origin, approved: c.approved, subject: c.subject || fresh.subject }
}
/** Approving a draft fills the reply box. It sends nothing. */
export function approveDraft(c: Composer, d: Draft): Composer {
  return { ...c, text: d.text, subject: d.subject && c.channel === "email" ? d.subject : c.subject, origin: "ai", approved: true }
}
/** Clearing the box clears where the text came from. */
export function typeText(c: Composer, text: string): Composer {
  return text.trim() ? { ...c, text } : { ...c, text, origin: "person", approved: false }
}

/** Why Send is not available yet, or undefined. The engine refuses the same cases. */
export function sendBlock(c: Composer): string | undefined {
  if (!c.text.trim()) return "Write a reply, or approve a draft"
  if (c.origin === "ai" && !c.approved) return "Approve the draft first"
  if (c.channel === "email" && !c.to) return "This lead has no email address"
  if (c.channel === "email" && !c.subject.trim()) return "Add a subject"
  if (c.channel === "sms" && !c.to) return "This lead has no phone number"
  if (c.channel === "instagram" && !c.to) return "This lead has no Instagram handle"
  if (c.channel === "sms" && c.text.length > 1600) return "An SMS is at most 1,600 characters"
  return undefined
}

/** The confirm's words: who receives it, how, and that it cannot be taken back. */
export function sendConfirm(c: Composer, name: string): { title: string; lines: string[] } {
  const where = c.channel === "email" ? `by email to ${c.to}` : c.channel === "sms" ? `by SMS to ${c.to}` : `as an Instagram DM to @${c.to?.replace(/^@/, "")}`
  return {
    title: `Send this to ${name}?`,
    lines: [
      `It goes ${where}, exactly as written below. A sent message can't be taken back.`,
      ...(c.origin === "ai" ? ["AI drafted it; you approved it."] : []),
      ...(c.channel === "instagram" ? ["Instagram replies go out through your Hive computer that runs the Instagram account."] : []),
    ],
  }
}

/** The body of the send request. `confirm` is the person's yes in the dialog — set only there. */
export function sendPayload(c: Composer, leadId: number, bloqId?: number) {
  return {
    leadId,
    channel: c.channel,
    text: c.text.trim(),
    to: c.to,
    ...(c.channel === "email" ? { subject: c.subject.trim() } : {}),
    origin: c.origin,
    approved: c.origin === "ai" ? c.approved : undefined,
    confirm: true,
    ...(bloqId ? { bloqId } : {}),
  }
}

// ─── AI response history ──────────────────────────────────────────────────────

/**
 * Drafts made here, per lead (Elon's LeadAIResponseHistory kept the same in the browser). The
 * platform's own record — outreach messages marked generated_by_ai — is shown beside it.
 */
export const DRAFTS_KEY = "iris.inbox.drafts"
export interface LocalDraft {
  at: string
  channel: ReplyChannel
  text: string
  subject?: string
  tone?: string
  /** approved = put in the reply box; sent = then sent. */
  state: "drafted" | "approved" | "sent"
}
export function parseDrafts(raw: string | null): Record<string, LocalDraft[]> {
  try {
    const v = JSON.parse(raw ?? "{}")
    return v && typeof v === "object" && !Array.isArray(v) ? v : {}
  } catch {
    return {}
  }
}
export function rememberDrafts(all: Record<string, LocalDraft[]>, leadId: number, add: LocalDraft[]): Record<string, LocalDraft[]> {
  return { ...all, [leadId]: [...add, ...(all[leadId] ?? [])].slice(0, 20) }
}
export function markDraft(all: Record<string, LocalDraft[]>, leadId: number, text: string, state: LocalDraft["state"]): Record<string, LocalDraft[]> {
  const list = all[leadId] ?? []
  const i = list.findIndex((d) => d.text === text)
  if (i < 0) return all
  return { ...all, [leadId]: list.map((d, j) => (j === i ? { ...d, state } : d)) }
}

export const initialOf = (name: string) => (name.replace(/^@/, "").trim().charAt(0) || "?").toUpperCase()
