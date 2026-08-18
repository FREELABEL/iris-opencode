/**
 * The `list` data contract: say how much you are withholding, and return identity
 * rather than everything.
 *
 * Two defects measured on 2026-08-17, both of which read as model failures and
 * were not:
 *
 * 1. TRUNCATION WAS INVISIBLE. `bloqs list --json` returned 20 records as a flat
 *    array. The account has 137. Nothing in the payload said so — no total, no
 *    truncated flag, no next — so a model reading it reasonably concluded it had
 *    everything, then answered "your family project is #602" while #200 (Family
 *    Businesses), #137 (Family Health and Finance), #544 and #584 sat in the other
 *    117. The API sends pagination metadata; the CLI dropped it.
 *
 * 2. `list` HAD NO FIELD CONTRACT. bloqs list = 20 x 4 fields = 2,290 bytes.
 *    agents list = 30 x 72 fields = 145,395 bytes. Same verb, 63x apart. The
 *    second overflowed every time, forcing a spill -> jq -> narrow round-trip to
 *    answer "what agents do I have".
 *
 * A tool that returns 15% of the data while looking complete will defeat any
 * model, and one that returns 145KB for a listing makes an easy question
 * expensive. Prompt guidance can compensate for both; it should not have to.
 */

export interface ListMeta {
  /** How many rows are in `data`. */
  returned: number
  /** How many exist server-side, when the API tells us. Absent means unknown. */
  total?: number
  /** True when rows are being withheld — or when we cannot rule it out. */
  truncated: boolean
  /** The page size that produced this result. */
  limit?: number
  /** Present only when truncated: how to actually get the rest. */
  hint?: string
}

export interface ListEnvelope<T> {
  data: T[]
  meta: ListMeta
}

/**
 * Wrap rows with metadata that makes withholding visible.
 *
 * When the server sends no total, a FULL page is treated as truncated. That is
 * deliberate: a full page is the only evidence available, and claiming
 * "complete" on no evidence is precisely the failure being fixed. Over-reporting
 * truncation costs one extra query; under-reporting it produces a confident
 * wrong answer.
 */
export function buildListEnvelope<T>(
  rows: T[],
  opts: { total?: number; limit?: number; resource?: string } = {},
): ListEnvelope<T> {
  const returned = rows.length
  const { total, limit, resource } = opts

  const truncated =
    typeof total === "number"
      ? returned < total
      : typeof limit === "number" && returned >= limit && returned > 0

  const meta: ListMeta = { returned, truncated }
  if (typeof total === "number") meta.total = total
  if (typeof limit === "number") meta.limit = limit

  if (truncated) {
    const noun = resource ?? "results"
    const searchCmd = resource ? `iris ${resource} search <term>` : "search"
    meta.hint =
      `Showing ${returned}${typeof total === "number" ? ` of ${total}` : ""} ${noun}. ` +
      `This is NOT the full set — do not answer "which do I have" from it. ` +
      `Use --limit <n> for more, or ${searchCmd} to find by keyword across everything.`
  }

  return { data: rows, meta }
}

/**
 * Summary fields per resource — identity plus the few discriminators a caller
 * needs to choose a row and then `get` it.
 *
 * The ceiling is 8. Past that it has stopped being a listing, and the caller
 * should be fetching the record instead. A test enforces both the ceiling and
 * the presence of an id and a human-readable label, because a row you cannot
 * follow up on is not lean, it is useless.
 */
export const LIST_FIELDS: Record<string, string[]> = {
  bloqs: ["id", "name", "type", "is_owner"],
  agents: ["id", "name", "type", "active", "description", "last_active_at"],
  leads: ["id", "name", "email", "company", "status", "updated_at"],
  pages: ["id", "title", "slug", "status", "updated_at"],
  workflows: ["id", "name", "type", "active", "updated_at"],
}

/**
 * Keep only `allow` on each row. `id` survives regardless — a row that cannot be
 * followed up with `get` defeats the purpose of a listing.
 *
 * Passing `undefined` returns rows untouched, so `get` keeps returning
 * everything. The contract is about `list`.
 */
export function projectFields<T extends Record<string, any>>(
  rows: T[],
  allow: string[] | undefined,
): Partial<T>[] {
  if (!allow || allow.length === 0) return rows

  const keys = allow.includes("id") ? allow : ["id", ...allow]

  return rows.map((row) => {
    const out: Partial<T> = {}
    for (const k of keys) {
      if (row && Object.prototype.hasOwnProperty.call(row, k)) {
        out[k as keyof T] = row[k]
      }
    }
    return out
  })
}
