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
export function pageVerdict(slug: string, a: FrameCheckAnswer): PageVerdict {
  if (!a || !a.state) return { show: true }
  if (a.state === "unreachable")
    return { show: false, title: "Couldn't reach freelabel.net", detail: a.reason ?? "no connection" }
  if (a.state === "refused")
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
