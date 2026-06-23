import { test, expect } from "bun:test"
import { asArray, extractTrendingItems } from "./platform-discover"

// ---------------------------------------------------------------------------
// asArray
// ---------------------------------------------------------------------------

test("asArray: passes arrays through", () => {
  expect(asArray([1, 2, 3])).toEqual([1, 2, 3])
})

test("asArray: unwraps a paginated { data: [...] } object", () => {
  expect(asArray({ current_page: 1, data: [{ id: 1 }], total: 14019 })).toEqual([{ id: 1 }])
})

test("asArray: returns [] for objects/null/undefined (never throws)", () => {
  expect(asArray({ tracks: [], articles: [] })).toEqual([])
  expect(asArray(null)).toEqual([])
  expect(asArray(undefined)).toEqual([])
})

// ---------------------------------------------------------------------------
// extractTrendingItems — the #147306 crash ("trendingItems.slice is not a function")
// ---------------------------------------------------------------------------

test("extractTrendingItems: flattens top_uploads_this_month and ranks by views", () => {
  // The real live shape: an object of sub-collections, with `videos` itself
  // paginated as { data: [...] } — exactly what crashed the command.
  const trending = {
    success: true,
    data: {
      top_uploads_this_month: {
        tracks: [],
        articles: [
          { title: "Tabi article", views: 1, type: "article" },
          { title: "Memory article", views: 9, type: "article" },
        ],
        videos: { current_page: 1, data: [{ title: "BBQ video", views: 50, type: "video" }] },
        services: [],
      },
    },
  }
  const items = extractTrendingItems(trending)
  expect(items).toHaveLength(3)
  // Ranked by views desc: 50 (video) → 9 → 1
  expect(items[0].title).toBe("BBQ video")
  expect(items[2].views).toBe(1)
  // Critically: the result is a real array you can .slice() without throwing.
  expect(() => items.slice(0, 5)).not.toThrow()
})

test("extractTrendingItems: backward-compatible with a flat data.data array", () => {
  const trending = { data: { data: [{ title: "x", views: 3 }] } }
  expect(extractTrendingItems(trending)).toEqual([{ title: "x", views: 3 }])
})

test("extractTrendingItems: never throws on an empty/odd payload", () => {
  expect(extractTrendingItems({})).toEqual([])
  expect(extractTrendingItems({ data: {} })).toEqual([])
  expect(extractTrendingItems(null)).toEqual([])
})
