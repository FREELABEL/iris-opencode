/**
 * Hive › Inbox (#189279) — the pure half: what the list shows, in what order, and what the
 * titlebar's two Hive pills open.
 *
 * Kept apart from the component so the rules can be tested without a DOM: the ordering, the
 * unread count, and the pill → pane mapping are where this feature was wrong before.
 */

/** A row as /iris/inbox returns it. */
export interface InboxRow {
  /** 1-based MANIFEST position — not the row's position in the list. */
  index: number
  id?: string
  read: boolean
  type: string
  from: string
  receivedAt?: string
  label: string
  preview?: string
  /** Handled. Read is "I opened it"; done is "nothing more is needed from me". */
  done?: boolean
  doneAt?: string
  /** A handoff/job's work item (bloq:item:N) and its status. */
  item?: string
  status?: string
}

/** One message this computer sent from the panel (/iris/inbox-sent). */
export interface SentRow {
  id: string
  to: string
  text: string
  sentAt: string
  /** The server ACCEPTED it. Not proof it was delivered or read. */
  taskId?: string
  replyTo?: string
  via?: string
}

/** One message as /iris/inbox/:index returns it. */
export interface InboxMessage extends InboxRow {
  body: string | null
  bodyState: "ok" | "truncated" | "binary" | "missing" | "none"
  url?: string
  item?: string
  status?: string
  result?: string
  file?: string
  originalName?: string
  sizeBytes?: number
  burn: boolean
}

/** The time a row sorts by. A row with no timestamp sorts by manifest position (append order). */
const at = (r: InboxRow) => {
  const t = r.receivedAt ? Date.parse(r.receivedAt) : NaN
  return Number.isFinite(t) ? t : -Infinity
}

/**
 * NEWEST FIRST — the order an inbox is read in. The sidecar sorts unread-first; that buried a
 * new message under an older unread one, and the dot already says which are unread.
 */
export function inboxRowsOf(rows: readonly InboxRow[] | undefined): InboxRow[] {
  return [...(rows ?? [])].sort((a, b) => at(b) - at(a) || b.index - a.index)
}

/** Unread, counted from rows. Null when there are no rows to count from — not zero. */
export function unreadOf(rows: readonly InboxRow[] | undefined): number | null {
  if (!rows) return null
  return rows.filter((r) => !r.read).length
}

const KIND: Record<string, string> = {
  message: "Message",
  text: "Note",
  link: "Link",
  file: "File",
  handoff: "Handoff",
  job: "Job result",
}
export function kindLabel(type: string | undefined): string {
  return KIND[type ?? ""] ?? (type ? type[0].toUpperCase() + type.slice(1) : "Message")
}

/**
 * What a row leads with: the message's first line, else what the manifest calls it. A file is
 * its name; a handoff is its work item.
 */
export function subjectOf(r: Pick<InboxRow, "type" | "label" | "preview">): string {
  // A handoff with a note leads with the note: "bloq:item:190875 [blocked]" is an id, not a subject.
  // The card id and status still show, on the row's second line.
  if ((r.type === "message" || r.type === "text" || r.type === "handoff" || r.type === "job") && r.preview) return r.preview
  return r.label || r.preview || "(no text)"
}

/** "5m", "3h", "2d", or a date — short, because it sits at the end of a row. */
export function shortAge(iso: string | undefined, now: number): string {
  if (!iso) return ""
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ""
  const s = Math.max(0, (now - t) / 1000)
  if (s < 60) return "now"
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d`
  return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" })
}

/** The full received time, for the detail header and the row's tooltip. */
export function fullTime(iso: string | undefined): string {
  if (!iso) return ""
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ""
  return new Date(t).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
}

/** The CLI equivalent, for the developer drawer — never the main content. */
export function inboxCli(m: Pick<InboxRow, "index">): string {
  return `iris hive inbox read ${m.index}`
}

/** What a missing body means, in a sentence — never a blank panel. */
export function bodyNote(m: Pick<InboxMessage, "bodyState" | "type" | "originalName">): string | null {
  if (m.bodyState === "truncated") return "This message is long — showing the first part."
  if (m.bodyState === "binary") return `${m.originalName ?? "This file"} is not text, so it cannot be shown here.`
  if (m.bodyState === "missing") return "The message's text is no longer on this computer."
  if (m.bodyState === "none") return m.type === "link" ? null : "This message has no text."
  return null
}

/** Which titlebar pill opens which Hive pane. */
export type HivePill = "machines" | "inbox"
export function hivePillTarget(pill: HivePill): { surface: "hive"; sub: "machines" | "inbox" } {
  return { surface: "hive", sub: pill === "inbox" ? "inbox" : "machines" }
}

/**
 * The body without its first line when that line IS the title — the header already shows it, and
 * a message that opens by repeating its own heading reads like a glitch.
 */
export function bodyAfterTitle(body: string, title: string): string {
  const lines = body.split("\n")
  const first = lines.findIndex((l) => l.trim())
  if (first < 0 || lines[first].trim() !== title.trim()) return body
  const rest = lines.slice(first + 1).join("\n").replace(/^\s*\n/, "")
  return rest.trim() ? rest : body
}

// ─────────────────────────────────────────────────────────────────────────────
// v2 — one inbox, two lenses (#190917). The lens changes order and grouping ONLY: never which
// items are in, never the filter, the read state, or where a click lands.
// ─────────────────────────────────────────────────────────────────────────────

export type Lens = "inbox" | "activity"
export type Filter = "all" | "needs" | "handoffs" | "files" | "sent" | "done"
export const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "needs", label: "Needs me" },
  { id: "handoffs", label: "Handoffs" },
  { id: "files", label: "Files" },
  { id: "sent", label: "Sent" },
  { id: "done", label: "Done" },
]

/**
 * Waiting on YOU, by a rule a person can repeat: a handoff that is not done, a job that failed,
 * or an unread message that asks a question. Never "everything unread" — that is what the unread
 * dot already says, and a "Needs me" that equals "unread" teaches people to ignore it.
 */
export function needsMe(r: InboxRow): boolean {
  if (r.done) return false
  if (r.type === "handoff") return true
  if (r.type === "job") return r.status === "failed"
  return !r.read && /\?\s*$/.test(r.preview ?? "")
}

/** Which incoming rows a filter keeps. Done rows live under Done only, in both lenses. */
export function applyFilter(rows: readonly InboxRow[], f: Filter): InboxRow[] {
  if (f === "done") return rows.filter((r) => r.done)
  const open = rows.filter((r) => !r.done)
  if (f === "needs") return open.filter(needsMe)
  if (f === "handoffs") return open.filter((r) => r.type === "handoff" || r.type === "job")
  if (f === "files") return open.filter((r) => r.type === "file")
  if (f === "sent") return []
  return open
}

export function filterCounts(rows: readonly InboxRow[], sent: readonly SentRow[]): Record<Filter, number> {
  const out = {} as Record<Filter, number>
  for (const f of FILTERS) out[f.id] = f.id === "sent" ? sent.length : applyFilter(rows, f.id).length
  return out
}

/** Case-insensitive match on sender, subject and label — what a person remembers about a message. */
export function matchesQuery(r: Pick<InboxRow, "from" | "label" | "preview">, q: string): boolean {
  const t = q.trim().toLowerCase()
  if (!t) return true
  return [r.from, r.label, r.preview].some((s) => (s ?? "").toLowerCase().includes(t))
}
export function sentMatches(s: SentRow, q: string): boolean {
  const t = q.trim().toLowerCase()
  return !t || s.to.toLowerCase().includes(t) || s.text.toLowerCase().includes(t)
}

/** INBOX lens: needs-me first, then unread, then read — newest first inside each. */
export function rankInbox(rows: readonly InboxRow[]): InboxRow[] {
  const tier = (r: InboxRow) => (needsMe(r) ? 0 : !r.read ? 1 : 2)
  return inboxRowsOf(rows).sort((a, b) => tier(a) - tier(b))
}

/** ACTIVITY lens: newest first, grouped Today / Yesterday / date. */
export function dayLabel(iso: string | undefined, now: number): string {
  if (!iso) return "Earlier"
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return "Earlier"
  const day = (x: number) => {
    const d = new Date(x)
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  }
  const diff = Math.round((day(now) - day(t)) / 86_400_000)
  if (diff <= 0) return "Today"
  if (diff === 1) return "Yesterday"
  if (diff < 7) return new Date(t).toLocaleDateString("en-US", { weekday: "long" })
  return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" })
}
export function groupByDay<T>(rows: readonly T[], at: (r: T) => string | undefined, now: number): { day: string; rows: T[] }[] {
  const out: { day: string; rows: T[] }[] = []
  for (const r of rows) {
    const d = dayLabel(at(r), now)
    const last = out[out.length - 1]
    if (last && last.day === d) last.rows.push(r)
    else out.push({ day: d, rows: [r] })
  }
  return out
}

/** Newest first, for the Sent filter. */
export function sentNewestFirst(sent: readonly SentRow[]): SentRow[] {
  return [...sent].sort((a, b) => (Date.parse(b.sentAt) || 0) - (Date.parse(a.sentAt) || 0))
}

/**
 * A THREAD is everything between you and one other computer: what it sent here, and what this
 * panel sent to it — oldest first, like a conversation.
 */
export type ThreadEntry = { dir: "in"; at: number; row: InboxRow } | { dir: "out"; at: number; sent: SentRow }
const ts = (iso: string | undefined) => {
  const t = iso ? Date.parse(iso) : NaN
  return Number.isFinite(t) ? t : 0
}
export const samePeer = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()
export function threadOf(peer: string, rows: readonly InboxRow[], sent: readonly SentRow[]): ThreadEntry[] {
  const entries: ThreadEntry[] = [
    ...rows.filter((r) => samePeer(r.from, peer)).map((row) => ({ dir: "in" as const, at: ts(row.receivedAt), row })),
    ...sent.filter((s) => samePeer(s.to, peer)).map((s) => ({ dir: "out" as const, at: ts(s.sentAt), sent: s })),
  ]
  return entries.sort((a, b) => a.at - b.at || (a.dir === "in" && b.dir === "in" ? a.row.index - b.row.index : 0))
}

/** The rail: every peer you have a thread with, most recent activity first, with its unread count. */
export function peersOf(rows: readonly InboxRow[], sent: readonly SentRow[]): { peer: string; unread: number; last: number }[] {
  const m = new Map<string, { peer: string; unread: number; last: number }>()
  const touch = (name: string, at: number, unread: boolean) => {
    const k = name.trim().toLowerCase()
    const p = m.get(k) ?? { peer: name, unread: 0, last: 0 }
    p.last = Math.max(p.last, at)
    if (unread) p.unread++
    m.set(k, p)
  }
  for (const r of rows) touch(r.from, ts(r.receivedAt), !r.read)
  for (const s of sent) touch(s.to, ts(s.sentAt), false)
  return [...m.values()].sort((a, b) => b.last - a.last)
}

/** How many replies this panel sent to one message. */
export function replyCount(id: string | undefined, sent: readonly SentRow[]): number {
  return id ? sent.filter((s) => s.replyTo === id).length : 0
}

/** Two letters for an avatar: "iris-hive-001" → "IH", "studio-mac" → "SM", "Riley (agent)" → "RA". */
export function initials(name: string): string {
  const parts = name.replace(/[()]/g, " ").split(/[\s\-_.]+/).filter((p) => /[a-z]/i.test(p))
  if (!parts.length) return (name.trim()[0] ?? "?").toUpperCase()
  return ((parts[0][0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase()
}

/** `bloq:item:5501` → "#5501"; anything else as it came. */
export function cardLabel(item: string | undefined): string | undefined {
  if (!item) return undefined
  const m = item.match(/(\d+)$/)
  return m ? `#${m[1]}` : item
}

/** What a sent message can honestly claim. "accepted" is the server's word; nothing says delivered. */
export function sentState(s: SentRow): string {
  if (s.taskId) return s.via === "relay" ? "accepted by IRIS · via relay" : "accepted by IRIS"
  return "sent"
}

/** Remembered per viewer: lens, filter and the selected item — reopen the tab where you left it. */
export interface InboxPrefs {
  lens: Lens
  filter: Filter
  selected?: string
}
export function parsePrefs(raw: string | null | undefined): InboxPrefs {
  const d: InboxPrefs = { lens: "inbox", filter: "all" }
  if (!raw) return d
  try {
    const j = JSON.parse(raw)
    return {
      lens: j.lens === "activity" ? "activity" : "inbox",
      filter: FILTERS.some((f) => f.id === j.filter) ? j.filter : "all",
      selected: typeof j.selected === "string" ? j.selected : undefined,
    }
  } catch {
    return d
  }
}

/**
 * A message body as plain text for the peek: two lines of a list do not need list markup, and
 * "**welcome screen**" with its asterisks reads like a bug. Links keep their words.
 */
export function plainPeek(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^[ \t]*[-*+][ \t]+/gm, "• ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[^*\w])[*_]([^*_\n]+)[*_](?=[^*\w]|$)/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}
