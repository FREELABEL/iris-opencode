import { IRIS_API, irisFetch, type PlatformResult, type Page } from "./platform"
import { PAGE_ORIGIN, PAGE_SLUG } from "./page-signin"
import { pagePinDeps } from "./page-pin"

/**
 * THE ADDRESS A MEMBER CAN OPEN (Marketing tab, 2026-11-20).
 *
 * Desktop's Marketing tab framed https://heyiris.io/p/<slug> — the address a STRANGER uses. That is
 * the wrong address for two of the three states a page can be in:
 *
 *   published + public    /p/<slug>                            the same for everyone
 *   published + unlisted  /p/<public_id>                       the slug 404s by design (#178589)
 *   draft, or private     /p/<slug>?preview=true&token=<t>     only the owner's preview link opens it
 *
 * Alex pinned FL‑007 (freelabel-grid-plan, published + unlisted) and the tab said "This page isn't
 * published": the server was right to 404 the slug for a stranger, and the tab asked as a stranger.
 * The rule he set: inside IRIS Desktop a member sees their page whatever its status; in a browser the
 * page keeps its visibility. This file is the first half — the sidecar, holding the member's own
 * token, works out the member's address. The browser path is untouched: nothing here changes what
 * /p/<slug> serves.
 *
 * Who may get an address: the account's OWN pages only — the same list `page-pin` checks (fl-api's
 * Page::scopeVisibleTo). The preview token comes from fl-api's management fields, which fl-api hands
 * only to a caller who may manage the page. Every address is built here on PAGE_ORIGIN from parts the
 * server returned; a URL is never taken whole from a response, so the panel only frames heyiris.io.
 *
 * Fails open to the plain address: an answer that can't be measured leaves the panel exactly where it
 * was before this file existed, never somewhere worse.
 */

export type PageAddressKind = "public" | "unlisted" | "preview"

export interface PageAddress {
  /** False = no member address could be worked out; `url` is the plain /p/<slug> and `reason` says why. */
  measured: boolean
  reason?: string
  url: string
  kind: PageAddressKind
  status?: string
  visibility?: string
}

/** The seam a test replaces. */
export const pageAddressDeps = {
  pages: (q: string): Promise<PlatformResult<{ pages: Page[] }>> => pagePinDeps.pages(q),
  fetch: (path: string, init?: RequestInit) => irisFetch(path, IRIS_API, init),
}

/** fl-api public_id: a UUID. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** fl-api preview tokens: base64/base64url/hex-ish, no separators that could break out of the query. */
const TOKEN = /^[A-Za-z0-9_\-.=:%]{8,512}$/

export const plainAddress = (slug: string) => `${PAGE_ORIGIN}/p/${encodeURIComponent(slug)}`

/** The preview token inside fl-api's preview_url (…/p/<slug>?preview=true&token=<t>), or undefined. */
export function previewToken(previewUrl: unknown): string | undefined {
  if (typeof previewUrl !== "string" || !previewUrl) return undefined
  try {
    const u = new URL(previewUrl)
    const t = u.searchParams.get("token") ?? ""
    return u.searchParams.get("preview") === "true" && TOKEN.test(t) ? t : undefined
  } catch {
    return undefined
  }
}

/**
 * Pure: given the page as its owner sees it (fl-api GET /api/v1/pages/{id}), the address to frame.
 * `status`/`visibility` come from the page list when the detail omits them.
 */
export function memberAddress(
  slug: string,
  page: { status?: string; visibility?: string; public_id?: unknown; preview_url?: unknown },
): PageAddress {
  const status = String(page.status ?? "").toLowerCase()
  const visibility = String(page.visibility ?? "public").toLowerCase() || "public"
  const plain = plainAddress(slug)
  const base = { status, visibility }
  if (status === "published" && visibility === "public") return { measured: true, url: plain, kind: "public", ...base }
  if (status === "published" && visibility === "unlisted" && typeof page.public_id === "string" && UUID.test(page.public_id))
    return { measured: true, url: `${PAGE_ORIGIN}/p/${page.public_id.toLowerCase()}`, kind: "unlisted", ...base }
  const token = previewToken(page.preview_url)
  if (token) return { measured: true, url: `${plain}?preview=true&token=${encodeURIComponent(token)}`, kind: "preview", ...base }
  return {
    measured: false,
    reason: status === "published" ? `a ${visibility} page with no address for members` : "a draft with no preview link — are you its owner?",
    url: plain,
    kind: "public",
    ...base,
  }
}

function plainOnly(slug: string, reason: string): PageAddress {
  return { measured: false, reason, url: plainAddress(slug), kind: "public" }
}

export async function resolvePageAddress(slug: string): Promise<PageAddress> {
  const s = String(slug ?? "").trim().toLowerCase()
  if (!PAGE_SLUG.test(s)) return { measured: false, reason: "not a page address", url: "", kind: "public" }
  try {
    const list = await pageAddressDeps.pages(s)
    if (!list.measured) return plainOnly(s, list.reason ?? "your pages could not be read")
    // The exact slug, never a search hit that merely contains it — and only the account's own pages.
    const row = list.data.pages.find((p) => (p.slug ?? "").toLowerCase() === s)
    if (!row) return plainOnly(s, "not one of your pages")
    const fromList = { status: row.status, visibility: row.visibility }
    // The common case costs one request: a published public page is the plain address for everyone.
    if (String(row.status).toLowerCase() === "published" && (row.visibility ?? "public") === "public")
      return memberAddress(s, fromList)
    const res = await pageAddressDeps.fetch(`/api/v1/pages/${row.id}`)
    if (!res.ok) return plainOnly(s, `iris-api ${res.status}`)
    const j = (await res.json().catch(() => null)) as { data?: Record<string, unknown> } | null
    const d = (j?.data ?? j ?? {}) as Record<string, unknown>
    return memberAddress(s, {
      status: typeof d.status === "string" ? d.status : fromList.status,
      visibility: typeof d.visibility === "string" ? d.visibility : fromList.visibility,
      public_id: d.public_id,
      preview_url: d.preview_url,
    })
  } catch (e) {
    return plainOnly(s, e instanceof Error ? e.message : String(e))
  }
}
