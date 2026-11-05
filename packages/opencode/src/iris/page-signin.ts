import { IRIS_API, irisFetch } from "./platform"

/**
 * A pinned Genesis page, opened SIGNED IN (#192482, epic #192479).
 *
 * The panel frames freelabel.net/p/<slug> from the app's own origin, where the page's sign-in
 * cookie cannot live: WKWebView (macOS) refuses every third-party cookie, WebView2 (Windows)
 * refuses a SameSite=Lax one. A person who typed the emailed code landed back on the sign-in form.
 *
 * So the sidecar — which holds the person's own token — asks fl-iris-api for a one-time code for
 * that one page (POST /api/v1/atlas/page-codes) and hands the panel the address to frame:
 * https://freelabel.net/p/<slug>#atlas_code=<code>. The page's SDK (iris-sdk 1.0.7) trades the
 * code for a session it keeps in memory. The code is single use, lives ~90 s, is bound to this
 * person and this page, and sits in the FRAGMENT, so no server or Referer sees it.
 *
 * THIS FILE NEVER LOGS OR CACHES THE CODE. Every frame load mints a fresh one; a cached address
 * would be a spent one.
 */

export const PAGE_ORIGIN = process.env.IRIS_PAGE_ORIGIN ?? "https://freelabel.net"

/** Genesis slugs: lowercase words and hyphens. Anything else is refused before any request. */
export const PAGE_SLUG = /^[a-z0-9][a-z0-9-]{0,190}$/

/** fl-iris-api's code: 32 random bytes, base64url, no padding. */
const CODE = /^[A-Za-z0-9_-]{43}$/

export interface PageSignIn {
  /** False = no signed address could be made; `reason` says why. The panel then frames the plain page. */
  measured: boolean
  reason?: string
  /** The address to frame, with the one-time code in its fragment. */
  url: string | null
  /** Seconds the code stays spendable. */
  expiresIn: number | null
}

/** The seam a test replaces. */
export const pageSignInDeps = {
  fetch: (path: string, init?: RequestInit) => irisFetch(path, IRIS_API, init),
}

function refused(reason: string): PageSignIn {
  return { measured: false, reason, url: null, expiresIn: null }
}

export async function mintPageSignIn(slug: string): Promise<PageSignIn> {
  const s = slug.trim().toLowerCase()
  if (!PAGE_SLUG.test(s)) return refused("not a page address")
  try {
    const res = await pageSignInDeps.fetch("/api/v1/atlas/page-codes", {
      method: "POST",
      body: JSON.stringify({ page_slug: s }),
    })
    const body = (await res.json().catch(() => null)) as { code?: unknown; expires_in?: unknown; error?: unknown; message?: unknown } | null
    if (!res.ok) {
      const why = typeof body?.error === "string" ? body.error : typeof body?.message === "string" ? body.message : `iris-api ${res.status}`
      return refused(res.status === 401 ? "not signed in to IRIS" : res.status === 404 ? "this page isn't published" : why)
    }
    const code = typeof body?.code === "string" ? body.code : ""
    if (!CODE.test(code)) return refused("iris-api answered without a code")
    const expiresIn = typeof body?.expires_in === "number" && Number.isFinite(body.expires_in) ? body.expires_in : null
    // Built here from the slug we asked for, not taken from the server's `path`: the panel must
    // only ever frame the page it named, on the origin it trusts.
    return { measured: true, url: `${PAGE_ORIGIN}/p/${encodeURIComponent(s)}#atlas_code=${code}`, expiresIn }
  } catch (e) {
    return refused(e instanceof Error ? e.message : String(e))
  }
}
