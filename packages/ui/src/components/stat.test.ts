import { describe, expect, test } from "bun:test"
import { changeTone, formatChange } from "./stat"

describe("Stat change (#194581)", () => {
  test("a signed number, a real minus sign, and words for zero", () => {
    expect(formatChange(3)).toBe("+3")
    expect(formatChange(-2)).toBe("−2")
    expect(formatChange(0)).toBe("No change")
    expect(formatChange(1200)).toBe("+1,200")
  })

  test("up is good unless inverted", () => {
    expect(changeTone(3)).toBe("positive")
    expect(changeTone(-3)).toBe("negative")
    expect(changeTone(-3, true)).toBe("positive")
    expect(changeTone(0)).toBe("neutral")
  })
})
