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
export interface AtlasViewOptions {
  sort: AtlasSort
  status: AtlasStatus
  edited: AtlasEdited
  hideEmpty: boolean
}

export const ATLAS_VIEW_DEFAULT: AtlasViewOptions = { sort: "board", status: "all", edited: "any", hideEmpty: false }

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
      return true
    })
    // Array.prototype.sort is stable, so ties keep board order.
    if (cmp) items = [...items].sort(cmp)
    if (opts.hideEmpty && items.length === 0) continue
    out.push({ ...list, items })
  }
  return out
}

export const isDefaultView = (o: AtlasViewOptions) =>
  o.sort === "board" && o.status === "all" && o.edited === "any" && !o.hideEmpty

/** Parse a stored view, dropping anything that is not a known option. */
export function readAtlasView(raw: string | null | undefined): AtlasViewOptions {
  try {
    const v = raw ? JSON.parse(raw) : {}
    return {
      sort: ATLAS_SORTS.some((s) => s.id === v.sort) ? v.sort : "board",
      status: ATLAS_STATUSES.some((s) => s.id === v.status) ? v.status : "all",
      edited: ATLAS_EDITED.some((s) => s.id === v.edited) ? v.edited : "any",
      hideEmpty: v.hideEmpty === true,
    }
  } catch {
    return { ...ATLAS_VIEW_DEFAULT }
  }
}
