import { describe, expect, test } from "bun:test"
import { ATLAS_PAGE, moreLabel, moreOf, windowOf } from "./iris-atlas-window"

describe("a list never renders all its cards at once (#192670)", () => {
  const cards = Array.from({ length: 6899 }, (_, i) => i)
  test("a big list shows one page by default", () => {
    expect(windowOf(cards, undefined).length).toBe(ATLAS_PAGE)
  })
  test("show more adds a page, and says what is left", () => {
    expect(windowOf(cards, 100).length).toBe(100)
    expect(moreOf(cards.length, undefined)).toEqual({ next: 50, left: 6849 })
    expect(moreLabel(moreOf(cards.length, undefined)!)).toBe("Show 50 more · 6,849 left")
  })
  test("the last page offers only what remains", () => {
    expect(moreOf(120, 100)).toEqual({ next: 20, left: 20 })
  })
  test("a small list is untouched: the same array, no control", () => {
    const few = [1, 2, 3]
    expect(windowOf(few, undefined)).toBe(few)
    expect(moreOf(few.length, undefined)).toBeUndefined()
  })
})
