import { paginationErrors } from "./pagination-args"

/**
 * iris_agent action:"list" — paging and honest counts (#191862).
 *
 * The tool used to run `iris agents list --json --limit 50` and then report
 * `${described} of ${roster.length} agent(s) carry a description and are listed` — where
 * roster.length was the PAGE it had just asked for, not the account. On an account with 455
 * agents it said "50 of 50", offered no page argument and no total, so an LLM picking an agent
 * concluded the other 405 did not exist. The total was in the CLI's own envelope (meta.total)
 * the whole time; it was simply never read.
 *
 * Pure and I/O-free so the argv and the wording are asserted by tests, not by reading output.
 */

export const AGENT_LIST_DEFAULT_LIMIT = 50
/** Kept well under the server's 500 so one page of compact rows stays inside an MCP result. */
export const AGENT_LIST_MAX_LIMIT = 200

export interface AgentListMeta {
  total: number | null
  returned: number
  per_page: number
  current_page: number
  last_page: number | null
  from: number | null
  to: number | null
  has_more: boolean
  truncated: boolean
  /** Rows the server returned for this page, before agents with no description were dropped. */
  page_rows: number
  /** Rows on this page dropped because they have no description. */
  omitted_no_description: number
  hint?: string
}

export type AgentListRequest =
  | { ok: true; argv: string[]; query: string; page: number; perPage: number }
  | { ok: false; error: string }

/** Validate the MCP arguments and build the `iris agents list` argv. */
export function buildAgentListArgs(args: Record<string, unknown> | undefined): AgentListRequest {
  const query = typeof args?.query === "string" ? args.query.trim() : ""
  const limit = args?.limit === undefined ? AGENT_LIST_DEFAULT_LIMIT : args.limit
  const page = args?.page === undefined ? 1 : args.page

  const errors = paginationErrors({ limit, page }, { maxLimit: AGENT_LIST_MAX_LIMIT })
  if (errors) {
    // The shared helper words these as CLI flags; an MCP caller passes fields.
    const msg = Object.values(errors).flat().join(" ").replace(/--(limit|page)\b/g, "$1")
    return { ok: false, error: `Error: ${msg}` }
  }
  if (query && /[;&|`$\\<>!\n\r]/.test(query)) return { ok: false, error: "Error: invalid characters in query" }

  const argv = ["agents", "list", "--json", "--limit", String(limit), "--page", String(page)]
  if (query) argv.push("-s", query)
  return { ok: true, argv, query, page: page as number, perPage: limit as number }
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null)

/**
 * Turn the CLI's JSON envelope into the tool result. Reads the total from the envelope
 * (meta.total, or a top-level total from an older CLI) — never from the page length.
 */
export function renderAgentList(
  parsed: unknown,
  req: { query: string; page: number; perPage: number },
): { text: string; data: Array<{ id: unknown; name: unknown; description: unknown }>; meta: AgentListMeta } {
  const env = (parsed ?? {}) as Record<string, any>
  const roster: Array<Record<string, unknown>> = Array.isArray(env.data) ? env.data : []
  const { query, page, perPage } = req

  const total = num(env.meta?.total) ?? num(env.total)
  const described = roster.filter((a) => typeof a.description === "string" && (a.description as string).trim())
  const data = described.map((a) => ({ id: a.id, name: a.name, description: a.description }))

  const lastPage = total === null ? null : Math.max(1, Math.ceil(total / perPage))
  const from = roster.length ? (page - 1) * perPage + 1 : null
  const to = from === null ? null : from + roster.length - 1
  // Unknown total: the only evidence of more is a full page.
  const hasMore = total === null ? roster.length >= perPage : (to ?? (page - 1) * perPage) < total
  const truncated = hasMore || page > 1

  const scope = query ? ` matching "${query}"` : ""
  const nextCall = (p: number) =>
    `iris_agent {action:"list"${query ? `, query:${JSON.stringify(query)}` : ""}, page:${p}${perPage !== AGENT_LIST_DEFAULT_LIMIT ? `, limit:${perPage}` : ""}}`

  const meta: AgentListMeta = {
    total,
    returned: data.length,
    per_page: perPage,
    current_page: page,
    last_page: lastPage,
    from,
    to,
    has_more: hasMore,
    truncated,
    page_rows: roster.length,
    omitted_no_description: roster.length - data.length,
  }
  if (hasMore) {
    meta.hint =
      `This is page ${page}${lastPage ? ` of ${lastPage}` : ""}, NOT every agent${scope}. ` +
      `Call ${nextCall(page + 1)} for the next page (limit up to ${AGENT_LIST_MAX_LIMIT}), ` +
      `or pass query to search all of them by name/description.`
  }

  const totalWord = total === null ? "an unknown total of" : String(total)
  let note: string
  if (roster.length === 0) {
    if (total === 0 || (total === null && page === 1)) {
      note = query ? `No agents matched "${query}". Try a broader term, or action:"list" with no query.` : "No agents found."
    } else {
      note =
        `Page ${page} is past the last page${lastPage ? ` (${lastPage})` : ""} — ${totalWord} agent(s)${scope} in total. ` +
        `Call ${nextCall(1)} to start from the first page.`
    }
  } else {
    note =
      `Agents ${from}–${to} of ${totalWord}${scope} (page ${page}${lastPage ? ` of ${lastPage}` : ""}, ${perPage} per page). ` +
      `${data.length} of these ${roster.length} carry a description and are listed` +
      (meta.omitted_no_description
        ? `; ${meta.omitted_no_description} omitted as unidentifiable — an agent with no description cannot be chosen deliberately.`
        : ".") +
      (hasMore ? ` MORE EXIST: call ${nextCall(page + 1)} for the next page, or narrow with query.` : " This is the last page.") +
      ` Pick by what an agent OWNS, then action:"ask" with its id.`
  }

  return { text: `${note}\n\n${JSON.stringify({ data, meta }, null, 2)}`, data, meta }
}
