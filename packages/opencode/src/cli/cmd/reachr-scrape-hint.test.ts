import { describe, test, expect } from "bun:test"
import { scrapeFixHint } from "./platform-reachr-scrape"

describe("reachr scrape: a missing browser dependency names its fix (#191700)", () => {
  test("the field error (old bridge) names the update and the alternatives", () => {
    const h = scrapeFixHint("browser-use not installed (install uv, then: uv tool install browser-use)")
    expect(h).toContain("iris daemon update")
    expect(h).toContain("npx playwright install chromium")
    expect(h).toContain("uv tool install browser-use")
  })
  test("no Chrome and the new engine's own message get the same hint", () => {
    expect(scrapeFixHint("no Chrome/Chromium found (set CHROME_BIN)")).toContain("iris daemon update")
    expect(scrapeFixHint("no browser engine: ...")).toContain("iris daemon update")
  })
  test("a page that was simply unreachable gets no install advice", () => {
    expect(scrapeFixHint("did not load (unreachable, DNS, TLS or refused)")).toBe("")
    expect(scrapeFixHint(undefined)).toBe("")
  })
})
