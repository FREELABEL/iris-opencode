import { describe, expect, test } from "bun:test"
import { envelopeOf, pageSummary } from "./use-paged-surface"

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

describe("pageSummary with a noun (#189770)", () => {
  test("a complete count names what it counts", () => {
    expect(pageSummary({ shown: 6, env: env({ total: 6, totalIsExact: true }), noun: "records" })).toBe("6 records")
    expect(pageSummary({ shown: 25, env: env({ total: 40, totalIsExact: true }), noun: "records" })).toBe("25 of 40 records")
  })
  test("without a noun nothing changes", () => {
    expect(pageSummary({ shown: 6, env: env({ total: 6, totalIsExact: true }) })).toBe("6")
  })
})

describe("envelopeOf", () => {
  test("a paginator's numbers read like every other surface", () => {
    const first = envelopeOf({ page: 1, perPage: 50, total: 102, lastPage: 3 })
    expect(first.hasMore).toBe(true)
    expect(pageSummary({ shown: 50, env: first, noun: "leads" })).toBe("50 of 102 leads")
    const last = envelopeOf({ page: 3, perPage: 50, total: 102, lastPage: 3 })
    expect(last.hasMore).toBe(false)
    expect(pageSummary({ shown: 102, env: last, noun: "leads" })).toBe("102 leads")
  })
})
