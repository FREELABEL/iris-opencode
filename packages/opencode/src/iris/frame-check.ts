/**
 * The side panel's Browser tab (#187864): can this page be shown in a frame inside the app?
 *
 * The app cannot answer that itself. A cross-origin frame that the site refuses fires `load`
 * exactly like one that worked, and the response headers that decide it are invisible to the
 * page. Measured 2026-10-03: heyiris.io allows the app (frame-ancestors lists tauri://localhost
 * and localhost); google.com sends X-Frame-Options SAMEORIGIN; github.com sends DENY. Without
 * this check, the sites people click most render as a white pane that looks like a bug.
 *
 * So the sidecar fetches the page and reads the two headers that decide it. `frameVerdict` is
 * pure, so the rules are tested without the network.
 */

export type FrameVerdict = { embeddable: true } | { embeddable: false; reason: string }

/** One CSP source expression against the framing origin. `self` is the FRAMED page's origin. */
function sourceMatches(source: string, origin: URL, self: URL): boolean {
  const s = source.trim()
  if (!s) return false
  if (s === "*") return origin.protocol === "http:" || origin.protocol === "https:"
  if (s === "'self'") return origin.origin === self.origin
  if (s === "'none'") return false
  // Scheme-only: `https:`, `tauri:`
  if (/^[a-z][a-z0-9+.-]*:$/i.test(s)) return origin.protocol === s.toLowerCase()
  const m = /^(?:([a-z][a-z0-9+.-]*):\/\/)?(\*\.)?([^/:]+|\*)(?::(\d+|\*))?(?:\/.*)?$/i.exec(s)
  if (!m) return false
  const [, scheme, wildSub, host, port] = m
  if (scheme && `${scheme.toLowerCase()}:` !== origin.protocol) return false
  if (!scheme && origin.protocol !== self.protocol && !(self.protocol === "http:" && origin.protocol === "https:"))
    return false
  const h = origin.hostname.toLowerCase()
  const want = host.toLowerCase()
  if (want !== "*") {
    if (wildSub ? !h.endsWith(`.${want}`) : h !== want) return false
  }
  if (port === "*") return true
  const actual = origin.port || (origin.protocol === "https:" ? "443" : origin.protocol === "http:" ? "80" : "")
  if (port) return actual === port
  // No port in the source: only the scheme's default port matches.
  return !origin.port
}

/**
 * Would a page served with these headers render in a frame on `origin`?
 *
 * CSP `frame-ancestors` wins over X-Frame-Options when both are present — that is what WebKit,
 * Chromium and Firefox all do, and heyiris.io depends on it. Several CSP headers each have to
 * allow it; the most restrictive one decides.
 */
export function frameVerdict(headers: Headers, pageUrl: string, origin: string): FrameVerdict {
  let o: URL
  let self: URL
  try {
    o = new URL(origin)
    self = new URL(pageUrl)
  } catch {
    return { embeddable: false, reason: "invalid origin" }
  }

  const csps = (headers.get("content-security-policy") ?? "")
    // Several CSP headers arrive joined by ", ". A comma is not legal inside a source list, so
    // it only ever separates policies.
    .split(",")
    .map((p) =>
      p
        .split(";")
        .map((d) => d.trim())
        .find((d) => /^frame-ancestors(\s|$)/i.test(d)),
    )
    .filter((d): d is string => !!d)

  if (csps.length) {
    for (const directive of csps) {
      const sources = directive.split(/\s+/).slice(1)
      if (!sources.some((src) => sourceMatches(src, o, self)))
        return {
          embeddable: false,
          reason:
            sources.length === 0 || (sources.length === 1 && sources[0] === "'none'")
              ? "frame-ancestors 'none'"
              : `frame-ancestors allows only ${sources.join(" ")}`,
        }
    }
    return { embeddable: true }
  }

  const xfo = (headers.get("x-frame-options") ?? "").trim().toUpperCase()
  if (xfo === "DENY") return { embeddable: false, reason: "X-Frame-Options: DENY" }
  if (xfo === "SAMEORIGIN" && o.origin !== self.origin)
    return { embeddable: false, reason: "X-Frame-Options: SAMEORIGIN" }
  return { embeddable: true }
}

export type FrameProbe =
  | { state: "embeddable"; url: string }
  | { state: "refused"; url: string; reason: string }
  | { state: "unreachable"; url: string; reason: string }

const PROBE_TIMEOUT_MS = 8000

/** Only http(s), no credentials in the URL. Anything else is never fetched. */
export function frameTarget(input: string | undefined): string | undefined {
  if (!input) return undefined
  try {
    const u = new URL(input.trim())
    if (u.protocol !== "http:" && u.protocol !== "https:") return undefined
    if (u.username || u.password) return undefined
    return u.href
  } catch {
    return undefined
  }
}

/**
 * Fetch the page (following redirects — the FINAL response's headers are the ones the frame
 * gets) and decide. GET, not HEAD: enough servers answer HEAD differently that it would lie.
 * The body is never read.
 */
export async function probeFrame(url: string, origin: string): Promise<FrameProbe> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), PROBE_TIMEOUT_MS)
  try {
    const res = await fetch(url, { redirect: "follow", signal: ctl.signal, headers: { Accept: "text/html,*/*" } })
    void res.body?.cancel().catch(() => undefined)
    const verdict = frameVerdict(res.headers, res.url || url, origin)
    if (verdict.embeddable) return { state: "embeddable", url }
    return { state: "refused", url, reason: verdict.reason }
  } catch (err) {
    return { state: "unreachable", url, reason: err instanceof Error ? err.message : String(err) }
  } finally {
    clearTimeout(timer)
  }
}
