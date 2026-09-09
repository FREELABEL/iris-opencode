import { describe, test, expect } from "bun:test"
import { selectHits, MIN_SIGNAL, TAIL_FRACTION } from "./platform-find"

// =============================================================================
// A DISCOVERY TOOL THAT CANNOT SAY "NO" (#183511)
//
// `iris find` filtered on `s > 0`, so a single incidental body mention was a
// result. Measured against the words a client's agent actually typed, EVERY
// query returned 4-12 confident rows and NONE returned zero — so the agent was
// never told "that does not exist here". It followed the rows, found nothing,
// switched command family, and repeated for a whole run.
//
// The scores below are the real ones from score(): a body-only hit on a
// ubiquitous term lands at 8 (rarity floor 2 + kind bonus 6); the weakest NAME
// signal lands at 21 (name.includes 15 + kind 6).
// =============================================================================

const noise = (n: number) => Array.from({ length: n }, () => ({ s: 8 }))

describe("selectHits", () => {
  test("a page of body-only noise returns NOTHING, so the caller can say no", () => {
    // This is `iris find organizations`: twelve documents that say the word once.
    expect(selectHits(noise(12))).toEqual([])
  })

  test("the weakest NAME match still survives", () => {
    // name.includes(term) 15 + kind bonus 6. Below this nothing about the
    // entry's identity matched — only its prose.
    expect(selectHits([{ s: 21 }])).toHaveLength(1)
  })

  test("a RARE body term survives, which is the point of rarity weighting", () => {
    // "SiteFooter" appears in one guide and is the whole reason someone searched.
    // ~28 rarity + 6 kind. It must not be cut by a floor aimed at common words.
    expect(selectHits([{ s: 34 }])).toHaveLength(1)
  })

  test("noise riding on a real hit's coat-tails is dropped", () => {
    // `iris find providers` legitimately matches `hive providers`; it should not
    // also return nine documents that mention the word.
    const hits = selectHits([{ s: 100 }, ...noise(9)])
    expect(hits).toHaveLength(1)
    expect(hits[0].s).toBe(100)
  })

  test("genuine near-matches are KEPT — this is a floor, not a top-1", () => {
    // Three real capabilities for one query is a good answer, not noise.
    expect(selectHits([{ s: 100 }, { s: 90 }, { s: 40 }])).toHaveLength(3)
  })

  test("results come back strongest first", () => {
    expect(selectHits([{ s: 40 }, { s: 100 }, { s: 60 }]).map((h) => h.s)).toEqual([100, 60, 40])
  })

  test("the limit is still honoured", () => {
    const many = Array.from({ length: 20 }, () => ({ s: 100 }))
    expect(selectHits(many, 5)).toHaveLength(5)
  })

  test("an empty index does not throw", () => {
    expect(selectHits([])).toEqual([])
  })

  test("the constants stay derived from score()'s weights", () => {
    // If score() is retuned, these must be revisited together — the floor is only
    // meaningful relative to the weakest name signal it is chosen to sit below.
    expect(MIN_SIGNAL).toBe(15)
    expect(TAIL_FRACTION).toBe(0.25)
  })
})
