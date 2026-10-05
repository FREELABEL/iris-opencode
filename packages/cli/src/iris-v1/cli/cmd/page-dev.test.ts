import { describe, expect, test } from "bun:test"
import { absolutizeAssets, injectLiveReload, DEV_RELOAD_MARKER } from "./page-dev"

/**
 * `iris pages dev` — the local render loop (GLD-04).
 *
 * Until now every visual iteration was a production write: publish, wait, screenshot the live
 * page. One dashboard reached 89 versions largely because of it.
 *
 * WHAT THE SERVER SENDS, AND WHY THAT SHAPES THIS FILE
 *
 * `/p/` pages are SERVER-rendered — I fetched a live one and it carries no `data-page` and no
 * `#app`. So there is nothing to hydrate client-side, and the local loop cannot be "run the
 * renderer locally". It is: hand the server your local document via a preview session, get HTML
 * back, serve that. The renderer stays the DEPLOYED one (ADR-03) — a local copy of 240
 * components would drift, and the drift shows as green locally and broken in production.
 *
 * What is left for the CLI is therefore small and mechanical: that HTML references assets by
 * absolute path (`/build/...`), which from `localhost` would 404. Those get pointed back at the
 * origin that rendered them. Everything else is left alone — in particular `/api/`, which must
 * keep going through the local proxy so the CLI's credentials are attached rather than being
 * sent cross-origin from a browser that has none.
 */
const HTML = `<!DOCTYPE html><html><head>
<link rel="stylesheet" href="/build/assets/app-ABC.css">
<link rel="canonical" href="/p/some-page">
</head><body>
<div id="page"><img src="/storage/x.png"><a href="/p/other">next</a></div>
<script type="module" src="/build/assets/app-XYZ.js"></script>
</body></html>`

describe("absolutizeAssets", () => {
  test("build assets are pointed back at the origin that rendered them", () => {
    const out = absolutizeAssets(HTML, "https://heyiris.io")
    expect(out).toContain('href="https://heyiris.io/build/assets/app-ABC.css"')
    expect(out).toContain('src="https://heyiris.io/build/assets/app-XYZ.js"')
  })

  test("uploaded media is absolutized too", () => {
    expect(absolutizeAssets(HTML, "https://heyiris.io")).toContain('src="https://heyiris.io/storage/x.png"')
  })

  test("NAVIGATION is left relative", () => {
    // A link to another page must stay local, or clicking it silently leaves the dev server and
    // lands on production — where the change you are previewing does not exist.
    const out = absolutizeAssets(HTML, "https://heyiris.io")
    expect(out).toContain('href="/p/other"')
    expect(out).toContain('href="/p/some-page"')
  })

  test("/api/ is left alone so it goes through the local proxy", () => {
    // The browser has no platform credentials. Sent cross-origin it would be an unauthenticated
    // request that fails as "no data" — indistinguishable from an empty binding, which is the
    // single most misleading way this could break.
    const h = `<script>fetch("/api/v1/public/pages/x/data/y")</script>`
    expect(absolutizeAssets(h, "https://heyiris.io")).toContain('"/api/v1/public/pages/x/data/y"')
  })

  test("already-absolute urls are untouched", () => {
    const h = `<img src="https://cdn.example.com/a.png"><script src="//x.test/b.js"></script>`
    expect(absolutizeAssets(h, "https://heyiris.io")).toBe(h)
  })

  test("a trailing slash on the origin does not produce a double slash", () => {
    expect(absolutizeAssets(HTML, "https://heyiris.io/")).toContain('"https://heyiris.io/build/assets/app-ABC.css"')
    expect(absolutizeAssets(HTML, "https://heyiris.io/")).not.toContain("heyiris.io//build")
  })

  test("data: and mailto: are not paths", () => {
    const h = `<img src="data:image/png;base64,AAA"><a href="mailto:a@b.c">x</a>`
    expect(absolutizeAssets(h, "https://heyiris.io")).toBe(h)
  })
})

describe("injectLiveReload", () => {
  test("the shim lands before </body>", () => {
    const out = injectLiveReload(HTML, 4321)
    expect(out).toContain(DEV_RELOAD_MARKER)
    expect(out.indexOf(DEV_RELOAD_MARKER)).toBeLessThan(out.indexOf("</body>"))
  })

  test("html with no </body> still gets the shim", () => {
    // A bespoke page (render_mode: html) may be a fragment. Silently not reloading would look
    // like "my edit did nothing", which is the worst failure a dev loop can have.
    const out = injectLiveReload("<div>bare</div>", 4321)
    expect(out).toContain(DEV_RELOAD_MARKER)
  })

  test("injection is idempotent", () => {
    const once = injectLiveReload(HTML, 4321)
    const twice = injectLiveReload(once, 4321)
    expect(twice.split(DEV_RELOAD_MARKER).length - 1).toBe(1)
  })

  test("the port is carried into the shim", () => {
    expect(injectLiveReload(HTML, 5555)).toContain("5555")
  })
})
