import { expect, test } from "bun:test"
import { isWritableTopKey, normaliseSetPath } from "./platform-pages"

// #186203 — `pages set` on a bespoke page refused css/html, and its hint (json_content.css) was
// stripped straight back to css: a loop that ended in "Done".
test("a bespoke page's html and css are writable top-level keys", () => {
  expect(isWritableTopKey("css", { html: "<p>", css: "" })).toBe(true)
  expect(isWritableTopKey("html", {})).toBe(true)
})

test("the json_content. prefix no longer leads to a refusal loop", () => {
  const { path } = normaliseSetPath("json_content.css")
  expect(isWritableTopKey(path, { html: "", css: "" })).toBe(true)
})

test("a key the page already has cannot be a dead key", () => {
  expect(isWritableTopKey("hero_note", { hero_note: "x" })).toBe(true)
})

test("an unknown key the page does NOT have is still refused (the #179802 dead-key guard stays)", () => {
  expect(isWritableTopKey("thumbnail_url", { components: [] })).toBe(false)
  expect(isWritableTopKey("thumbnail_url", null)).toBe(false)
})

test("dotted paths are nested writes and are not judged here", () => {
  expect(isWritableTopKey("components.0.props.title", {})).toBe(true)
})
