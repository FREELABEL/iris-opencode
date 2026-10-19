import { describe, expect, test } from "bun:test"
import { editDistance, normalizeLeadQuery, rankLeads, searchFetchSize, typoMatches, typoProbes } from "./lead-search-rank"

// #189943 — `iris leads search darren` did not list #29284 Darren Cummings (found only by email),
// and `haripurkah` (one letter off "Haripurkh") returned 0. The server agent owns name-token and
// fuzzy matching; this is the CLI half: pass the query through intact, over-fetch so ranking is
// not decided by the server's page order, put real name matches first, and when the CRM says 0,
// try a typo-tolerant probe and LABEL the result as a close match.

const darren = { id: 29284, name: "Darren Cummings", email: "dc@m42.com" }
const handles = [
  { id: 24397, name: "@darrenellis14" },
  { id: 21964, name: "@darren.r226" },
  { id: 15468, name: "thedarrenpeel" },
]

describe("query normalisation", () => {
  test("trims, collapses whitespace, keeps quotes/apostrophes/% intact", () => {
    expect(normalizeLeadQuery("  Darren   Cummings ")).toBe("Darren Cummings")
    expect(normalizeLeadQuery("O'Brien")).toBe("O'Brien")
    expect(normalizeLeadQuery('"darren"')).toBe('"darren"')
    expect(normalizeLeadQuery("50%_off")).toBe("50%_off")
  })
  test("empty / whitespace → empty", () => {
    expect(normalizeLeadQuery("   ")).toBe("")
    expect(normalizeLeadQuery(undefined)).toBe("")
  })
})

describe("over-fetch", () => {
  test("asks the server for more than it shows, so a real name match is not cut by page order", () => {
    expect(searchFetchSize(10)).toBeGreaterThanOrEqual(50)
    expect(searchFetchSize(200)).toBe(200)
  })
})

describe("ranking", () => {
  test("a person whose first name IS the query outranks handles that merely contain it", () => {
    const ranked = rankLeads([...handles, darren], "darren")
    expect(ranked[0].id).toBe(29284)
  })
  test("full-name query: exact name first", () => {
    const ranked = rankLeads([{ id: 1, name: "Darren Head" }, darren], "darren cummings")
    expect(ranked[0].id).toBe(29284)
  })
  test("case-insensitive; email match counts", () => {
    expect(rankLeads([{ id: 2, name: "x", email: "y@z.com" }, darren], "DC@M42.COM")[0].id).toBe(29284)
  })
  test("stable for equal scores", () => {
    expect(rankLeads([{ id: 1, name: "Darren A" }, { id: 2, name: "Darren B" }], "darren").map((l) => l.id)).toEqual([1, 2])
  })
})

describe("typo tolerance", () => {
  test("edit distance basics, including a transposition", () => {
    expect(editDistance("haripurkah", "haripurkh")).toBe(1)
    expect(editDistance("darern", "darren")).toBe(1)
    expect(editDistance("abc", "abc")).toBe(0)
  })
  test("probes are server-searchable prefixes of the long tokens", () => {
    expect(typoProbes("haripurkah")).toContain("haripu")
    expect(typoProbes("al")).toEqual([])
  })
  test("one-letter typo matches the lead; an unrelated name does not", () => {
    const rows = [{ id: 29285, name: "Haripurkh Khalsa", email: "hpk@m42.com" }, { id: 9, name: "Harriet Purdy" }]
    expect(typoMatches(rows, "haripurkah").map((r) => r.id)).toEqual([29285])
  })
  test("short tokens are not fuzzed (al ≠ ali)", () => {
    expect(typoMatches([{ id: 1, name: "Ali Khan" }], "al")).toEqual([])
  })
  test("a multi-word query needs every word to be close", () => {
    const rows = [{ id: 29284, name: "Darren Cummings" }, { id: 1, name: "Darren Head" }]
    expect(typoMatches(rows, "darren cumings").map((r) => r.id)).toEqual([29284])
  })
})
