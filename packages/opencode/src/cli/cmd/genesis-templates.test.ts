import { describe, expect, test } from "bun:test"
import { briefQuestions, findTemplate, parseTemplateCatalogue } from "./genesis-templates"

const page = (bindings: unknown) =>
  `<html><head><script type="application/json" id="iris-bindings">${JSON.stringify(bindings)}</script></head><body></body></html>`

describe("genesis template catalogue (#188411)", () => {
  test("reads rows from the gallery page's bindings, flattening {data: …} records, ordered", () => {
    const rows = parseTemplateCatalogue(
      page({
        templates: {
          data: [
            { data: { slug: "genesis-template-b", name: "b", order: 2 } },
            { slug: "genesis-template-a", name: "a", order: 1 },
            { data: { name: "no slug — dropped" } },
          ],
        },
      }),
    )
    expect(rows.map((r) => r.slug)).toEqual(["genesis-template-a", "genesis-template-b"])
  })

  test("a page without bindings, or with broken JSON, is an empty catalogue, not a crash", () => {
    expect(parseTemplateCatalogue("<html></html>")).toEqual([])
    expect(parseTemplateCatalogue('<script id="iris-bindings">{not json</script>')).toEqual([])
  })

  test("a template can be named by slug, short name, or display name", () => {
    const rows = [{ slug: "genesis-template-measured", name: "Measured results" }]
    expect(findTemplate(rows, "genesis-template-measured")?.slug).toBe("genesis-template-measured")
    expect(findTemplate(rows, "measured")?.slug).toBe("genesis-template-measured")
    expect(findTemplate(rows, "Measured results")?.slug).toBe("genesis-template-measured")
    expect(findTemplate(rows, "nope")).toBeUndefined()
  })

  test("the brief is one question per line, numbering and bullets stripped", () => {
    expect(briefQuestions({ slug: "x", name: "x", brief: "1. What is measured?\n- Who reads it?\n\n  Why now? " })).toEqual([
      "What is measured?",
      "Who reads it?",
      "Why now?",
    ])
  })
})
