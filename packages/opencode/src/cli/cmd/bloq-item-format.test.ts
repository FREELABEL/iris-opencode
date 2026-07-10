import { describe, test, expect } from "bun:test"
import { itemTitle, itemContentPreview, matchesSearchQuery } from "./bloq-item-format"

// =============================================================================
// Bloq item rendering — regression for the `[object Object]` bug (IRIS bug)
// `bloqs get <id> --items` printed "[object Object]" for items whose `content`
// is a structured object (e.g. fleet vehicles with make/model/vin), and showed
// "(untitled)" even when a title lived inside that object.
// =============================================================================

describe("itemContentPreview", () => {
  test("string content is returned trimmed of newlines", () => {
    expect(itemContentPreview({ content: "hello\nworld" })).toBe("hello world")
  })

  test("object content does NOT render as [object Object]", () => {
    const item = { content: { make: "Volkswagen", model: "Tiguan", year: 2022, vin: "ABC123" } }
    const out = itemContentPreview(item)
    expect(out).not.toContain("[object Object]")
    expect(out).toContain("Volkswagen")
  })

  test("object content prefers a description-like field", () => {
    const item = { content: { description: "Top-trim AWD SUV", vin: "X" } }
    expect(itemContentPreview(item)).toBe("Top-trim AWD SUV")
  })

  test("null/undefined content yields empty string", () => {
    expect(itemContentPreview({ content: null })).toBe("")
    expect(itemContentPreview({})).toBe("")
  })

  test("respects max length", () => {
    expect(itemContentPreview({ content: "x".repeat(200) }, 50).length).toBe(50)
  })
})

describe("itemTitle", () => {
  test("uses explicit title when present", () => {
    expect(itemTitle({ title: "2022 VW Tiguan", content: {} })).toBe("2022 VW Tiguan")
  })

  test("falls back to content.title when top-level title is missing", () => {
    expect(itemTitle({ title: null, content: { title: "2022 VW Tiguan", vin: "X" } })).toBe("2022 VW Tiguan")
  })

  test("derives a title from string content when no title field exists", () => {
    expect(itemTitle({ content: "# Heading\nbody text" })).toBe("Heading body text")
  })

  test("falls back to (untitled) only when nothing usable exists", () => {
    expect(itemTitle({ content: { vin: "X" } })).toBe("(untitled)")
  })
})

// =============================================================================
// Bloq search matching — regression for IRIS bug #162208. A raw substring match
// treated the query as one contiguous string, so "Mayo Life Atlas" never matched
// the stored "MAYO — Life Atlas" (the em-dash broke the run). Tokenized AND fixes it.
// =============================================================================

describe("matchesSearchQuery", () => {
  test("natural name matches across a separator the DB stores (#162208)", () => {
    expect(matchesSearchQuery("MAYO — Life Atlas", "Mayo Life Atlas")).toBe(true)
  })

  test("is case-insensitive", () => {
    expect(matchesSearchQuery("MAYO — Life Atlas", "mayo")).toBe(true)
  })

  test("is word-order independent", () => {
    expect(matchesSearchQuery("MAYO — Life Atlas", "atlas mayo")).toBe(true)
  })

  test("requires ALL tokens to be present (AND, not OR)", () => {
    expect(matchesSearchQuery("MAYO — Life Atlas", "mayo spaceship")).toBe(false)
  })

  test("non-matching query returns false", () => {
    expect(matchesSearchQuery("MAYO — Life Atlas", "zzzznope")).toBe(false)
  })

  test("empty/whitespace query matches everything (no filter)", () => {
    expect(matchesSearchQuery("anything", "")).toBe(true)
    expect(matchesSearchQuery("anything", "   ")).toBe(true)
  })

  test("tolerates null/undefined haystack and query", () => {
    expect(matchesSearchQuery(undefined as any, "x")).toBe(false)
    expect(matchesSearchQuery("x", undefined as any)).toBe(true)
  })

  test("collapses runs of whitespace in the query", () => {
    expect(matchesSearchQuery("MAYO — Life Atlas", "  mayo   atlas  ")).toBe(true)
  })

  test("query characters are matched literally, not as a regex", () => {
    expect(matchesSearchQuery("C++ Runtime (v2)", "c++ v2")).toBe(true)
    expect(matchesSearchQuery("C++ Runtime (v2)", "c\\+\\+")).toBe(false)
  })

  test("matches across whitespace variants in the haystack (tab/newline)", () => {
    expect(matchesSearchQuery("Tab\tSeparated", "separated")).toBe(true)
    expect(matchesSearchQuery("Newline\nName", "newline name")).toBe(true)
  })

  test("NFC-normalizes so visually identical accents match regardless of composition", () => {
    const nfc = "café" // é as one codepoint
    const nfd = "café" // e + combining acute — looks identical
    expect(matchesSearchQuery(nfd, nfc)).toBe(true)
    expect(matchesSearchQuery(nfc, nfd)).toBe(true)
  })

  test("does NOT accent-fold (typo tolerance is Typesense's job, #162213)", () => {
    expect(matchesSearchQuery("café menu", "cafe")).toBe(false)
  })
})
