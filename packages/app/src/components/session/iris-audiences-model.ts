/**
 * OUTREACH › AUDIENCES (#193533 U2a), as pure functions: the draft segment's filters as editable
 * rows, each row's count from the preview's breakdown, and the member rows. The engine side is
 * packages/opencode/src/iris/segments.ts (the draft, and fl-api's segments API, D3 #193484).
 *
 * A demographic filter (niche, role, city, followers) is never shown as a bare 0: most leads have
 * not been tagged yet, so its count is "3 of 4 known · 6,046 unknown".
 */

export type FilterKey =
  | "source_post"
  | "comment_contains"
  | "discovery_mode"
  | "status_in"
  | "replied"
  | "contacted"
  | "niche_in"
  | "role_in"
  | "city_contains"
  | "followers_min"
  | "followers_max"
  | "has_email"
export type FilterValue = string | number | boolean | string[]
export type SegmentFilter = { key: FilterKey; value: FilterValue }

type Kind = "text" | "list" | "flag" | "number"
export type FilterDef = { key: FilterKey; label: string; kind: Kind; demographic: boolean; hint: string }

/** Every filter fl-api's segments take, in the order the "add filter" menu lists them. */
export const FILTER_DEFS: FilterDef[] = [
  { key: "source_post", label: "Commented on post", kind: "text", demographic: false, hint: "post URL or shortcode" },
  { key: "comment_contains", label: "Comment contains", kind: "text", demographic: false, hint: "roadmap" },
  { key: "discovery_mode", label: "Found by", kind: "text", demographic: false, hint: "comments, followers, profiles, inbox" },
  { key: "status_in", label: "Status is", kind: "list", demographic: false, hint: "Prospected, Contacted" },
  { key: "replied", label: "Replied", kind: "flag", demographic: false, hint: "yes or no" },
  { key: "contacted", label: "Contacted", kind: "flag", demographic: false, hint: "yes or no" },
  { key: "niche_in", label: "Niche is", kind: "list", demographic: true, hint: "Course creator, Coach" },
  { key: "role_in", label: "Role is", kind: "list", demographic: true, hint: "Founder, Creator" },
  { key: "city_contains", label: "City contains", kind: "text", demographic: true, hint: "Austin" },
  { key: "followers_min", label: "Followers at least", kind: "number", demographic: true, hint: "5000" },
  { key: "followers_max", label: "Followers at most", kind: "number", demographic: true, hint: "50000" },
  { key: "has_email", label: "Has email", kind: "flag", demographic: false, hint: "yes or no" },
]
const DEF = new Map(FILTER_DEFS.map((d) => [d.key, d]))
export const filterDef = (key: string) => DEF.get(key as FilterKey)

/** One editable row: a key and the text in its box. */
export type FilterRow = { key: FilterKey; text: string }

/** A post URL's shortcode, or null. Same rule as the engine's postKey. */
const shortcode = (s: string) => /instagram\.com\/(?:[^/?#]+\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i.exec(s)?.[1] ?? null

/** A row → the filter fl-api takes, or undefined while its text says nothing usable. */
export function rowToFilter(row: FilterRow): SegmentFilter | undefined {
  const def = DEF.get(row.key)
  const text = row.text.trim()
  if (!def || !text) return undefined
  if (def.kind === "list") {
    const list = text.split(",").map((s) => s.trim()).filter(Boolean)
    return list.length ? { key: row.key, value: list } : undefined
  }
  if (def.kind === "flag") {
    const s = text.toLowerCase()
    if (["yes", "true", "y", "1"].includes(s)) return { key: row.key, value: true }
    if (["no", "false", "n", "0"].includes(s)) return { key: row.key, value: false }
    return undefined
  }
  if (def.kind === "number") {
    const n = Number(text.replace(/[,_\s]/g, "").replace(/k$/i, "000"))
    return Number.isFinite(n) && n >= 0 ? { key: row.key, value: Math.round(n) } : undefined
  }
  return { key: row.key, value: row.key === "source_post" ? (shortcode(text) ?? text) : text }
}

/** A filter → the text its row shows. */
export function filterToRow(f: SegmentFilter): FilterRow {
  const v = f.value
  const text = Array.isArray(v) ? v.join(", ") : typeof v === "boolean" ? (v ? "yes" : "no") : String(v)
  return { key: f.key, text }
}

/** The rows that say something, in order, as filters. One filter per key: a later duplicate is dropped. */
export function rowsToFilters(rows: FilterRow[]): SegmentFilter[] {
  const seen = new Set<string>()
  return rows.flatMap((r) => {
    const f = rowToFilter(r)
    if (!f || seen.has(f.key)) return []
    seen.add(f.key)
    return [f]
  })
}

/** The first key not already used — what "Add filter" starts a new row with. */
export function nextKey(rows: FilterRow[]): FilterKey | undefined {
  return FILTER_DEFS.find((d) => !rows.some((r) => r.key === d.key))?.key
}

// ─── Counts ───────────────────────────────────────────────────────────────────

export type BreakdownRow = { key: string; matched: number; known: number | null; of: number }
export type MemberRow = {
  id: number
  handle: string | null
  name: string
  status: string
  comment: string
  niche: string | null
  role: string | null
  city: string | null
  followers: number | null
}
export type MemberPage = { data: MemberRow[]; total: number; page: number; last_page: number }
export type Preview = { total: number | null; of: number | null; breakdown: BreakdownRow[]; members: MemberPage }
export type Draft = {
  bloq: number
  segment_id: number | null
  name: string
  filters: SegmentFilter[]
  rev: number
  saved: string | null
  by: string
  updated_at: string
}
export type Segment = { id: number; bloq_id: number; name: string; filters: SegmentFilter[]; member_count: number | null; updated_at: string | null }

const n = (v: number) => v.toLocaleString("en-US")

/** One count cell: what is left after this filter, and of how many. */
export type CountView = { key: string; label: string; value: string; count: string; detail: string; pending: boolean }

/**
 * Each filter's count, cumulative in order: row i is what is left after filters 1..i. A row with
 * no matching breakdown entry (the preview is still running, or fl-api skipped it) is pending.
 * Demographic rows say how many were known: "3 of 4 known · 6,046 unknown".
 */
export function countViews(filters: SegmentFilter[], breakdown: BreakdownRow[] | undefined): CountView[] {
  return filters.map((f, i) => {
    const def = DEF.get(f.key)
    const r = breakdown?.[i]?.key === f.key ? breakdown[i] : undefined
    const base = { key: f.key, label: def?.label ?? f.key, value: filterToRow(f).text }
    if (!r) return { ...base, count: "…", detail: "", pending: true }
    if (def?.demographic && r.known !== null) {
      const unknown = Math.max(0, r.of - r.known)
      return { ...base, count: `${n(r.matched)} of ${n(r.known)} known`, detail: `${n(unknown)} unknown`, pending: false }
    }
    return { ...base, count: n(r.matched), detail: `of ${n(r.of)}`, pending: false }
  })
}

/** "3 of 4 known · 6,046 unknown" / "849 of 6,895" — the row's whole count as one line. */
export const countText = (c: CountView) => (c.pending ? "…" : c.detail.endsWith("unknown") ? `${c.count} · ${c.detail}` : `${c.count} ${c.detail}`)

/** A member's cells; anything the platform does not hold is "—", never a made-up 0. */
export function memberCells(m: MemberRow) {
  return {
    handle: m.handle ?? "—",
    name: m.name,
    status: m.status || "—",
    comment: m.comment || "—",
    niche: m.niche ?? "—",
    role: m.role ?? "—",
    city: m.city ?? "—",
    followers: m.followers === null ? "—" : n(m.followers),
  }
}

/** True when the draft has edits its saved segment does not (or it was never saved). */
export function draftUnsaved(d: Pick<Draft, "name" | "filters" | "saved">): boolean {
  return d.saved !== JSON.stringify({ name: d.name, filters: d.filters })
}
