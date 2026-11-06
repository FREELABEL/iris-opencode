/**
 * GENESIS › SITES in the Pages pane (#192672) — the decisions behind "which site is this page in",
 * pure so they are tested without a DOM: how pages group under their site, what the site filter
 * keeps, which pages can be added to a site, how a site's order moves, and the ONE plain line that
 * says what changes when a page goes into a site, moves, or comes out.
 *
 * Why it matters: a client's staff pages sat in no site, each with its own sign-in list and
 * sidebar, so people were asked to sign in on every page. A site is the group of pages that share
 * one sidebar and (epic #192662) one sign-in policy. Ported from Elon's BloqPagesSection.
 */

export type SiteSummary = {
  id: number
  name: string
  slug: string
  status: string
  pagesCount: number
  requiresAuth: boolean
}

export type SitesPayload = { measured: boolean; reason?: string; sites: SiteSummary[] }

/** "any" = every page; "none" = pages in no site; a number = that site's pages. */
export type SiteFilter = "any" | "none" | number

type Paged = { id: number; siteId?: number }

/** What the site filter keeps, from the pages already read. */
export function filterBySite<P extends Paged>(pages: P[], f: SiteFilter): P[] {
  if (f === "any") return pages
  if (f === "none") return pages.filter((p) => p.siteId == null)
  return pages.filter((p) => p.siteId === f)
}

export type PageGroup<P> =
  | { kind: "site"; key: string; site: SiteSummary; known: true; pages: P[] }
  | { kind: "site"; key: string; site: { id: number; name: string }; known: false; pages: P[] }
  | { kind: "none"; key: "none"; pages: P[] }

/**
 * Pages under their site, Elon's layout: one group per site that has a page here, in the order
 * the sites are listed (published first, biggest first), then "Not in a site".
 *
 * NOT copied from Elon: a page whose site is not in the list (another board's site, or one past
 * the list's end) went into the unassigned group there. It IS in a site, and saying otherwise is
 * the exact confusion this exists to end — so it gets its own group, named by id.
 */
export function groupBySite<P extends Paged>(pages: P[], sites: SiteSummary[]): PageGroup<P>[] {
  const bySite = new Map<number, P[]>()
  const none: P[] = []
  for (const p of pages) {
    if (p.siteId == null) none.push(p)
    else bySite.set(p.siteId, [...(bySite.get(p.siteId) ?? []), p])
  }
  const out: PageGroup<P>[] = []
  for (const s of sites) {
    const ps = bySite.get(s.id)
    if (!ps) continue
    out.push({ kind: "site", key: `site-${s.id}`, site: s, known: true, pages: ps })
    bySite.delete(s.id)
  }
  for (const [id, ps] of [...bySite.entries()].sort((a, b) => a[0] - b[0]))
    out.push({ kind: "site", key: `site-${id}`, site: { id, name: `Site #${id}` }, known: false, pages: ps })
  if (none.length) out.push({ kind: "none", key: "none", pages: none })
  return out
}

/** The site a page is in, by name; `Site #14` when the site is not in the list; undefined when in none. */
export function siteNameOf(p: { siteId?: number }, sites: SiteSummary[]): string | undefined {
  if (p.siteId == null) return undefined
  return sites.find((s) => s.id === p.siteId)?.name ?? `Site #${p.siteId}`
}

/** The group header's count: "3 pages", or "3 of 9 pages here" when the site holds more than are shown. */
export function groupCount(shown: number, inSite?: number): string {
  const word = (n: number) => `${n} page${n === 1 ? "" : "s"}`
  if (inSite == null || inSite <= shown) return word(shown)
  return `${shown} of ${word(inSite)} here`
}

export type SiteChange =
  | { kind: "same" }
  | { kind: "add"; to: string }
  | { kind: "move"; from: string; to: string }
  | { kind: "remove"; from: string }

export function siteChange(from: { id: number; name: string } | undefined, to: { id: number; name: string } | undefined): SiteChange {
  if (from?.id === to?.id) return { kind: "same" }
  if (!from) return { kind: "add", to: to!.name }
  if (!to) return { kind: "remove", from: from.name }
  return { kind: "move", from: from.name, to: to.name }
}

/** The one plain line of what changes. Never "Are you sure?". */
export function siteChangeLine(c: SiteChange, count = 1): string | undefined {
  const it = count === 1 ? "This page" : `These ${count} pages`
  if (c.kind === "add") return `${it} will use ${c.to}’s sidebar and sign-in rules.`
  if (c.kind === "move") return `${it} will leave ${c.from} and use ${c.to}’s sidebar and sign-in rules instead.`
  if (c.kind === "remove") return `${it} will stop using ${c.from}’s sidebar and sign-in rules, and go back to its own.`
  return undefined
}

export function siteChangeLabel(c: SiteChange): string {
  if (c.kind === "add") return "Add to site"
  if (c.kind === "move") return "Move to site"
  if (c.kind === "remove") return "Remove from site"
  return "No change"
}

/** Which of the board's pages can be added to a site: the ones in NO site. A move is done from the page. */
export function addablePages<P extends Paged>(pages: P[]): P[] {
  return pages.filter((p) => p.siteId == null)
}

/** The site's order with one page moved up (-1) or down (+1). The ends stop; nothing else moves. */
export function movePage(ids: readonly number[], id: number, delta: -1 | 1): number[] {
  const i = ids.indexOf(id)
  const j = i + delta
  if (i < 0 || j < 0 || j >= ids.length) return [...ids]
  const out = [...ids]
  ;[out[i], out[j]] = [out[j], out[i]]
  return out
}

/** Which board's sites a page can go into: the board that owns it, else the one open. */
export function boardForPage(p: { ownerType?: string; ownerId?: number }, open?: number): number | undefined {
  if (p.ownerType === "bloq" && p.ownerId != null) return p.ownerId
  return open
}

/** "bloq 174" → 174. Sites carry their owner as that string. */
export function ownerBoard(owner?: string): number | undefined {
  const m = /^bloq (\d+)$/.exec(owner ?? "")
  return m ? Number(m[1]) : undefined
}

export const SITE_GROUP_KEY = "iris.genesis.pages.bysite"
/** Grouped by site unless the person turned it off. */
export const readGroup = (raw: string | null | undefined) => raw !== "0"
