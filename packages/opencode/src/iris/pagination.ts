/**
 * One pagination contract for every /iris/* list.
 *
 * WHY A SHARED SERVICE AND NOT PER-ROUTE SLICING. Eight list surfaces, three different upstream
 * shapes: fl-api paginates with Laravel meta, iris-api returns a bare array, and schemas and
 * integrations come back whole with no paging at all. Left to each route, "how many are there"
 * would mean something slightly different in each one — and a UI cannot render a count it
 * cannot trust.
 *
 * THE DISTINCTION THIS EXISTS TO PRESERVE. `total` is `number | null`, and null means NOT
 * KNOWN — the upstream did not say. It does not mean zero. A footer that renders an unknown
 * total as "0 of 0" tells someone their board is empty when the truth is that nobody counted,
 * and that is the same failure this codebase has now paid for in the fleet pill, the Atlas
 * panel and the inbox badge. `totalIsExact` says whether the number can be stated flatly
 * ("127 playbooks") or only as a floor ("127 so far").
 */

export interface PageEnvelope<T> {
  items: T[]
  /** 1-based. */
  page: number
  perPage: number
  /** Null means NOT MEASURED — never render it as zero. */
  total: number | null
  /**
   * True when `total` counts everything that exists. False when it counts only what we have
   * seen so far, because the upstream truncated and did not report a total.
   */
  totalIsExact: boolean
  hasMore: boolean
}

export const DEFAULT_PER_PAGE = 25
const MAX_PER_PAGE = 200

export function clampPaging(input: { page?: number; perPage?: number }): { page: number; perPage: number } {
  const page = Number.isFinite(input.page) && (input.page as number) > 0 ? Math.floor(input.page as number) : 1
  const raw = Number.isFinite(input.perPage) ? Math.floor(input.perPage as number) : DEFAULT_PER_PAGE
  return { page, perPage: Math.min(MAX_PER_PAGE, Math.max(1, raw)) }
}

/**
 * Page a list we hold in full.
 *
 * `upstreamTotal` is for the case where we do NOT hold it in full: fl-api truncates at its own
 * per_page and reports the real total in its meta. Pass it and the envelope reports that number
 * as exact; omit it and the count is whatever we actually have.
 *
 * `upstreamTruncated` is the honest middle: we asked for N, got exactly N, and were told no
 * total — so there may be more and our count is a floor, not an answer.
 */
export function paginate<T>(
  all: T[],
  input: { page?: number; perPage?: number; upstreamTotal?: number | null; upstreamTruncated?: boolean },
): PageEnvelope<T> {
  const { page, perPage } = clampPaging(input)
  const start = (page - 1) * perPage
  const items = all.slice(start, start + perPage)

  const haveWholeSet = !input.upstreamTruncated
  const total = input.upstreamTotal ?? (haveWholeSet ? all.length : all.length)
  const totalIsExact = input.upstreamTotal != null ? true : haveWholeSet

  return {
    items,
    page,
    perPage,
    total,
    totalIsExact,
    // Within what we hold, OR beyond it when the upstream truncated on the last local page.
    hasMore: start + items.length < all.length || (!haveWholeSet && start + items.length >= all.length),
  }
}

/** Laravel-style pagination meta, when the upstream bothers to send it. */
export function readUpstreamTotal(json: unknown): number | null {
  const j = json as any
  const candidates = [j?.meta?.total, j?.data?.total, j?.total]
  for (const c of candidates) if (typeof c === "number" && Number.isFinite(c)) return c
  return null
}
