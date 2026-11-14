import { afterAll, describe, expect, test } from "bun:test"
import { PageSession, findChrome } from "./browser-driver"
import {
  clampPageText,
  describeChange,
  findInPage,
  humanCheckReason,
  listingFooter,
  refuseOptionReason,
  refuseTargetReason,
  renderElements,
} from "./browser-verbs"

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

/**
 * The stress-test fixtures (#193355): each one a pattern real booking sites use, that the driver
 * got wrong before. Built from the harness that found them, one page per finding.
 */
const STRESS: Record<string, string> = {
  // A OneTrust cookie banner: role=dialog, NOT modal, along the bottom. The page is still the page.
  "/banner": `<title>Book</title><body><h1>Find flights</h1><input aria-label="From"><input aria-label="To"><button>Search flights</button>
    <div id="onetrust-consent-sdk"><div class="ot-sdk-container" role="dialog" aria-label="Privacy" style="position:fixed;left:0;right:0;bottom:0;height:80px;background:#eee">
    <button>Accept all cookies</button><button>Cookie settings</button></div></div></body>`,
  // Radix/MUI: opens on pointerdown and ignores click. react-select: mousedown only.
  "/pointerdown": `<title>pd</title><button onpointerdown="document.title='opened'">Open menu</button>
    <div role="button" tabindex="0" onmousedown="this.textContent='airport open'">Choose airport</div>
    <button id="n" onclick="this.dataset.n=(+this.dataset.n||0)+1;document.title='clicks '+this.dataset.n">Count</button>
    <label><input type="checkbox" onchange="document.title='checked '+this.checked">Window seat</label>`,
  // An airport box that searches on keyup; a search that only submits on Enter; a beforeinput editor.
  "/keys": `<title>keys</title><input aria-label="From" onkeyup="document.getElementById('s').innerHTML=this.value?'<li role=option>Austin, TX - AUS</li>':''"><ul id="s" role="listbox"></ul>
    <form onsubmit="document.title='searched '+this.q.value;return false"><input name="q" aria-label="Search"></form>
    <div id="e" contenteditable="true" aria-label="Message"></div>
    <script>const e=document.getElementById('e');let model='';e.addEventListener('beforeinput',ev=>{ev.preventDefault();model+=ev.data||'';e.textContent=model});window.model=()=>model</script>
    <input type="date" aria-label="Pick-up date" onchange="document.title='date '+this.value">`,
  // An async router: the click navigates 900 ms later.
  "/slownav": `<title>sn</title><button onclick="setTimeout(()=>location.assign('/second'),900)">Continue</button>`,
  // A new tab, two ways.
  "/blank": `<title>blank</title><a href="/second" target="_blank">Open the map</a><button onclick="window.open('/second')">View itinerary</button>`,
  // A web component and an embedded same-origin checkout.
  "/deep": `<title>deep</title><x-btn></x-btn><iframe src="/inner" style="width:600px;height:200px"></iframe>
    <script>customElements.define('x-btn',class extends HTMLElement{connectedCallback(){const r=this.attachShadow({mode:'open'});r.innerHTML='<button>Select fare $155</button><input aria-label="Promo code">';r.querySelector('button').onclick=()=>document.title='shadow clicked'}})</script>`,
  "/inner": `<title>inner</title><button onclick="parent.document.title='iframe clicked'">Reserve car</button><input aria-label="Driver age">`,
  // Repeated words: two months of day buttons, five Select buttons, icon-only buttons.
  "/names": `<title>names</title>${["November", "December"].map((m) => `<table><caption>${m} 2026</caption><tr>${Array.from({ length: 12 }, (_, i) => `<td><button>${i + 1}</button></td>`).join("")}</tr></table>`).join("")}
    ${Array.from({ length: 3 }, (_, i) => `<div><span>Flight WN${100 + i}</span><button>Select</button></div>`).join("")}
    <span id="lbl">Swap origin and destination</span><button aria-labelledby="lbl"><svg width="16" height="16"></svg></button>
    <button><svg width="16" height="16"><title>Close dialog</title></svg></button>`,
  // Google Flights (#193443): one grid per month, the month printed above it, each day a price
  // button with no month of its own; a row of days that carry data-iso.
  "/calendar": `<title>cal</title>${["December 2026", "January 2027"].map((m, k) => `<div><div>${m}</div><div role="grid">${Array.from({ length: 3 }, (_, i) => `<div role="gridcell"><div role="button">${i + 10} $${410 + i + k}</div></div>`).join("")}</div></div>`).join("")}
    <div>${[1, 2].map((d) => `<span data-iso="2026-11-0${d}" role="button" tabindex="0">${d}</span>`).join("")}</div>
    <input aria-label="Departure" placeholder="Departure" onchange="setTimeout(()=>this.value='',50)">
    <input aria-label="Where to?" role="combobox" aria-autocomplete="list">
    <input aria-label="Phone" oninput="this.value=this.value.replace(/[^0-9]/g,'')">`,
  // A control under a full-page overlay.
  "/overlay": `<title>ov</title><button style="margin:100px">Search flights</button><div style="position:fixed;inset:0;background:rgba(0,0,0,.5)"><button style="position:absolute;bottom:20px;right:20px" onclick="this.parentElement.remove()">Accept cookies</button></div>`,
  // Expedia's block page, and Kayak's.
  "/botornot": `<title>Bot or Not?</title><body><h1>Bot or Not?</h1><p>We can't tell if you're a human or a bot.</p></body>`,
  "/help/bots.html": `<title>KAYAK</title><body><h1>What is happening?</h1><p>Please confirm you are not a robot.</p></body>`,
}

const server = Bun.serve({
  port: 0,
  fetch(req) {
    const html = (body: string) => new Response(`<!doctype html>${body}`, { headers: { "content-type": "text/html" } })
    const stress = STRESS[new URL(req.url).pathname]
    if (stress) return html(stress)
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
    // Southwest's date bar (#193443): 160 day tabs all reporting as on screen (a carousel that
    // stacks them), fares just below. The tabs alone filled the 150-entry list.
    if (new URL(req.url).pathname === "/dates") {
      const days = Array.from({ length: 160 }, (_, i) => `<li><button role="tab" style="position:absolute;left:0;top:0">Day ${i + 1}</button></li>`).join("")
      const fare = (id: string, price: string) => `<button onclick="document.title='picked ${id}'">${id} $${price}</button>`
      return html(`<title>Depart</title><body><ul style="position:relative;height:40px;overflow:hidden">${days}</ul><div style="height:1200px"></div>
        <section>${fare("WN300", "104")}${fare("WN485", "159")}${fare("WN271", "149")}</section></body>`)
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
    // the 200-link header is one strip: a few kept, the rest summed up, so the fares fit (#193443)
    expect(session.lastListing?.total).toBe(203)
    expect(top.filter((e) => e.area).length).toBe(3)
    expect(top.length).toBe(15)
    // the shortening is reported, not silent
    expect(listingFooter(top.length, session.lastListing)).toContain("188 more links in one strip")
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
    // two cells that say the same thing carry their flight (#193355)
    expect(there.slice(0, 3).map((e) => e.name.replace(/\s+/g, " "))).toEqual(["$170 4 left (WN404)", "$155 4 left", "$170 4 left (WN409)"])
    expect(there.find((e) => e.ref === hit[0].ref)?.name).toContain("$155")

    // a ref beyond the cut still resolves for the action that names it
    const withNav = await session.elements(1, { include: navRef })
    expect(withNav.map((e) => e.ref)).toContain(navRef)

    expect(refuseTargetReason(there, hit[0].ref, "click")).toBeNull()
    expect(await session.clickRef(hit[0].ref)).toBe(true)
    expect((await session.where()).title).toBe("picked WN1050 155")
    await session.open(url)
  }, 60_000)

  test("a 160-day date bar cannot push the fares off the list (#193443)", async () => {
    await session.open(`${url}dates`)
    const els = await session.elements()
    expect(els.filter((e) => e.role === "tab").length).toBe(12)
    expect(els.filter((e) => e.role === "button").map((e) => e.name)).toEqual(["WN300 $104", "WN485 $159", "WN271 $149"])
    const footer = listingFooter(els.length, session.lastListing)
    expect(footer).toContain('148 more tabs in one strip ("Day 1" … "Day 160")')
    // any one day is still reachable by its words
    const day = await session.elements(150, { query: "day 97" })
    expect(day.map((e) => e.name)).toEqual(["Day 97"])
    await session.open(url)
  }, 60_000)

  test("a cookie banner (role=dialog, not modal) does not hide the page; a real modal does, and says what is behind it (#193355)", async () => {
    await session.open(`${url}banner`)
    const els = await session.elements()
    expect(els.some((e) => e.inDialog)).toBe(false)
    expect(els.map((e) => e.name)).toEqual(expect.arrayContaining(["From", "To", "Search flights", "Accept all cookies"]))
    expect(session.lastListing?.behind).toBeUndefined()

    await session.open(`${url}menu`)
    const modal = await session.elements()
    expect(modal.every((e) => e.inDialog)).toBe(true)
    expect(session.lastListing?.behind).toBe(220)
    expect(listingFooter(modal.length, session.lastListing)).toContain("220 more controls are BEHIND the pop-up")
  }, 60_000)

  test("a click is a mouse: pointerdown/mousedown widgets open, and the click fires exactly once (#193355)", async () => {
    await session.open(`${url}pointerdown`)
    let els = await session.elements()
    const by = (n: string) => els.find((e) => e.name.startsWith(n))!
    await session.clickRef(by("Open menu").ref)
    expect((await session.where()).title).toBe("opened")
    await session.clickRef(by("Choose airport").ref)
    els = await session.elements()
    expect(els.some((e) => e.name === "airport open")).toBe(true)
    await session.clickRef(by("Count").ref)
    expect((await session.where()).title).toBe("clicks 1")
    await session.clickRef(by("Window seat").ref)
    expect((await session.where()).title).toBe("checked true")
  }, 60_000)

  test("typing is keystrokes: keyup autocompletes suggest, beforeinput editors fill, Enter submits a form with no button (#193355)", async () => {
    await session.open(`${url}keys`)
    let els = await session.elements()
    const by = (n: string) => els.find((e) => e.name.startsWith(n))!
    await session.typeRef(by("From").ref, "Aus")
    els = await session.elements()
    expect(els.some((e) => e.name.includes("Austin"))).toBe(true)

    await session.typeRef(by("Message").ref, "hello")
    expect(await session.evaluate<string>("window.model()")).toBe("hello")

    const search = by("Search").ref
    await session.typeRef(search, "phoenix")
    expect(await session.enterEffect(search)).toEqual({ found: true, kind: "submit", label: "Search" })
    expect(await session.pressKey(search, "Enter")).toBe(true)
    expect((await session.where()).title).toBe("searched phoenix")
    // Backspace and Enter on whatever has focus
    await session.pressKey(undefined, "Backspace")
    expect(await session.evaluate<string>("document.querySelector('[name=q]').value")).toBe("phoeni")
    expect((await session.enterEffect(by("Message").ref)).kind).toBe("newline")
  }, 60_000)

  test("a date field takes 12/10/2026 as 2026-12-10, and says so when it stays empty (#193355)", async () => {
    await session.open(`${url}keys`)
    const els = await session.elements()
    const d = els.find((e) => e.name === "Pick-up date")!
    expect(await session.typeRef(d.ref, "12/10/2026")).toBe(true)
    expect((await session.where()).title).toBe("date 2026-12-10")
    expect(session.takeNotes()).toEqual([])
    await session.typeRef(d.ref, "next friday")
    expect(session.takeNotes().join(" ")).toContain("date field is still EMPTY")
  }, 60_000)

  test("a click that navigates 900 ms later is waited for, not read as nothing changed (#193355)", async () => {
    await session.open(`${url}slownav`)
    const els = await session.elements()
    const before = await session.state()
    await session.clickRef(els[0]!.ref)
    expect(describeChange(before, await session.state())).toContain("navigated to")
  }, 60_000)

  test("a new-tab link and window.open open in this tab, and the session says so (#193355)", async () => {
    for (const name of ["Open the map", "View itinerary"]) {
      await session.open(`${url}blank`)
      const els = await session.elements()
      session.takeNotes()
      await session.clickRef(els.find((e) => e.name === name)!.ref)
      expect((await session.where()).url).toBe(`${url}second`)
      expect(session.takeNotes().join(" ")).toContain("NEW TAB")
    }
  }, 60_000)

  test("controls in an open shadow root and a same-origin iframe are listed, and their refs act (#193355)", async () => {
    await session.open(`${url}deep`)
    await Bun.sleep(300)
    let els = await session.elements()
    const by = (n: string) => els.find((e) => e.name === n)!
    expect(els.map((e) => e.name)).toEqual(expect.arrayContaining(["Select fare $155", "Promo code", "Reserve car", "Driver age"]))
    await session.clickRef(by("Select fare $155").ref)
    expect((await session.where()).title).toBe("shadow clicked")
    await session.clickRef(by("Reserve car").ref)
    expect((await session.where()).title).toBe("iframe clicked")
    await session.typeRef(by("Driver age").ref, "30")
    const st = await session.state()
    expect(st.values[String(by("Driver age").ref)]).toBe("30")
    expect((await session.inspect(by("Promo code").ref))?.tag).toBe("input")
    els = await session.elements()
    expect(by("Promo code").value).toBe("")
  }, 60_000)

  test("same words, different things: a day carries its month, Select its flight; icon buttons have names (#193355)", async () => {
    await session.open(`${url}names`)
    const names = (await session.elements()).map((e) => e.name)
    expect(names).toContain("10 (November 2026)")
    expect(names).toContain("10 (December 2026)")
    expect(names).toContain("Select (Flight WN101)")
    expect(names).not.toContain("Select")
    expect(names).toContain("Swap origin and destination")
    expect(names).toContain("Close dialog")
  }, 60_000)

  test("a calendar day carries its month and year: from the month printed above it, or its data-iso (#193443)", async () => {
    await session.open(`${url}calendar`)
    const names = (await session.elements()).map((e) => e.name)
    expect(names).toContain("10 $410 (December 2026)")
    expect(names).toContain("10 $411 (January 2027)")
    expect(names).toContain("1 (2026-11-01)")
  }, 60_000)

  test("typing says when the site cleared it, changed it, or still needs a choice from its list (#193442)", async () => {
    await session.open(`${url}calendar`)
    const els = await session.elements()
    const by = (n: string) => els.find((e) => e.name === n)!
    session.takeNotes()
    await session.typeRef(by("Departure").ref, "12/10/2026")
    expect(session.takeNotes().join(" ")).toContain("still EMPTY")
    await session.typeRef(by("Where to?").ref, "Austin")
    expect(session.takeNotes().join(" ")).toContain("NOT CHOSEN YET")
    await session.typeRef(by("Phone").ref, "512-555")
    expect(session.takeNotes().join(" ")).toContain(`NOT AS TYPED: [${by("Phone").ref}] now shows "512555"`)
  }, 60_000)

  test("a control under an overlay is flagged as covered (#193355)", async () => {
    await session.open(`${url}overlay`)
    const els = await session.elements()
    const b = els.find((e) => e.name === "Search flights")!
    expect(b.covered).toBeTruthy()
    expect(renderElements([b])).toContain("covered by")
    expect(els.find((e) => e.name === "Accept cookies")!.covered).toBeUndefined()
  }, 60_000)

  test("a bot-check page is recognised, not read as an empty page (#193355)", async () => {
    await session.open(`${url}botornot`)
    expect(humanCheckReason(await session.signals())).toBe("a block page")
    await session.elements()
    expect(humanCheckReason(session.lastListing?.signals)).toBe("a block page")
    await session.open(`${url}help/bots.html`)
    expect(humanCheckReason(await session.signals())).toBe("the site's bot page")
    await session.open(url)
    expect(humanCheckReason(await session.signals())).toBeNull()
  }, 60_000)

  test("closing twice is not an error — the session may end after the user already closed it", async () => {
    await session.close()
    await session.close()
  }, 60_000)
})

test.if(!chrome)("SKIPPED: no Chrome on this machine — the driver was not exercised", () => {
  expect(chrome).toBeNull()
})
