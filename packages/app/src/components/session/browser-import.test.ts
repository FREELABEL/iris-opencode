import { describe, expect, test } from "bun:test"
import { filterSites, parseChoice, presetSites, primarySource, shouldReimport, siteOfUrl } from "./browser-import"

const src = (id: string, sites: string[]) => ({ id, browser: "Chrome", profile: id, sites: sites.map((site, i) => ({ site, cookies: 10 - i })) })

describe("which sites start ticked", () => {
  test("the quick tiles' sites and common ones, only if Chrome has them; never a bank", () => {
    expect(presetSites(src("a", ["youtube.com", "chase.com", "heb.com", "github.com", "mybank.com"]))).toEqual([
      "youtube.com",
      "heb.com",
      "github.com",
    ])
    expect(presetSites(undefined)).toEqual([])
  })
  test("siteOfUrl", () => {
    expect(siteOfUrl("https://www.youtube.com")).toBe("youtube.com")
    expect(siteOfUrl("https://open.spotify.com")).toBe("spotify.com")
    expect(siteOfUrl("nope")).toBe("")
  })
})

test("search filters, and the profile with most sites comes first", () => {
  expect(filterSites(src("a", ["youtube.com", "heb.com"]), "HE").map((s) => s.site)).toEqual(["heb.com"])
  expect(primarySource([src("small", ["a.com"]), src("big", ["a.com", "b.com"])])?.id).toBe("big")
})

describe("the remembered choice", () => {
  test("junk is ignored; sites are strings only", () => {
    expect(parseChoice("{")).toBeUndefined()
    expect(parseChoice('{"source":"chrome:Default","sites":["heb.com",3,""]}')?.sites).toEqual(["heb.com"])
  })
  test("re-import at launch only where the Browser forgets (macOS 13)", () => {
    expect(shouldReimport({ source: "s", sites: ["heb.com"], persistent: false, at: 1 })).toBe(true)
    expect(shouldReimport({ source: "s", sites: ["heb.com"], persistent: true, at: 1 })).toBe(false)
    expect(shouldReimport({ source: "s", sites: [], persistent: false, at: 1 })).toBe(false)
    expect(shouldReimport(undefined)).toBe(false)
  })
})
