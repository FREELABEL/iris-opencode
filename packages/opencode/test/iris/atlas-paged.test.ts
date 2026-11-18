import { describe, expect, test } from "bun:test"
import {
  ATLAS_BIG,
  ATLAS_HEAD,
  pageSkeleton,
  skeletonTotal,
  type AtlasItem,
  type AtlasSkeleton,
} from "../../src/iris/platform"

// IRIS CLI Bug Reports (#297) in miniature: one huge list, a few small ones (#192670).
const skel: AtlasSkeleton = {
  version: "v2",
  containsPhi: false,
  lists: [
    { id: 1, name: "Bug Reports", items: Array.from({ length: 6917 }, (_, i) => ({ id: 1000 + i, rev: "r1" })) },
    {
      id: 2,
      name: "Todo",
      items: [
        { id: 1, rev: "a" },
        { id: 2, rev: "b" },
      ],
    },
  ],
}
const card = (id: number, rev = "r1"): AtlasItem => ({ id, title: `#${id}`, rev }) as AtlasItem

describe("big boards are read a page per list (#192670)", () => {
  test("the skeleton says how big a board is; past ATLAS_BIG it is paged", () => {
    expect(skeletonTotal(skel)).toBe(6919)
    expect(skeletonTotal(skel) > ATLAS_BIG).toBe(true)
  })

  test("a cold read fetches only each list's first page, and keeps the true total and the rest", () => {
    const plan = pageSkeleton(skel, () => ATLAS_HEAD)
    expect(plan.need.length).toBe(ATLAS_HEAD + 2)
    const lists = plan.build(new Map(plan.need.map((id) => [id, card(id)])))
    expect(lists[0].items.length).toBe(ATLAS_HEAD)
    expect(lists[0].total).toBe(6917)
    expect(lists[0].more.length).toBe(6917 - ATLAS_HEAD)
    expect(lists[0].more[0]).toBe(1000 + ATLAS_HEAD)
    expect(lists[1]).toMatchObject({ name: "Todo", total: 2, more: [] })
  })

  test("a refresh reuses held cards whose rev still matches and fetches only the ones that moved", () => {
    const held = new Map<number, AtlasItem>([
      [1000, card(1000)],
      [1001, card(1001, "old")],
      [1, card(1, "a")],
      [2, card(2, "b")],
    ])
    const plan = pageSkeleton(skel, (id) => (id === 1 ? 2 : ATLAS_HEAD), held)
    expect(plan.need).toEqual([1001])
  })

  test("what the person already loaded stays loaded on refresh", () => {
    const plan = pageSkeleton(skel, () => 120)
    expect(plan.build(new Map(plan.need.map((id) => [id, card(id)])))[0].items.length).toBe(120)
  })

  test("a card deleted between the two requests is absent, and the count stays the skeleton's", () => {
    const plan = pageSkeleton(skel, () => 3)
    const fetched = new Map(plan.need.filter((id) => id !== 1001).map((id) => [id, card(id)]))
    const lists = plan.build(fetched)
    expect(lists[0].items.map((i) => i.id)).toEqual([1000, 1002])
    expect(lists[0].total).toBe(6917)
  })

  test("a list name missing from the skeleton falls back to the held name", () => {
    const s: AtlasSkeleton = { ...skel, lists: [{ id: 9, items: [{ id: 5, rev: "x" }] }] }
    expect(
      pageSkeleton(s, () => 50, new Map(), new Map([[9, "Ideas"]])).build(new Map([[5, card(5, "x")]]))[0].name,
    ).toBe("Ideas")
  })
})
