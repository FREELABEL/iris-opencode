import { describe, test, expect } from "bun:test"
import { fmtPct, krProgress } from "./platform-okr"

// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "")

describe("krProgress — direction is arithmetic, not decoration", () => {
  /**
   * REGRESSION. This shipped. `current / target` is only correct for an INCREASE
   * KR; on a decrease KR it inverts, and the failure is silent and flattering.
   *
   * Found by seeding real RevOps data, not by reading the code: a real KR
   * ("cut hours of manual effort per campaign from 6h to a target of 1h") sat at
   * its WORST value and the dashboard reported the objective at 60%.
   */
  test("REGRESSION: a decrease KR at its worst value is not 100% complete", () => {
    // 6h against a 1h target = barely started, NOT done.
    const p = krProgress(6, 1, "decrease")
    expect(p).not.toBeNull()
    expect(p!).toBeLessThan(20)
    // The old math: 6/1 = 600%, capped to 100%.
    expect(Math.min(100, (6 / 1) * 100)).toBe(100) // what it used to report
  })

  test("a decrease KR that reaches its target is complete", () => {
    expect(krProgress(1, 1, "decrease")).toBe(100)
  })

  test("a decrease KR that beats its target is complete, not infinite", () => {
    // current=0 is total elimination — the best case. Guarded before the divide.
    expect(krProgress(0, 1, "decrease")).toBe(100)
    expect(Number.isFinite(krProgress(0, 1, "decrease")!)).toBe(true)
    expect(krProgress(0.5, 1, "decrease")).toBe(100)
  })

  test("a decrease KR improves monotonically as it falls toward target", () => {
    const far = krProgress(10, 1, "decrease")!
    const closer = krProgress(4, 1, "decrease")!
    const closest = krProgress(2, 1, "decrease")!
    expect(far).toBeLessThan(closer)
    expect(closer).toBeLessThan(closest)
  })

  test("an increase KR keeps the straightforward ratio", () => {
    expect(krProgress(1, 5, "increase")).toBe(20)
    expect(krProgress(5, 5, "increase")).toBe(100)
    expect(krProgress(0, 100, "increase")).toBe(0)
  })

  test("direction defaults to increase when absent", () => {
    expect(krProgress(1, 5)).toBe(20)
    expect(krProgress(1, 5, null)).toBe(20)
  })

  test("a maintain KR peaks AT the target and overshooting is a miss", () => {
    expect(krProgress(100, 100, "maintain")).toBe(100)
    // Deviating either way costs the same — holding steady is the goal.
    expect(krProgress(90, 100, "maintain")).toBe(krProgress(110, 100, "maintain"))
    expect(krProgress(110, 100, "maintain")!).toBeLessThan(100)
  })

  test("a maintain KR floors at 0 instead of going negative", () => {
    expect(krProgress(500, 100, "maintain")).toBe(0)
    expect(krProgress(-500, 100, "maintain")).toBe(0)
  })

  test("unmeasurable pairs return null — 'not measured' is not 'no progress'", () => {
    expect(krProgress(40, null)).toBeNull()
    expect(krProgress(40, undefined)).toBeNull()
    expect(krProgress(null, 100)).toBeNull()
    expect(krProgress(undefined, 100)).toBeNull()
    // An increase KR cannot divide by a zero target.
    expect(krProgress(5, 0, "increase")).toBeNull()
  })

  test("a zero target is meaningful for decrease and maintain, unlike increase", () => {
    // "drive this to zero" is a real goal; reaching 0 is 100%.
    expect(krProgress(0, 0, "decrease")).toBe(100)
    expect(krProgress(0, 0, "maintain")).toBe(100)
    expect(krProgress(5, 0, "maintain")).toBe(0)
  })
})

describe("fmtPct — rendering", () => {
  test("unmeasurable reads as an em dash, not 0% or NaN%", () => {
    expect(stripAnsi(fmtPct(40, null))).toBe("—")
    expect(stripAnsi(fmtPct(null, 100))).toBe("—")
    expect(stripAnsi(fmtPct(5, 0, "increase"))).toBe("—")
  })

  test("a real 0% reading is shown as 0%, distinct from the em-dash case", () => {
    expect(stripAnsi(fmtPct(0, 100))).toBe("0%")
  })

  test("rounds to the nearest whole percent", () => {
    expect(stripAnsi(fmtPct(1, 3))).toBe("33%")
    expect(stripAnsi(fmtPct(2, 3))).toBe("67%")
  })

  test("an increase KR past its target may exceed 100%", () => {
    expect(stripAnsi(fmtPct(150, 100))).toBe("150%")
  })

  test("REGRESSION: the decrease KR that read 100% now renders honestly", () => {
    expect(stripAnsi(fmtPct(6, 1, "decrease"))).toBe("17%")
  })
})
