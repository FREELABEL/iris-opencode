/**
 * What the bell in the message box's toolbar shows (#190993).
 *
 * One place for everything that wants the person's attention: people waiting on a reply, work
 * running in the background, and unread Hive messages. The bell's number and the list it opens are
 * computed here from the same rows, so they cannot disagree.
 *
 * Only what NEEDS the person is counted on the badge (people waiting, unread messages). Work that is
 * running is shown in the list but never counted: nothing about it is the person's to do.
 */
import type { BackgroundRow } from "./background-work-model"

/** A mail thread as /iris/onboarding/mail returns it (the same shape the first run reads). */
export type BellThread = {
  id: string
  subject: string
  from: string
  snippet: string
  date?: string
  unread?: boolean
  automated?: boolean
  kind?: "person" | "action" | "fyi"
}

export type BellRow =
  | { kind: "reply"; id: string; title: string; sub: string; faces: string[]; threads: BellThread[] }
  | { kind: "work"; id: string; title: string; sub?: string }
  | { kind: "hive"; id: string; title: string; sub?: string; count: number }

export function senderName(from: string): string {
  const m = /^\s*"?([^"<]+?)"?\s*<[^>]+>\s*$/.exec(from)
  return (m ? m[1] : from).trim() || "Someone"
}

function senderAddress(from: string): string {
  return (/<([^>]+)>/.exec(from)?.[1] ?? from).trim().toLowerCase()
}

/** People (not newsletters, not you) who wrote and are likely waiting on a reply, newest first. */
export function waitingOnYou(threads: BellThread[], account?: string, n = 8): BellThread[] {
  const me = account?.trim().toLowerCase()
  const seen = new Set<string>()
  return threads
    .filter((t) => (t.kind ?? (t.automated ? "fyi" : "person")) === "person")
    .filter((t) => !me || senderAddress(t.from) !== me)
    .sort((a, b) => (Date.parse(b.date ?? "") || 0) - (Date.parse(a.date ?? "") || 0))
    .filter((t) => {
      // One row per person: two emails from Maria are one person waiting.
      const who = senderAddress(t.from)
      if (seen.has(who)) return false
      seen.add(who)
      return true
    })
    .slice(0, n)
}

function initial(name: string): string {
  return (name.match(/[\p{L}\p{N}]/u)?.[0] ?? "?").toUpperCase()
}

function names(threads: BellThread[]): string {
  const all = threads.map((t) => senderName(t.from).split(/\s+/)[0])
  if (all.length <= 3) return all.join(", ")
  return `${all.slice(0, 3).join(", ")} and ${all.length - 3} more`
}

export function bellRows(input: {
  waiting: BellThread[]
  work: BackgroundRow[]
  hiveUnread: number | null
  hiveFrom?: string
}): BellRow[] {
  const rows: BellRow[] = []
  const w = input.waiting
  if (w.length > 0) {
    rows.push({
      kind: "reply",
      id: "reply",
      title: w.length === 1 ? `${senderName(w[0].from)} needs a reply` : `${w.length} people need a reply`,
      sub: w.length === 1 ? w[0].subject : names(w),
      faces: w.slice(0, 4).map((t) => initial(senderName(t.from))),
      threads: w,
    })
  }
  for (const r of input.work) {
    rows.push({ kind: "work", id: r.id, title: r.title, sub: r.retrying ? "Retrying" : r.subagent ? r.parent : undefined })
  }
  const unread = input.hiveUnread ?? 0
  if (unread > 0) {
    rows.push({
      kind: "hive",
      id: "hive",
      title: unread === 1 ? "1 new Hive message" : `${unread} new Hive messages`,
      sub: input.hiveFrom ? `Latest from ${input.hiveFrom}` : undefined,
      count: unread,
    })
  }
  return rows
}

/** The badge: people waiting plus unread messages. Running work is never counted. */
export function bellCount(rows: BellRow[]): number {
  let n = 0
  for (const r of rows) {
    if (r.kind === "reply") n += r.threads.length
    if (r.kind === "hive") n += r.count
  }
  return n
}

export function bellLabel(count: number): string | null {
  if (count <= 0) return null
  return count > 99 ? "99+" : String(count)
}

/**
 * The request the "people need a reply" row sends. IRIS answers it with the question card: first
 * who to answer, then one question per person with drafted replies. Nothing is sent without the
 * person choosing a reply, and the replies are saved as drafts.
 */
export function replyPrompt(threads: BellThread[]): string {
  const lines = threads.map(
    (t) =>
      `- ${senderName(t.from)} <${senderAddress(t.from)}> — "${t.subject}"${t.date ? ` (${t.date})` : ""}: ${t.snippet.replace(/\s+/g, " ").slice(0, 280)}`,
  )
  return [
    "These people are waiting on a reply from me:",
    ...lines,
    "",
    "Use the question tool, not a long message:",
    `1. First ask one multiple-choice question (multiple: true, header "Waiting on you") listing each person as an option — label: their name, description: what they want in a few words. I tick who to answer.`,
    `2. Then ask one question per person I ticked. Header: "<name> · Email · <how long ago>". Question: their message in one short quote. Options: two or three replies drafted in my voice (label: a 2–4 word summary, description: the full reply), plus "Not now".`,
    "3. For each reply I pick or write, save it as a draft reply in my mail. Do not send anything. Skip anyone I answered \"Not now\".",
    "Then tell me in one line which drafts are ready.",
  ].join("\n")
}
