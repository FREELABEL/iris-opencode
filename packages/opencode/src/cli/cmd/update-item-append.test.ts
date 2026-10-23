import { describe, expect, test } from "bun:test"
import { contentIsText, planContentEdit } from "./platform-bloqs"

// 2026-10-08: `update-item --merge` onto five markdown bodies replaced each with the merged keys.
describe("update-item --append / --merge guard", () => {
  test("markdown is text; JSON maps, lists and empty content are not", () => {
    expect(contentIsText("**Owner's ask:** templates\n\n## Plan")).toBe(true)
    expect(contentIsText('"a json string"')).toBe(true)
    expect(contentIsText('{"rate_cents":7900}')).toBe(false)
    expect(contentIsText("[1,2]")).toBe(false)
    expect(contentIsText("")).toBe(false)
    expect(contentIsText(null)).toBe(false)
  })
  test("--merge onto a text body is refused before anything is sent", () => {
    expect(planContentEdit("## Epic body", { merge: true })).toHaveProperty("error")
    expect(planContentEdit('{"a":1}', { merge: true })).toEqual({})
    expect(planContentEdit(null, { merge: true })).toEqual({})
  })
  test("--append keeps the body and adds a paragraph after it", () => {
    expect(planContentEdit("Body.\n\n", { append: "## Shipped\n\nv1.3.317" })).toEqual({ content: "Body.\n\n## Shipped\n\nv1.3.317" })
    expect(planContentEdit(null, { append: "first" })).toEqual({ content: "first" })
  })
  test("--append onto a fields item is refused rather than turning the map into text", () => {
    expect(planContentEdit('{"rate_cents":7900}', { append: "note" })).toHaveProperty("error")
    expect(planContentEdit("Body", { append: "   " })).toHaveProperty("error")
  })
})
