import { describe, expect, test } from "bun:test"
import { atlasFingerprint } from "../../src/iris/atlas-live"

const board = () => [
  {
    id: 1,
    name: "Todo",
    sort_order: 0,
    items: [
      { id: 10, bloq_list_id: 1, sort_order: 0, status: "active", title: "A", updated_at: "2026-10-17T08:00:00Z" },
      { id: 11, bloq_list_id: 1, sort_order: 1, status: "active", title: "B", updated_at: "2026-10-17T08:00:00Z" },
    ],
  },
  { id: 2, name: "Done", sort_order: 1, items: [] as any[] },
]

describe("atlasFingerprint (#189767)", () => {
  test("the same board served in a different order is the same board", () => {
    const a = board()
    const b = board().reverse()
    b[1].items.reverse()
    expect(atlasFingerprint(b)).toBe(atlasFingerprint(a))
  })

  test("everything a person can see change, changes it", () => {
    const base = atlasFingerprint(board())
    const edits: ((b: ReturnType<typeof board>) => void)[] = [
      (b) => (b[0].items[0].title = "A2"),
      (b) => (b[0].items[0].status = "done"),
      (b) => (b[0].items[0].updated_at = "2026-10-17T09:00:00Z"),
      (b) => (b[0].items[0].sort_order = 5),
      (b) => (b[0].name = "Doing"),
      (b) => (b[1].sort_order = 9),
      (b) => b[1].items.push({ id: 12, bloq_list_id: 2, sort_order: 0, status: "active", title: "C", updated_at: "x" }),
      (b) => b[0].items.pop(),
      // a card moved between lists
      (b) => b[1].items.push({ ...b[0].items.shift()!, bloq_list_id: 2 }),
    ]
    for (const edit of edits) {
      const b = board()
      edit(b)
      expect(atlasFingerprint(b)).not.toBe(base)
    }
  })

  test("a soft-deleted card is not on the board", () => {
    const b = board()
    ;(b[0].items[1] as any).deleted_at = "2026-10-17T09:00:00Z"
    const without = board()
    without[0].items.pop()
    expect(atlasFingerprint(b)).toBe(atlasFingerprint(without))
  })
})
