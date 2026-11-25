import { describe, expect, test } from "bun:test"
import { siteFaviconProblem } from "../../src/cli/cmd/platform-sites"

// #194264 — a site's icon is the tab icon for every page on its domain without one of its own.
describe("iris sites config --favicon", () => {
  test("an https image address is accepted; clearing is accepted", () => {
    expect(siteFaviconProblem("https://cdn.heyiris.io/cloud-files/1795637062_cwc-favicon-256.png")).toBeNull()
    expect(siteFaviconProblem(null)).toBeNull()
  })
  test("http, a file path, nothing, or too long is refused with what to do instead", () => {
    expect(siteFaviconProblem("http://example.com/x.png")).toContain("https://")
    expect(siteFaviconProblem("./logo.png")).toContain("iris cloud:upload")
    expect(siteFaviconProblem("")).toContain("--favicon https://")
    expect(siteFaviconProblem("https://x.test/" + "a".repeat(600))).toContain("500")
  })
})
