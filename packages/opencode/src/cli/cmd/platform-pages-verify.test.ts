import { describe, expect, test } from "bun:test"
import { normalizeForMatch, detectLane, detectGated, parseHtmlDocument, buildBespokeJsonContent } from "./platform-pages"

/**
 * These guard the read-back surface against the exact false signals measured on
 * /p/harness-position-paper (2026-08-22), where four checks returned zero information
 * about a page that had published correctly.
 */
describe("normalizeForMatch", () => {
  test("folds case — the text-transform:uppercase false negative (the repro)", () => {
    // The stylesheet carried 8 `text-transform:uppercase` rules, so the headline READS
    // "THE HARNESS" and the text layer says "The harness". grep -c 'THE HARNESS' -> 0.
    const hay = normalizeForMatch("The harness is not the moat")
    expect(hay.includes(normalizeForMatch("THE HARNESS"))).toBe(true)
  })

  test("keeps case when explicitly asked", () => {
    const hay = normalizeForMatch("The harness", { caseSensitive: true })
    expect(hay.includes(normalizeForMatch("THE HARNESS", { caseSensitive: true }))).toBe(false)
  })

  test("folds the typography a bespoke page is written with", () => {
    const hay = normalizeForMatch("Compliance isn’t a feature — it’s a boundary…")
    expect(hay.includes(normalizeForMatch("isn't a feature -- it's"))).toBe(false)
    expect(hay.includes(normalizeForMatch("isn't a feature - it's a boundary..."))).toBe(true)
  })

  test("collapses whitespace so wrapped markup still matches a typed phrase", () => {
    const hay = normalizeForMatch("no user,\n   tenant\tor org column")
    expect(hay.includes(normalizeForMatch("no user, tenant or org column"))).toBe(true)
  })
})

describe("detectLane", () => {
  test("absent data-page means the bespoke blade served it — not a crash", () => {
    // The session's data-page regex threw AttributeError here and it was read as a
    // failure. It is the answer: this page is bespoke.
    expect(detectLane("<!DOCTYPE html><html><head><style>a{}</style></head><body>x</body></html>")).toBe("bespoke")
  })

  test("present data-page means the composable Inertia viewer", () => {
    expect(detectLane('<div id="app" data-page="{&quot;component&quot;:&quot;Page&quot;}"></div>')).toBe("composable")
  })
})

describe("parseHtmlDocument", () => {
  const FULL = `<!DOCTYPE html>
<html lang="en"><head>
<title>The Harness Is Not the Moat</title>
<meta name="description" content="Why IRIS OS, not the DeepSeek harness.">
<style>.hx h1{text-transform:uppercase}</style>
</head><body><div class="hx"><h1>The harness is not the moat</h1></div></body></html>`

  test("lifts title, description, css and body from a full document", () => {
    const d = parseHtmlDocument(FULL)
    expect(d.title).toBe("The Harness Is Not the Moat")
    expect(d.description).toBe("Why IRIS OS, not the DeepSeek harness.")
    expect(d.css).toBe(".hx h1{text-transform:uppercase}")
    expect(d.isFullDocument).toBe(true)
    expect(d.body).toContain("<h1>The harness is not the moat</h1>")
    // The <style> must not survive into the body — in the custom lane it is re-added once,
    // and a duplicate would silently double every rule.
    expect(d.body).not.toContain("<style>")
  })

  test("handles a bare fragment (the CustomHtml lane input)", () => {
    const d = parseHtmlDocument(`<style>.hx{color:red}</style><div class="hx">hi</div>`)
    expect(d.isFullDocument).toBe(false)
    expect(d.css).toBe(".hx{color:red}")
    expect(d.body).toBe(`<div class="hx">hi</div>`)
    expect(d.title).toBeNull()
  })

  test("concatenates multiple style blocks rather than keeping only the last", () => {
    const d = parseHtmlDocument(`<style>a{}</style><style>b{}</style><p>x</p>`)
    expect(d.css).toBe("a{}\n\nb{}")
  })
})

describe("buildBespokeJsonContent", () => {
  const doc = parseHtmlDocument(`<style>.hx{color:red}</style><div class="hx">hi</div>`)

  test("standalone lane sets render_mode:html with html and css split", () => {
    const jc = buildBespokeJsonContent(doc, "standalone")
    expect(jc.render_mode).toBe("html")
    expect(jc.css).toBe(".hx{color:red}")
    expect(jc.html).toBe(`<div class="hx">hi</div>`)
    expect(jc.components).toBeUndefined()
  })

  test("standalone lane types the page as article so /p/papers can index it", () => {
    // `type` and `render_mode` are independent — a bespoke page IS indexable.
    expect(buildBespokeJsonContent(doc, "standalone").type).toBe("article")
  })

  test("custom lane inlines the css into the single CustomHtml prop", () => {
    const jc = buildBespokeJsonContent(doc, "custom")
    expect(jc.components).toHaveLength(1)
    expect(jc.components[0].type).toBe("CustomHtml")
    expect(jc.components[0].props.html).toBe(`<style>\n.hx{color:red}\n</style>\n<div class="hx">hi</div>`)
    expect(jc.render_mode).toBeUndefined()
  })

  test("custom lane omits the style tag entirely when there is no css", () => {
    const bare = parseHtmlDocument(`<p>hi</p>`)
    expect(buildBespokeJsonContent(bare, "custom").components[0].props.html).toBe("<p>hi</p>")
  })
})

/**
 * An unauthenticated fetch of a gated page returns HTTP 200 with a rendered OTP gate, so
 * every ordinary success signal is present and the text is the GATE's. Measured on
 * /p/iris-harness-gap-analysis: read returned "Welcome to IRIS / Instant access — no code,
 * no password / Email address / Continue" as the document, and --min-words 400 would have
 * failed with "52 words" — which reads as an empty page, not as one you were never let into.
 */
describe("detectGated", () => {
  const wrap = (props: any) =>
    `<div id="app" data-page="${JSON.stringify({ component: "PublicPage/Render", props })
      .replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"></div>`

  test("gateRequired:true in the Inertia payload is the authoritative signal (the repro)", () => {
    expect(detectGated(wrap({ gateRequired: true, gateBloqId: 570 }))).toBe(true)
  })

  test("gateRequired:false is NOT gated — an authenticated read must pass through", () => {
    expect(detectGated(wrap({ gateRequired: false, auth: { user: { id: 1 } } }))).toBe(false)
  })

  test("an ordinary composable page is not gated", () => {
    expect(detectGated(wrap({ page: { slug: "x" } }))).toBe(false)
  })

  test("falls back to the gate's own copy when there is no parsable payload", () => {
    expect(detectGated("<body><h1>Welcome to IRIS</h1><p>Instant access — no code, no password.</p></body>")).toBe(true)
  })

  test("an email input alone is NOT a gate — plenty of real pages have one", () => {
    // Deliberately narrow: a false positive here would refuse to read a legitimate page.
    expect(detectGated('<form><input type="email" name="signup"><button>Continue</button></form>')).toBe(false)
  })

  test("a bespoke page with no data-page and no gate copy reads normally", () => {
    expect(detectGated("<!DOCTYPE html><html><body><h1>The harness</h1></body></html>")).toBe(false)
  })
})
