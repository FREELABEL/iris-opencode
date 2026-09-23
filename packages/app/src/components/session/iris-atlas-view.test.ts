import { describe, expect, test } from "bun:test"
import { ATLAS_VIEW_DEFAULT, applyAtlasView, isDone, readAtlasView, relativeTime } from "./iris-atlas-view"

const NOW = Date.parse("2026-09-23T12:00:00Z")
const ago = (h: number) => new Date(NOW - h * 3_600_000).toISOString()

const lists = [
  {
    id: 1,
    name: "Signals",
    items: [
      { id: 10, title: "beta", status: "active", createdAt: ago(500), updatedAt: ago(2) },
      { id: 11, title: "Alpha", status: "completed", createdAt: ago(100), updatedAt: ago(200) },
      { id: 12, title: "gamma", status: "active", createdAt: ago(10), updatedAt: undefined },
      { id: 13, title: "delta", status: "active" },
    ],
  },
  { id: 2, name: "Ideas", items: [] },
]
const ids = (r: typeof lists) => r.map((l) => l.items.map((i) => i.id))

describe("applyAtlasView", () => {
  test("board order is the identity", () => {
    expect(ids(applyAtlasView(lists, ATLAS_VIEW_DEFAULT, NOW))).toEqual([[10, 11, 12, 13], []])
  })
  test("last edited: newest edit first, undated last", () => {
    expect(ids(applyAtlasView(lists, { ...ATLAS_VIEW_DEFAULT, sort: "edited" }, NOW))[0]).toEqual([10, 11, 12, 13])
  })
  test("newest / oldest by created, undated last in both", () => {
    expect(ids(applyAtlasView(lists, { ...ATLAS_VIEW_DEFAULT, sort: "newest" }, NOW))[0]).toEqual([12, 11, 10, 13])
    expect(ids(applyAtlasView(lists, { ...ATLAS_VIEW_DEFAULT, sort: "oldest" }, NOW))[0]).toEqual([10, 11, 12, 13])
  })
  test("title ignores case", () => {
    expect(ids(applyAtlasView(lists, { ...ATLAS_VIEW_DEFAULT, sort: "title" }, NOW))[0]).toEqual([11, 10, 13, 12])
  })
  test("status filters agree with the ✓ mark", () => {
    expect(ids(applyAtlasView(lists, { ...ATLAS_VIEW_DEFAULT, status: "done" }, NOW))[0]).toEqual([11])
    expect(ids(applyAtlasView(lists, { ...ATLAS_VIEW_DEFAULT, status: "open" }, NOW))[0]).toEqual([10, 12, 13])
  })
  test("edited window uses updatedAt, falls back to createdAt, drops undated", () => {
    expect(ids(applyAtlasView(lists, { ...ATLAS_VIEW_DEFAULT, edited: "24h" }, NOW))[0]).toEqual([10, 12])
    expect(ids(applyAtlasView(lists, { ...ATLAS_VIEW_DEFAULT, edited: "30d" }, NOW))[0]).toEqual([10, 11, 12])
  })
  test("hide empty lists, including lists a filter emptied", () => {
    expect(applyAtlasView(lists, { ...ATLAS_VIEW_DEFAULT, hideEmpty: true }, NOW).map((l) => l.id)).toEqual([1])
    const r = applyAtlasView(lists, { ...ATLAS_VIEW_DEFAULT, status: "done", edited: "24h", hideEmpty: true }, NOW)
    expect(r).toEqual([])
  })
  test("never mutates the input", () => {
    applyAtlasView(lists, { ...ATLAS_VIEW_DEFAULT, sort: "title" }, NOW)
    expect(lists[0].items.map((i) => i.id)).toEqual([10, 11, 12, 13])
  })
})

describe("relativeTime", () => {
  test("buckets", () => {
    expect(relativeTime(ago(0), NOW)).toBe("just now")
    expect(relativeTime(ago(0.5), NOW)).toBe("30m")
    expect(relativeTime(ago(3), NOW)).toBe("3h")
    expect(relativeTime(ago(50), NOW)).toBe("2d")
    expect(relativeTime(ago(24 * 20), NOW)).toBe("2w")
    expect(relativeTime(undefined, NOW)).toBe("")
    expect(relativeTime("garbage", NOW)).toBe("")
  })
})

test("isDone", () => {
  expect(isDone("Completed")).toBe(true)
  expect(isDone("active")).toBe(false)
  expect(isDone(undefined)).toBe(false)
})

test("readAtlasView drops unknown values", () => {
  expect(readAtlasView('{"sort":"edited","status":"bogus","hideEmpty":true}')).toEqual({
    sort: "edited",
    status: "all",
    edited: "any",
    hideEmpty: true,
  })
  expect(readAtlasView("not json")).toEqual(ATLAS_VIEW_DEFAULT)
  expect(readAtlasView(null)).toEqual(ATLAS_VIEW_DEFAULT)
})
