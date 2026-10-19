import { describe, expect, test } from "bun:test"
import {
  ATLAS_VIEW_DEFAULT,
  applyAtlasView,
  atlasCountLine,
  atlasDropPosition,
  boardLabels,
  cardPreview,
  changedItemIds,
  dueLabel,
  dueState,
  initials,
  editedSince,
  isDefaultView,
  isDone,
  keepUnchanged,
  moveAtlasItem,
  readAtlasLayout,
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
    ...ATLAS_VIEW_DEFAULT,
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
  test("a structured body shows its prose, never its JSON", () => {
    expect(cardPreview(JSON.stringify({ text: "The plan", body: "The plan in full", labels: ["x"] }), "Card")).toBe("The plan in full")
    expect(cardPreview(JSON.stringify({ text: "Card", labels: ["x"], attachments: [{}] }), "Card")).toBe("")
    expect(cardPreview("{not json", "Card")).toBe("{not json")
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
  test("Board is the default; List only when chosen; anything else is Board", () => {
    expect(readAtlasLayout(null)).toBe("board")
    expect(readAtlasLayout("board")).toBe("board")
    expect(readAtlasLayout("kanban")).toBe("board")
    expect(readAtlasLayout("list")).toBe("list")
  })
})

describe("card face: due dates and avatars (#189806)", () => {
  const NOW = Date.parse("2026-10-17T09:00:00")
  test("a date-only due date is the end of that day", () => {
    expect(dueState("2026-10-17", NOW)).toBe("soon")
    expect(dueState("2026-10-16", NOW)).toBe("overdue")
    expect(dueState("2026-10-18", NOW)).toBe("soon")
    expect(dueState("2026-10-25", NOW)).toBe("later")
    expect(dueState(undefined, NOW)).toBeUndefined()
    expect(dueState("not a date", NOW)).toBeUndefined()
  })
  test("fl-api's midnight-UTC due date is the date it names, not the evening before", () => {
    expect(dueState("2026-10-17T00:00:00.000000Z", NOW)).toBe("soon")
    expect(dueLabel("2026-10-18T00:00:00.000000Z", NOW)).toBe("Tomorrow")
    expect(dueState("2026-10-16T00:00:00.000000Z", NOW)).toBe("overdue")
  })
  test("labels read like a person would say them", () => {
    expect(dueLabel("2026-10-17", NOW)).toBe("Today")
    expect(dueLabel("2026-10-18", NOW)).toBe("Tomorrow")
    expect(dueLabel("2026-10-16", NOW)).toBe("Yesterday")
  })
  test("initials", () => {
    expect(initials("Ana Pérez")).toBe("AP")
    expect(initials("elon")).toBe("EL")
    expect(initials("alex@freelabel.net")).toBe("AN")
    expect(initials(undefined)).toBe("?")
  })
})

describe("filters: label, assignee, due, files (#189798)", () => {
  const NOW = Date.parse("2026-10-19T12:00:00")
  const card = (id: number, f: any = {}) => ({ id, title: `c${id}`, ...f })
  const board = [
    {
      id: 1,
      name: "A",
      items: [
        card(1, { labels: ["bug"], assignees: [{ type: "user", userId: 193 }], dueDate: "2026-10-18T00:00:00.000000Z", attachments: 2 }),
        card(2, { labels: ["design", "bug"], dueDate: "2026-10-22" }),
        card(3, { assignees: [{ type: "agent", agentId: 9 }], dueDate: "2026-11-30" }),
        card(4, {}),
      ],
    },
  ]
  const ids = (o: any, me?: number | null) =>
    applyAtlasView(board as any, { ...ATLAS_VIEW_DEFAULT, ...o }, NOW, me)[0].items.map((i: any) => i.id)

  test("label", () => expect(ids({ label: "bug" })).toEqual([1, 2]))
  test("assigned to me, nobody; an agent assignee is not 'me'", () => {
    expect(ids({ assigned: "me" }, 193)).toEqual([1])
    expect(ids({ assigned: "none" })).toEqual([2, 4])
  })
  test("'me' with no known user matches nothing, not everything", () => expect(ids({ assigned: "me" }, null)).toEqual([]))
  test("due: overdue, next 7 days, no date", () => {
    expect(ids({ due: "overdue" })).toEqual([1])
    expect(ids({ due: "week" })).toEqual([2])
    expect(ids({ due: "none" })).toEqual([4])
  })
  test("has files", () => expect(ids({ hasFiles: true })).toEqual([1]))
  test("filters combine", () => expect(ids({ label: "bug", hasFiles: true, assigned: "me" }, 193)).toEqual([1]))
  test("the label picker offers only labels in use, A-Z", () => expect(boardLabels(board as any)).toEqual(["bug", "design"]))
  test("a stored view from before these filters still reads; garbage falls back to any", () => {
    expect(readAtlasView(JSON.stringify({ sort: "title" }))).toEqual({ ...ATLAS_VIEW_DEFAULT, sort: "title" })
    expect(readAtlasView(JSON.stringify({ assigned: "everyone", due: 5, label: 3 }))).toEqual(ATLAS_VIEW_DEFAULT)
  })
  test("any filter set is not the default view", () => {
    expect(isDefaultView({ ...ATLAS_VIEW_DEFAULT, hasFiles: true })).toBe(false)
    expect(isDefaultView(ATLAS_VIEW_DEFAULT)).toBe(true)
  })
})
