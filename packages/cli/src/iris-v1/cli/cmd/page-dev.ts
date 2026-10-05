/**
 * `iris pages dev` helpers — the local render loop (GLD-04).
 *
 * Every visual iteration used to be a production write: publish, wait, screenshot the live page.
 * One dashboard reached 89 versions largely because of it.
 *
 * THE RENDER STAYS ON THE SERVER, AND THAT IS THE DESIGN
 *
 * `/p/` pages are server-rendered — a live one carries no `data-page` and no `#app`, so there is
 * nothing to hydrate client-side and "run the renderer locally" is not an option that exists.
 * The loop is: hand the server your local document through a preview session, get HTML back,
 * serve it. The renderer is therefore always the DEPLOYED one (ADR-03). A local copy of 240
 * components would drift, and the drift shows as green locally and broken in production — the
 * most expensive false green there is.
 *
 * What is left for the CLI is small and mechanical, which is the point.
 *
 * Pure and dependency-free so it is testable without a server — see page-dev.test.ts.
 */

/** Marker for the reload shim, so injection can be idempotent. */
export const DEV_RELOAD_MARKER = "__iris_dev_reload__"

/**
 * Path prefixes that are ASSETS and must resolve back to the origin that rendered the HTML.
 *
 * An allow-list of prefixes rather than a guess from the file extension. An extension test would
 * have to decide what `/p/report.html` is, and getting that wrong sends navigation to production
 * — where the change being previewed does not exist.
 */
const ASSET_PREFIXES = ["/build/", "/assets/", "/storage/", "/images/", "/img/", "/fonts/", "/media/"]

/**
 * Point asset paths at the origin that rendered them, and leave everything else alone.
 *
 * Explicitly NOT rewritten:
 *   - `/api/...` — must go through the local proxy so the CLI's credentials are attached. Sent
 *     cross-origin from a browser with no platform credentials it would fail as an empty result,
 *     which is indistinguishable from a binding that legitimately has no rows. That is the single
 *     most misleading way this could break.
 *   - `/p/...` and other navigation — a link that jumps to production silently leaves the dev
 *     server behind.
 *   - anything already absolute, protocol-relative, `data:`, `mailto:` — not paths.
 */
export function absolutizeAssets(html: string, origin: string): string {
  const base = (origin ?? "").replace(/\/+$/, "")
  if (!base) return html
  return (html ?? "").replace(
    /\b(src|href)=("|')(\/[^"']*)\2/g,
    (whole, attr: string, q: string, path: string) => {
      // Protocol-relative (`//host/x`) is already absolute; leaving the leading-slash test alone
      // would rewrite it into a broken triple-slash URL.
      if (path.startsWith("//")) return whole
      if (!ASSET_PREFIXES.some((p) => path.startsWith(p))) return whole
      return `${attr}=${q}${base}${path}${q}`
    },
  )
}

/**
 * Insert the reload shim.
 *
 * Polls a version counter the dev server bumps on every file change. Polling rather than a
 * websocket because the loop is one developer on one machine, and a for-loop you can read beats
 * a socket you cannot (the best process is no process).
 *
 * A page with no `</body>` still gets it: a bespoke page (`render_mode: html`) can be a fragment,
 * and a dev loop that silently stops reloading looks exactly like "my edit did nothing" — the
 * worst failure this tool could have.
 */
export function injectLiveReload(html: string, port: number): string {
  const src = html ?? ""
  if (src.includes(DEV_RELOAD_MARKER)) return src

  const shim = `
<script id="${DEV_RELOAD_MARKER}">
(function () {
  var seen = null;
  setInterval(function () {
    fetch("http://127.0.0.1:${port}/__dev/version", { cache: "no-store" })
      .then(function (r) { return r.text(); })
      .then(function (v) {
        if (seen !== null && v !== seen) location.reload();
        seen = v;
      })
      .catch(function () { /* server stopped; keep the last good render on screen */ });
  }, 700);
})();
</script>`

  return src.includes("</body>") ? src.replace("</body>", `${shim}\n</body>`) : src + shim
}
