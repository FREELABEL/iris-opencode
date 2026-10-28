import { describe, expect, test } from "bun:test"
import { close, closeColumn, dropSlot, finalSlot, insertIndex, previewBox, openAt, maxColumns, open, paneKey, prune, reconcile, visible, type PaneRef } from "./split-model"

const p = (id: string, server = "local"): PaneRef => ({ server, sessionId: id })

describe("split model (#191484)", () => {
  test("columns come from width, capped at 3", () => {
    expect(maxColumns(700)).toBe(1)
    expect(maxColumns(1000)).toBe(2)
    expect(maxColumns(1460)).toBe(3)
    expect(maxColumns(4000)).toBe(3)
    // a hidden row measures 0 — that is not a narrow window
    expect(maxColumns(0)).toBe(3)
  })

  test("opening seeds the split with the focused session and puts the new one to its right", () => {
    expect(open([], p("a"), p("b"))).toEqual([p("a"), p("b")])
    expect(open([p("a"), p("c")], p("a"), p("b"))).toEqual([p("a"), p("b"), p("c")])
    expect(open([p("a"), p("b")], p("a"), p("b"))).toEqual([p("a"), p("b")])
    expect(open([p("a"), p("b"), p("c")], p("c"), p("d"))).toHaveLength(3)
  })

  test("the same session id on another server is another column", () => {
    expect(open([], p("a"), p("a", "remote"))).toEqual([p("a"), p("a", "remote")])
  })

  test("closing down to one column ends the split", () => {
    expect(close([p("a"), p("b")], p("b"))).toEqual([])
    expect(close([p("a"), p("b"), p("c")], p("b"))).toEqual([p("a"), p("c")])
  })

  test("a route outside the split replaces the column you were last in; inside it only moves focus", () => {
    const split = [p("a"), p("b"), p("c")]
    expect(reconcile(split, p("b"), 0)).toBe(split)
    expect(reconcile(split, p("x"), 1)).toEqual([p("a"), p("x"), p("c")])
    expect(reconcile([], p("x"), 0)).toEqual([])
  })

  test("when not every column fits, the focused one is always drawn", () => {
    const split = [p("a"), p("b"), p("c")]
    expect(visible(split, p("a"), 2)).toEqual([p("a"), p("b")])
    expect(visible(split, p("b"), 2)).toEqual([p("a"), p("b")])
    expect(visible(split, p("c"), 2)).toEqual([p("b"), p("c")])
    expect(visible(split, p("c"), 1)).toEqual([p("c")])
  })

  test("a column whose tab closed goes; the route's own session stays even before its tab exists", () => {
    const split = [p("a"), p("b"), p("c")]
    const tabs = (...ids: string[]) => new Set(ids.map((id) => paneKey(p(id))))
    expect(prune(split, p("a"), tabs("a", "b", "c"))).toBe(split)
    expect(prune(split, p("a"), tabs("a", "c"))).toEqual([p("a"), p("c")])
    expect(prune(split, p("a"), tabs("b"))).toEqual([p("a"), p("b")])
    expect(prune(split, p("a"), tabs())).toEqual([])
  })

  test("closing the focused column hands focus to its neighbour, even when that ends the split", () => {
    const split = [p("a"), p("b"), p("c")]
    expect(closeColumn(split, p("b"), p("b"))).toEqual({ panes: [p("a"), p("c")], focus: p("c") })
    expect(closeColumn(split, p("c"), p("c"))).toEqual({ panes: [p("a"), p("b")], focus: p("b") })
    expect(closeColumn(split, p("a"), p("b"))).toEqual({ panes: [p("b"), p("c")] })
    expect(closeColumn([p("a"), p("b")], p("a"), p("a"))).toEqual({ panes: [], focus: p("b") })
  })

  test("a dropped tab lands at the slot it was dropped on, seeding a split from one column", () => {
    expect(openAt([], p("a"), p("b"), 0)).toEqual([p("b"), p("a")])
    expect(openAt([], p("a"), p("b"), 1)).toEqual([p("a"), p("b")])
    expect(openAt([p("a"), p("c")], p("a"), p("b"), 1)).toEqual([p("a"), p("b"), p("c")])
    expect(openAt([p("a"), p("c")], p("a"), p("b"), 9)).toEqual([p("a"), p("c"), p("b")])
    // dropping a session already in the split moves it there instead of duplicating it
    expect(openAt([p("a"), p("b"), p("c")], p("a"), p("c"), 0)).toEqual([p("c"), p("a"), p("b")])
  })

  test("the drop slot is the half of the column under the pointer", () => {
    const cols = [{ left: 0, right: 500 }, { left: 508, right: 1000 }]
    expect(dropSlot(cols, 100)).toEqual({ column: 0, side: "left", index: 0 })
    expect(dropSlot(cols, 400)).toEqual({ column: 0, side: "right", index: 1 })
    expect(dropSlot(cols, 600)).toEqual({ column: 1, side: "left", index: 1 })
    expect(dropSlot(cols, 990)).toEqual({ column: 1, side: "right", index: 2 })
    expect(dropSlot(cols, 5000)).toEqual({ column: 1, side: "right", index: 2 })
    expect(dropSlot([], 10)).toBeUndefined()
  })

  test("the preview is the column the drop creates: halves from one, thirds from two", () => {
    expect(previewBox(1008, 2, 1)).toEqual({ left: 508, width: 500 })
    const third = (1016 - 16) / 3
    expect(previewBox(1016, 3, 0)).toEqual({ left: 0, width: third })
    expect(previewBox(1016, 3, 1)).toEqual({ left: third + 8, width: third })
    expect(previewBox(1016, 3, 2)).toEqual({ left: 2 * (third + 8), width: third })
  })

  test("make room: the slot is read against the final layout, so it does not move while columns slide", () => {
    // one chat, dragging a second in: halves
    expect(finalSlot(1000, 2, 200)).toBe(0)
    expect(finalSlot(1000, 2, 700)).toBe(1)
    // two chats, dragging a third in: thirds
    expect(finalSlot(900, 3, 100)).toBe(0)
    expect(finalSlot(900, 3, 450)).toBe(1)
    expect(finalSlot(900, 3, 899)).toBe(2)
    expect(finalSlot(900, 3, 5000)).toBe(2)
    expect(finalSlot(0, 3, 100)).toBe(0)
  })

  test("make room: a visible slot maps to the stored split around it", () => {
    const split = [p("a"), p("b")]
    expect(insertIndex(split, split, 0)).toBe(0) // before a
    expect(insertIndex(split, split, 1)).toBe(1) // between a and b
    expect(insertIndex(split, split, 2)).toBe(2) // after b
    expect(insertIndex([p("a")], [p("a")], 1)).toBe(1) // from one column: to its right
    // when not every column is drawn, the slot is relative to what is
    expect(insertIndex([p("a"), p("b"), p("c")], [p("b"), p("c")], 0)).toBe(1)
  })
})
