import { afterAll, describe, expect, test } from "bun:test"
import { PageSession, findChrome } from "./browser-driver"
import { clampPageText, describeChange, findInPage, listingFooter, refuseOptionReason, refuseTargetReason } from "./browser-verbs"

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
    const html = (body: string) => new Response(`<!doctype html>${body}`, { headers: { "content-type": "text/html" } })
    // Indeed's results (#193242): the visible control is a button; the job's link and id sit around it.
    if (new URL(req.url).pathname === "/jobs") {
      return html(`<title>Jobs</title><link rel="canonical" href="https://jobs.example/q"><body><ul>
        <li data-jk="abc123"><div><h2><a href="/viewjob?jk=abc123">Contract Software Engineer</a></h2>
        <button aria-label="full details of Contract Software Engineer">Details</button></div></li>
        <li data-jk="def456"><div><button aria-label="full details of Data Labeler">Details</button></div></li>
        </ul><button id="route" onclick="history.pushState({}, '', '/jobs?vjk=abc123')">Show job</button></body>`)
    }
    // Toast's item pop-up (2026-11-11): a long menu behind, choices drawn by the site with the
    // real radio hidden, and an Add to Cart button.
    if (new URL(req.url).pathname === "/menu") {
      const menu = Array.from({ length: 220 }, (_, i) => `<button>Menu item ${i}</button>`).join("")
      const choice = (n: string) =>
        `<label style="display:block;padding:8px">${n}<input type="radio" name="protein" style="position:absolute;opacity:0;width:0;height:0"></label>`
      return html(`<title>Menu</title><body>${menu}<div role="dialog" aria-modal="true" style="position:fixed;top:0;left:0;background:#fff">
        <h2>ORIGINATOR</h2>${choice("Hemp Protein")}${choice("Pea Protein")}<button>Add to Cart</button></div></body>`)
    }
    // Southwest's results (#193331): a header of 200 links, then a fare grid whose prices are
    // <div>s that answer a click — no button, no role. The old list stopped at 150 in document
    // order and never reached them; scrolling could not help.
    if (new URL(req.url).pathname === "/fares") {
      const nav = Array.from({ length: 200 }, (_, i) => `<a href="/nav${i}">Menu link ${i}</a>`).join(" ")
      const fare = (id: string, price: string) =>
        `<div class="row"><span>${id}</span><div class="fare" style="cursor:pointer;padding:10px;display:inline-block" onclick="document.title='picked ${id} ${price}'"><span>$${price}</span><span> 4 left</span></div></div>`
      return html(`<title>Select flights</title><body><nav>${nav}</nav><div style="height:3000px"></div>
        <section id="grid">${fare("WN404", "170")}${fare("WN1050", "155")}${fare("WN409", "170")}</section><div style="height:2000px"></div></body>`)
    }
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
    expect(refuseOptionReason(els, dd.ref, "99")).toContain(`01 "Round 01", 02 "Round 02"`)

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

  test("a job card's link and id come with its button, and inspect finds them without a click (#193242)", async () => {
    await session.open(`${url}jobs`)
    const els = await session.elements()
    const link = els.find((e) => e.name === "Contract Software Engineer")!
    expect(link.href).toBe(`${url}viewjob?jk=abc123`)
    expect(link.ids).toEqual({ "data-jk": "abc123" })
    const details = els.find((e) => e.name === "full details of Contract Software Engineer")!
    expect(details.href).toBeUndefined()
    expect(details.ids).toEqual({ "data-jk": "abc123" })

    const seen = (await session.inspect(details.ref))!
    expect(seen.links).toEqual([{ url: `${url}viewjob?jk=abc123`, source: "card-anchor", where: "a link in the same card: Contract Software Engineer" }])
    expect(seen.ids["data-jk"]).toBe("abc123")
    expect(seen.canonical).toBe("https://jobs.example/q")
    // A card with only an id: no link is made up.
    const bare = (await session.inspect(els.find((e) => e.name === "full details of Data Labeler")!.ref))!
    expect(bare.links).toEqual([])
    expect(bare.ids["data-jk"]).toBe("def456")
  }, 60_000)

  test("an in-place route change (pushState) shows in where()", async () => {
    await session.open(`${url}jobs`)
    const els = await session.elements()
    await session.clickRef(els.find((e) => e.name === "Show job")!.ref)
    expect((await session.where()).url).toBe(`${url}jobs?vjk=abc123`)
  }, 60_000)

  test("an open pop-up lists ITS choices, drawn ones included, and choosing one checks it (Toast)", async () => {
    await session.open(`${url}menu`)
    const els = await session.elements()
    expect(els.every((e) => e.inDialog)).toBe(true)
    expect(els.map((e) => `${e.role} ${e.name}`)).toEqual(["radio Hemp Protein", "radio Pea Protein", "button Add to Cart"])
    const hemp = els[0]!
    expect(hemp.checked).toBe(false)
    expect(refuseTargetReason(els, hemp.ref, "click")).toBeNull()
    await session.clickRef(hemp.ref)
    expect((await session.elements())[0]!.checked).toBe(true)
  }, 60_000)

  test("a fare cell that is only a clickable <div>, past 200 header links, is listed and clicked (#193331)", async () => {
    await session.open(`${url}fares`)
    const top = await session.elements()
    expect(top.length).toBe(150)
    expect(session.lastListing?.total).toBe(203)
    // the cut is reported, not silent
    expect(listingFooter(top.length, session.lastListing)).toContain("Not listed: 53 below")
    const navRef = top.find((e) => e.name === "Menu link 0")!.ref

    // asked for by its words: found at once, from anywhere on the page
    const hit = await session.elements(150, { query: "$155" })
    expect(hit.length).toBe(1)
    expect(hit[0]).toMatchObject({ role: "button", area: true })
    expect(hit[0].name).toContain("$155")

    // scrolled to: on screen comes FIRST, and nothing already seen was renumbered
    await session.evaluate("document.getElementById('grid').scrollIntoView({block:'center'})")
    const there = await session.elements()
    expect(there[0].area).toBe(true)
    expect(there.slice(0, 3).map((e) => e.name.replace(/\s+/g, " "))).toEqual(["$170 4 left", "$155 4 left", "$170 4 left"])
    expect(there.find((e) => e.ref === hit[0].ref)?.name).toContain("$155")

    // a ref beyond the cut still resolves for the action that names it
    const withNav = await session.elements(1, { include: navRef })
    expect(withNav.map((e) => e.ref)).toContain(navRef)

    expect(refuseTargetReason(there, hit[0].ref, "click")).toBeNull()
    expect(await session.clickRef(hit[0].ref)).toBe(true)
    expect((await session.where()).title).toBe("picked WN1050 155")
    await session.open(url)
  }, 60_000)

  test("closing twice is not an error — the session may end after the user already closed it", async () => {
    await session.close()
    await session.close()
  }, 60_000)
})

test.if(!chrome)("SKIPPED: no Chrome on this machine — the driver was not exercised", () => {
  expect(chrome).toBeNull()
})
