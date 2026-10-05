import { describe, expect, test } from "bun:test"
import { parseInertiaProps, bindingHealth, readServerRender, stripMarkup, headingsFromHtml, collectStrings, decodeEntities } from "./page-render-read"

/**
 * These guard the middle tier of `iris pages verify` (#183716) against the failure it exists to
 * remove: an instrument that answers a weaker question than the one asked, in the same words.
 *
 * The motivating page is pathways-dashboard, where a stat row read 1,182 above a board reading
 * 16. Both numbers are FETCHED — neither appears in the stored JSON — so the #183704 fallback
 * called that page healthy. The server render carries the rows, and these tests pin that.
 */

/** Build a `data-page` document the way Blade escapes it. */
const inertia = (props: any) =>
  `<div id="app" data-page="${JSON.stringify({ component: "PublicPage/Render", props })
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;")}"></div>`

describe("parseInertiaProps", () => {
  test("reads the props back through Blade's escaping", () => {
    const props = parseInertiaProps(inertia({ page: { slug: "x" }, content: { components: [] } }))
    expect(props?.page?.slug).toBe("x")
  })

  test("no data-page is an ANSWER, not a crash — the page is bespoke", () => {
    expect(parseInertiaProps("<!DOCTYPE html><html><body><h1>hi</h1></body></html>")).toBeNull()
  })

  test("a malformed payload returns null rather than throwing", () => {
    expect(parseInertiaProps('<div data-page="{not json"></div>')).toBeNull()
  })
})

describe("bindingHealth", () => {
  test("an UNINJECTED dataset source is unresolved — this is the 1,182-vs-16 case", () => {
    // As stored. The injector never ran (or was refused), so the rows are not here and a
    // missing number says nothing about the page.
    const h = bindingHealth({ dataSources: [{ id: "cases", type: "dataset", schema: "pathways-cases" }], components: [] })
    expect(h.dataSources).toBe(1)
    expect(h.sourcesUnresolved).toBe(1)
    expect(h.rows).toBe(0)
    expect(h.complete).toBe(false)
  })

  test("the injector's rewrite to static+staticData IS the record of success", () => {
    // SsrDatasetInjector rewrites a resolved `dataset` source into a `static` one carrying its
    // rows. Nothing here has to guess whether injection happened — the shape says so.
    const h = bindingHealth({
      dataSources: [{ id: "cases", type: "static", staticData: [{ n: 1 }, { n: 2 }] }],
      components: [],
    })
    expect(h.sourcesResolved).toBe(1)
    expect(h.sourcesUnresolved).toBe(0)
    expect(h.rows).toBe(2)
    expect(h.complete).toBe(true)
  })

  test("an api source never resolves server-side and is counted as outstanding", () => {
    // The BROWSER fetches these. Counting one as resolved would turn an unknown into a ✗.
    const h = bindingHealth({ dataSources: [{ id: "live", type: "api", url: "/x" }], components: [] })
    expect(h.sourcesUnresolved).toBe(1)
    expect(h.complete).toBe(false)
  })

  test("a bound component with rows is resolved; one without is not", () => {
    const h = bindingHealth({
      components: [
        { type: "DataTable", props: { datasetSlug: "cases", data: [{ a: 1 }] } },
        { type: "DataTable", props: { datasetSlug: "denials" } },
      ],
    })
    expect(h.boundComponents).toBe(2)
    expect(h.componentsResolved).toBe(1)
    expect(h.componentsUnresolved).toBe(1)
    expect(h.rows).toBe(1)
    expect(h.complete).toBe(false)
  })

  test("a binding nested in a slot is found — flat prop bags included", () => {
    // Slot children are FLAT prop bags (the renderer does v-bind="child"). Reading only
    // `props` found no nested binding at all, and the injector recurses for that same reason.
    const h = bindingHealth({
      components: [{ type: "Grid", props: { slots: { default: [{ type: "DataTable", datasetSlug: "cases" }] } } }],
    })
    expect(h.boundComponents).toBe(1)
    expect(h.componentsUnresolved).toBe(1)
  })

  test("a page with no bindings at all is complete — absence there is a REAL absence", () => {
    const h = bindingHealth({ components: [{ type: "Hero", props: { title: "hi" } }] })
    expect(h.complete).toBe(true)
    expect(h.dataSources).toBe(0)
  })

  test("named datasets resolve through datasetsData", () => {
    const h = bindingHealth({
      components: [{ type: "MasterDetail", props: { datasets: { p: "projects" }, datasetsData: { p: { data: [{ x: 1 }, { x: 2 }] } } } }],
    })
    expect(h.componentsResolved).toBe(1)
    expect(h.rows).toBe(2)
  })
})

describe("readServerRender — composable", () => {
  test("INJECTED ROWS ARE IN THE TEXT (the whole point of this tier over stored JSON)", () => {
    const html = inertia({
      page: { title: "Caseload" },
      gateRequired: false,
      content: {
        components: [{ type: "StatTile", props: { label: "Open cases" } }],
        dataSources: [{ id: "cases", type: "static", staticData: [{ patient: "Rivera", status: "denied" }] }],
      },
    })
    const r = readServerRender(html)
    expect(r.lane).toBe("composable")
    expect(r.text).toContain("Open cases")
    // Stored JSON has none of this. A row value is exactly what the #183704 tier could not see.
    expect(r.text).toContain("Rivera")
    expect(r.bindings.rows).toBe(1)
    expect(r.bindings.complete).toBe(true)
  })

  test("markup inside a CustomHtml prop compares like rendered text", () => {
    const r = readServerRender(inertia({ content: { components: [{ type: "CustomHtml", props: { html: "<h2>The&nbsp;ladder</h2>" } }] } }))
    expect(r.text).toContain("The ladder")
  })

  test("the walk is greedy and that includes structural keys — recorded, not accidental", () => {
    // Component type names land in the haystack, so `--expect "DataTable"` would pass on a page
    // that never prints the word. Deliberate, and the same choice the stored-JSON tier makes:
    // narrowing the walk risks a MISSED prop, and a false negative here tells an author her text
    // is missing when it is on screen — a confident wrong statement about her own work. A false
    // positive on a component type name is a phrase nobody asserts.
    const r = readServerRender(inertia({ content: { components: [{ type: "DataTable", props: {} }] } }))
    expect(r.text).toContain("DataTable")
  })

  test("numbers in the payload survive — a stat is not always a string", () => {
    const r = readServerRender(inertia({ content: { components: [{ type: "StatTile", props: { value: 1182 } }] } }))
    expect(r.text).toContain("1182")
  })

  test("the gate is reported, not read as the page", () => {
    // A gated render returns lockedContentShell() — no components, no data sources. Every
    // ordinary success signal is present and the content is the gate's.
    const r = readServerRender(inertia({ gateRequired: true, gateBloqId: 570, content: { components: [] } }))
    expect(r.gated).toBe(true)
  })

  test("headings are declined rather than guessed", () => {
    // The payload holds components, not h-tags. Returning "probably a heading" props under the
    // name `headings` would be a different measurement wearing the same name.
    const r = readServerRender(inertia({ content: { components: [{ type: "Hero", props: { title: "Caseload" } }] } }))
    expect(r.headingsAvailable).toBe(false)
    expect(r.headings).toEqual([])
  })
})

describe("readServerRender — bespoke", () => {
  const HTML = `<!DOCTYPE html><html><head><title>The Harness</title><style>h1{text-transform:uppercase}</style></head>
<body><h1>The harness is not the moat</h1><p>Already shipping.</p><script>var x=1</script></body></html>`

  test("no data-page means public-html.blade served it — the finished document", () => {
    const r = readServerRender(HTML)
    expect(r.lane).toBe("bespoke")
    expect(r.title).toBe("The Harness")
    expect(r.text).toContain("The harness is not the moat")
    expect(r.text).toContain("Already shipping.")
  })

  test("script and style contents never enter the text layer", () => {
    const r = readServerRender(HTML)
    expect(r.text).not.toContain("var x=1")
    expect(r.text).not.toContain("text-transform")
  })

  test("real h-tags ARE available on this lane", () => {
    const r = readServerRender(HTML)
    expect(r.headingsAvailable).toBe(true)
    expect(r.headings).toEqual(["The harness is not the moat"])
  })

  test("a bespoke page has no bindings, so a miss is a real miss", () => {
    expect(readServerRender(HTML).bindings.complete).toBe(true)
  })
})

describe("stripMarkup / collectStrings", () => {
  test("collapses wrapped markup into a phrase a person would type", () => {
    expect(stripMarkup("<p>no user,\n   tenant\tor org</p>")).toBe("no user, tenant or org")
  })

  test("collects greedily — a missed prop would be a false 'your text is not there'", () => {
    expect(collectStrings({ a: "one", b: [{ c: "two" }], d: 3 })).toEqual(["one", "two", "3"])
  })

  test("headingsFromHtml ignores h4 and below", () => {
    expect(headingsFromHtml("<h1>a</h1><h3>b</h3><h4>c</h4>")).toEqual(["a", "b"])
  })
})

describe("decodeEntities", () => {
  // Measured on /p/patsy-resume: the stored copy carries &#x27;, &middot; and &mdash;. The
  // BROWSER tier reads innerText off a real DOM, where those are already characters — so
  // leaving them encoded here makes the two tiers disagree, and makes
  // --expect "Children's Hospital" fail on a page that plainly says it.
  test("hex numeric — the apostrophe that would break a typed phrase", () => {
    expect(decodeEntities("Texas Children&#x27;s Hospital")).toBe("Texas Children's Hospital")
  })

  test("decimal numeric", () => {
    expect(decodeEntities("Children&#39;s")).toBe("Children's")
  })

  test("the typography a bespoke page is written with", () => {
    expect(decodeEntities("Charge Nurse &middot; BSN &mdash; UTA&hellip;")).toBe("Charge Nurse · BSN — UTA…")
  })

  test("&amp; is decoded in the SAME pass, so &amp;lt; stays literal text", () => {
    // Decoding & first and then the rest would turn the escaped example `&lt;` in a code
    // sample into a real `<`, and strip everything after it as a tag on the next read.
    expect(decodeEntities("&amp;lt;div&amp;gt;")).toBe("&lt;div&gt;")
  })

  test("an unknown entity is left exactly as it was", () => {
    // A mangled character is worse than a visible &frac12; — and a needle typed off the page
    // will carry the same literal, so it still matches.
    expect(decodeEntities("half a &frac12; loaf")).toBe("half a &frac12; loaf")
  })

  test("stripMarkup decodes what it strips", () => {
    expect(stripMarkup("<p>Perioperative &amp; Pediatric&nbsp;Care</p>")).toBe("Perioperative & Pediatric Care")
  })

  test("inline markup does NOT become a space — the repro", () => {
    // Measured on /p/drex-cfo. Replacing every tag with a space gave "salary line ." and
    // --expect "salary line." failed on a page that says exactly that. A browser's innerText
    // inserts nothing here, and the browser tier is what this one has to agree with.
    expect(stripMarkup("<h1>Senior finance, without the <em>salary line</em>.</h1>")).toBe("Senior finance, without the salary line.")
  })

  test("block markup DOES separate — or two paragraphs weld into one word", () => {
    expect(stripMarkup("<p>one</p><p>two</p>")).toBe("one two")
    expect(stripMarkup("first<br>second")).toBe("first second")
  })

  test("an html comment is not a word", () => {
    expect(stripMarkup("<p>a<!-- note -->b</p>")).toBe("a b")
  })
})
