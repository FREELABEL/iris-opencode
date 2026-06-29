import { describe, test, expect } from "bun:test"
import { itemTitle, itemContentPreview } from "./bloq-item-format"

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
