import { afterAll, describe, expect, test } from "bun:test"
import { PageSession, findChrome } from "./browser-driver"
import { clampPageText, findInPage } from "./browser-verbs"

/**
 * The driver, against a REAL Chrome and a real page.
 *
 * Pointed at 127.0.0.1 deliberately: the refusals live at the tool boundary (browser-verbs), so
 * this can serve its own fixture while the agent still cannot reach a private host. A test that
 * mocked CDP would prove only that the mock matches the code that calls it.
 *
 * Skipped, loudly, where there is no Chrome — a browser test that silently passes on a machine
 * without a browser is the false green this repo keeps finding.
 */
const chrome = await findChrome()
const server = Bun.serve({
  port: 0,
  fetch() {
    const lines = [
      "<h1>Fixture page</h1>",
      ...Array.from({ length: 40 }, (_, i) => `<p>filler line ${i}</p>`),
      "<p>kimi-k3 scored 67 on the far fact</p>",
      ...Array.from({ length: 40 }, (_, i) => `<p>tail line ${i}</p>`),
    ]

    return new Response(`<!doctype html><title>Fixture</title><body>${lines.join("")}</body>`, {
      headers: { "content-type": "text/html" },
    })
  },
})
const url = `http://127.0.0.1:${server.port}/`
// 45s, not 20: this launches a real Chrome, and on a machine that is also running a type check
// the launch alone took most of 20s and the suite failed for being busy rather than broken.
const session = new PageSession({ timeoutMs: 45_000 })

afterAll(async () => {
  await session.close()
  server.stop(true)
})

describe.if(!!chrome)("PageSession against real Chrome", () => {
  test("opens a page and reports where it landed", async () => {
    const r = await session.open(url)
    expect(r.title).toBe("Fixture")
    expect(r.url).toStartWith(url)
  }, 60_000)

  test("reads the text a person would read, not the markup", async () => {
    const text = await session.text()
    expect(text).toContain("Fixture page")
    expect(text).not.toContain("<p>")
  }, 60_000)

  test("finds a fact that sits below the excerpt a model would be shown", async () => {
    // The whole point of slice 1, end to end: the fact is past a 3,000-character budget, so the
    // clamped text does NOT contain it — and find does.
    const text = await session.text()
    const clamped = clampPageText(text, 300)
    expect(clamped).not.toContain("kimi-k3")
    expect(clamped).toContain("truncated")

    const hit = findInPage(text, "kimi-k3")
    expect(hit.matches).toBe(1)
    expect(hit.text).toContain("67")
  }, 60_000)

  test("photographs the page as a PNG", async () => {
    const png = await session.screenshot()
    expect(png.length).toBeGreaterThan(1000)
    expect(Array.from(png.slice(1, 4))).toEqual([0x50, 0x4e, 0x47]) // "PNG"
  }, 60_000)

  test("closing twice is not an error — the session may end after the user already closed it", async () => {
    await session.close()
    await session.close()
  }, 60_000)
})

test.if(!chrome)("SKIPPED: no Chrome on this machine — the driver was not exercised", () => {
  expect(chrome).toBeNull()
})
