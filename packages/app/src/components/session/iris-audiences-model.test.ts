import { describe, expect, test } from "bun:test"
import { DRAFT_ROADMAP, PREVIEW_ROADMAP } from "./iris-audiences.fixtures"
import {
  countText,
  countViews,
  draftUnsaved,
  FILTER_DEFS,
  filterToRow,
  memberCells,
  nextKey,
  rowsToFilters,
  rowToFilter,
  type SegmentFilter,
} from "./iris-audiences-model"
import { todayIsClear } from "./iris-outreach-model"
import type { Conversation } from "./iris-inbox-model"
import type { ReviewBatch } from "./iris-reachr-review-model"

describe("filter rows ↔ fl-api filters", () => {
  test("each kind of filter maps to the type fl-api takes", () => {
    expect(rowToFilter({ key: "source_post", text: "https://www.instagram.com/p/De9Uw8Ilhne/?img_index=1" })).toEqual({ key: "source_post", value: "De9Uw8Ilhne" })
    expect(rowToFilter({ key: "source_post", text: "De9Uw8Ilhne" })).toEqual({ key: "source_post", value: "De9Uw8Ilhne" })
    expect(rowToFilter({ key: "comment_contains", text: "  roadmap " })).toEqual({ key: "comment_contains", value: "roadmap" })
    expect(rowToFilter({ key: "niche_in", text: "Course creator, Coach ,," })).toEqual({ key: "niche_in", value: ["Course creator", "Coach"] })
    expect(rowToFilter({ key: "replied", text: "Yes" })).toEqual({ key: "replied", value: true })
    expect(rowToFilter({ key: "has_email", text: "no" })).toEqual({ key: "has_email", value: false })
    expect(rowToFilter({ key: "followers_min", text: "5,000" })).toEqual({ key: "followers_min", value: 5000 })
    expect(rowToFilter({ key: "followers_max", text: "50k" })).toEqual({ key: "followers_max", value: 50000 })
  })

  test("a row that says nothing usable is not a filter yet", () => {
    expect(rowToFilter({ key: "comment_contains", text: "  " })).toBeUndefined()
    expect(rowToFilter({ key: "replied", text: "maybe" })).toBeUndefined()
    expect(rowToFilter({ key: "followers_min", text: "lots" })).toBeUndefined()
    expect(rowToFilter({ key: "status_in", text: " , " })).toBeUndefined()
  })

  test("filter → row → filter is the identity for every kind", () => {
    const filters: SegmentFilter[] = [
      { key: "source_post", value: "De9Uw8Ilhne" },
      { key: "status_in", value: ["Prospected", "Contacted"] },
      { key: "contacted", value: false },
      { key: "followers_min", value: 5000 },
      { key: "city_contains", value: "Austin" },
    ]
    expect(rowsToFilters(filters.map(filterToRow))).toEqual(filters)
  })

  test("rows keep their order, skip blanks, and a key counts once", () => {
    expect(
      rowsToFilters([
        { key: "comment_contains", text: "roadmap" },
        { key: "niche_in", text: "" },
        { key: "source_post", text: "De9Uw8Ilhne" },
        { key: "comment_contains", text: "later duplicate" },
      ]),
    ).toEqual([
      { key: "comment_contains", value: "roadmap" },
      { key: "source_post", value: "De9Uw8Ilhne" },
    ])
  })

  test("Add filter starts on the first unused key; none left = none", () => {
    expect(nextKey([])).toBe("source_post")
    expect(nextKey([{ key: "source_post", text: "x" }])).toBe("comment_contains")
    expect(nextKey(FILTER_DEFS.map((d) => ({ key: d.key, text: "" })))).toBeUndefined()
  })
})

describe("the cumulative breakdown (typed shape, measured counts)", () => {
  const views = countViews(DRAFT_ROADMAP.filters, PREVIEW_ROADMAP.breakdown)

  test("each row is what is left after it and every row above it", () => {
    expect(views.map((v) => v.count)).toEqual(["849", "788", "0 of 0 known"])
    expect(countText(views[0])).toBe("849 of 11,341")
    expect(countText(views[1])).toBe("788 of 849")
  })

  test("a demographic filter is never a bare 0: it says how many were known", () => {
    expect(countText(views[2])).toBe("0 of 0 known · 788 unknown")
    const tagged = countViews([{ key: "niche_in", value: ["Coach"] }], [{ key: "niche_in", matched: 3, known: 4, of: 6050 }])
    expect(countText(tagged[0])).toBe("3 of 4 known · 6,046 unknown")
    expect(tagged[0].label).toBe("Niche is")
    expect(tagged[0].value).toBe("Coach")
  })

  test("a demographic filter without a known count falls back to matched of", () => {
    const v = countViews([{ key: "city_contains", value: "Austin" }], [{ key: "city_contains", matched: 2, known: null, of: 40 }])
    expect(countText(v[0])).toBe("2 of 40")
  })

  test("rows the preview has not counted yet are pending, not zero", () => {
    const more: SegmentFilter[] = [...DRAFT_ROADMAP.filters, { key: "followers_min", value: 5000 }]
    const v = countViews(more, PREVIEW_ROADMAP.breakdown)
    expect(v[3]).toMatchObject({ pending: true, count: "…" })
    expect(countText(v[3])).toBe("…")
    // A breakdown out of step with the rows (the agent reordered them) is not borrowed.
    expect(countViews([{ key: "comment_contains", value: "x" }], PREVIEW_ROADMAP.breakdown)[0].pending).toBe(true)
    expect(countViews(DRAFT_ROADMAP.filters, undefined).every((x) => x.pending)).toBe(true)
  })
})

describe("members", () => {
  test("what the platform does not hold is a dash, not a 0", () => {
    const [a, b, c] = PREVIEW_ROADMAP.members.data.map(memberCells)
    expect(a).toMatchObject({ handle: "@example.one", niche: "—", role: "—", city: "—", followers: "0" })
    expect(b).toMatchObject({ niche: "Course creator", role: "Founder", city: "Austin", followers: "12,400" })
    expect(c).toMatchObject({ handle: "—", comment: "—", followers: "—" })
  })
})

describe("saved or not", () => {
  test("a draft equal to what was saved has nothing unsaved", () => {
    const filters = DRAFT_ROADMAP.filters
    const saved = JSON.stringify({ name: "Roadmap", filters })
    expect(draftUnsaved({ name: "Roadmap", filters, saved })).toBe(false)
    expect(draftUnsaved({ name: "Roadmap 2", filters, saved })).toBe(true)
    expect(draftUnsaved({ name: "Roadmap", filters: filters.slice(1), saved })).toBe(true)
    expect(draftUnsaved({ name: "", filters: [], saved: null })).toBe(true)
  })
})

describe("Today's empty state", () => {
  const conv = (needsReply: boolean) => ({ key: "c", name: "A", preview: "hi", channel: "ig", lastAt: "2026-11-14", needsReply }) as unknown as Conversation
  const batch = (counts: Record<string, number>) => ({ id: 1, name: "b", counts, starts_at: null }) as unknown as ReviewBatch

  test("shows only when no replies wait and nothing is in review", () => {
    expect(todayIsClear([], [])).toBe(true)
    expect(todayIsClear([conv(false)], [batch({ sent: 4 })])).toBe(true)
  })
  test("a reply waiting, or a draft in review, is not clear", () => {
    expect(todayIsClear([conv(true)], [])).toBe(false)
    expect(todayIsClear([], [batch({ pending_approval: 2 })])).toBe(false)
  })
  test("a read that failed is not a clear day", () => {
    expect(todayIsClear(undefined, [])).toBe(false)
    expect(todayIsClear([], undefined)).toBe(false)
  })
})
