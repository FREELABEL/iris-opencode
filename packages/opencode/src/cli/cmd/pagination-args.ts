import * as prompts from "./clack"

/**
 * Shared validation for --limit / --page / --hours style flags (#191851, #191850).
 *
 * `iris schedules list --limit 0|1` and `--page 0|-1` all returned every one of 967 schedules,
 * and `iris monitor overview --hours 0|-1|999999` was sent as-is. A flag value the command would
 * have to reinterpret is refused instead, before any network call, so what the caller asked for
 * is what was applied. Mirrors the shape #191846 uses for `bloqs items` so the two can converge
 * on this module.
 */

export type FieldErrors = Record<string, string[]>

const isWhole = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v)

/**
 * Field errors for a whole-number flag bounded to [min, max] (max optional), or null when the
 * value is usable. `undefined` (flag not given, no default) is not checked.
 */
export function wholeNumberError(
  flag: string,
  value: unknown,
  opts: { min: number; max?: number; note?: string },
): string | null {
  if (value === undefined) return null
  const { min, max } = opts
  if (isWhole(value) && value >= min && (max === undefined || value <= max)) return null
  const range = max === undefined ? `of at least ${min}` : `from ${min} to ${max}`
  return `--${flag} must be a whole number ${range}${opts.note ? ` ${opts.note}` : ""}; got ${JSON.stringify(
    typeof value === "number" && Number.isNaN(value) ? "NaN" : value,
  )}.`
}

/** --limit (1..maxLimit) and --page (>= 1). */
export function paginationErrors(
  args: { limit?: unknown; page?: unknown },
  opts: { maxLimit?: number } = {},
): FieldErrors | null {
  const errors: FieldErrors = {}
  const limit = wholeNumberError("limit", args.limit, { min: 1, max: opts.maxLimit })
  if (limit) errors.limit = [limit]
  const page = wholeNumberError("page", args.page, { min: 1, note: "(pages are 1-based)" })
  if (page) errors.page = [page]
  return Object.keys(errors).length ? errors : null
}

/**
 * Report field errors and set a non-zero exit: JSON on stdout in --json mode, an error line
 * otherwise. Returns true when the caller must stop. Exit code 2 = usage error.
 */
export function rejectFieldErrors(errors: FieldErrors | null, json: unknown): boolean {
  if (!errors) return false
  const message = Object.values(errors).flat().join(" ")
  process.exitCode = 2
  if (json) console.log(JSON.stringify({ success: false, error: message, errors }))
  else prompts.log.error(message)
  return true
}

export function rejectBadPagination(
  args: { limit?: unknown; page?: unknown; json?: unknown },
  opts: { maxLimit?: number } = {},
): boolean {
  return rejectFieldErrors(paginationErrors(args, opts), args.json)
}

export interface PageInfo {
  page: number
  per_page: number
  total: number
  last_page: number
  has_more: boolean
  returned: number
}

/** Page metadata for `rows` items of `total`, computed the same way the server does. */
export function pageInfo(page: number, perPage: number, total: number, returned: number): PageInfo {
  const lastPage = Math.max(1, Math.ceil(total / perPage))
  return { page, per_page: perPage, total, last_page: lastPage, has_more: page < lastPage, returned }
}

/** Slice one page out of a full list (for servers that ignore paging, or client-side filters). */
export function slicePage<T>(rows: T[], page: number, perPage: number): T[] {
  return rows.slice((page - 1) * perPage, page * perPage)
}

// ============================================================================
// The list contract (#191863, #191864)
// ============================================================================
//
// Every list command's --json output has one shape, whatever the server sent:
//
//   { data: [...],
//     meta: { total, returned, per_page, current_page, last_page, from, to,
//             has_more, truncated, hint? },
//     links?: { next, prev } }          // CLI command strings, not URLs
//
// Before this, five list commands answered in five shapes: agents/pages {data, meta:{returned,
// truncated,total,limit,hint}}, schedules {schedules, pagination}, users a bare [] with no
// metadata, bugs {items, page, total, last_page}. A script (or a model) reading one could not
// read the next, and a bare array cannot say "this is page 1 of 10".
//
// Rules the builder enforces:
//   - `total` is null only when the server truly did not count. It is never guessed.
//   - `has_more` is always present. With no total it comes from the server's own signal
//     (has_more / next_page_url / last_page); with none of those, a FULL page is treated as
//     "more may exist" — a full page is the only evidence, and claiming completeness on no
//     evidence is the failure being fixed.
//   - `truncated` = returned < total (or has_more when total is unknown); a truncated result
//     always carries a `hint` that says exactly how to get the rest.
//   - Empty is { data: [], meta: { total: 0, has_more: false, ... } } — never a bare [].

export interface ListMeta {
  /** Rows that exist server-side for this query; null only when the server did not count. */
  total: number | null
  /** Rows in `data`. */
  returned: number
  /** The page size that was applied (the server's, when it reports one — it may clamp). */
  per_page: number
  /** 1-based page this result is. null only on a cursor continuation page (see next_cursor). */
  current_page: number | null
  /** null when total is unknown and the server gave no last page. */
  last_page: number | null
  /** 1-based position of the first / last row in `data`; null when `data` is empty. */
  from: number | null
  to: number | null
  /** True when a later page has rows. */
  has_more: boolean
  /** True when rows are being withheld from this result (other pages exist, or might). */
  truncated: boolean
  /** Present when truncated: how to get the rest. */
  hint?: string
  /** Keyset-cursor commands only: pass as --cursor for the next page; null on the last. */
  next_cursor?: string | null
  /** @deprecated v1.5.25 alias of per_page (agents/pages/workflows/atlas list meta.limit). */
  limit?: number
}

export interface ListLinks {
  /** The CLI command for the next page, or null on the last page. */
  next: string | null
  /** The CLI command for the previous page, or null on page 1. */
  prev: string | null
}

export interface ListEnvelope<T> {
  data: T[]
  meta: ListMeta
  links?: ListLinks
}

/** A server list response reduced to rows plus whatever paging facts it carried. */
export interface ListPage<T> {
  rows: T[]
  total: number | null
  page: number | null
  perPage: number | null
  lastPage: number | null
  hasMore: boolean | null
}

const num = (...vals: unknown[]): number | null => {
  for (const v of vals) {
    if (typeof v === "number" && Number.isFinite(v)) return v
    if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v)
  }
  return null
}

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v)

/**
 * Normalize the server shapes this API actually returns into rows + paging facts:
 *   - bare array                                   [ ... ]
 *   - Laravel paginator                            { data:[...], current_page, per_page, total, last_page, next_page_url }
 *   - Laravel resource collection / our envelope   { data:[...], meta:{ total, current_page, ... }, links }
 *   - {items, total} / {items, page, total, last_page}
 *   - {<key>:[...], pagination:{...}}              (pass `key`, e.g. "schedules")
 *   - any of the above wrapped as { success, data: <paginator> }
 * Anything else yields no rows and no facts — an empty list, not a crash.
 */
export function normalizeListResponse<T = any>(body: unknown, opts: { key?: string } = {}): ListPage<T> {
  if (Array.isArray(body)) return { rows: body as T[], total: null, page: null, perPage: null, lastPage: null, hasMore: null }
  if (!isObj(body)) return { rows: [], total: null, page: null, perPage: null, lastPage: null, hasMore: null }

  // { success, data: { data:[...], total, ... } } — unwrap to the paginator.
  if (!(opts.key && Array.isArray(body[opts.key])) && isObj(body.data) && (Array.isArray(body.data.data) || Array.isArray(body.data.items) || (opts.key && Array.isArray(body.data[opts.key])))) {
    return normalizeListResponse<T>(body.data, opts)
  }

  const rowsSrc = opts.key && Array.isArray(body[opts.key]) ? body[opts.key] : Array.isArray(body.data) ? body.data : Array.isArray(body.items) ? body.items : Array.isArray(body.results) ? body.results : []
  const meta = isObj(body.meta) ? body.meta : {}
  const pg = isObj(body.pagination) ? body.pagination : isObj(meta.pagination) ? meta.pagination : {}

  let hasMore: boolean | null = null
  for (const v of [body.has_more, meta.has_more, pg.has_more]) if (typeof v === "boolean") { hasMore = v; break }
  if (hasMore === null && "next_page_url" in body) hasMore = body.next_page_url != null
  if (hasMore === null && isObj(body.links) && "next" in body.links) hasMore = body.links.next != null

  return {
    rows: rowsSrc as T[],
    total: num(body.total, meta.total, pg.total),
    page: num(body.current_page, meta.current_page, pg.current_page, pg.page, body.page, meta.page),
    perPage: num(body.per_page, meta.per_page, pg.per_page, pg.limit, meta.limit),
    lastPage: num(body.last_page, meta.last_page, pg.last_page),
    hasMore,
  }
}

const isListPage = (v: unknown): v is ListPage<any> => isObj(v) && Array.isArray(v.rows) && "total" in v && "hasMore" in v

export interface ListEnvelopeOptions {
  /** Plural noun for messages: "agents", "schedules". */
  resource: string
  /** The CLI command that produced this, e.g. "agents list" — enables links + an exact hint. */
  command?: string
  /** The page / page size the caller asked for (used where the server is silent). */
  page?: number
  limit?: number
  /** Override the server's total (e.g. after a client-side filter over every page). */
  total?: number | null
  /** `rows` is the WHOLE result set (server ignores paging, or a client-side filter): count and slice here. */
  complete?: boolean
  /** Row array key for {<key>:[...]} bodies. */
  key?: string
  /** Keyword-search alternative to mention in the hint, e.g. "iris agents search <term>". */
  search?: string
  /**
   * Keys a command already emitted before this contract (e.g. schedules' {schedules, pagination}).
   * Kept beside data/meta so scripts written against v1.5.25 keep working. Deprecated: remove
   * once the release notes have carried the data/meta shape for a cycle.
   */
  legacy?: Record<string, unknown>
  /**
   * Keyset-cursor paging (leads). `next` is the server's next cursor (it decides has_more);
   * `continued` = this page was reached by --cursor, so its page number and row offsets are
   * unknown and reported as null rather than invented.
   */
  cursor?: { next: string | null; continued: boolean }
}

/** Build the contract envelope from rows, a ListPage, or a raw server body. */
export function listEnvelope<T = any>(source: T[] | ListPage<T> | unknown, opts: ListEnvelopeOptions): ListEnvelope<T> {
  const src: ListPage<T> = isListPage(source) ? (source as ListPage<T>) : normalizeListResponse<T>(source, { key: opts.key })

  let rows = src.rows
  let total: number | null
  let page: number
  let perPage: number
  let serverHasMore = src.hasMore
  let serverLastPage = src.lastPage

  if (opts.complete) {
    total = rows.length
    page = opts.page ?? 1
    perPage = opts.limit ?? Math.max(rows.length, 1)
    rows = slicePage(rows, page, perPage)
    serverHasMore = null
    serverLastPage = null
  } else {
    total = opts.total !== undefined ? opts.total : src.total
    // The server's applied values win: it may clamp per_page (asked 1000, got 500).
    page = src.page ?? opts.page ?? 1
    perPage = src.perPage ?? opts.limit ?? Math.max(rows.length, 1)
  }
  page = Math.max(1, Math.trunc(page))
  perPage = Math.max(1, Math.trunc(perPage))

  const returned = rows.length
  const lastPage = total !== null ? Math.max(1, Math.ceil(total / perPage)) : serverLastPage
  const from = returned > 0 ? (page - 1) * perPage + 1 : null
  const to = from !== null ? from + returned - 1 : null

  let hasMore: boolean
  // A cursor says "more" by existing; a missing cursor with a known total still larger than this
  // first page is "more", not "done" (an older server that ignored ?pagination=cursor).
  if (opts.cursor) hasMore = opts.cursor.next !== null || (!opts.cursor.continued && total !== null && page * perPage < total)
  else if (total !== null) hasMore = page * perPage < total
  else if (serverHasMore !== null) hasMore = serverHasMore
  else if (lastPage !== null) hasMore = page < lastPage
  else hasMore = returned > 0 && returned >= perPage

  const truncated = total !== null ? returned < total || hasMore : hasMore
  const continued = Boolean(opts.cursor?.continued)

  const meta: ListMeta = {
    total,
    returned,
    per_page: perPage,
    current_page: continued ? null : page,
    last_page: continued ? null : lastPage,
    from: continued ? null : from,
    to: continued ? null : to,
    has_more: hasMore,
    truncated,
  }
  if (opts.cursor) meta.next_cursor = opts.cursor.next

  const cmdFor = (p: number) => (opts.command ? `iris ${opts.command} --page ${p} --limit ${perPage}` : null)
  const nextCmd = opts.cursor
    ? opts.cursor.next !== null && opts.command
      ? `iris ${opts.command} --cursor ${opts.cursor.next} --limit ${perPage}`
      : null
    : cmdFor(page + 1)

  if (truncated) {
    const noun = opts.resource
    const parts: string[] = []
    if (returned === 0 && page > 1) {
      parts.push(`Page ${page} is past the end${lastPage !== null ? ` (last page is ${lastPage})` : ""}${total !== null ? ` — ${total} ${noun} in total` : ""}.`)
      if (lastPage !== null) parts.push(opts.command ? `Last page: ${cmdFor(lastPage)}.` : `Use --page ${lastPage}.`)
    } else {
      const range = meta.from !== null ? `${meta.from}–${meta.to}` : `${returned}`
      const where = meta.current_page !== null ? ` (page ${page}${lastPage !== null ? `/${lastPage}` : ""})` : ""
      parts.push(`Showing ${range}${total !== null ? ` of ${total}` : ""} ${noun}${where}.`)
      parts.push(`This is NOT the full set — do not answer "which do I have" from it.`)
      if (hasMore) {
        if (nextCmd) parts.push(`Next page: ${nextCmd}${opts.cursor ? "" : " (or a larger --limit)"}.`)
        else parts.push(opts.cursor ? `Next page: --cursor ${opts.cursor.next}.` : `Use --page ${page + 1} or a larger --limit <n> for more.`)
      }
      else if (page > 1) parts.push(`Earlier rows: --page 1 … --page ${page - 1} (or a larger --limit).`)
      if (total === null) parts.push("The server did not report a total.")
    }
    if (opts.search) parts.push(`To find by keyword across everything: ${opts.search}.`)
    meta.hint = parts.join(" ")
  }

  const env: ListEnvelope<T> = { data: rows, meta }
  if (opts.command) {
    env.links = {
      next: hasMore ? nextCmd : null,
      prev: !opts.cursor && page > 1 ? cmdFor(lastPage !== null ? Math.min(page - 1, lastPage) : page - 1) : null,
    }
  }
  if (opts.legacy) return { ...opts.legacy, ...env } as ListEnvelope<T>
  return env
}

/**
 * The one human footer for a list:
 *   "Showing 1–50 of 455 agents · page 1/10 · --page 2 for more"
 *   "Showing 1–12 of 12 agents · page 1/1"
 *   "No agents found."
 *   "Page 12 is past the end — 455 agents in 10 page(s). Try --page 10."
 */
export function listFooter(meta: ListMeta, resource: string, opts: { more?: string } = {}): string {
  if (meta.returned === 0) {
    if (meta.current_page !== null && meta.current_page > 1 && meta.total !== 0) {
      const of = meta.total !== null ? ` — ${meta.total} ${resource}${meta.last_page !== null ? ` in ${meta.last_page} page(s)` : ""}` : ""
      return `Page ${meta.current_page} is past the end${of}.${meta.last_page !== null ? ` Try --page ${meta.last_page}.` : " Try --page 1."}`
    }
    return `No ${resource} found.`
  }
  const of = meta.total !== null ? ` of ${meta.total}` : ""
  if (meta.current_page === null || meta.from === null) {
    // Cursor continuation: no page number or offsets to show.
    const more = meta.has_more ? ` · ${opts.more ?? (meta.next_cursor ? `--cursor ${meta.next_cursor} for more` : "more available")}` : " · last page"
    return `Showing ${meta.returned}${of} ${resource}${more}`
  }
  const pages = `page ${meta.current_page}${meta.last_page !== null ? `/${meta.last_page}` : ""}`
  const nextHow = meta.next_cursor ? `--cursor ${meta.next_cursor} for more` : `--page ${meta.current_page + 1} for more`
  const more = meta.has_more ? ` · ${opts.more ?? nextHow}` : ""
  return `Showing ${meta.from}–${meta.to}${of} ${resource} · ${pages}${more}`
}

/**
 * A command string carrying the caller's filters, for `links` and hints:
 * commandWith("schedules list", { active: true, "agent-id": 12 }) → "schedules list --active --agent-id 12".
 * false / null / undefined / "" are dropped; values with spaces are quoted.
 */
export function commandWith(base: string, flags: Record<string, unknown>): string {
  const parts = [base]
  for (const [k, v] of Object.entries(flags)) {
    if (v === undefined || v === null || v === false || v === "") continue
    if (v === true) parts.push(`--${k}`)
    else {
      const s = String(v)
      parts.push(`--${k} ${/[\s"'$`\\]/.test(s) ? JSON.stringify(s) : s}`)
    }
  }
  return parts.join(" ")
}
