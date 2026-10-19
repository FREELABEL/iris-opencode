/**
 * Atlas › Lists — sort, filter and "last edited" (#186579 #186580 #186581).
 *
 * Pure, so the rules are tested without a DOM. It runs on the board the sidecar already
 * returned (search is server-side and applied first); it never refetches.
 */

export interface AtlasViewItem {
  id: number
  title: string
  status?: string
  createdAt?: string
  updatedAt?: string
}
export interface AtlasViewList<I extends AtlasViewItem = AtlasViewItem> {
  id: number
  name: string
  items: I[]
}

export type AtlasSort = "board" | "edited" | "newest" | "oldest" | "title"
export type AtlasStatus = "all" | "open" | "done"
export type AtlasEdited = "any" | "24h" | "7d" | "30d"
export type AtlasAssigned = "any" | "me" | "none"
export type AtlasDue = "any" | "overdue" | "week" | "none"
export interface AtlasViewOptions {
  sort: AtlasSort
  status: AtlasStatus
  edited: AtlasEdited
  hideEmpty: boolean
  /** One label id, or "" for any (#189798). */
  label: string
  assigned: AtlasAssigned
  due: AtlasDue
  hasFiles: boolean
}

export const ATLAS_VIEW_DEFAULT: AtlasViewOptions = {
  sort: "board",
  status: "all",
  edited: "any",
  hideEmpty: false,
  label: "",
  assigned: "any",
  due: "any",
  hasFiles: false,
}

export const ATLAS_ASSIGNED: { id: AtlasAssigned; label: string }[] = [
  { id: "any", label: "Anyone" },
  { id: "me", label: "Me" },
  { id: "none", label: "Nobody" },
]
export const ATLAS_DUE: { id: AtlasDue; label: string }[] = [
  { id: "any", label: "Any" },
  { id: "overdue", label: "Overdue" },
  { id: "week", label: "Next 7 days" },
  { id: "none", label: "No date" },
]

/** The card-face facts the filters read (#189806). All optional: an older fl-api sends none. */
interface CardFacts {
  labels?: string[]
  dueDate?: string
  attachments?: number
  assignees?: { type: "user" | "agent"; userId?: number }[]
}

/** Every label on the board, A–Z, for the Label picker — only what is actually used. */
export function boardLabels(lists: AtlasViewList[]): string[] {
  const all = new Set<string>()
  for (const l of lists) for (const i of l.items) for (const x of (i as CardFacts).labels ?? []) all.add(x)
  return [...all].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))
}

export const ATLAS_SORTS: { id: AtlasSort; label: string }[] = [
  { id: "board", label: "Board order" },
  { id: "edited", label: "Last edited" },
  { id: "newest", label: "Newest" },
  { id: "oldest", label: "Oldest" },
  { id: "title", label: "Title A–Z" },
]
export const ATLAS_STATUSES: { id: AtlasStatus; label: string }[] = [
  { id: "all", label: "All" },
  { id: "open", label: "Open" },
  { id: "done", label: "Done" },
]
export const ATLAS_EDITED: { id: AtlasEdited; label: string }[] = [
  { id: "any", label: "Any time" },
  { id: "24h", label: "24h" },
  { id: "7d", label: "7 days" },
  { id: "30d", label: "30 days" },
]

const DONE = new Set(["done", "completed", "complete", "closed", "resolved"])
/** The same test the row's ✓ uses — a filter and the mark it filters on must agree. */
export const isDone = (status?: string) => !!status && DONE.has(status.toLowerCase())

const WINDOW_MS: Record<Exclude<AtlasEdited, "any">, number> = {
  "24h": 86_400_000,
  "7d": 7 * 86_400_000,
  "30d": 30 * 86_400_000,
}

const ms = (iso?: string) => {
  if (!iso) return NaN
  return Date.parse(iso)
}

/** "just now", "5m", "3h", "4d", "6w", then a date — short enough for a row's right edge. */
export function relativeTime(iso: string | undefined, now: number): string {
  const t = ms(iso)
  if (Number.isNaN(t)) return ""
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 60) return "just now"
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d}d`
  if (d < 56) return `${Math.floor(d / 7)}w`
  const date = new Date(t)
  const sameYear = date.getFullYear() === new Date(now).getFullYear()
  return date.toLocaleDateString(
    undefined,
    sameYear ? { month: "short", day: "numeric" } : { month: "short", year: "numeric" },
  )
}

/** Items without a timestamp sort last in every time order, never first. */
function byTime(key: "createdAt" | "updatedAt", dir: 1 | -1) {
  return (a: AtlasViewItem, b: AtlasViewItem) => {
    const x = ms(a[key])
    const y = ms(b[key])
    if (Number.isNaN(x) && Number.isNaN(y)) return 0
    if (Number.isNaN(x)) return 1
    if (Number.isNaN(y)) return -1
    return (x - y) * dir
  }
}

export function applyAtlasView<I extends AtlasViewItem, L extends AtlasViewList<I>>(
  lists: L[],
  opts: AtlasViewOptions,
  now: number,
  /** The signed-in user, for "Assigned: Me". Unknown → "Me" matches nothing rather than everything. */
  me?: number | null,
): L[] {
  const since = opts.edited === "any" ? undefined : now - WINDOW_MS[opts.edited]
  const cmp =
    opts.sort === "edited"
      ? byTime("updatedAt", -1)
      : opts.sort === "newest"
        ? byTime("createdAt", -1)
        : opts.sort === "oldest"
          ? byTime("createdAt", 1)
          : opts.sort === "title"
            ? (a: AtlasViewItem, b: AtlasViewItem) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" })
            : undefined
  const out: L[] = []
  for (const list of lists) {
    let items = list.items.filter((i) => {
      if (opts.status === "open" && isDone(i.status)) return false
      if (opts.status === "done" && !isDone(i.status)) return false
      if (since !== undefined) {
        const t = ms(i.updatedAt ?? i.createdAt)
        if (Number.isNaN(t) || t < since) return false
      }
      return matchesFacts(i as CardFacts, opts, now, me)
    })
    // Array.prototype.sort is stable, so ties keep board order.
    if (cmp) items = [...items].sort(cmp)
    if (opts.hideEmpty && items.length === 0) continue
    out.push({ ...list, items })
  }
  return out
}

/** Label, assignee, due date and files (#189798). A card with no facts passes only "any". */
function matchesFacts(i: CardFacts, opts: AtlasViewOptions, now: number, me?: number | null): boolean {
  if (opts.label && !(i.labels ?? []).includes(opts.label)) return false
  const people = i.assignees ?? []
  if (opts.assigned === "me" && !(me != null && people.some((a) => a.type === "user" && a.userId === me))) return false
  if (opts.assigned === "none" && people.length > 0) return false
  if (opts.due !== "any") {
    const state = dueState(i.dueDate, now)
    if (opts.due === "none" && i.dueDate) return false
    if (opts.due === "overdue" && state !== "overdue") return false
    if (opts.due === "week") {
      if (!i.dueDate || state === "overdue") return false
      const t = Date.parse(/^\d{4}-\d{2}-\d{2}/.test(i.dueDate) ? `${i.dueDate.slice(0, 10)}T23:59:59` : i.dueDate)
      if (Number.isNaN(t) || t - now > 7 * 86_400_000) return false
    }
  }
  if (opts.hasFiles && !((i.attachments ?? 0) > 0)) return false
  return true
}

export const isDefaultView = (o: AtlasViewOptions) =>
  o.sort === "board" &&
  o.status === "all" &&
  o.edited === "any" &&
  !o.hideEmpty &&
  !o.label &&
  o.assigned === "any" &&
  o.due === "any" &&
  !o.hasFiles

/** Parse a stored view, dropping anything that is not a known option. */
export function readAtlasView(raw: string | null | undefined): AtlasViewOptions {
  try {
    const v = raw ? JSON.parse(raw) : {}
    return {
      sort: ATLAS_SORTS.some((s) => s.id === v.sort) ? v.sort : "board",
      status: ATLAS_STATUSES.some((s) => s.id === v.status) ? v.status : "all",
      edited: ATLAS_EDITED.some((s) => s.id === v.edited) ? v.edited : "any",
      hideEmpty: v.hideEmpty === true,
      label: typeof v.label === "string" ? v.label : "",
      assigned: ATLAS_ASSIGNED.some((s) => s.id === v.assigned) ? v.assigned : "any",
      due: ATLAS_DUE.some((s) => s.id === v.due) ? v.due : "any",
      hasFiles: v.hasFiles === true,
    }
  } catch {
    return { ...ATLAS_VIEW_DEFAULT }
  }
}

/**
 * LIVE (#189767). Which cards changed between two reads of the same board — a card that is new,
 * or whose edit time, status, title or list moved. Removed cards are not returned: there is no
 * row left to mark.
 */
export function changedItemIds<I extends AtlasViewItem & { listId?: number }>(
  prev: AtlasViewList<I>[],
  next: AtlasViewList<I>[],
): Set<number> {
  const before = new Map<number, string>()
  const sig = (i: AtlasViewItem, listId: number) => `${listId}|${i.status ?? ""}|${i.title}|${i.updatedAt ?? ""}`
  for (const l of prev) for (const i of l.items) before.set(i.id, sig(i, l.id))
  const out = new Set<number>()
  for (const l of next) for (const i of l.items) if (before.get(i.id) !== sig(i, l.id)) out.add(i.id)
  return out
}

/** Cards edited after `since` (an ISO time) — what moved while you were away from this board. */
export function editedSince(lists: AtlasViewList[], since: string | null | undefined): Set<number> {
  const t = ms(since ?? undefined)
  const out = new Set<number>()
  if (Number.isNaN(t)) return out
  for (const l of lists)
    for (const i of l.items) {
      const e = ms(i.updatedAt ?? i.createdAt)
      if (!Number.isNaN(e) && e > t) out.add(i.id)
    }
  return out
}

/**
 * One line from a card's body for the row under its title (#189764) — markdown and HTML
 * stripped, whitespace folded. Empty when the body only repeats the title, so a row never says
 * the same thing twice.
 */
export function cardPreview(rawBody: string | undefined, title: string, max = 160): string {
  if (!rawBody) return ""
  // A STRUCTURED body is JSON — {text, body, labels, attachments, …} — once a card has labels or
  // files. Its prose is `body` (or `text`); the rest is not something to read on a row.
  const body = structuredProse(rawBody)
  if (!body) return ""
  // A body often opens with its own title as a heading, sometimes shorter or longer than the
  // card's title ("# EPIC — Links open inside IRIS Desktop" under "… Desktop (#187864)").
  const fold = (x: string) => x.replace(/[#*_`>]/g, "").replace(/\s+/g, " ").trim().toLowerCase()
  const lines = body.split("\n")
  const first = lines.findIndex((l) => l.trim() !== "")
  if (first >= 0) {
    const a = fold(lines[first])
    const b = fold(title)
    if (a && b.startsWith(a)) lines.splice(first, 1)
  }
  let t = lines
    .join("\n")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
    .replace(/^\s*\|?[\s:|-]+\|?\s*$/gm, " ")
    .replace(/[*_`~|]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
  const head = title.trim().toLowerCase()
  if (head && t.toLowerCase().startsWith(head)) t = t.slice(head.length).replace(/^[\s:;,.—–-]+/, "")
  if (!t) return ""
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t
}

function structuredProse(raw: string): string {
  const t = raw.trim()
  if (!t.startsWith("{") || !t.endsWith("}")) return raw
  try {
    const o = JSON.parse(t) as Record<string, unknown>
    const prose = typeof o.body === "string" && o.body ? o.body : typeof o.text === "string" ? o.text : ""
    return prose
  } catch {
    return raw
  }
}

/**
 * The footer, in nouns (#189770). It used to print the number of LISTS bare — "6" under a board
 * of nine cards, read as a stray glyph. Counts what is loaded; says when more lists exist and
 * when the filters are hiding cards.
 */
export function atlasCountLine(
  loaded: AtlasViewList[],
  shown: AtlasViewList[],
  more?: { total: number | null; hasMore: boolean },
): string {
  const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`
  const cards = loaded.reduce((s, l) => s + l.items.length, 0)
  const showing = shown.reduce((s, l) => s + l.items.length, 0)
  const lists =
    more?.hasMore && more.total != null
      ? `${loaded.length} of ${more.total} lists`
      : n(loaded.length, "list", "lists")
  const base = `${lists} · ${n(cards, "card", "cards")}`
  return showing === cards ? base : `${base} · showing ${showing}`
}

/**
 * Keep the objects of what did not change (#189767).
 *
 * Solid's <For> matches rows by object, and every refetch returns new objects — so a live update
 * every few seconds rebuilt every row, lost keyboard focus, and replayed the "just changed"
 * flash on cards that changed minutes ago. Reusing the previous object for an unchanged card
 * (and an unchanged list) means only what moved is rebuilt, which is also what flashes.
 */
export function keepUnchanged<L extends AtlasViewList>(prev: L[] | undefined, next: L[]): L[] {
  if (!prev) return next
  const oldItems = new Map<number, AtlasViewItem>()
  const oldLists = new Map<number, L>()
  for (const l of prev) {
    oldLists.set(l.id, l)
    for (const i of l.items) oldItems.set(i.id, i)
  }
  const same = (a: Record<string, unknown>, b: Record<string, unknown>) => {
    const ka = Object.keys(a)
    if (ka.length !== Object.keys(b).length) return false
    return ka.every((k) => a[k] === b[k])
  }
  return next.map((l) => {
    const items = l.items.map((i) => {
      const o = oldItems.get(i.id)
      return o && same(o as any, i as any) ? o : i
    })
    const ol = oldLists.get(l.id)
    if (ol && ol.name === l.name && ol.items.length === items.length && ol.items.every((x, k) => x === items[k])) return ol
    return { ...l, items } as L
  })
}

/*
 * BOARD VIEW (#189723). The same lists, laid out as columns side by side; a card is moved by
 * dragging it. Layout is stored apart from the filters on purpose: "reset" clears what you are
 * filtering by, not how you like to look at the board.
 */
export type AtlasLayout = "list" | "board"
/*
 * BOARD FIRST (Alex, 2026-10-19): Board is the primary view and the first tab; List is the
 * secondary one. Only a choice of List is stored now — before this, only Board was, so someone
 * who had picked List cannot be told from someone who never chose, and both open on Board once.
 */
export const ATLAS_LAYOUTS: { id: AtlasLayout; label: string }[] = [
  { id: "board", label: "Board" },
  { id: "list", label: "List" },
]
export const ATLAS_LAYOUT_DEFAULT: AtlasLayout = "board"
export const readAtlasLayout = (raw: string | null | undefined): AtlasLayout => (raw === "list" ? "list" : "board")

/**
 * Where a dragged card lands. `beforeId` is the card it was dropped onto (it goes in front of
 * that card); null means the end of the column. One meaning, shared by the optimistic move and
 * the position sent to fl-api — if the two disagreed, the board would show one order and save
 * another, and the next refresh would quietly move the card.
 */
export interface AtlasDrop {
  itemId: number
  toListId: number
  beforeId: number | null
}

/** The board after the move, for showing it before the server answers. Unknown ids → unchanged. */
export function moveAtlasItem<I extends AtlasViewItem, L extends AtlasViewList<I>>(lists: L[], drop: AtlasDrop): L[] {
  let moving: I | undefined
  for (const l of lists) moving ??= l.items.find((i) => i.id === drop.itemId)
  if (!moving || !lists.some((l) => l.id === drop.toListId)) return lists
  if (drop.beforeId === drop.itemId) return lists
  return lists.map((l) => {
    const items = l.items.filter((i) => i.id !== drop.itemId)
    if (l.id !== drop.toListId) return items.length === l.items.length ? l : { ...l, items }
    const at = drop.beforeId == null ? -1 : items.findIndex((i) => i.id === drop.beforeId)
    const next = at < 0 ? [...items, moving!] : [...items.slice(0, at), moving!, ...items.slice(at)]
    return { ...l, items: next }
  })
}

/**
 * The 0-based position fl-api's /position endpoint wants: the index in the target list's FULL
 * order with the moving card taken out. Computed on the unfiltered board — with a filter on,
 * the card you dropped in front of may be the 40th, not the 3rd, and the visible index would
 * put it in the wrong place. Null when the drop names a list or card that is not on the board.
 */
export function atlasDropPosition<I extends AtlasViewItem, L extends AtlasViewList<I>>(
  fullLists: L[],
  drop: AtlasDrop,
): number | null {
  const target = fullLists.find((l) => l.id === drop.toListId)
  if (!target) return null
  const rest = target.items.filter((i) => i.id !== drop.itemId)
  if (drop.beforeId == null) return rest.length
  const at = rest.findIndex((i) => i.id === drop.beforeId)
  return at < 0 ? null : at
}

/**
 * WHERE A HELD CARD LANDS (the drag preview). Over another card: before it in its top half, after
 * it in its bottom half — Sortable's rule, which Elon's board uses. "Always before" made the last
 * slot of a list unreachable except by the gap under it, and the line jumped as the pointer
 * crossed each card. The card being dragged is not in the list it is measured against.
 */
export function dropBeforeId(items: { id: number }[], overId: number, lowerHalf: boolean, draggingId: number) {
  const rest = items.filter((i) => i.id !== draggingId)
  const at = rest.findIndex((i) => i.id === overId)
  if (at < 0) return null
  if (!lowerHalf) return overId
  return rest[at + 1]?.id ?? null
}

/** Same landing spot — dragover fires many times a second, and only a change should move anything. */
export const sameDrop = (a: Omit<AtlasDrop, "itemId"> | null, b: Omit<AtlasDrop, "itemId"> | null) =>
  a?.toListId === b?.toListId && a?.beforeId === b?.beforeId

/**
 * A due date as a card face says it (#189806): overdue (red), due within 48 h (amber), later.
 * Date-only values ("2026-10-20") are the END of that day — a card due today is not overdue at 9am.
 */
export type DueState = "overdue" | "soon" | "later"
/**
 * fl-api stores a due DATE as midnight UTC ("2026-10-18T00:00:00.000000Z"). Read as a timestamp
 * that is the previous evening anywhere west of UTC, so a card due today turns overdue before
 * the day starts. Midnight-UTC is treated as the date it names.
 */
const asDate = (due: string) => (/^\d{4}-\d{2}-\d{2}T00:00:00(\.0+)?Z$/.test(due) ? due.slice(0, 10) : due)
export function dueState(rawDue: string | undefined, now: number): DueState | undefined {
  if (!rawDue) return undefined
  const due = asDate(rawDue)
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(due)
  const t = Date.parse(dateOnly ? `${due}T23:59:59` : due)
  if (Number.isNaN(t)) return undefined
  if (t < now) return "overdue"
  if (t - now <= 48 * 3_600_000) return "soon"
  return "later"
}

/** "Mar 4", "Today", "Tomorrow", "Yesterday" — short enough for a chip. */
export function dueLabel(rawDue: string, now: number): string {
  const due = asDate(rawDue)
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(due)
  const d = new Date(dateOnly ? `${due}T12:00:00` : due)
  if (Number.isNaN(d.getTime())) return due
  const day = (x: Date) => Math.floor((Date.UTC(x.getFullYear(), x.getMonth(), x.getDate())) / 86_400_000)
  const diff = day(d) - day(new Date(now))
  if (diff === 0) return "Today"
  if (diff === 1) return "Tomorrow"
  if (diff === -1) return "Yesterday"
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

/** Two letters for an avatar: "Ana Pérez" → "AP", "elon" → "EL", nothing → "?". */
export function initials(name: string | undefined): string {
  const parts = (name ?? "").trim().split(/[\s._@-]+/).filter(Boolean)
  if (!parts.length) return "?"
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}
