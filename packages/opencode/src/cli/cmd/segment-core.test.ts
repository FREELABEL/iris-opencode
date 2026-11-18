import { describe, expect, test } from "bun:test"
import {
  FILTER_KEYS,
  FilterError,
  mergeFilters,
  parseCount,
  parseFilterArgs,
  renderBreakdown,
  renderMembers,
  shortcode,
  stepNote,
  watchSignature,
  type Breakdown,
  type BreakdownStep,
} from "./segment-core"

/**
 * #193484 — `iris segment`: --filter flags become the filters object fl-api stores, and the
 * breakdown table never shows "0 match" where the truth is "we don't know".
 */

describe("parseFilterArgs", () => {
  test("types each key: strings, lists, bools, counts", () => {
    expect(
      parseFilterArgs([
        "source_post=https://www.instagram.com/p/De9Uw8Ilhne/",
        "comment_contains=roadmap",
        "status_in=Prospected, Contacted",
        "replied=no",
        "contacted",
        "followers_min=5k",
        "followers_max=50,000",
        "has_email=true",
      ]),
    ).toEqual({
      source_post: "De9Uw8Ilhne",
      comment_contains: "roadmap",
      status_in: ["Prospected", "Contacted"],
      replied: false,
      contacted: true,
      followers_min: 5000,
      followers_max: 50000,
      has_email: true,
    })
  })

  test("returns keys in the server's breakdown order, not typing order", () => {
    const f = parseFilterArgs(["has_email=1", "followers_min=10", "source_post=Abc"])
    expect(Object.keys(f)).toEqual(["source_post", "followers_min", "has_email"])
    expect(Object.keys(FILTER_KEYS)[0]).toBe("source_post")
  })

  test("splits on the first '=' so a comment filter may contain one", () => {
    expect(parseFilterArgs(["comment_contains=a=b"])).toEqual({ comment_contains: "a=b" })
  })

  test("later flags win over the file and over earlier flags", () => {
    expect(parseFilterArgs(["niche_in=coach", "niche_in=coach,creator"], { niche_in: ["x"], role_in: "founder" })).toEqual({
      niche_in: ["coach", "creator"],
      role_in: ["founder"],
    })
  })

  test("refuses unknown keys, naming the allowed ones", () => {
    expect(() => parseFilterArgs(["followers=5"])).toThrow(FilterError)
    expect(() => parseFilterArgs(["followers=5"])).toThrow(/Allowed: source_post, comment_contains/)
    expect(() => parseFilterArgs([], { nope: 1 })).toThrow(/Unknown filter key\(s\): nope/)
  })

  test("refuses bad values and a bare non-bool key", () => {
    expect(() => parseFilterArgs(["replied=maybe"])).toThrow(/true or false/)
    expect(() => parseFilterArgs(["followers_min=-3"])).toThrow(/whole number/)
    expect(() => parseFilterArgs(["followers_min=1.5"])).toThrow(/whole number/)
    expect(() => parseFilterArgs(["comment_contains"])).toThrow(/needs a value/)
    expect(() => parseFilterArgs(["status_in= , "])).toThrow(/at least one/)
    expect(() => parseFilterArgs(["followers_min=10k", "followers_max=5k"])).toThrow(/greater than/)
  })

  test("counts and shortcodes", () => {
    expect(parseCount("1.2m", "x")).toBe(1_200_000)
    expect(parseCount("0", "x")).toBe(0)
    expect(shortcode("https://www.instagram.com/reel/Ab_cd/?igsh=1")).toBe("Ab_cd")
    expect(shortcode("De9Uw8Ilhne")).toBe("De9Uw8Ilhne")
  })
})

describe("mergeFilters (segment update)", () => {
  test("adds, replaces and unsets", () => {
    expect(mergeFilters({ comment_contains: "roadmap", replied: true }, { followers_min: 10 }, ["replied"])).toEqual({
      comment_contains: "roadmap",
      followers_min: 10,
    })
    expect(() => mergeFilters({}, {}, ["bogus"])).toThrow(FilterError)
  })
})

const step = (over: Partial<BreakdownStep>): BreakdownStep => ({
  key: "comment_contains",
  value: "roadmap",
  before: 6050,
  known: 6050,
  unknown: 0,
  matched: 4,
  of: 6050,
  known_in_board: 6050,
  field_always_known: false,
  ...over,
})

describe("breakdown rendering — known vs matched", () => {
  const b: Breakdown = {
    of: 6050,
    matched: 3,
    steps: [
      step({ key: "source_post", value: "De9Uw8Ilhne", before: 6050, known: 6000, unknown: 50, matched: 120 }),
      step({ key: "status_in", value: ["Prospected"], before: 120, known: 120, unknown: 0, matched: 100, field_always_known: true }),
      step({ key: "followers_min", value: 5000, before: 100, known: 4, unknown: 96, matched: 3, known_in_board: 4 }),
    ],
  }

  test("one row per filter with before / known / unknown / matched, and the board total", () => {
    const lines = renderBreakdown(b)
    expect(lines[0]).toMatch(/#\s+filter\s+value\s+before\s+known\s+unknown\s+matched/)
    expect(lines[1]).toMatch(/\(board\)\s+6,050$/)
    expect(lines[2]).toMatch(/^\s+1\s+source_post\s+De9Uw8Ilhne\s+6,050\s+6,000\s+50\s+120$/)
    expect(lines[3]).toMatch(/^\s+2\s+status_in\s+Prospected\s+120\s+all\s+-\s+100$/)
    expect(lines[4]).toMatch(/^\s+3\s+followers_min\s+5000\s+100\s+4\s+96\s+3$/)
    expect(lines[5]).toBe("  → 3 of 6,050 leads match on what is known — 146 more could not be judged (source_post, followers_min unknown)")
    const allKnown = renderBreakdown({ of: 10, matched: 4, steps: [step({ before: 10, known: 10, unknown: 0, matched: 4 })] })
    expect(allKnown).toContain("  → 4 of 10 leads match")
  })

  test("a partially-known field says how many it could judge", () => {
    const notes = renderBreakdown(b).filter((l) => l.startsWith("  !"))
    expect(notes).toContain("  ! followers_min: 3 match among 4 known — unknown for 96 (not counted, never treated as 0)")
    expect(notes.some((n) => n.includes("status_in"))).toBe(false) // a column every lead has
  })

  test("a field nobody has is 'cannot be judged', never a bare 0 match", () => {
    const n = stepNote(step({ key: "city_contains", value: "austin", before: 6046, known: 0, unknown: 6046, matched: 0, known_in_board: 0 }))
    expect(n).toContain("cannot be judged yet")
    expect(n).toContain("6,046 unknown")
    expect(n).toContain('not "0 match"')
  })

  test("a fully-known field gets no note", () => {
    expect(stepNote(step({}))).toBeNull()
  })
})

describe("members table", () => {
  test("unknown followers print as ?, never 0", () => {
    const lines = renderMembers([
      { id: 1, handle: "jj", name: "JJ", status: "Prospected", comment: "ROADMAP\nplease", source_post_url: null, niche: "coach", role: null, city: null, followers: null },
      { id: 2, handle: null, name: "Ann", status: "Contacted", comment: null, source_post_url: null, niche: null, role: null, city: null, followers: 0 },
    ])
    expect(lines[1]).toMatch(/^\s+1\s+@jj\s+Prospected\s+\?\s+coach\s+ROADMAP please$/)
    expect(lines[2]).toMatch(/^\s+2\s+Ann\s+Contacted\s+0\s+$/)
    expect(renderMembers([])).toEqual(["  (no members)"])
  })
})

describe("watchSignature", () => {
  const seg = { name: "s", filters: { replied: true }, breakdown: { of: 10, matched: 2, steps: [step({ before: 10, known: 10, matched: 2 })] } }

  test("ignores nothing that matters and changes when a count does", () => {
    expect(watchSignature(seg)).toBe(watchSignature(JSON.parse(JSON.stringify(seg))))
    const changed = { ...seg, breakdown: { ...seg.breakdown, matched: 3, steps: [step({ before: 10, known: 10, matched: 3 })] } }
    expect(watchSignature(changed)).not.toBe(watchSignature(seg))
    expect(watchSignature({ ...seg, name: "renamed" })).not.toBe(watchSignature(seg))
  })
})
