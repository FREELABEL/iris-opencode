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
