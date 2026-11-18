import { FL_API, irisFetch, resolveUserId, tokenSource, type PlatformResult } from "./platform"

/**
 * GENESIS › SITES, writing (#192672) — put a page into a site, take it out, move it, order a site's
 * pages, and make a new site. The list of sites stays in platform.ts (`fetchSites`); this is the
 * half that changes things.
 *
 * WHY IT EXISTS: a client's staff pages ended up in no site at all, each with its own sign-in list
 * and sidebar, so people were asked to sign in on every page. A site is the group of pages that
 * share one sidebar (and, with epic #192662, one sign-in policy). Desktop could list sites but had
 * no way to put a page in one.
 *
 * Same fl-api routes Elon's BloqPagesSection uses: POST|DELETE /api/v1/sites/{site}/pages/{page},
 * PUT /api/v1/sites/{site}/reorder, POST /api/v1/sites. Every write answers with the site and its
 * pages AS THE PLATFORM HOLDS THEM AFTER the write (`$site->fresh()->load('pages')`), and that is
 * what is returned — never the panel's guess of what should have happened.
 */

/** The seam a test replaces: the platform call and who is signed in. */
export const sitesDeps = {
  fetch: (path: string, init?: RequestInit) => irisFetch(path, FL_API, init),
  userId: () => resolveUserId(),
}

export interface SitePage {
  id: number
  title: string
  slug?: string
  status: string
  sortOrder: number
  updatedAt?: string
  thumbnailUrl?: string
}

export interface SiteDetail {
  id: number
  name: string
  slug: string
  status: string
  requiresAuth: boolean
  homePageId?: number
  /** In the site's order — the order its sidebar lists them. */
  pages: SitePage[]
}

export interface SiteActionResult {
  ok: boolean
  reason?: string
  site?: SiteDetail
}

const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined)
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : undefined)
const unescape = (s: string) => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")

/** fl-api's PageSite with its `pages` relation (already ordered by sort_order upstream; sorted again here). */
export function siteDetailOf(raw: any): SiteDetail {
  const pages: SitePage[] = (Array.isArray(raw?.pages) ? raw.pages : [])
    .filter((p: any) => num(p?.id) != null)
    .map((p: any) => ({
      id: num(p.id)!,
      title: unescape(String(p.title || p.slug || "Untitled")),
      slug: str(p.slug),
      status: String(p.status ?? "draft"),
      sortOrder: num(p.sort_order) ?? 0,
      updatedAt: str(p.updated_at),
      thumbnailUrl: str(p.thumbnail_url),
    }))
  // Stable: equal sort_order keeps the platform's order.
  pages.sort((a, b) => a.sortOrder - b.sortOrder)
  return {
    id: Number(raw?.id),
    name: unescape(String(raw?.name ?? raw?.slug ?? "unnamed")),
    slug: String(raw?.slug ?? ""),
    status: String(raw?.status ?? "unknown"),
    requiresAuth: Boolean(raw?.requires_auth),
    homePageId: num(raw?.home_page_id),
    pages,
  }
}

async function failure(res: Response, what: string) {
  const j = (await res.json().catch(() => ({}))) as any
  if (res.status === 404) return `${what}: the site or the page no longer exists`
  if (res.status === 422 && j?.errors) {
    const first = Object.values(j.errors as Record<string, string[]>)[0]
    if (Array.isArray(first) && first[0]) return String(first[0])
  }
  return String(j?.message ?? j?.error ?? `${what}: fl-api ${res.status}`)
}

const notSignedIn = () => ({ ok: false, reason: `not signed in (token: ${tokenSource()})` })
const positive = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n > 0

async function readBack(res: Response): Promise<SiteDetail | undefined> {
  const j = (await res.json().catch(() => null)) as any
  const d = j?.data ?? j
  return d && num(d.id) != null ? siteDetailOf(d) : undefined
}

export async function fetchSiteDetail(siteId: number): Promise<PlatformResult<SiteDetail | undefined>> {
  if (!(await sitesDeps.userId())) return { measured: false, reason: `not signed in (token: ${tokenSource()})`, data: undefined }
  try {
    const res = await sitesDeps.fetch(`/api/v1/sites/${siteId}`)
    if (!res.ok) return { measured: false, reason: res.status === 404 ? "no such site on your account" : `fl-api ${res.status}`, data: undefined }
    const site = await readBack(res)
    return site ? { measured: true, data: site } : { measured: false, reason: "fl-api returned no site", data: undefined }
  } catch (e) {
    return { measured: false, reason: e instanceof Error ? e.message : String(e), data: undefined }
  }
}

/**
 * Put a page in a site. `fromSiteId` makes it a MOVE: the page is taken out of the old site first,
 * so that site's home page is handed on (fl-api's detach does that; a bare attach would leave the
 * old site pointing its home at a page it no longer has). If taking it out fails, nothing else runs.
 */
export async function addPageToSite(input: { siteId: number; pageId: number; fromSiteId?: number }): Promise<SiteActionResult> {
  if (!positive(input.siteId) || !positive(input.pageId)) return { ok: false, reason: "a site and a page are both needed" }
  if (input.fromSiteId === input.siteId) return { ok: false, reason: "the page is already in this site" }
  if (!(await sitesDeps.userId())) return notSignedIn()
  try {
    if (positive(input.fromSiteId)) {
      const out = await sitesDeps.fetch(`/api/v1/sites/${input.fromSiteId}/pages/${input.pageId}`, { method: "DELETE" })
      // 404 here = it was not in that site any more; the move can still go ahead.
      if (!out.ok && out.status !== 404) return { ok: false, reason: await failure(out, "Taking it out of its current site") }
    }
    const res = await sitesDeps.fetch(`/api/v1/sites/${input.siteId}/pages/${input.pageId}`, { method: "POST" })
    if (!res.ok) return { ok: false, reason: await failure(res, "Adding it to the site") }
    const site = await readBack(res)
    if (site && !site.pages.some((p) => p.id === input.pageId)) return { ok: false, reason: "the platform answered, but the page is not in the site — nothing changed", site }
    return { ok: true, site }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
}

export async function removePageFromSite(input: { siteId: number; pageId: number }): Promise<SiteActionResult> {
  if (!positive(input.siteId) || !positive(input.pageId)) return { ok: false, reason: "a site and a page are both needed" }
  if (!(await sitesDeps.userId())) return notSignedIn()
  try {
    const res = await sitesDeps.fetch(`/api/v1/sites/${input.siteId}/pages/${input.pageId}`, { method: "DELETE" })
    if (!res.ok) return { ok: false, reason: res.status === 404 ? "the page is not in this site" : await failure(res, "Removing it from the site") }
    const site = await readBack(res)
    if (site?.pages.some((p) => p.id === input.pageId)) return { ok: false, reason: "the platform answered, but the page is still in the site", site }
    return { ok: true, site }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
}

/** The site's pages in a new order. Every id must be one of the site's own pages, each once. */
export async function reorderSite(input: { siteId: number; pageIds: readonly number[] }): Promise<SiteActionResult> {
  if (!positive(input.siteId)) return { ok: false, reason: "no site" }
  if (input.pageIds.length === 0 || !input.pageIds.every(positive)) return { ok: false, reason: "no pages to order" }
  if (new Set(input.pageIds).size !== input.pageIds.length) return { ok: false, reason: "a page is listed twice" }
  if (!(await sitesDeps.userId())) return notSignedIn()
  try {
    const res = await sitesDeps.fetch(`/api/v1/sites/${input.siteId}/reorder`, { method: "PUT", body: JSON.stringify({ page_ids: input.pageIds }) })
    if (!res.ok) return { ok: false, reason: await failure(res, "Reordering") }
    return { ok: true, site: await readBack(res) }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
}

/** A new, empty draft site on a board — what Elon's "Create Site" makes. */
export async function createSite(input: { name: string; description?: string; bloqId: number }): Promise<SiteActionResult> {
  const name = input.name.trim()
  if (!name) return { ok: false, reason: "a site needs a name" }
  if (name.length > 255) return { ok: false, reason: "that name is too long (255 characters at most)" }
  if (!positive(input.bloqId)) return { ok: false, reason: "a site belongs to a board — open one first" }
  if (!(await sitesDeps.userId())) return notSignedIn()
  try {
    const res = await sitesDeps.fetch(`/api/v1/sites`, {
      method: "POST",
      body: JSON.stringify({ name, description: input.description?.trim() || null, owner_type: "bloq", owner_id: input.bloqId, status: "draft" }),
    })
    if (!res.ok) return { ok: false, reason: await failure(res, "Creating the site") }
    const site = await readBack(res)
    return site ? { ok: true, site } : { ok: false, reason: "the platform answered without the new site" }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
}
