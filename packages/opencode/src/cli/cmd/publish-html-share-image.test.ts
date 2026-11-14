import { describe, expect, test } from "bun:test"
import { buildBespokeJsonContent, carryForward, parseHtmlDocument, parseMetaTags, shareImageProblem } from "./platform-pages"

// publish-html read <title> and the meta description from the file and threw the rest of <head>
// away — including og:image. Every hand-written page therefore unfurled as the generic IRIS card
// in iMessage/Slack/X, while the file in the repo plainly declared its own image. Found sharing
// /p/hive-net-party (2026-10-09). These pin the file's share image all the way into json_content,
// which is FIRST in the server's og:image chain.

const CARD = "https://cdn.heyiris.io/cloud-files/1791553489_og-card.png"
const page = (head: string) => `<!doctype html><html><head><title>T</title>${head}<style>.a{}</style></head><body><p>hi</p></body></html>`

describe("the file's share image", () => {
  test("og:image is read, whatever the attribute order", () => {
    expect(parseHtmlDocument(page(`<meta property="og:image" content="${CARD}">`)).ogImage).toBe(CARD)
    expect(parseHtmlDocument(page(`<meta content="${CARD}" property="og:image">`)).ogImage).toBe(CARD)
    expect(parseHtmlDocument(page(`<meta property='og:image' content='${CARD}' />`)).ogImage).toBe(CARD)
  })

  test("twitter:image is the fallback; og:image wins when both exist", () => {
    expect(parseHtmlDocument(page(`<meta name="twitter:image" content="${CARD}">`)).ogImage).toBe(CARD)
    const both = page(`<meta name="twitter:image" content="https://x/t.png"><meta property="og:image" content="${CARD}">`)
    expect(parseHtmlDocument(both).ogImage).toBe(CARD)
  })

  test("og:image:width is not mistaken for the image", () => {
    expect(parseHtmlDocument(page(`<meta property="og:image:width" content="1200"><meta property="og:image" content="${CARD}">`)).ogImage).toBe(CARD)
  })

  test("a file with no share image says so (null), rather than inventing one", () => {
    expect(parseHtmlDocument(page(`<meta name="description" content="d">`)).ogImage).toBeNull()
  })

  test("an apostrophe inside a double-quoted content does not end the value (#188610 shape)", () => {
    expect(parseMetaTags(`<meta property="og:title" content="Tonight's menu">`)["og:title"]).toBe("Tonight's menu")
  })
})

describe("into json_content — both lanes", () => {
  test("standalone and custom pages carry og_image", () => {
    const doc = parseHtmlDocument(page(`<meta property="og:image" content="${CARD}">`))
    expect(buildBespokeJsonContent(doc, "standalone").og_image).toBe(CARD)
    expect(buildBespokeJsonContent(doc, "custom").og_image).toBe(CARD)
  })

  test("an unusable URL is not stored — crawlers fetch it without the page", () => {
    for (const bad of ["/img/card.png", "card.png", "data:image/png;base64,AAAA"]) {
      expect(shareImageProblem(bad)).not.toBeNull()
      const doc = parseHtmlDocument(page(`<meta property="og:image" content="${bad}">`))
      expect("og_image" in buildBespokeJsonContent(doc, "standalone")).toBe(false)
    }
    expect(shareImageProblem(CARD)).toBeNull()
  })
})

describe("on republish", () => {
  const live = { render_mode: "html", html: "<p>old</p>", og_image: CARD, bindings: { a: 1 } }

  test("a file WITHOUT og:image keeps the live page's share image", () => {
    const fresh = buildBespokeJsonContent(parseHtmlDocument(page("")), "standalone")
    const { json, kept } = carryForward(live, fresh)
    expect(json.og_image).toBe(CARD)
    expect(kept).toContain("og_image")
  })

  test("a file WITH og:image replaces it", () => {
    const next = "https://cdn.heyiris.io/cloud-files/new-card.png"
    const fresh = buildBespokeJsonContent(parseHtmlDocument(page(`<meta property="og:image" content="${next}">`)), "standalone")
    expect(carryForward(live, fresh).json.og_image).toBe(next)
  })
})
