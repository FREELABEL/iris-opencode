import { describe, expect, test } from "bun:test"
import { clampPaging, paginate, readUpstreamTotal } from "./pagination"

const items = Array.from({ length: 10 }, (_, i) => i + 1)

describe("paginate", () => {
  test("slices and reports an exact total when we hold the whole set", () => {
    const p = paginate(items, { page: 1, perPage: 4 })
    expect(p.items).toEqual([1, 2, 3, 4])
    expect(p.total).toBe(10)
    expect(p.totalIsExact).toBe(true)
    expect(p.hasMore).toBe(true)
  })

  test("the last page says so", () => {
    const p = paginate(items, { page: 3, perPage: 4 })
    expect(p.items).toEqual([9, 10])
    expect(p.hasMore).toBe(false)
  })

  test("a page past the end is empty but still not 'more'", () => {
    const p = paginate(items, { page: 9, perPage: 4 })
    expect(p.items).toEqual([])
    expect(p.hasMore).toBe(false)
  })

  test("an upstream total wins, and is exact", () => {
    // fl-api truncated at 10 but told us there are 240. The count belongs to the upstream.
    const p = paginate(items, { page: 1, perPage: 4, upstreamTotal: 240, upstreamTruncated: true })
    expect(p.total).toBe(240)
    expect(p.totalIsExact).toBe(true)
    expect(p.hasMore).toBe(true)
  })

  test("TRUNCATED WITH NO TOTAL is a floor, not an answer", () => {
    // The honest middle: we asked for 10, got exactly 10, nobody said how many exist. Reporting
    // "10" flatly would state a number we did not measure.
    const p = paginate(items, { page: 3, perPage: 4, upstreamTruncated: true })
    expect(p.total).toBe(10)
    expect(p.totalIsExact).toBe(false)
    expect(p.hasMore).toBe(true)
  })
})

describe("clampPaging", () => {
  test("junk falls back rather than throwing or paging to nowhere", () => {
    expect(clampPaging({})).toEqual({ page: 1, perPage: 25 })
    expect(clampPaging({ page: 0, perPage: -5 })).toEqual({ page: 1, perPage: 1 })
    expect(clampPaging({ page: 2.7, perPage: 5000 })).toEqual({ page: 2, perPage: 200 })
  })
})

describe("readUpstreamTotal", () => {
  test("finds a total where the upstreams actually put it", () => {
    expect(readUpstreamTotal({ meta: { total: 42 } })).toBe(42)
    expect(readUpstreamTotal({ data: { total: 7 } })).toBe(7)
    expect(readUpstreamTotal({ total: 3 })).toBe(3)
  })

  test("absent means NULL, not zero", () => {
    expect(readUpstreamTotal({ data: [1, 2, 3] })).toBeNull()
    expect(readUpstreamTotal(null)).toBeNull()
  })
})
