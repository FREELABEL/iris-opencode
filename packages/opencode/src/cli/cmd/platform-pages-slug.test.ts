import { describe, expect, test } from "bun:test"
import { normalizeSlugArg } from "./platform-pages"

/**
 * `pages pull` writes ./pages/<slug>.json, so handing that path back to `push` is the
 * obvious next move — and it used to build ./pages/pages/<slug>.json.json, report
 * "Local file not found", and advise running the `pull` that had just produced the file.
 * The one thing the error never said was that the argument is a slug.
 */
describe("normalizeSlugArg", () => {
  test("leaves a real slug untouched and reports no correction", () => {
    for (const slug of ["my-page", "ai2-vanguard-summit-day1", "a", "page_2026"]) {
      expect(normalizeSlugArg(slug)).toEqual({ slug, corrected: false })
    }
  })

  test("accepts the path that pull just wrote (the repro)", () => {
    expect(normalizeSlugArg("pages/ai2-vanguard-summit-day1.json")).toEqual({
      slug: "ai2-vanguard-summit-day1",
      corrected: true,
    })
  })

  test("accepts the other shapes a shell produces", () => {
    expect(normalizeSlugArg("./pages/my-page.json")).toEqual({ slug: "my-page", corrected: true })
    expect(normalizeSlugArg("my-page.json")).toEqual({ slug: "my-page", corrected: true })
    expect(normalizeSlugArg("/abs/path/to/pages/my-page.json")).toEqual({ slug: "my-page", corrected: true })
  })

  test("trims stray whitespace WITHOUT claiming a correction", () => {
    // `corrected` drives a user-facing "I read your path as a slug" note. Whitespace is
    // not a path mistake, and announcing it would be noise, so it must not set the flag.
    expect(normalizeSlugArg("  my-page  ")).toEqual({ slug: "my-page", corrected: false })
  })

  test("only strips a trailing .json, not a slug that merely contains the letters", () => {
    // A slug is allowed to contain "json" — stripping on substring would corrupt it.
    expect(normalizeSlugArg("json-schema-guide")).toEqual({ slug: "json-schema-guide", corrected: false })
    expect(normalizeSlugArg("my-json")).toEqual({ slug: "my-json", corrected: false })
  })

  test("strips exactly one extension, so a doubled suffix stays visibly wrong", () => {
    // Guards the old bug's own output shape: if someone pastes the mangled path back,
    // we must not quietly "fix" it into a slug that was never real.
    expect(normalizeSlugArg("pages/my-page.json.json")).toEqual({ slug: "my-page.json", corrected: true })
  })
})
