import { describe, expect, test } from "bun:test"
import { recipeTitle, injectTitle, nearestCategory, validateRecipeMeta } from "./platform-howto"

/**
 * Six recipes were published to the PUBLIC index titled after their own filenames.
 *
 * Adding front-matter as `---\n…\n---\n\n# Real Title` leaves a blank line where the title
 * reader looked — it took `lines[0]` literally — so the title fell through to the slug.
 * Nothing errored, nothing warned; the cards just went out wrong, and the real title was
 * one line below the whole time.
 */
describe("recipeTitle", () => {
  test("a blank line after front-matter does not cost the title", () => {
    expect(recipeTitle(undefined, "\n# Page privacy — who can see a Genesis page\n\nbody", "page-privacy")).toBe(
      "Page privacy — who can see a Genesis page",
    )
  })

  test("no blank line works the same way", () => {
    expect(recipeTitle(undefined, "# Evaluate an AI writer\n\nbody", "article-evals")).toBe("Evaluate an AI writer")
  })

  test("front-matter title wins over the heading", () => {
    expect(recipeTitle("Declared Title", "# Heading", "slug")).toBe("Declared Title")
  })

  test("the slug is the LAST resort, not the second", () => {
    expect(recipeTitle(undefined, "\n\n\n", "spreadsheets-excel-and-csv")).toBe("spreadsheets-excel-and-csv")
  })

  test("deeper headings are unwrapped too", () => {
    expect(recipeTitle(undefined, "\n## Sub heading", "s")).toBe("Sub heading")
  })
})

describe("injectTitle — never above the front-matter", () => {
  const FM = "---\ncategory: Data & Atlas\n---\n# Real Title\n\nbody\n"

  test("front-matter stays first, so it still parses", () => {
    expect(injectTitle(FM, null, "some-name").startsWith("---\n")).toBe(true)
  })

  test("a recipe that already has a heading is left alone", () => {
    expect(injectTitle(FM, null, "some-name")).toBe(FM)
  })

  test("front-matter with no heading gets one AFTER the closing delimiter", () => {
    const out = injectTitle("---\ncategory: Finance\n---\nbody text\n", null, "my-recipe")
    expect(out.startsWith("---\n")).toBe(true)
    expect(out).toContain("# How to: my recipe")
    expect(out.indexOf("---\ncategory")).toBeLessThan(out.indexOf("# How to:"))
  })

  test("no front-matter and no heading still gets a title", () => {
    expect(injectTitle("just body\n", null, "my-recipe")).toStartWith("# How to: my recipe")
  })

  test("malformed front-matter is left untouched rather than made worse", () => {
    const broken = "---\ncategory: Finance\nbody with no closing delimiter\n"
    expect(injectTitle(broken, null, "x")).toBe(broken)
  })
})

describe("category validation catches it where ONE person can fix it", () => {
  test("a known-good category passes", () => {
    expect(validateRecipeMeta("s", { category: "Data & Atlas" })).toEqual([])
  })

  test("an unknown category is named, not swallowed", () => {
    expect(validateRecipeMeta("s", { category: "Integrations" })[0]).toContain("unknown category")
  })

  test("the near-miss points somewhere instead of printing the list and walking away", () => {
    expect(nearestCategory("Integrations")).toBe("Infrastructure")
    expect(nearestCategory("Building")).toBe("Pages & Design")
    expect(nearestCategory("DevOps")).toBe("Infrastructure")
    // A real category always beats an alias.
    expect(nearestCategory("Finance")).toBe("Finance")
    // And genuine nonsense still gets null rather than a confident wrong answer.
    expect(nearestCategory("zzzqqq")).toBeNull()
  })
})
