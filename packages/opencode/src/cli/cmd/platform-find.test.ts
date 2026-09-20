import { expect, test } from "bun:test"
import { phraseIn } from "./platform-find"

test("synonyms match whole words, not substrings (website ≠ site, SiteFooter ≠ site)", () => {
  expect(phraseIn("build me a site", "site")).toBe(true)
  expect(phraseIn("find people from my website", "site")).toBe(false)
  expect(phraseIn("SiteFooter validation error", "site")).toBe(false)
  expect(phraseIn("then email them and book calls", "book calls")).toBe(true)
})

test("phrases with regex characters are matched literally", () => {
  expect(phraseIn("update agents.md for cursor", "agents.md")).toBe(true)
  expect(phraseIn("update agentsXmd", "agents.md")).toBe(false)
})
