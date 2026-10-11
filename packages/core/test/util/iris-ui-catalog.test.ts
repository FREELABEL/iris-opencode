import { describe, expect, test } from "bun:test"
import { CATALOG, SpecError, specDocument, validateSpec } from "../../src/util/iris-ui-catalog"

// #188930 gap #1 — the model picks parts; a spec the runtime cannot draw never reaches the frame.

const ok =
  (nodes: unknown, bound: string[] = ["plans"]) =>
  () =>
    validateSpec(nodes, bound)
const bad = (nodes: unknown, re: RegExp, bound: string[] = ["plans"]) =>
  expect(() => validateSpec(nodes, bound)).toThrow(re)

describe("validateSpec", () => {
  test("a well-formed answer passes", () => {
    expect(
      ok([
        { type: "Heading", props: { text: "Plans" } },
        {
          type: "Row",
          children: [
            { type: "Stat", props: { label: "Plans", value: { from: "plans", field: "price", agg: "count" } } },
            { type: "Stat", props: { label: "Monthly", formula: "seats * 29", prefix: "$" } },
          ],
        },
        { type: "Slider", props: { name: "seats", min: 1, max: 50, value: 15 } },
        { type: "Table", props: { from: "plans", columns: ["plan", { field: "price", label: "$/mo" }], search: true } },
        { type: "BarChart", props: { from: "plans", x: "plan", y: "price" } },
      ]),
    ).not.toThrow()
  })
  test("an unknown component names the catalog", () => bad([{ type: "Iframe" }], /unknown component "Iframe".*Table/))
  test("from must be a binding", () =>
    bad([{ type: "Table", props: { from: "secrets" } }], /from "secrets" is not a binding\. Bound: plans/))
  test("Table and BarChart need from", () => bad([{ type: "Table", props: {} }], /Table needs from/))
  test("a formula is arithmetic over slider names only", () => {
    bad([{ type: "Stat", props: { formula: "fetch('x')" } }], /only numbers, slider names/)
    bad([{ type: "Stat", props: { formula: "window.top" } }], /only numbers, slider names/)
    bad([{ type: "Stat", props: { formula: "seats * 2" } }], /"seats", which no Slider defines/)
  })
  test("a slider declared AFTER the stat still counts", () =>
    expect(
      ok([
        { type: "Stat", props: { formula: "n * 2" } },
        { type: "Slider", props: { name: "n" } },
      ]),
    ).not.toThrow())
  test("links are https only", () => bad([{ type: "Link", props: { href: "javascript:alert(1)" } }], /https:\/\//))
  test("agg is from the list", () =>
    bad([{ type: "Stat", props: { value: { from: "plans", field: "x", agg: "median" } } }], /agg must be one of/))
  test("empty or non-array is refused", () => {
    bad([], /non-empty array/)
    bad({ type: "Text" }, /non-empty array/)
  })
  test("errors are SpecError", () => {
    try {
      validateSpec([{ type: "Nope" }], [])
    } catch (e) {
      expect(e).toBeInstanceOf(SpecError)
    }
  })
})

describe("specDocument", () => {
  test("the spec is inert JSON — a value cannot close its script element", () => {
    const doc = specDocument([{ type: "Text", props: { text: "</script><script>alert(1)</script>" } }], "t")
    expect(doc.match(/<\/script>/g)?.length).toBe(2)
  })
  test("the title is escaped", () =>
    expect(specDocument([{ type: "Text", props: { text: "x" } }], '<b>"x"</b>')).toContain(
      "&lt;b&gt;&quot;x&quot;&lt;/b&gt;",
    ))
  test("the runtime never evaluates strings as code and never parses data as HTML", () => {
    const doc = specDocument([{ type: "Text", props: { text: "x" } }], "t")
    expect(doc).not.toMatch(/\beval\(|new Function|innerHTML/)
  })
  test("every catalog entry has a renderer in the runtime", () => {
    const doc = specDocument([{ type: "Text", props: { text: "x" } }], "t")
    for (const name of Object.keys(CATALOG)) expect(doc).toContain(`${name}:function(`)
  })
})
