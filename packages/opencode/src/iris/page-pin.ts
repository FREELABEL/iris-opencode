import { fetchPages, type Page, type PlatformResult } from "./platform"
import { PAGE_SLUG } from "./page-signin"

/**
 * MAY THIS ACCOUNT PIN THIS PAGE? (#192624, epic #192614)
 *
 * Desktop's Marketing tab is made of Genesis pages the signed-in account pinned. 1.18.169 named
 * FREELABEL's own ads pages in code and showed them to every customer; the fix is that a page is
 * pinned only when the account can see it as its OWN — a page it created, a page it owns, or a page
 * owned by a board it owns or is a member of.
 *
 * That rule already exists, once, on the platform: fl-api's GET /api/v1/pages is scoped by
 * Page::scopeVisibleTo (created_by, owner user, owned bloqs UNION joined bloqs), and fl-iris-api
 * forwards the caller as X-Iris-Acting-User-Id. So the check is "is this exact slug in the
 * account's own page list" — the same list the Genesis tab draws — and not a second copy of the
 * rule that could drift from the first. A platform admin's list is every page (scopeVisibleTo
 * returns the table for one), so an admin may pin any page; that is the platform's rule, not ours.
 *
 * Fails closed: a list that could not be read refuses, with the reason.
 */

export interface PagePinCheck {
  /** False = the account's pages could not be read; `allowed` is then false and `reason` says why. */
  measured: boolean
  allowed: boolean
  reason?: string
  page?: {
    slug: string
    title: string
    status: string
    visibility?: string
    requiresAuth?: boolean
    /** Open it signed in (#192482): it asks for a sign-in, or is not public. */
    signIn: boolean
  }
}

/** The seam a test replaces: the account's pages matching a search, as the Genesis tab reads them. */
export const pagePinDeps = {
  pages: (q: string): Promise<PlatformResult<{ pages: Page[] }>> => fetchPages(0, { all: true, q }),
}

export function needsSignIn(p: Pick<Page, "visibility" | "requiresAuth">): boolean {
  return p.requiresAuth === true || (typeof p.visibility === "string" && p.visibility !== "" && p.visibility !== "public")
}

export async function checkPagePin(slug: string): Promise<PagePinCheck> {
  const s = String(slug ?? "").trim().toLowerCase()
  if (!PAGE_SLUG.test(s)) return { measured: true, allowed: false, reason: "not a page address" }
  const r = await pagePinDeps.pages(s).catch((e) => ({
    measured: false as const,
    reason: e instanceof Error ? e.message : String(e),
    data: { pages: [] as Page[] },
  }))
  if (!r.measured) return { measured: false, allowed: false, reason: r.reason ?? "your pages could not be read" }
  // The exact slug, never a search hit that merely contains it.
  const page = r.data.pages.find((p) => (p.slug ?? "").toLowerCase() === s)
  if (!page) return { measured: true, allowed: false, reason: "not one of your pages — pin a page you own or a page on a board you are a member of" }
  return {
    measured: true,
    allowed: true,
    page: {
      slug: s,
      title: page.title,
      status: page.status,
      ...(page.visibility ? { visibility: page.visibility } : {}),
      ...(typeof page.requiresAuth === "boolean" ? { requiresAuth: page.requiresAuth } : {}),
      signIn: needsSignIn(page),
    },
  }
}
