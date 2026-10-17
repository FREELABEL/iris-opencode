import { describe, expect, test } from "bun:test"
import { ATLAS_VIEW_DEFAULT, applyAtlasView, atlasDropPosition, isDone, moveAtlasItem, readAtlasLayout, readAtlasView, relativeTime } from "./iris-atlas-view"

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

describe("board view — moving a card (#189723)", () => {
  const board = [
    { id: 1, name: "To do", items: [{ id: 10, title: "a" }, { id: 11, title: "b" }, { id: 12, title: "c" }] },
    { id: 2, name: "Doing", items: [{ id: 20, title: "x" }] },
    { id: 3, name: "Done", items: [] as { id: number; title: string }[] },
  ]
  const shape = (r: typeof board) => r.map((l) => l.items.map((i) => i.id))

  test("onto a card in another column: lands in front of it", () => {
    expect(shape(moveAtlasItem(board, { itemId: 11, toListId: 2, beforeId: 20 }))).toEqual([[10, 12], [11, 20], []])
  })
  test("onto a column: lands at the end, including an empty column", () => {
    expect(shape(moveAtlasItem(board, { itemId: 10, toListId: 3, beforeId: null }))).toEqual([[11, 12], [20], [10]])
    expect(shape(moveAtlasItem(board, { itemId: 10, toListId: 2, beforeId: null }))).toEqual([[11, 12], [20, 10], []])
  })
  test("within a column: reorders without duplicating", () => {
    expect(shape(moveAtlasItem(board, { itemId: 12, toListId: 1, beforeId: 10 }))).toEqual([[12, 10, 11], [20], []])
  })
  test("dropped on itself, or an unknown card/list: nothing changes", () => {
    expect(moveAtlasItem(board, { itemId: 11, toListId: 1, beforeId: 11 })).toBe(board)
    expect(moveAtlasItem(board, { itemId: 99, toListId: 1, beforeId: null })).toBe(board)
    expect(moveAtlasItem(board, { itemId: 10, toListId: 99, beforeId: null })).toBe(board)
  })
  test("the saved position matches where the board shows it", () => {
    for (const drop of [
      { itemId: 11, toListId: 2, beforeId: 20 },
      { itemId: 10, toListId: 3, beforeId: null },
      { itemId: 12, toListId: 1, beforeId: 10 },
      { itemId: 10, toListId: 1, beforeId: null },
    ]) {
      const after = moveAtlasItem(board, drop).find((l) => l.id === drop.toListId)!
      expect(atlasDropPosition(board, drop)).toBe(after.items.findIndex((i) => i.id === drop.itemId))
    }
  })
  test("position is counted on the FULL list, not the filtered one", () => {
    // With "open" on, the board shows only 12 in column 1; dropping in front of 12 is position 2.
    expect(atlasDropPosition(board, { itemId: 20, toListId: 1, beforeId: 12 })).toBe(2)
  })
  test("an unknown target has no position, so nothing is sent", () => {
    expect(atlasDropPosition(board, { itemId: 10, toListId: 99, beforeId: null })).toBeNull()
    expect(atlasDropPosition(board, { itemId: 10, toListId: 2, beforeId: 999 })).toBeNull()
  })
  test("layout reads back only a known value", () => {
    expect(readAtlasLayout("board")).toBe("board")
    expect(readAtlasLayout("kanban")).toBe("list")
    expect(readAtlasLayout(null)).toBe("list")
  })
})
