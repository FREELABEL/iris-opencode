import { describe, expect, test } from "bun:test"
import { listSummary } from "./platform-bloqs"

/** #190329 — no command returned a list id, so the missing read blocked the writes. */
describe("bloqs lists", () => {
  test("keeps id, name and the declared item count", () => {
    expect(listSummary([{ id: 1051, name: "Bug Reports", items_count: 258 }])).toEqual([
      { id: 1051, name: "Bug Reports", item_count: 258 },
    ])
  })

  test("falls back to counting nested items when no count is declared", () => {
    expect(listSummary([{ id: 7, name: "Journal", items: [{ id: 1 }, { id: 2 }] }])).toEqual([
      { id: 7, name: "Journal", item_count: 2 },
    ])
  })

  test("a list with nothing in it is 0, not undefined", () => {
    expect(listSummary([{ id: 8, name: "Empty" }])[0].item_count).toBe(0)
  })

  test("a malformed payload yields no lists instead of throwing", () => {
    expect(listSummary(undefined)).toEqual([])
    expect(listSummary({ data: [] })).toEqual([])
  })
})
