import { describe, expect, test } from "bun:test"
import { pageSummary } from "./use-paged-surface"

const env = (o: Partial<Parameters<typeof pageSummary>[0]["env"] & {}> = {}) => ({
  measured: true, page: 1, perPage: 25, total: 100, totalIsExact: true, hasMore: true, ...o,
}) as any

describe("pageSummary", () => {
  test("an unmeasured response says nothing at all", () => {
    // Not "0 results" — we did not look. A count is a claim.
    expect(pageSummary({ shown: 0, env: env({ measured: false, total: null }) })).toBeNull()
    expect(pageSummary({ shown: 0 })).toBeNull()
  })

  test("a null total is reported as a count of what is SHOWN, never as a total", () => {
    // "12 of 0" and "12 of 12" would both be inventions.
    expect(pageSummary({ shown: 12, env: env({ total: null }) })).toBe("12 shown")
  })

  test("an inexact total is a floor and says so", () => {
    expect(pageSummary({ shown: 50, env: env({ total: 50, totalIsExact: false }) })).toBe("50 of 50+ so far")
  })

  test("everything shown collapses to the plain number", () => {
    expect(pageSummary({ shown: 100, env: env({ total: 100 }) })).toBe("100")
  })

  test("partway through reads as a fraction", () => {
    expect(pageSummary({ shown: 25, env: env({ total: 127 }) })).toBe("25 of 127")
  })
})
