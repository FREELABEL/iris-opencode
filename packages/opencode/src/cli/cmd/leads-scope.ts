/**
 * How much of the population an answer actually covers, and how to say so.
 *
 * Extracted from the `leads list` handler so it can be tested (#182078). It was
 * inline, and the reporting is the part that failed: the command hides Prospected by
 * default, caps by recency, and reported only the page size. Each is defensible
 * alone. Together, with no population figure, they produce a confident partial
 * answer indistinguishable from a complete one — and six funnel KPIs were computed
 * from it over 56 rows out of 28,522.
 */
export type ListScope = {
  /** rows actually being shown */
  shown: number
  /** the POPULATION, from the paginator — not the page size */
  total: number
  /** rows removed by the default Prospected filter */
  prospectedHidden: number
  /**
   * How many rows the filter was applied to. `prospectedHidden` is counted over FETCHED
   * rows, not the whole book, so on its own it reads as a book-wide figure it is not:
   * the default list fetched 100, hid 73 of them, showed 20, and printed
   * "73 Prospected hidden" beside "20 of 28750" — two numbers that cannot both be
   * counts of the same population (#190003). Say the window when we know it.
   */
  scanned?: number
  /**
   * How the server picked the window, in words a reader can check — "most recently
   * active", "newest", "by name". The report QUOTES this, it does not assume it
   * (#184945). Saying "newest N of M" while the server ordered by something else is
   * the same defect as not saying anything: a sentence about the data that is not a
   * fact about the data. Defaults to the neutral "first" when the caller does not know.
   */
  ordering?: string
}

export type ScopeReport = {
  truncated: boolean
  /** human-facing, appended to the count line */
  notes: string[]
  /** machine-facing, written to stderr so piped stdout stays parseable */
  warnings: string[]
}

export function describeListScope(s: ListScope): ScopeReport {
  // `>` not `!==`: a total that is somehow below `shown` is bad data, not truncation,
  // and inventing a negative remainder would be its own silent lie.
  const truncated = s.total > s.shown

  const ordering = s.ordering && s.ordering.trim() ? s.ordering.trim() : "first"

  // The count is over the scanned window, so name the window when we know it. Otherwise
  // "73 Prospected hidden" sits next to "20 of 28750" and reads as a book-wide figure.
  const hidden = `Prospected hidden${s.scanned && s.scanned > s.shown ? ` of ${s.scanned} scanned` : ""}`

  const notes: string[] = []
  if (s.prospectedHidden > 0) notes.push(`${s.prospectedHidden} ${hidden} — use --all`)
  if (truncated) notes.push(`${ordering} ${s.shown} of ${s.total}`)

  const warnings: string[] = []
  if (truncated) warnings.push(`TRUNCATED: ${ordering} ${s.shown} of ${s.total}`)
  if (s.prospectedHidden > 0) warnings.push(`FILTERED: ${s.prospectedHidden} ${hidden} (pass --all)`)
  // Only when something was withheld. A clean answer that shouts about being clean
  // trains people to ignore the shout.
  if (warnings.length) warnings.push("This is a page, not a population — do not compute rates from it.")

  return { truncated, notes, warnings }
}

// ============================================================================
// `leads list` request building — #191688 #191689 #191690 #191691
// ============================================================================

/** Largest page the server serves (fl-api LeadController::LIST_MAX_PER_PAGE). */
export const LIST_MAX_LIMIT = 1000

/**
 * The orders `leads list --sort` offers, each the server field it pushes and the words the
 * footer uses. An unmapped field silently falls back to created_at on the server, so do not
 * add one without checking LeadController::index's field map.
 *
 * `name` is the DISPLAY name — the server orders on COALESCE(name, nickname) (#191688).
 * `value` is the deal value in money, price_bid, numeric, unpriced last (#191689).
 */
export const LIST_SORTS: Record<string, { sortBy: string; sortDirection: string; orderingLabel: string }> = {
  activity: { sortBy: "updated_at", sortDirection: "desc", orderingLabel: "most recently active" },
  created: { sortBy: "created_at", sortDirection: "desc", orderingLabel: "newest" },
  name: { sortBy: "name", sortDirection: "asc", orderingLabel: "first alphabetically by name" },
  value: { sortBy: "price_bid", sortDirection: "desc", orderingLabel: "highest deal value (price_bid)" },
}

/**
 * #191691 — `--limit` is a positive whole number no larger than the server's page. yargs
 * turns `abc` into NaN, which reached the API and came back as "Server Error"; `-1` was
 * accepted and the server quietly served its default page of 7.
 */
export function parseListLimit(raw: unknown): { ok: true; value: number } | { ok: false; error: string } {
  const text = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim() : ""
  if (!/^\d+$/.test(text) || Number(text) < 1 || Number(text) > LIST_MAX_LIMIT) {
    return {
      ok: false,
      error: `--limit must be a whole number from 1 to ${LIST_MAX_LIMIT} (got ${JSON.stringify(typeof raw === "number" && Number.isNaN(raw) ? "NaN" : (raw ?? ""))})`,
    }
  }
  return { ok: true, value: Number(text) }
}

export type ListRequestOptions = {
  limit: number
  sort?: string
  all?: boolean
  status?: string
  search?: string
  bloqId?: number
  /** #191737 — any of these tag names (server: tag[]), price_bid bounds. */
  tags?: string[]
  minPrice?: number
  maxPrice?: number
  /**
   * #191736 — paging. `cursor` continues a keyset walk (the server's next_cursor);
   * `paginate: "cursor"` starts one; `page` is the server's OFFSET page (1-based).
   */
  cursor?: string
  paginate?: "cursor"
  page?: number
}

export type ListRequest = {
  params: URLSearchParams
  orderingLabel: string
  /** Prospected is excluded IN THE QUERY, so the page is full whenever matches exist. */
  hidesProspected: boolean
  /** Reorder the fetched window into status bands — only for the default activity order. */
  reorderByStatus: boolean
}

/**
 * Build the GET /api/v1/leads query for `leads list`.
 *
 * #191690 — the Prospected filter used to run client-side AFTER the server cut the page,
 * with no backfill: the newest 100 leads were all Prospected (lead discovery), so
 * `--sort created` printed "0 lead(s)" and `--json` printed [] over a book of 29k. The
 * exclusion is now `exclude_statuses=Prospected` on the server, before pagination.
 *
 * #191688/#191689 — an explicit --sort is the order shown. The status-band reorder ran over
 * every sort, so `--sort value` came back 50k, 8k, 100k (In Negotiation first) and
 * `--sort name` was not alphabetical. It now applies only to the default `activity` view,
 * where "active clients first" is the point.
 */
export function buildListRequest(o: ListRequestOptions): ListRequest {
  const sortKey = o.sort && LIST_SORTS[o.sort] ? o.sort : "activity"
  const { sortBy, sortDirection, orderingLabel } = LIST_SORTS[sortKey]
  const hidesProspected = !o.all && !o.status && !o.search
  // #191736 — a page of a walk is shown in the server's order. Banding re-sorts a window, and
  // a window re-sorted per page is not one order across pages: the bands would restart on
  // every page and the walk would no longer be the book in order.
  const paging = Boolean(o.cursor || o.paginate || o.page)
  const reorderByStatus = sortKey === "activity" && !paging
  // The activity view reorders a window into bands, so it needs a window wider than the page.
  const perPage = reorderByStatus && hidesProspected ? Math.min(Math.max(o.limit * 5, 100), LIST_MAX_LIMIT) : o.limit

  const params = new URLSearchParams({ per_page: String(perPage) })
  params.set("sort_by", sortBy)
  params.set("sort_direction", sortDirection)
  if (hidesProspected) params.set("exclude_statuses", "Prospected")
  if (o.status) params.set("status", o.status)
  if (o.search) params.set("search", o.search)
  if (o.bloqId) params.set("bloq_id", String(o.bloqId))
  for (const t of o.tags ?? []) if (t.trim()) params.append("tag[]", t.trim())
  if (o.minPrice !== undefined) params.set("price_bid_min", String(o.minPrice))
  if (o.maxPrice !== undefined) params.set("price_bid_max", String(o.maxPrice))
  if (o.cursor) params.set("cursor", o.cursor)
  else if (o.paginate === "cursor") params.set("pagination", "cursor")
  else if (o.page) params.set("page", String(o.page))
  return { params, orderingLabel, hidesProspected, reorderByStatus }
}

/**
 * #191737 — a price bound is a number or it is refused before any request. The server 422s
 * a non-number too; refusing here keeps `--min-price 5k` from ever being a silent no-op.
 */
export function parsePriceBound(flag: string, raw: unknown): { ok: true; value?: number } | { ok: false; error: string } {
  if (raw === undefined || raw === null || raw === "") return { ok: true }
  const text = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim() : ""
  if (!/^-?\d+(\.\d+)?$/.test(text)) {
    return { ok: false, error: `--${flag} must be a number, e.g. 5000 (got ${JSON.stringify(typeof raw === "number" ? String(raw) : raw)})` }
  }
  return { ok: true, value: Number(text) }
}

/** `--page` is a whole number from 1. */
export function parseListPage(raw: unknown): { ok: true; value?: number } | { ok: false; error: string } {
  if (raw === undefined || raw === null || raw === "") return { ok: true }
  const text = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim() : ""
  if (!/^\d+$/.test(text) || Number(text) < 1) return { ok: false, error: `--page must be a whole number from 1 (got ${JSON.stringify(raw)})` }
  return { ok: true, value: Number(text) }
}

/** One page of GET /api/v1/leads in cursor mode (fl-api LeadController::index, #191736). */
export type CursorPage = { data?: unknown[]; total?: number | null; next_cursor?: string | null; has_more?: boolean }

/**
 * #191736 — walk EVERY page of a keyset cursor and return the rows in order.
 *
 * The server's cursor is "the rows strictly after this row" with id as the final tie-break, so
 * a walk has no gaps and no repeats even when thousands of rows share a sort value or rows
 * are added mid-walk. This loop still refuses to trust that blindly: a row id seen twice, or
 * a cursor that does not advance, stops the walk with an error instead of looping or quietly
 * returning a wrong population.
 */
export async function walkCursorPages(
  fetchPage: (cursor: string | undefined) => Promise<CursorPage>,
  onProgress?: (p: { page: number; fetched: number; total: number | null }) => void,
  maxPages = 10_000,
): Promise<{ rows: any[]; total: number | null; pages: number }> {
  const rows: any[] = []
  const seen = new Set<unknown>()
  let cursor: string | undefined
  let total: number | null = null
  let pages = 0
  while (pages < maxPages) {
    const page = await fetchPage(cursor)
    pages++
    if (pages === 1) total = typeof page.total === "number" ? page.total : null
    for (const r of Array.isArray(page.data) ? (page.data as any[]) : []) {
      const id = r?.id
      if (seen.has(id)) throw new Error(`walk returned lead #${id} twice (page ${pages}) — stopping rather than double-count`)
      seen.add(id)
      rows.push(r)
    }
    onProgress?.({ page: pages, fetched: rows.length, total })
    const next = page.next_cursor ?? null
    if (!next) return { rows, total, pages }
    if (next === cursor) throw new Error(`cursor did not advance on page ${pages} — stopping`)
    cursor = next
  }
  throw new Error(`walk stopped after ${maxPages} pages`)
}

/**
 * #191738 — a timestamp from the API as an instant. The API now sends ISO 8601 with a zone
 * for every lead timestamp; older servers sent some as bare "YYYY-MM-DD HH:MM:SS", which is
 * UTC on fl-api, but `new Date()` reads a bare string as LOCAL time — so a reply 2h ago read
 * as 7h ago in Chicago. Bare strings are read as UTC here.
 */
export function parseServerTime(v: unknown): Date | null {
  if (typeof v !== "string" || !v.trim()) return null
  const s = v.trim()
  const bare = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s)
  const d = new Date(bare ? s.replace(" ", "T") + "Z" : s)
  return isNaN(d.getTime()) ? null : d
}

/** A server timestamp in the reader's local time, e.g. "2026-10-28 21:36 CDT". `--json` keeps the ISO value. */
export function formatLocalTime(v: unknown, timeZone?: string): string | undefined {
  const d = parseServerTime(v)
  if (!d) return typeof v === "string" && v.trim() ? v : undefined
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZoneName: "short",
    })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  )
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} ${parts.timeZoneName}`
}

/** The name a lead is shown by — `name` is null on most leads, which carry `nickname` (#191688). */
export function leadDisplayName(l: Record<string, unknown>): string {
  for (const k of ["name", "nickname", "first_name"]) {
    const v = l[k]
    if (typeof v === "string" && v.trim()) return v.trim()
  }
  return `Lead #${l.id}`
}

/**
 * #191693 — an empty FILTERED result is not an empty book: say what matched nothing instead
 * of "Create one". (An unknown status never gets here; the server rejects it with the valid list.)
 */
export function emptyListMessage(o: { status?: string; search?: string; bloqId?: number }): { warn: string; hint: string } {
  const parts: string[] = []
  if (o.status) parts.push(`status "${o.status}"`)
  if (o.search) parts.push(`search "${o.search}"`)
  if (o.bloqId) parts.push(`bloq ${o.bloqId}`)
  if (parts.length) return { warn: `No leads match ${parts.join(", ")}`, hint: "Widen the filter, or: iris leads list --all" }
  return { warn: "No leads found", hint: "Create one: iris leads create" }
}

/**
 * #191692 — the bloq scope is part of a segment's saved definition, so it goes in `filters`
 * as an integer, alongside the URL scope. It used to live only in the URL, and the saved
 * filters said {status: "Responded"} for a segment that was really "Responded in bloq 40".
 */
export function buildSegmentFilters(o: {
  status?: string
  search?: string
  bloqId?: number
  minPrice?: number
  maxPrice?: number
  tag?: string
}): Record<string, any> {
  const filters: Record<string, any> = {}
  if (o.status) filters.status = String(o.status)
  if (o.search) filters.search = String(o.search)
  if (o.bloqId) filters.bloq_id = Math.trunc(Number(o.bloqId))
  if (o.minPrice) filters.value_range = { ...(filters.value_range || {}), min: Number(o.minPrice) }
  if (o.maxPrice) filters.value_range = { ...(filters.value_range || {}), max: Number(o.maxPrice) }
  if (o.tag) filters.tags = [String(o.tag)]
  return filters
}

// ============================================================================
// `leads replied` — #191702
// ============================================================================

export const REPLIED_TAG = "DM Replied"

/** True when the lead itself says it replied: has_replied, or the "DM Replied" tag as fallback. */
export function leadHasReplied(l: Record<string, any>): boolean {
  if (l.has_replied === true || l.has_replied === 1 || l.has_replied === "1") return true
  const tags = Array.isArray(l.tags) ? l.tags : []
  return tags.some((t: any) => (typeof t === "string" ? t : t?.name) === REPLIED_TAG)
}

/**
 * #191702 — "leads that replied" is has_replied (fl-api #185 sets it, and the tag, on every
 * genuine reply), with the "DM Replied" tag as a fallback for leads tagged before that. It is
 * NOT a status: status moves on after triage (Follow Up, Qualified…), and the help used to
 * claim "status Responded" while the filter was the tag alone.
 *
 * Merges the two server queries, de-duplicates by id, keeps only rows that really replied (a
 * server that ignored a filter must not turn this into "every lead"), newest reply first.
 */
export function mergeResponders(lists: Array<Array<Record<string, any>>>, limit: number): Array<Record<string, any>> {
  const byId = new Map<unknown, Record<string, any>>()
  for (const list of lists) for (const l of list) if (l && !byId.has(l.id) && leadHasReplied(l)) byId.set(l.id, l)
  const t = (l: Record<string, any>) => parseServerTime(l.replied_at ?? l.updated_at)?.getTime() ?? 0
  return [...byId.values()].sort((a, b) => t(b) - t(a)).slice(0, limit)
}
