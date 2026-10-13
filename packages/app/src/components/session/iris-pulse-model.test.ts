import { describe, expect, test } from "bun:test"
import { blindLine, pinsOf, priorLine, runsLine, sparkOf, tallyOf, topicLine, touchedLine, type PulseStop } from "./iris-pulse-model"

const stop = (o: Partial<PulseStop>): PulseStop => ({
  id: "git",
  label: "Commits",
  shut: false,
  reason: null,
  provenance: "measured",
  count: 0,
  floor: false,
  delta: null,
  text: "",
  owed: 0,
  items: [],
  ...o,
})

describe("pulse panel model (#189286)", () => {
  test("a shut stop says shut — never 0, never a number", () => {
    expect(tallyOf(stop({ shut: true, count: null, provenance: "not-measured" }))).toEqual({ main: "shut", delta: null, tone: "shut" })
  })

  test("a floor shows +, a change shows its sign, a deal shows money", () => {
    expect(tallyOf(stop({ count: 200, floor: true }))).toMatchObject({ main: "200+" })
    expect(tallyOf(stop({ count: 53, delta: -3 }))).toMatchObject({ main: "53", delta: "−3" })
    expect(tallyOf(stop({ id: "deal", count: 9950, owed: 1 }))).toEqual({ main: "$9,950", delta: null, tone: "wait" })
    expect(tallyOf(stop({ count: null }))).toMatchObject({ main: "—", tone: "none" })
  })

  test("pins number the stops that were visited; shut ones get ×", () => {
    expect(pinsOf([stop({}), stop({ shut: true }), stop({}), stop({ shut: true })])).toEqual(["1", "×", "2", "×"])
  })

  test("the summary keeps the floor and the shut stops in the sentence", () => {
    const s = { hits: 101, floor: true, withHits: 3, reachable: 5, total: 8, shut: 3, prior: 56, lastTouched: null }
    expect(topicLine(s)).toBe("101+ hits at 3 of 5 reachable stops")
    expect(priorLine(s, 30)).toEqual({ text: "101 vs 56 the 30 days before", tone: "up" })
    expect(priorLine({ ...s, prior: null }, 30).tone).toBe("none")
    expect(touchedLine(null, 0)).toBe("not touched in the window")
  })

  test("contact: runs, the trend, and how many channels were blind", () => {
    const h = [{ at: "2026-09-20 02:00:00", score: 40 }, { at: "2026-10-11 02:00:00", score: 60 }]
    expect(runsLine(h)).toBe("2 runs in 21 days")
    expect(sparkOf(h)).toEqual([3, 16])
    expect(blindLine({ read: 1, total: 5 })).toBe("partial read — 4 of 5 channels blind")
    expect(blindLine({ read: 5, total: 5 })).toBeNull()
  })
})
