import { afterAll, describe, expect, test } from "bun:test"
import { PageSession, findChrome } from "./browser-driver"
import { clampPageText, describeChange, findInPage, refuseOptionReason, refuseTargetReason } from "./browser-verbs"

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
  fetch(req) {
    if (new URL(req.url).pathname === "/second") {
      return new Response("<!doctype html><title>Second</title><body><h1>Second page</h1></body>", {
        headers: { "content-type": "text/html" },
      })
    }
    const lines = [
      "<h1>Fixture page</h1>",
      ...Array.from({ length: 40 }, (_, i) => `<p>filler line ${i}</p>`),
      "<p>kimi-k3 scored 67 on the far fact</p>",
      "<table><tr><th>Model</th><th>Floor</th><th>Mean</th></tr>",
      "<tr><td>hy3</td><td>64</td><td>81</td></tr>",
      "<tr><td>kimi-k2.6</td><td>55</td><td>89</td></tr></table>",
      '<input id="q" placeholder="Search models">',
      '<button id="go">Run search</button>',
      '<button id="danger">Delete account</button>',
      '<a href="/second">Go to second page</a>',
      '<select id="round"><option value="01">Round 01</option><option value="02">Round 02</option></select>',
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

  test("a table row comes back WITH its header — the eleven-call lesson, against real Chrome", async () => {
    // The header detection assumes innerText renders a row as tab-separated cells. That is an
    // assumption about a browser, so it is checked in one: a unit test with hand-written tabs
    // would prove only that the fixture matches the parser.
    const text = await session.text()
    const hit = findInPage(text, "kimi-k2.6")
    expect(hit.matches).toBe(1)
    expect(hit.text).toContain("header")
    expect(hit.text).toContain("Mean")
  }, 60_000)

  test("photographs the page as a PNG", async () => {
    const png = await session.screenshot()
    expect(png.length).toBeGreaterThan(1000)
    expect(Array.from(png.slice(1, 4))).toEqual([0x50, 0x4e, 0x47]) // "PNG"
  }, 60_000)

  test("lists the page as a numbered menu, with roles a target can be checked against", async () => {
    const els = await session.elements()
    const byName = (n: string) => els.find((e) => e.name.includes(n))
    expect(byName("Search models")?.role).toBe("textbox")
    expect(byName("Run search")?.role).toBe("button")
    expect(byName("second page")?.role).toBe("link")
    // the compatibility rule is enforced against THESE roles, not against a guess
    expect(refuseTargetReason(els, byName("Search models")!.ref, "click")).toContain("not clickable")
    expect(refuseTargetReason(els, byName("Run search")!.ref, "type")).toContain("not a text field")
  }, 60_000)

  test("typing lands in the field, and the change is visible in the diff — not asserted", async () => {
    const els = await session.elements()
    const field = els.find((e) => e.name.includes("Search models"))!
    const before = await session.state()
    expect(await session.typeRef(field.ref, "kimi-k3")).toBe(true)
    const after = await session.state()
    expect(describeChange(before, after)).toContain("kimi-k3")
  }, 60_000)

  test("a click that navigates is reported as a navigation", async () => {
    const els = await session.elements()
    const link = els.find((e) => e.name.includes("second page"))!
    const before = await session.state()
    expect(await session.clickRef(link.ref)).toBe(true)
    const after = await session.state()
    const changed = describeChange(before, after)
    expect(changed).toContain("/second")
    expect(changed).toContain("title")
    await session.open(url) // back to the fixture for the remaining tests
  }, 60_000)

  test("a stale ref is not a wrong click — it is not found at all", async () => {
    // The failure this prevents: refs from a previous page silently addressing whatever now sits
    // in that position. After a navigation the data attribute is gone, so the click cannot land.
    await session.open(`${url}second`)
    expect(await session.clickRef(999)).toBe(false)
    await session.open(url)
  }, 60_000)

  test("a dropdown comes back with its own options, and can only be set to one of them", async () => {
    // The closed-set property, against a real <select>: what it offers is what it can become.
    const els = await session.elements()
    const dd = els.find((e) => e.tag === "select")!
    expect(dd.options).toEqual(["01", "02"])
    expect(refuseOptionReason(els, dd.ref, "99")).toContain("01, 02")

    const before = await session.state()
    expect(await session.selectRef(dd.ref, "02")).toBe(true)
    const after = await session.state()
    expect(describeChange(before, after)).toContain("02")
  }, 60_000)

  test("scrolling to the bottom and back to the top actually moves the viewport", async () => {
    await session.scroll("bottom")
    const atBottom = await session.evaluate<number>("Math.round(scrollY)")
    expect(atBottom).toBeGreaterThan(0)
    await session.scroll("top")
    expect(await session.evaluate<number>("Math.round(scrollY)")).toBe(0)
  }, 60_000)

  test("closing twice is not an error — the session may end after the user already closed it", async () => {
    await session.close()
    await session.close()
  }, 60_000)
})

test.if(!chrome)("SKIPPED: no Chrome on this machine — the driver was not exercised", () => {
  expect(chrome).toBeNull()
})
