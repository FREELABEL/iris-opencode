/**
 * OUTREACH › AUDIENCES (#193533 U2a), as pure functions: the draft segment's filters as editable
 * rows, each row's count from the preview's breakdown, and the member rows. The engine side is
 * packages/opencode/src/iris/segments.ts (the draft, and fl-api's segments API, D3 #193484).
 *
 * A filter on a field most leads lack (niche, role, city, followers) is never shown as a bare 0:
 * its count is "3 of 4 known · 6,046 unknown", or "can't be judged yet" when no lead has it.
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
export type FilterDef = { key: FilterKey; label: string; kind: Kind; hint: string }
/** fl-api's SegmentFilters::KEYS order — also the order the breakdown walks and a saved segment keeps. */

/** Every filter fl-api's segments take, in the order the "add filter" menu lists them. */
export const FILTER_DEFS: FilterDef[] = [
  { key: "source_post", label: "Commented on post", kind: "text", hint: "post URL or shortcode" },
  { key: "comment_contains", label: "Comment contains", kind: "text", hint: "roadmap" },
  { key: "discovery_mode", label: "Found by", kind: "text", hint: "comments, followers, profiles, inbox" },
  { key: "status_in", label: "Status is", kind: "list", hint: "Prospected, Contacted" },
  { key: "replied", label: "Replied", kind: "flag", hint: "yes or no" },
  { key: "contacted", label: "Contacted", kind: "flag", hint: "yes or no" },
  { key: "niche_in", label: "Niche is", kind: "list", hint: "Course creator, Coach" },
  { key: "role_in", label: "Role is", kind: "list", hint: "Founder, Creator" },
  { key: "city_contains", label: "City contains", kind: "text", hint: "Austin" },
  { key: "followers_min", label: "Followers at least", kind: "number", hint: "5000" },
  { key: "followers_max", label: "Followers at most", kind: "number", hint: "50000" },
  { key: "has_email", label: "Has email", kind: "flag", hint: "yes or no" },
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

/** One step of fl-api's breakdown (PR #308): `before` reached the filter, `known` of them have the field. */
export type BreakdownRow = { key: string; before: number; known: number; unknown: number; matched: number; of: number; always_known: boolean }
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

/** One count cell: what is left after this filter, and how it was judged. */
export type CountView = { key: string; label: string; value: string; count: string; detail: string; pending: boolean; unjudged: boolean }

/**
 * Each filter's count, cumulative in fl-api's order: the step for a key is what is left after it
 * and every filter above it. A key with no step yet (the preview is still running) is pending.
 * - every lead could be judged: "788" · "of 849"
 * - some could not: "3 of 4 known" · "6,046 unknown"
 * - none could (known 0): "can't be judged yet" · "788 unknown" — never "0 match"
 */
export function countViews(filters: SegmentFilter[], breakdown: BreakdownRow[] | undefined): CountView[] {
  return filters.map((f) => {
    const def = DEF.get(f.key)
    const r = breakdown?.find((x) => x.key === f.key)
    const base = { key: f.key, label: def?.label ?? f.key, value: filterToRow(f).text, unjudged: false }
    if (!r) return { ...base, count: "…", detail: "", pending: true }
    if (r.always_known || r.unknown === 0) return { ...base, count: n(r.matched), detail: `of ${n(r.before)}`, pending: false }
    if (r.known === 0) return { ...base, count: "can't be judged yet", detail: `${n(r.unknown)} unknown`, pending: false, unjudged: true }
    return { ...base, count: `${n(r.matched)} of ${n(r.known)} known`, detail: `${n(r.unknown)} unknown`, pending: false }
  })
}

/** The row's whole count as one line: "849 of 11,341", "3 of 4 known · 6,046 unknown", "can't be judged yet · 788 unknown". */
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
