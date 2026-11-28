/**
 * What a board card SAYS, read the way people actually write cards (#192839).
 *
 * Measured on real boards before this was built (Pathways #402, IRIS Features #503, bugs #297):
 *   - status is the default on 83–90% of cards; "done" lives in titles ("[ACCT-1 ✅ DONE] …") and in
 *     list names ("Completed"), not in the field;
 *   - priority, type and due date were empty on 60 of 60 sampled cards; "P1" / "[HIGH]" live in titles;
 *   - epics are a title convention, and epic → child links are not recorded as data.
 *
 * So every reading here takes the STRUCTURED field first and falls back to the title, then the list
 * name. And because the default is the common case, the default reads as nothing: colour is for
 * exceptions only (in progress, done, blocked, urgent/high).
 *
 * Pure and framework-free, so the board, the counts strip and "tidy this board" agree on one answer.
 */

export type CardState = "done" | "in_progress" | "blocked" | null
export type Loud = "urgent" | "high" | null

export interface SignalInput {
  id: number
  title: string
  type?: string
  status?: string
  priority?: string | null
  labels?: string[]
  tasks?: { open: number; done: number; total: number }
  assignees?: { id: number; type: "user" | "agent"; name?: string }[]
  content?: string
  preview?: string
}

export interface CardSignal {
  /** The title without its bracket prefix — the part a person reads. */
  title: string
  /** The bracket prefix, minus any state or priority words it carried ("ACCT-1", "SOC2 · CC6.1"). */
  tag?: string
  state: CardState
  /** Where the state came from — the field, the title, or the list name. Tidy writes only non-field ones. */
  stateFrom?: "field" | "title" | "list"
  loud: Loud
  /** P0–P3 or the priority word, as shown on the card. */
  priority?: string
  priorityFrom?: "field" | "title"
  epic: boolean
  /** Child links recorded as data (the card's task list). A ring is drawn ONLY from this. */
  progress?: { done: number; total: number }
  /** "8 child tickets" written in the title or body — shown as words, never as a 0% ring. */
  children?: number
  /** "Next: …" from the body. */
  next?: string
  /** Open rows in a "## Questions" table (needs the body; absent when the board was read without bodies). */
  openQuestions?: number
}

const DONE_STATUS = new Set(["done", "completed", "complete", "closed", "resolved", "shipped"])
const PROGRESS_STATUS = new Set(["in_progress", "in progress", "doing", "wip", "started"])
const BLOCKED_STATUS = new Set(["blocked", "on_hold", "on hold", "waiting"])

const TITLE_DONE = /(✅|✔|☑|\bDONE\b|\bSHIPPED\b|\bCOMPLETED?\b|\bRESOLVED\b|\bFIXED\b)/i
const TITLE_PROGRESS = /(🚧|\bIN[ -]PROGRESS\b|\bWIP\b|\bDOING\b)/i
const TITLE_BLOCKED = /(⛔|🛑|\bBLOCKED\b|\bON[ -]HOLD\b)/i

const LIST_DONE = /^\s*(done|completed?|shipped|closed|resolved|finished)\b/i
const LIST_PROGRESS = /\b(in[ -]progress|doing|wip|building|active work)\b/i
const LIST_BLOCKED = /\b(blocked|on[ -]hold|waiting)\b/i

const PRIORITY_WORD: Record<string, Loud> = {
  urgent: "urgent",
  critical: "urgent",
  p0: "urgent",
  high: "high",
  p1: "high",
}
const TITLE_PRIORITY = /\b(P[0-3])\b|\b(CRITICAL|URGENT|HIGH|MEDIUM|LOW)\b/

const EPIC_TITLE = /^\s*(\[\s*EPIC\b|EPIC\b\s*[-—–:·#|]|EPIC\s+\d|EPIC$)/i

/**
 * Where a title is allowed to SAY state or priority: its bracket prefix ("[ACCT-1 ✅ DONE]",
 * "[SOC2 · P0]") or a short leading label ("BLOCKED: …", "WIP — …"). Never the prose: "Code Mode
 * P1: …" is phase 1, not priority 1, and "Fixed node lookup" is a title, not a status.
 */
function signalHead(title: string): string | undefined {
  const [prefix] = splitPrefix(title)
  if (prefix) return prefix
  return title.match(/^\s*((?:[✅✔☑🚧⛔🛑]\s*)?[A-Z][A-Z0-9 -]{1,18})\s*[:—–]\s+\S/)?.[1]
}

/** Strip one leading [ … ] (or a run of them) and return [prefix, rest]. */
export function splitPrefix(title: string): [string | undefined, string] {
  const m = title.match(/^\s*((?:\[[^\]]{1,80}\]\s*)+)(.*)$/s)
  if (!m || !m[2]?.trim()) return [undefined, title.trim()]
  const prefix = m[1]
    .split(/\]\s*/)
    .map((p) => p.replace(/^\[/, "").trim())
    .filter(Boolean)
    .join(" · ")
  return [prefix, m[2].trim()]
}

/** The tag a card keeps once state and priority words are read out of its prefix. */
function cleanTag(prefix: string): string | undefined {
  const g = (r: RegExp) => new RegExp(r.source, "gi")
  const t = prefix
    .replace(g(TITLE_DONE), "")
    .replace(g(TITLE_PROGRESS), "")
    .replace(g(TITLE_BLOCKED), "")
    .replace(/\b(P[0-3]|CRITICAL|URGENT|HIGH|MEDIUM|LOW|EPIC)\b/gi, "")
    .split("·")
    .map((s) => s.replace(/\s{2,}/g, " ").trim())
    .filter(Boolean)
    .join(" · ")
    .trim()
  return t || undefined
}

export function stateOf(item: SignalInput, listName = ""): { state: CardState; from?: CardSignal["stateFrom"] } {
  const s = (item.status ?? "").toLowerCase().trim()
  if (DONE_STATUS.has(s)) return { state: "done", from: "field" }
  if (PROGRESS_STATUS.has(s)) return { state: "in_progress", from: "field" }
  if (BLOCKED_STATUS.has(s)) return { state: "blocked", from: "field" }
  const head = signalHead(item.title)
  if (head && TITLE_BLOCKED.test(head)) return { state: "blocked", from: "title" }
  if (head && TITLE_DONE.test(head)) return { state: "done", from: "title" }
  if (head && TITLE_PROGRESS.test(head)) return { state: "in_progress", from: "title" }
  if (LIST_DONE.test(listName)) return { state: "done", from: "list" }
  if (LIST_BLOCKED.test(listName)) return { state: "blocked", from: "list" }
  if (LIST_PROGRESS.test(listName)) return { state: "in_progress", from: "list" }
  return { state: null }
}

export function priorityOf(item: SignalInput): { loud: Loud; label?: string; from?: "field" | "title" } {
  const p = (item.priority ?? "").toString().trim()
  if (p) return { loud: PRIORITY_WORD[p.toLowerCase()] ?? null, label: p.toUpperCase().length <= 3 ? p.toUpperCase() : p.toLowerCase(), from: "field" }
  const m = signalHead(item.title)?.match(TITLE_PRIORITY)
  if (!m) return { loud: null }
  const word = (m[1] ?? m[2]).toLowerCase()
  return { loud: PRIORITY_WORD[word] ?? null, label: m[1] ? m[1].toUpperCase() : word, from: "title" }
}

export function isEpic(item: SignalInput): boolean {
  if ((item.type ?? "").toLowerCase() === "epic") return true
  if (item.labels?.some((l) => l.toLowerCase() === "epic")) return true
  return EPIC_TITLE.test(item.title)
}

const CHILDREN = /\b(\d{1,4})\s+(?:child\s+)?(?:tickets?|tasks?|children|sub-?tasks?)\b/i
const NEXT_LINE = /^\s*(?:\*\*)?Next(?:\*\*)?\s*[:—-]\s*(.+)$/im

export function readSignal(item: SignalInput, listName = ""): CardSignal {
  const [prefix, rest] = splitPrefix(item.title)
  const { state, from } = stateOf(item, listName)
  const pr = priorityOf(item)
  const body = item.content ?? item.preview ?? ""
  const tasks = item.tasks && item.tasks.total > 0 ? { done: item.tasks.done, total: item.tasks.total } : undefined
  const kids = (item.title.match(CHILDREN) ?? body.match(CHILDREN))?.[1]
  const next = body.match(NEXT_LINE)?.[1]?.replace(/\*\*/g, "").trim()
  return {
    title: rest || item.title,
    tag: prefix ? cleanTag(prefix) : undefined,
    state,
    stateFrom: from,
    loud: pr.loud,
    priority: pr.label,
    priorityFrom: pr.from,
    epic: isEpic(item),
    progress: tasks,
    children: tasks ? undefined : kids ? Number(kids) : undefined,
    next: next ? next.slice(0, 140) : undefined,
    openQuestions: item.content != null ? openQuestions(item.content) : undefined,
  }
}

/**
 * Rows still open in a "## Questions" table — the section the epic playbook writes
 * (| # | Question | Owner | Priority | Blocks | Source | Status |). Status is the last column.
 */
export function openQuestions(body: string): number {
  const start = body.search(/^##\s+Questions\s*$/im)
  if (start < 0) return 0
  const after = body.slice(start).replace(/^[^\n]*\n?/, "")
  const end = after.search(/^##\s/m)
  const sec = end < 0 ? after : after.slice(0, end)
  return sec
    .split("\n")
    .filter((l) => /^\s*\|\s*Q?\d+/i.test(l))
    .filter((l) => {
      const cells = l.split("|").map((c) => c.trim()).filter(Boolean)
      return /^open$/i.test(cells.at(-1) ?? "")
    }).length
}

/** The counts strip. Zero counts are left out by the caller (rule 5). */
export interface BoardCounts {
  open: number
  in_progress: number
  blocked: number
  questions: number
  epics: number
  /** Whether questions could be counted at all (bodies loaded). */
  questionsKnown: boolean
}

export function countBoard(lists: { name: string; items: SignalInput[] }[]): BoardCounts {
  const c: BoardCounts = { open: 0, in_progress: 0, blocked: 0, questions: 0, epics: 0, questionsKnown: false }
  for (const l of lists)
    for (const it of l.items) {
      const s = readSignal(it, l.name)
      if (s.state !== "done") c.open++
      if (s.state === "in_progress") c.in_progress++
      if (s.state === "blocked") c.blocked++
      if (s.epic) c.epics++
      if (s.openQuestions != null) {
        c.questionsKnown = true
        c.questions += s.openQuestions
      }
    }
  return c
}

export type BoardFocus = "open" | "in_progress" | "blocked" | "questions" | "epics" | null

/** Does a card stay lit under a counts-strip filter? Everything else is dimmed, not hidden. */
export function matchesFocus(s: CardSignal, focus: BoardFocus): boolean {
  switch (focus) {
    case null:
      return true
    case "open":
      return s.state !== "done"
    case "in_progress":
      return s.state === "in_progress"
    case "blocked":
      return s.state === "blocked"
    case "questions":
      return (s.openQuestions ?? 0) > 0
    case "epics":
      return s.epic
  }
}

/** One proposed change from "tidy this board". Nothing is written until a person applies it. */
export interface TidyChange {
  itemId: number
  title: string
  list: string
  status?: string
  priority?: string
  why: string
}

const PRIORITY_WRITE: Record<string, string> = { P0: "urgent", P1: "high", P2: "medium", P3: "low" }

/**
 * Real status and priority from what the title and list name already say (rule 3). Only cards
 * whose FIELD disagrees are proposed; a field someone set by hand is never overwritten.
 */
export function tidyPlan(lists: { name: string; items: SignalInput[] }[]): TidyChange[] {
  const out: TidyChange[] = []
  for (const l of lists)
    for (const it of l.items) {
      if (it.id < 0) continue
      const s = readSignal(it, l.name)
      const fieldDefault = !it.status || ["active", "todo", "pending"].includes(it.status.toLowerCase())
      const change: TidyChange = { itemId: it.id, title: s.title, list: l.name, why: "" }
      const why: string[] = []
      // "blocked" is not a writable status, so tidy proposes only done / in progress.
      if (fieldDefault && s.stateFrom && s.stateFrom !== "field" && (s.state === "done" || s.state === "in_progress")) {
        change.status = s.state
        why.push(s.stateFrom === "title" ? "title says so" : `list "${l.name}"`)
      }
      if (!it.priority && s.priorityFrom === "title" && s.priority) {
        const p = PRIORITY_WRITE[s.priority] ?? (["urgent", "high", "medium", "low"].includes(s.priority) ? s.priority : undefined)
        if (p) {
          change.priority = p
          why.push(`"${s.priority}" in the title`)
        }
      }
      if (change.status || change.priority) out.push({ ...change, why: why.join(", ") })
    }
  return out
}

/** The first N cards of a lane on the board (rule 4); the rest behind "show N more". */
export const BOARD_LANE_PAGE = 20
