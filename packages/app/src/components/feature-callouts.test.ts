import { describe, expect, test } from "bun:test"
import { CALLOUTS, compareVersions, pickCallout, placeCallout, type Callout } from "./feature-callouts"

const A: Callout = { id: "a", title: "A", body: "a", targets: ["add-tab", "iris-panel"], minVersion: "1.18.211" }
const B: Callout = { id: "b", title: "B", body: "b", targets: ["add-tab"], until: "2027-01-01" }
const now = new Date("2026-11-18T12:00:00Z")
const all = () => true

describe("compareVersions", () => {
  test("numeric, not string, order", () => {
    expect(compareVersions("1.18.211", "1.18.99")).toBe(1)
    expect(compareVersions("1.18.9", "1.18.10")).toBe(-1)
    expect(compareVersions("v1.18.211", "1.18.211")).toBe(0)
    expect(compareVersions("1.18", "1.18.0")).toBe(0)
  })
})

describe("pickCallout", () => {
  test("the first unseen one, pointing at the first control on screen", () => {
    expect(pickCallout({ callouts: [A, B], seen: [], version: "1.18.211", now, onScreen: all })).toEqual({
      callout: A,
      target: "add-tab",
    })
  })

  test("falls back to the next control when the first is not on screen (panel closed)", () => {
    const got = pickCallout({ callouts: [A], seen: [], version: "1.18.212", now, onScreen: (t) => t === "iris-panel" })
    expect(got?.target).toBe("iris-panel")
  })

  test("seen ones never come back", () => {
    expect(pickCallout({ callouts: [A, B], seen: ["a"], version: "1.18.211", now, onScreen: all })?.callout.id).toBe("b")
    expect(pickCallout({ callouts: [A, B], seen: ["a", "b"], version: "1.18.211", now, onScreen: all })).toBeUndefined()
  })

  test("an older app never points at a control it does not have", () => {
    expect(pickCallout({ callouts: [A], seen: [], version: "1.18.210", now, onScreen: all })).toBeUndefined()
  })

  test("a dev build (no version) is not gated", () => {
    expect(pickCallout({ callouts: [A], seen: [], now, onScreen: all })?.callout.id).toBe("a")
  })

  test("old news retires itself", () => {
    expect(pickCallout({ callouts: [B], seen: [], now: new Date("2027-01-02"), onScreen: all })).toBeUndefined()
  })

  test("nothing on screen, nothing shown", () => {
    expect(pickCallout({ callouts: [A, B], seen: [], version: "1.18.211", now, onScreen: () => false })).toBeUndefined()
  })
})

describe("placeCallout", () => {
  const viewport = { width: 1200, height: 800 }
  const card = { width: 320, height: 110 }

  test("below the control, arrow under its centre", () => {
    const p = placeCallout({ target: { top: 10, left: 500, width: 32, height: 32 }, card, viewport })
    expect(p.side).toBe("below")
    expect(p.top).toBe(52)
    expect(p.left + p.arrow).toBe(516)
  })

  test("a control at the right edge: the card slides in, the arrow still points at it", () => {
    const p = placeCallout({ target: { top: 10, left: 1100, width: 32, height: 32 }, card, viewport })
    expect(p.left).toBe(1200 - 320 - 12)
    expect(p.left + p.arrow).toBe(1116)
    // Hard against the corner, the arrow stops short of the card's rounded edge.
    const q = placeCallout({ target: { top: 10, left: 1180, width: 16, height: 16 }, card, viewport })
    expect(q.arrow).toBe(320 - 16)
  })

  test("no room below: it flips above", () => {
    const p = placeCallout({ target: { top: 760, left: 500, width: 32, height: 32 }, card, viewport })
    expect(p.side).toBe("above")
    expect(p.top).toBe(760 - 10 - 110)
  })
})

describe("the shipped list", () => {
  test("ids are unique and every callout names a control", () => {
    const ids = CALLOUTS.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const c of CALLOUTS) expect(c.targets.length).toBeGreaterThan(0)
  })
})
