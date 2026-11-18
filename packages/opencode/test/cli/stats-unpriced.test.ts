import { describe, expect, test } from "bun:test"
import { money, tokenCount } from "../../src/cli/cmd/stats"

// #185834 — `iris stats` printed "Total Cost $0.00" under 8.8M input tokens because every model's
// price table was zero. A cost that was never priced must not read as free.
describe("iris stats cost rendering", () => {
  test("tokens used and nothing priced reads 'unpriced', not $0.00", () => {
    expect(money(0, 8_800_000, 2)).toBe("unpriced")
  })

  test("a real cost still renders as dollars", () => {
    expect(money(1.234, 10, 2)).toBe("$1.23")
    expect(money(0.000123, 10, 6)).toBe("$0.000123")
  })

  test("no tokens and no cost is a true $0.00", () => {
    expect(money(0, 0, 2)).toBe("$0.00")
  })

  test("NaN is never printed", () => {
    expect(money(NaN, 0, 2)).toBe("$0.00")
    expect(money(NaN, 5, 2)).toBe("unpriced")
  })

  test("cache reads count as usage — the bug's own numbers were mostly cache", () => {
    expect(tokenCount({ input: 0, output: 0, cache: { read: 42_800_000, write: 0 } })).toBe(42_800_000)
    expect(tokenCount({ input: 1, output: 2 })).toBe(3)
  })
})
