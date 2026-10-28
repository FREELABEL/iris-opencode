import { describe, expect, test } from "bun:test"
import { close, maxColumns, open, reconcile, visible, type PaneRef } from "./split-model"

const p = (id: string, server = "local"): PaneRef => ({ server, sessionId: id })

describe("split model (#191484)", () => {
  test("columns come from width, capped at 3", () => {
    expect(maxColumns(700)).toBe(1)
    expect(maxColumns(1000)).toBe(2)
    expect(maxColumns(1460)).toBe(3)
    expect(maxColumns(4000)).toBe(3)
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
})
