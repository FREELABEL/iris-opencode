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
  if ((r.type === "message" || r.type === "text") && r.preview) return r.preview
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
