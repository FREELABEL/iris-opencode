import { describe, test, expect } from "bun:test"
import { fmtPct } from "./platform-okr"

// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "")

describe("fmtPct — OKR/KPI progress percentage", () => {
  test("no target set reads as an em dash, not 0% or NaN%", () => {
    expect(stripAnsi(fmtPct(40, null))).toBe("—")
    expect(stripAnsi(fmtPct(40, undefined))).toBe("—")
  })

  test("a zero target reads as an em dash — division by zero must not surface as a number", () => {
    expect(stripAnsi(fmtPct(0, 0))).toBe("—")
    expect(stripAnsi(fmtPct(5, 0))).toBe("—")
  })

  test("no reading yet reads as an em dash, distinct from a real 0%", () => {
    expect(stripAnsi(fmtPct(null, 100))).toBe("—")
    expect(stripAnsi(fmtPct(undefined, 100))).toBe("—")
  })

  test("an actual 0% reading is shown as 0%, not folded into the em-dash case", () => {
    expect(stripAnsi(fmtPct(0, 100))).toBe("0%")
  })

  test("rounds to the nearest whole percent", () => {
    expect(stripAnsi(fmtPct(1, 3))).toBe("33%")
    expect(stripAnsi(fmtPct(2, 3))).toBe("67%")
  })

  test("a decrease-direction KR can legitimately exceed 100% of target", () => {
    expect(stripAnsi(fmtPct(150, 100))).toBe("150%")
  })
})
