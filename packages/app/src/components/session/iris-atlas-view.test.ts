import { describe, expect, test } from "bun:test"
import {
  ATLAS_VIEW_DEFAULT,
  applyAtlasView,
  atlasCountLine,
  cardPreview,
  changedItemIds,
  editedSince,
  isDone,
  keepUnchanged,
  readAtlasView,
  relativeTime,
} from "./iris-atlas-view"

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

describe("live: what changed (#189767)", () => {
  const list = (id: number, items: any[]) => ({ id, name: `L${id}`, items })
  const card = (id: number, over: any = {}) => ({ id, title: `c${id}`, status: "active", updatedAt: "2026-10-17T08:00:00Z", ...over })

  test("a new card, an edited card and a moved card are changed; an untouched one is not", () => {
    const prev = [list(1, [card(1), card(2), card(3)]), list(2, [])]
    const next = [list(1, [card(1), card(2, { updatedAt: "2026-10-17T09:00:00Z" })]), list(2, [card(3), card(4)])]
    expect([...changedItemIds(prev, next)].sort()).toEqual([2, 3, 4])
  })

  test("a status flip with the same edit time still counts", () => {
    expect([...changedItemIds([list(1, [card(1)])], [list(1, [card(1, { status: "done" })])])]).toEqual([1])
  })

  test("the same board twice changes nothing", () => {
    const b = [list(1, [card(1), card(2)])]
    expect(changedItemIds(b, structuredClone(b)).size).toBe(0)
  })

  test("edited since: only cards after the mark; no mark means nothing is new", () => {
    const b = [list(1, [card(1, { updatedAt: "2026-10-17T07:00:00Z" }), card(2, { updatedAt: "2026-10-17T09:00:00Z" })])]
    expect([...editedSince(b, "2026-10-17T08:00:00Z")]).toEqual([2])
    expect(editedSince(b, null).size).toBe(0)
  })
})

describe("row preview (#189764)", () => {
  test("markdown becomes one plain line", () => {
    const body = "# Heading\n\nSome **bold** and a [link](https://x.y).\n\n- item one\n- item two\n\n```js\ncode()\n```"
    expect(cardPreview(body, "Card")).toBe("Heading Some bold and a link. item one item two")
  })
  test("a body that only repeats the title says nothing", () => {
    expect(cardPreview("# Fix the footer", "Fix the footer")).toBe("")
    expect(cardPreview("Fix the footer — it prints 6", "Fix the footer")).toBe("it prints 6")
  })
  test("a first line that is a shorter or longer copy of the title is dropped", () => {
    expect(cardPreview("# EPIC — Links open inside IRIS Desktop\n\nThe goal, as said", "EPIC — Links open inside IRIS Desktop (#187864)")).toBe("The goal, as said")
    expect(cardPreview("RELEASE — ship it, then tell her\nUntil then nothing", "RELEASE — ship it")).toBe("then tell her Until then nothing")
  })
  test("long bodies are cut with an ellipsis; empty stays empty", () => {
    expect(cardPreview("x ".repeat(200), "t", 20).length).toBe(20)
    expect(cardPreview(undefined, "t")).toBe("")
  })
})

describe("footer in nouns (#189770)", () => {
  const l = (n: number) => ({ id: n, name: `L${n}`, items: Array.from({ length: n }, (_, i) => ({ id: n * 100 + i, title: "t" })) })
  test("the screenshot board: six lists, nine cards", () => {
    const lists = [l(3), l(5), l(0), l(0), l(0), l(1)]
    expect(atlasCountLine(lists, lists)).toBe("6 lists · 9 cards")
  })
  test("filters say how many are showing", () => {
    expect(atlasCountLine([l(3), l(5)], [l(3)])).toBe("2 lists · 8 cards · showing 3")
  })
  test("more lists on the server are counted as such", () => {
    expect(atlasCountLine([l(1)], [l(1)], { total: 40, hasMore: true })).toBe("1 of 40 lists · 1 card")
  })
})

describe("keepUnchanged (#189767)", () => {
  const card = (id: number, t = "x") => ({ id, title: t, status: "active", updatedAt: "2026-10-17T08:00:00Z" })
  test("unchanged cards and lists keep their objects; a changed card gets a new one and so does its list", () => {
    const prev = [
      { id: 1, name: "A", items: [card(1), card(2)] },
      { id: 2, name: "B", items: [card(3)] },
    ]
    const next = [
      { id: 1, name: "A", items: [card(1), card(2, "edited")] },
      { id: 2, name: "B", items: [card(3)] },
    ]
    const out = keepUnchanged(prev, next)
    expect(out[0].items[0]).toBe(prev[0].items[0])
    expect(out[0].items[1]).not.toBe(prev[0].items[1])
    expect(out[0].items[1].title).toBe("edited")
    expect(out[0]).not.toBe(prev[0])
    expect(out[1]).toBe(prev[1])
  })
  test("a card that moved lists keeps its object, and both lists change", () => {
    const prev = [{ id: 1, name: "A", items: [card(1)] }, { id: 2, name: "B", items: [] as any[] }]
    const next = [{ id: 1, name: "A", items: [] as any[] }, { id: 2, name: "B", items: [card(1)] }]
    const out = keepUnchanged(prev, next)
    expect(out[1].items[0]).toBe(prev[0].items[0])
    expect(out[0]).not.toBe(prev[0])
    expect(out[1]).not.toBe(prev[1])
  })
})
