// A board's web address (#185736).
//
// The canonical address is the Atlas console: {PUBLIC_SITE}/atlas?project={id}. `project` is
// one of that page's declared urlState keys, so it opens the board on load.
//
// This used to be built here as {IRIS_FRONTEND_URL}/iris/bloq/{id} — the old Elon route — and
// because a compiled binary cannot be corrected after release, every install kept minting the
// retired address. fl-api now returns the address as `public_url`, and a caller holding an API
// response should prefer it (bloqUrlFrom) so the next move is a server change, not a release.
//
// Do NOT append `source=` as provenance. On the Atlas page `source` is the console TAB
// (memory, agents, ...) and `row` is a selection inside it; `source=cli` opens a tab that does
// not exist.

export function bloqWebUrl(id: string | number, site: string): string {
  return `${site.replace(/\/+$/, "")}/atlas?project=${encodeURIComponent(String(id))}`
}

/**
 * The API's address when it is an Atlas address, otherwise the same format built locally.
 *
 * Shape-checked rather than trusted blindly: an fl-api that predates #185736 answers
 * `https://web.freelabel.net/bloq/{id}`, and passing that through would reintroduce the exact
 * link this replaces. An explicit IRIS_PUBLIC_URL (a local or staging stack) also wins, since the
 * API's host is production's.
 */
export function bloqUrlFrom(
  bloq: { id?: unknown; public_url?: unknown } | null | undefined,
  fallbackId: string | number,
  site: string,
  siteOverridden = false,
): string {
  const id = bloq?.id ?? fallbackId
  const api = typeof bloq?.public_url === "string" ? bloq.public_url : ""
  if (!siteOverridden && /^https?:\/\/[^/]+\/atlas\?project=[^&]+/.test(api)) return api
  return bloqWebUrl(id as string | number, site)
}

// ── one item (#190012) ───────────────────────────────────────────────────────
//
// A board link is not a link to the thing you just filed. The Atlas console opens one card
// from four of its declared urlState keys — verified in a browser 2026-10-19 by clicking a
// card, then cold-loading the address it wrote:
//
//     /atlas?project={bloq}&source=memory&row={list}&card={item}
//
// `source=memory` is the console tab that holds lists, `row` the list, `card` the item. It is
// the SIGNED-IN address — owner and board members only. A private item has no other URL, and
// before this an agent asked for "the link" built one by hand from an old diary and handed out
// the retired Elon /iris/bloq/{id} route (#190012).

export function atlasItemUrl(
  bloqId: string | number | null | undefined,
  listId: string | number | null | undefined,
  itemId: string | number | null | undefined,
  site: string,
): string | null {
  // Half an address is worse than none: the console falls back to ANOTHER project when the
  // one asked for is missing, and says nothing. Refuse rather than open the wrong board.
  if (!bloqId || !listId || !itemId) return null
  const q = new URLSearchParams({
    project: String(bloqId),
    source: "memory",
    row: String(listId),
    card: String(itemId),
  })
  return `${site.replace(/\/+$/, "")}/atlas?${q.toString()}`
}

/** The API's `atlas_url` when it is an Atlas card address, otherwise built locally. */
export function itemUrlFrom(
  item: { id?: unknown; atlas_url?: unknown; bloq_id?: unknown; bloq_list_id?: unknown; list_id?: unknown } | null | undefined,
  site: string,
  siteOverridden = false,
  fallback: { bloqId?: unknown; listId?: unknown } = {},
): string | null {
  const api = typeof item?.atlas_url === "string" ? item.atlas_url : ""
  if (!siteOverridden && /^https?:\/\/[^/]+\/atlas\?project=[^&]+&.*card=/.test(api)) return api
  return atlasItemUrl(
    (item?.bloq_id ?? fallback.bloqId) as any,
    (item?.bloq_list_id ?? item?.list_id ?? fallback.listId) as any,
    item?.id as any,
    site,
  )
}

/**
 * Patterns of every address the product has RETIRED for a board or an item. A link matching
 * one of these must never be printed — the guard test scans the CLI source for them.
 */
export const RETIRED_BOARD_URL = /web\.(heyiris\.io|freelabel\.net)\/(iris\/)?bloq\b/
