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
