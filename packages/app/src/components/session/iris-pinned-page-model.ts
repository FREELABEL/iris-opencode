/**
 * A PINNED GENESIS PAGE (#192480, epic #192479): what a panel tab that frames a freelabel.net/p/
 * page should show, decided without I/O so the rules are tested without a network.
 *
 * Why the sidecar is asked first: a cross-origin frame tells the app nothing. A 404 page, a draft
 * and a page that refuses to be framed all fire `load` exactly like one that worked. The sidecar's
 * /iris/frame-check fetches the page and returns its framing verdict and its HTTP status; the
 * frame's own `load` (or a timeout) only decides when to stop the spinner.
 */

export const PAGE_ORIGIN = "https://freelabel.net"

/** How long a frame may take to fire `load` before the tab says so instead of spinning forever. */
export const PAGE_LOAD_TIMEOUT_MS = 20_000

/**
 * The sandbox for pinned pages: the Genesis preview's rule — scripts + same-origin, so the page's
 * own scripts and storage work in its own origin — plus what S2's click-through of the Marketing
 * pages found missing (#192481, every control clicked once inside the frame):
 * - allow-popups + allow-popups-to-escape-sandbox: the ads pages link each ad to its live post with
 *   target=_blank (hive-ads-review has ~155). Without it Chromium logs "Blocked opening … in a new
 *   window" and the click does nothing. Escaping the sandbox means the opened post is a normal page.
 * Not granted: top navigation (a page cannot replace the app), forms (no page submits a <form>;
 * scores and notes are fetch calls, which work), downloads, modals.
 */
export const PAGE_SANDBOX = "allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"

/**
 * Permissions delegated to the frame (an `allow` attribute, not a sandbox flag). clipboard-write:
 * freelabel-ads-review's template "Copy" buttons call navigator.clipboard.writeText, which a
 * cross-origin frame may only do when the embedder delegates it — without it the button reads
 * "Select it" and Chromium logs a permissions-policy violation.
 */
export const PAGE_ALLOW = "clipboard-write"

export function pinnedPageUrl(slug: string): string {
  return `${PAGE_ORIGIN}/p/${encodeURIComponent(slug.trim())}`
}

/** The sidecar's answer, as /iris/frame-check returns it. `undefined` = it could not be asked. */
export type FrameCheckAnswer = { state?: string; reason?: string; status?: number } | undefined

export type PageVerdict =
  | { show: true }
  | { show: false; title: string; detail: string }

/**
 * Show the frame, or say why not. An unanswered check (an older sidecar, the sidecar offline) says
 * nothing about the page, so the frame is shown and the load timeout is the only guard left.
 */
/** The desktop webview's origins: macOS and Linux load the app from tauri://localhost, Windows from http(s)://tauri.localhost. */
const APP_ORIGINS = ["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"]

/** Does a `frame-ancestors allows only …` reason list one of the app's own origins? */
function allowsTheApp(reason: string | undefined): boolean {
  const m = /^frame-ancestors allows only (.+)$/.exec(reason ?? "")
  if (!m) return false
  const sources = m[1].split(/\s+/)
  return APP_ORIGINS.some((o) => sources.includes(o))
}

export function pageVerdict(slug: string, a: FrameCheckAnswer): PageVerdict {
  if (!a || !a.state) return { show: true }
  if (a.state === "unreachable")
    return { show: false, title: "Couldn't reach freelabel.net", detail: a.reason ?? "no connection" }
  // A refusal that names the app's own origins is a wrong guess about where the app runs, not a
  // refusal: the sidecar judges by the `location.origin` it is handed, and 1.18.169 on macOS
  // reported "frame-ancestors allows only 'self' tauri://localhost …" for lexicon-console, whose
  // header lists tauri://localhost (2026-11-05). The webview enforces the header against its real
  // origin, so the page is framed and the status check below still catches a missing page.
  if (a.state === "refused" && !allowsTheApp(a.reason))
    return { show: false, title: "This page can't be shown inside IRIS", detail: a.reason ?? "the site refuses" }
  if (a.state === "invalid") return { show: false, title: "Not a page address", detail: slug }
  if (typeof a.status === "number" && a.status >= 400)
    return {
      show: false,
      title: a.status === 404 ? "This page isn't published" : `freelabel.net answered ${a.status}`,
      detail: a.status === 404 ? `/p/${slug} is missing, a draft, or renamed` : `/p/${slug}`,
    }
  return { show: true }
}

/**
 * SIGNED IN (#192482). A pinned page with `signIn` is framed at an address the sidecar mints:
 * /p/<slug>#atlas_code=<one-time code>, which the page's SDK (iris-sdk 1.0.7) trades for a session
 * held in memory — the page's cookie cannot live in a frame from the app's origin (WKWebView refuses
 * every third-party cookie; WebView2 refuses SameSite=Lax). The sidecar's answer, as POST
 * /iris/page-signin returns it.
 */
export type PageSignInAnswer = { measured?: boolean; reason?: string; url?: string | null; expiresIn?: number | null } | undefined

/**
 * The address to frame, and whether it carries a sign-in. Only an address for THIS page on THIS
 * origin is ever used; anything else — no answer, a refusal, a different page — frames the plain
 * page, which shows its own sign-in gate. A failed sign-in never blocks the page.
 */
export function signedFrameUrl(slug: string, a: PageSignInAnswer): { url: string; signed: boolean; reason?: string } {
  const plain = pinnedPageUrl(slug)
  const url = a?.url
  if (a?.measured && typeof url === "string" && url.startsWith(`${plain}#atlas_code=`) && /^[A-Za-z0-9_-]{43}$/.test(url.slice(plain.length + 12)))
    return { url, signed: true }
  return { url: plain, signed: false, reason: a?.reason ?? "IRIS could not sign you in to this page" }
}

/** A sign-in a frame refused (the code was spent or expired before it loaded) is retried this many times per reload. */
export const SIGNIN_RETRIES = 1

/**
 * The page's own report about its sign-in, or null. Accepted only from the page's origin AND the
 * frame this tab owns — another frame, or another page, saying "refused" must not make us mint.
 */
export function pageSessionState(
  e: { origin: string; data: unknown; source: unknown },
  frame: unknown,
  slug: string,
): "exchanging" | "signed_in" | "refused" | null {
  if (e.origin !== PAGE_ORIGIN || !frame || e.source !== frame) return null
  const d = e.data as { type?: unknown; state?: unknown; slug?: unknown } | null
  if (!d || d.type !== "iris:page-session" || d.slug !== slug.trim().toLowerCase()) return null
  return d.state === "exchanging" || d.state === "signed_in" || d.state === "refused" ? d.state : null
}
