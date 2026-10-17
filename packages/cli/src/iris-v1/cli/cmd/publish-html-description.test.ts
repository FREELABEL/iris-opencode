import { describe, expect, test } from "bun:test"
import { parseHtmlDocument } from "./platform-pages"

// #188610: the restaurant template went live described as "Tonight".
describe("publish-html reads the whole meta description", () => {
  test("an apostrophe inside a double-quoted value does not end it", () => {
    const d = parseHtmlDocument(`<html><head><meta name="description" content="Tonight's menu, and what's left"></head><body></body></html>`)
    expect(d.description).toBe("Tonight's menu, and what's left")
  })
  test("a double quote inside a single-quoted value does not end it", () => {
    const d = parseHtmlDocument(`<head><meta name='description' content='The "chef" table is back'></head>`)
    expect(d.description).toBe(`The "chef" table is back`)
  })
  test("plain values still work, and no description is null", () => {
    expect(parseHtmlDocument(`<meta name="description" content="Plain.">`).description).toBe("Plain.")
    expect(parseHtmlDocument(`<title>x</title>`).description).toBeNull()
  })
})
