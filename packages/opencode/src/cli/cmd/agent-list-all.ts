import { irisFetch } from "./iris-api"
import { normalizeListResponse } from "./pagination-args"

/** fl-api clamps per_page to this, so asking for more in one request never gets more (#191868). */
const PER_PAGE = 500
/** 500,000 agents. Past this a server that never says "last page" is the likelier explanation. */
const MAX_PAGES = 1000

export type AllAgents<T> = { ok: true; rows: T[] } | { ok: false; status: number | null; error: string }

/**
 * Every agent the account has, across every page. A failure is a failure rather than the pages
 * read so far: name lookups and the Desktop sync both treat this list as complete, so a partial
 * one reads as "that agent does not exist".
 */
export async function listAllAgents<T = any>(
  userId: number | string,
  options: { signal?: AbortSignal } = {},
): Promise<AllAgents<T>> {
  const rows: T[] = []
  const seen = new Set<unknown>()

  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await irisFetch(
      `/api/v1/users/${userId}/bloqs/agents?per_page=${PER_PAGE}&page=${page}`,
      options.signal ? { signal: options.signal } : {},
    )
    if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}` }

    const body = normalizeListResponse<T>(await res.json())
    let added = 0
    for (const row of body.rows) {
      const id = (row as any)?.id
      if (id !== undefined && seen.has(id)) continue
      if (id !== undefined) seen.add(id)
      rows.push(row)
      added++
    }

    const more =
      body.hasMore ??
      (body.lastPage !== null
        ? page < body.lastPage
        : body.total !== null
          ? rows.length < body.total
          : body.rows.length >= (body.perPage ?? PER_PAGE))
    if (!more) return { ok: true, rows }
    // The server says there is more but this page held nothing new, so it is ignoring `page`.
    if (added === 0) return { ok: false, status: null, error: `agent list stopped advancing at page ${page}` }
  }

  return { ok: false, status: null, error: `agent list did not end within ${MAX_PAGES} pages` }
}
