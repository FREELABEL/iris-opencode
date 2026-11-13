import { describe, expect, test } from "bun:test"
import {
  VERBS,
  clampPageText,
  describeChange,
  errorPageReason,
  findInPage,
  humanCheckAdvice,
  humanCheckReason,
  listingFooter,
  looksIrreversible,
  normalizeDate,
  refuseNavigationReason,
  refuseOptionReason,
  refuseScrollReason,
  refuseTargetReason,
  refuseUrlReason,
  renderElements,
  renderInspect,
  shortHref,
  windowOfLines,
} from "./browser-verbs"

describe("VERBS", () => {
  test("S3 adds the acting verbs, in one place", () => {
    // Read-only through S1.1; click and type arrive here with compatibility, a gate on
    // irreversible labels, and a change verified in code.
    expect(VERBS).toEqual(["open", "read", "find", "window", "elements", "click", "type", "select", "press", "scroll", "screenshot", "close"])
  })
})

describe("findInPage", () => {
  const page = ["intro line", "kimi-k3 67 67 67 0", "middle", "another kimi-k3 row", "end"].join("\n")

  test("returns the matching lines with their line numbers", () => {
    // The verb this epic exists for. Measured 2026-09-21 on a 12,617-character page: shown the
    // first 3,000 characters, a model answered "not found" 0/3; given a way to SEARCH, 4/4.
    const r = findInPage(page, "kimi-k3")
    expect(r.matches).toBe(2)
    expect(r.text).toContain("line 2")
    expect(r.text).toContain("67 67 67")
  })

  test("says how many lines it searched when there is no match — never an empty string", () => {
    const r = findInPage(page, "minimax")
    expect(r.matches).toBe(0)
    expect(r.text).toContain("No match")
    expect(r.text).toContain("5 lines")
  })

  test("caps the hits and says how many it left out", () => {
    const many = Array.from({ length: 30 }, (_, i) => `row ${i} needle`).join("\n")
    const r = findInPage(many, "needle", { max: 8 })
    expect(r.matches).toBe(30)
    expect(r.text).toContain("22 more")
  })

  test("an empty query is a caller error, not a search of everything", () => {
    expect(() => findInPage(page, "   ")).toThrow()
  })
})

describe("clampPageText", () => {
  test("keeps a short page whole", () => {
    expect(clampPageText("short", 100)).toBe("short")
  })

  test("says the page was cut AND how big it was, so the agent knows to search instead", () => {
    // The bug this prevents: a truncated excerpt that does not announce itself reads as the
    // whole page, and a fact below the cut gets a confident "not found".
    const out = clampPageText("x".repeat(500), 100)
    expect(out.length).toBeLessThan(300)
    expect(out).toContain("truncated")
    expect(out).toContain("500")
    expect(out).toContain("find")
  })
})

describe("refuseUrlReason", () => {
  test("allows an ordinary public page", () => {
    expect(refuseUrlReason("https://heyiris.io/p/agent-model-benchmark")).toBeNull()
  })

  test("refuses credentials in the URL", () => {
    expect(refuseUrlReason("https://user:pw@example.com/")).toContain("credential")
  })

  for (const host of [
    "http://127.0.0.1:8080/",
    "http://localhost:3000/",
    "http://10.1.2.3/",
    "http://192.168.1.10/",
    "http://172.16.4.5/",
    "http://[::1]:9222/",
    "http://printer.local/",
  ]) {
    test(`refuses the private host ${host}`, () => {
      expect(refuseUrlReason(host)).toContain("private")
    })
  }

  test("refuses the cloud metadata address by name", () => {
    // 169.254.169.254 hands out cloud credentials to anything that asks. It is link-local, so
    // a range check catches it — but it is named so the refusal says what it protected.
    expect(refuseUrlReason("http://169.254.169.254/latest/meta-data/")).toContain("metadata")
  })

  for (const url of ["file:///etc/passwd", "data:text/html,<b>x", "javascript:alert(1)", "chrome://settings"]) {
    test(`refuses the non-web scheme ${url.slice(0, 12)}`, () => {
      expect(refuseUrlReason(url)).toContain("http")
    })
  }

  test("refuses a private host even when it is reached by a public-looking name", () => {
    expect(refuseUrlReason("http://0.0.0.0/")).toContain("private")
  })
})

describe("refuseNavigationReason", () => {
  test("allows a link inside the page the agent opened", () => {
    expect(refuseNavigationReason("https://heyiris.io/p/a", "https://heyiris.io/p/b")).toBeNull()
  })

  test("refuses a jump to another origin — the page does not get to choose where we go", () => {
    // Page text is untrusted input. Without this, a visited page can walk the agent anywhere.
    expect(refuseNavigationReason("https://heyiris.io/p/a", "https://evil.example/x")).toContain("origin")
  })

  test("refuses a private host even from a page that is allowed", () => {
    expect(refuseNavigationReason("https://heyiris.io/p/a", "http://127.0.0.1/")).toContain("private")
  })
})

describe("findInPage inside a table", () => {
  // Measured in the app on 2026-09-24, first real use: eleven browser calls to answer one
  // question, then a fallback to webfetch. `find` returned the row — `kimi-k3 67 67 67 0` —
  // with no column headers, so the agent could not tell WHICH 67 was the Mean and spent the
  // next six calls hunting for the header row. A matched table row now carries its header.
  const table = [
    "Some prose above the table",
    "MODEL\tFLOOR\tMEAN\tPEAK\tSPREAD",
    "hy3\t64\t81\t100\t36",
    "kimi-k3\t67\t67\t67\t0",
  ].join("\n")

  test("returns the header row with a match inside a table", () => {
    const r = findInPage(table, "kimi-k3")
    expect(r.text).toContain("MEAN")
    expect(r.text).toContain("header")
  })

  test("does not invent a header for ordinary prose", () => {
    const r = findInPage("one\ntwo needle\nthree", "needle")
    expect(r.text).not.toContain("header")
  })

  test("takes the nearest header above the match, not the first in the page", () => {
    const two = [
      "A\tB",
      "1\t2",
      "prose between",
      "MODEL\tMEAN",
      "kimi-k3\t67",
    ].join("\n")
    const r = findInPage(two, "kimi-k3")
    expect(r.text).toContain("MODEL")
    expect(r.text).not.toContain("header: A")
  })
})

describe("windowOfLines", () => {
  const doc = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join("\n")

  test("reads a window around a line number, so a hit can be zoomed into", () => {
    // The other half of the eleven calls: find returns line numbers, and there was no way to
    // say "show me around line 140" — so the agent re-read the whole page with a bigger budget.
    const r = windowOfLines(doc, 140, 3)
    expect(r).toContain("line 137")
    expect(r).toContain("line 143")
    expect(r).not.toContain("line 120")
  })

  test("clamps at the top and bottom instead of failing", () => {
    expect(windowOfLines(doc, 1, 5)).toContain("line 1")
    expect(windowOfLines(doc, 200, 5)).toContain("line 200")
  })

  test("refuses a line number the page does not have", () => {
    expect(() => windowOfLines(doc, 9999, 3)).toThrow()
  })
})

describe("S3 — the element table", () => {
  const raw = [
    { ref: 1, role: "link", name: "Home", tag: "a", enabled: true, inViewport: true },
    { ref: 2, role: "textbox", name: "Search", tag: "input", value: "", enabled: true, inViewport: true },
    { ref: 3, role: "button", name: "Delete account", tag: "button", enabled: true, inViewport: false },
    { ref: 4, role: "button", name: "Disabled thing", tag: "button", enabled: false, inViewport: true },
  ]

  test("renders one numbered line per element, with what it is and what it says", () => {
    const t = renderElements(raw)
    expect(t).toContain("[1] link")
    expect(t).toContain("Home")
    expect(t).toContain("[2] textbox")
  })

  test("marks what is off-screen and what is disabled, instead of hiding them", () => {
    const t = renderElements(raw)
    expect(t).toContain("off-screen")
    expect(t).toContain("disabled")
  })
})

describe("S3 — a target must be compatible with the operation", () => {
  const els = [
    { ref: 1, role: "link", name: "Home", tag: "a", enabled: true, inViewport: true },
    { ref: 2, role: "textbox", name: "Search", tag: "input", value: "", enabled: true, inViewport: true },
    { ref: 9, role: "button", name: "Off", tag: "button", enabled: false, inViewport: true },
  ]

  test("clicking a text field is refused by TYPE, not by prompt", () => {
    // The property worth having: a target head that only contains compatible elements makes the
    // wrong pick structurally impossible rather than discouraged.
    expect(refuseTargetReason(els, 2, "click")).toContain("not clickable")
    expect(refuseTargetReason(els, 1, "click")).toBeNull()
  })

  test("typing into a link is refused", () => {
    expect(refuseTargetReason(els, 1, "type")).toContain("not a text field")
    expect(refuseTargetReason(els, 2, "type")).toBeNull()
  })

  test("a ref the page does not have is refused with the count, not a silent no-op", () => {
    expect(refuseTargetReason(els, 42, "click")).toContain("3 elements")
  })

  test("a disabled element is refused", () => {
    expect(refuseTargetReason(els, 9, "click")).toContain("disabled")
  })
})

describe("S3 — irreversible clicks are gated", () => {
  test("a destructive label needs confirm", () => {
    // The page is untrusted input, and a click cannot be undone. This is the cheap half of a risk
    // gate: the agent must say it meant it, and the user sees which word triggered the gate.
    expect(looksIrreversible("Delete account")).toBe(true)
    expect(looksIrreversible("Pay $420 now")).toBe(true)
    expect(looksIrreversible("Send message")).toBe(true)
    expect(looksIrreversible("Confirm transfer")).toBe(true)
  })

  test("ordinary navigation is not gated", () => {
    expect(looksIrreversible("Home")).toBe(false)
    expect(looksIrreversible("Next page")).toBe(false)
    expect(looksIrreversible("Search")).toBe(false)
  })

  // The stress test's list (#193355): booking words went through free, list/field words asked.
  // Every real pay / submit / send-message gate stays.
  const ASK = [
    "Book now", "Book", "Book flight", "Reserve", "Reserve now", "Complete booking", "Confirm booking",
    "Complete reservation", "Make a reservation", "Cancel booking",
    "Purchase", "Place order", "Pay now", "Pay $420 now", "Buy now", "Checkout", "Submit", "Submit order",
    "Send message", "Send", "Send money", "Confirm", "Confirm and pay", "Confirm transfer", "Delete account",
    "Remove", "Archive", "Publish", "Post", "Unsubscribe", "Sign out", "Order now",
    // a harmless phrase does not launder a real commit word next to it
    "Confirm dates and pay", "Send code and book",
  ]
  const FREE = [
    "Sort order", "Order history", "Order status", "Track your order", "View orders", "Confirm dates", "Confirm selection",
    "Send code", "Send verification code", "Resend code", "Post code", "Postcode", "Postal code",
    "Continue to payment", "Cancel", "Home", "Search flights", "Booking details", "Bookings", "Reservations",
    "Address book", "Facebook", "Reserved seating",
  ]
  test.each(ASK)("asks before %p", (label) => expect(looksIrreversible(label)).toBe(true))
  test.each(FREE)("does not ask before %p", (label) => expect(looksIrreversible(label)).toBe(false))
})

describe("a date as a date field takes it (#193355)", () => {
  test.each([
    ["12/10/2026", "2026-12-10"],
    ["1/5/26", "2026-01-05"],
    ["2026-12-10", "2026-12-10"],
    ["2026/12/10", "2026-12-10"],
    ["25/12/2026", "2026-12-25"],
    ["12.10.2026", "2026-12-10"],
    ["December 10, 2026", "2026-12-10"],
    ["Dec 10 2026", "2026-12-10"],
    ["10 December 2026", "2026-12-10"],
    ["Thu, Dec 10th, 2026", "2026-12-10"],
  ])("%p → %p", (text, iso) => expect(normalizeDate(text)).toBe(iso))
  test.each(["next friday", "13/13/2026", "2/30/2026", "", "Phoenix"])("%p is not a date", (text) => expect(normalizeDate(text)).toBeNull())
})

describe("bot checks and block pages are named, and handed to the person (#193355)", () => {
  const page = { url: "https://site.test/", title: "Flights", heading: "Flights", text: "Find cheap flights", textLength: 5000, frames: [], cfChallenge: false, blockWidget: false }
  test.each([
    [{ title: "Just a moment..." }, "a Cloudflare check"],
    [{ cfChallenge: true }, "a Cloudflare check"],
    [{ frames: ["https://geo.captcha-delivery.com/captcha/?x=1"] }, "a DataDome check"],
    [{ text: "Press & Hold to confirm you are a human", textLength: 200 }, "a PerimeterX check"],
    [{ url: "https://www.kayak.com/help/bots.html" }, "the site's bot page"],
    [{ title: "Bot or Not?", heading: "Bot or Not?" }, "a block page"],
    [{ title: "Access Denied" }, "a block page"],
    [{ heading: "Sorry, you have been blocked", textLength: 400 }, "a block page"],
    [{ text: "", textLength: 0, frames: ["https://www.google.com/recaptcha/api2/anchor"] }, "a captcha"],
    [{ blockWidget: true }, "a human check"],
  ])("%p is %p", (over, kind) => expect(humanCheckReason({ ...page, ...over })).toBe(kind))

  test("a real page is not one, even one that mentions captchas or blocking", () => {
    expect(humanCheckReason(page)).toBeNull()
    expect(humanCheckReason({ ...page, heading: "Blocked dates", text: "These dates are blocked" })).toBeNull()
    expect(humanCheckReason({ ...page, title: "Blocked dates | Calendar", textLength: 100 })).toBeNull()
    expect(humanCheckReason({ ...page, title: "Attention Required! | Cloudflare" })).toBe("a Cloudflare check")
    expect(humanCheckReason({ ...page, title: "Access Denied - Hertz" })).toBe("a block page")
    expect(humanCheckReason({ ...page, frames: ["https://www.google.com/recaptcha/api2/anchor"] })).toBeNull()
    expect(humanCheckReason(null)).toBeNull()
  })

  test("the advice hands it to the person and never to a workaround", () => {
    for (const target of ["agent", "panel"] as const) {
      const a = humanCheckAdvice("a Cloudflare check", target)
      expect(a).toContain("for a PERSON")
      expect(a).toContain("do not click, solve")
      expect(a).toContain("do not switch browsers")
    }
    expect(humanCheckAdvice("x", "panel")).toContain("finish the check in the Browser")
  })
})

describe("a pop-up's listing says what is behind it, and a covered control says what covers it (#193355)", () => {
  test("footer counts what is behind a blocking pop-up", () => {
    const l = { total: 3, matched: 3, above: 0, below: 0, behind: 220 }
    expect(listingFooter(3, l)).toContain("220 more controls are BEHIND the pop-up")
    expect(listingFooter(3, { ...l, behind: undefined })).toBe("")
  })

  test("a covered row names the cover", () => {
    const t = renderElements([{ ref: 1, role: "button", name: "Search flights", tag: "button", enabled: true, inViewport: true, covered: "Accept cookies" }])
    expect(t).toContain('covered by "Accept cookies"')
  })
})

describe("S3 — the change is verified in code, not asserted by the model", () => {
  const before = { url: "https://x.test/a", title: "A", textLength: 1000, textHash: "aaa", values: { "2": "" } }

  test("reports a navigation", () => {
    const after = { ...before, url: "https://x.test/b", title: "B", textHash: "bbb" }
    const s = describeChange(before, after)
    expect(s).toContain("https://x.test/b")
    expect(s).toContain("title")
  })

  test("reports a field that now holds what was typed", () => {
    const after = { ...before, values: { "2": "kimi" } }
    expect(describeChange(before, after)).toContain("kimi")
  })

  test("says plainly when NOTHING changed — the most useful answer after a click", () => {
    // "DONE is never independent evidence of success". A click that changed nothing is the case a
    // model is most likely to narrate as success.
    expect(describeChange(before, { ...before })).toContain("nothing changed")
  })
})

describe("S3.1 — select and scroll", () => {
  const els = [
    { ref: 1, role: "combobox", name: "Round", tag: "select", value: "01", enabled: true, inViewport: true, options: ["01", "02", "03"] },
    { ref: 2, role: "button", name: "Go", tag: "button", enabled: true, inViewport: true },
  ]

  test("select refuses a target that is not a dropdown", () => {
    expect(refuseTargetReason(els, 2, "select")).toContain("not a dropdown")
    expect(refuseTargetReason(els, 1, "select")).toBeNull()
  })

  test("select refuses an option the dropdown does not have — and lists what it does have", () => {
    // A picker that cannot invent is the property worth keeping: the option set is closed, so a
    // wrong value is a refusal with the real choices, not a silent no-op on the page.
    const why = refuseOptionReason(els, 1, "99")
    expect(why).toContain("01")
    expect(why).toContain("02")
    expect(refuseOptionReason(els, 1, "02")).toBeNull()
  })

  test("the element table shows a dropdown's options, so a choice can be made from the menu", () => {
    expect(renderElements(els)).toContain("options: 01, 02, 03")
  })

  test("scroll takes a direction, and says what it will not take", () => {
    expect(refuseScrollReason("down")).toBeNull()
    expect(refuseScrollReason("up")).toBeNull()
    expect(refuseScrollReason("bottom")).toBeNull()
    expect(refuseScrollReason("sideways")).toContain("up, down, top, bottom")
  })
})

describe("dropdowns show what each option MEANS (Vonlane: '30' is Austin)", () => {
  const el = {
    ref: 12, role: "combobox", name: "source", tag: "select", enabled: true, inViewport: true,
    options: ["", "29", "30", "14"],
    optionLabels: ["Where are you starting?", "Austin-Arboretum: DoubleTree Northwest", "Austin: DoubleTree University Area", "Fort Worth: Hilton"],
  }
  test("elements lists the value with its words", () => {
    expect(renderElements([el])).toContain('30 "Austin: DoubleTree University Area"')
  })
  test("the words a person sees choose the option too", () => {
    expect(refuseOptionReason([el], 12, "Fort Worth: Hilton")).toBeNull()
    expect(refuseOptionReason([el], 12, "30")).toBeNull()
    expect(refuseOptionReason([el], 12, "Dallas")).toContain('14 "Fort Worth: Hilton"')
  })
})

describe("what an element IS (#193242)", () => {
  test("rows say where they lead, their ids and whether a choice is checked", () => {
    const out = renderElements(
      [
        { ref: 1, role: "link", name: "Engineer", tag: "a", enabled: true, inViewport: true, href: "https://www.indeed.com/viewjob?jk=abc", ids: { "data-jk": "abc" } },
        { ref: 2, role: "radio", name: "Hemp Protein", tag: "input", enabled: true, inViewport: true, checked: false, inDialog: true },
      ],
      "https://www.indeed.com/jobs?q=ai",
    )
    expect(out).toContain("A pop-up is open")
    expect(out).toContain("→ /viewjob?jk=abc · data-jk=abc")
    expect(out).toContain("Hemp Protein  · not checked")
  })

  test("other sites' links stay whole; long ones are cut", () => {
    expect(shortHref("https://b.com/x", "https://a.com/")).toBe("https://b.com/x")
    expect(shortHref("https://a.com/" + "x".repeat(200), "https://a.com/").length).toBe(120)
  })

  test("inspect gives real links with their source, and never makes one from an id", () => {
    const base = { tag: "button", attributes: { "aria-label": "full details" }, ancestors: [{ tag: "li", ids: { "data-jk": "abc" } }], page: "https://www.indeed.com/jobs" }
    const found = renderInspect(3, { ...base, ids: { "data-jk": "abc" }, links: [{ url: "https://www.indeed.com/viewjob?jk=abc", source: "card-anchor", where: "a link in the same card" }] })
    expect(found).toContain("https://www.indeed.com/viewjob?jk=abc  · card-anchor")
    const idOnly = renderInspect(3, { ...base, ids: { "data-jk": "abc" }, links: [] })
    expect(idOnly).toContain("links: none")
    expect(idOnly).toContain("Don't build a link from an id")
    expect(idOnly).not.toContain("viewjob")
  })
})

describe("#193442 — a step that lands on an error page says FAILED, not progress", () => {
  const before = { url: "https://www.google.com/travel/flights/booking?tfs=x", title: "Google Flights", textLength: 9000, textHash: "a", values: {} }

  test("Google's 404 after 'Continue to book' (2026-11-13, twice) is a failure with a way forward", () => {
    const after = {
      url: "https://www.google.com/travel/clk/f?t=1794549600000",
      title: "Error 404 (Not Found)!!1",
      textLength: 160,
      textHash: "b",
      values: {},
      head: "404. That’s an error. The requested URL /travel/clk/f was not found on this server. That’s all we know.",
    }
    const s = describeChange(before, after)
    expect(s.startsWith("FAILED")).toBeTrue()
    expect(s).toContain("404")
    expect(s).toContain("Do not repeat the same step")
  })

  test("real pages are not error pages: an article about 404s, a price of $404, a long page", () => {
    expect(errorPageReason({ ...before, title: "How to fix a 404 error", textLength: 8000, head: "404 errors happen when" })).toBeUndefined()
    expect(errorPageReason({ ...before, title: "Select flights", textLength: 900, head: "Basic $404 Choice $439" })).toBeUndefined()
    expect(errorPageReason({ ...before, title: "Southwest Airlines", textLength: 20000, head: "Something went wrong? Contact us" })).toBeUndefined()
  })

  test("a page that was already showing stays as it was: only a step that MOVED the page is judged", () => {
    const bad = { ...before, title: "Error 404 (Not Found)", textLength: 100, head: "404 not found" }
    expect(describeChange(bad, { ...bad, textHash: "c" })).not.toContain("FAILED")
  })

  test("other error shapes: a 503, 'page not found', a blank page", () => {
    expect(errorPageReason({ ...before, title: "503 Service Unavailable", textLength: 50, head: "" })).toContain("503")
    expect(errorPageReason({ ...before, title: "Oops", textLength: 200, head: "Sorry, this page not found." })).toBeDefined()
    expect(errorPageReason({ ...before, title: "", textLength: 0, head: "" })).toBe("a blank page")
  })
})
