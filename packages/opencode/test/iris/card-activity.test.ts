import { describe, expect, test } from "bun:test"
import { readActivity } from "../../src/iris/platform"

describe("a card's trail (#189799)", () => {
  test("keeps fl-api's rows in its order, in words, with who did it", () => {
    const rows = readActivity([
      { id: 2, type: "item_moved", content: "Moved from Todo to Done", icon: "➡️", actor: "Alex", created_at: "2026-10-19T20:00:00Z" },
      { id: 1, type: "item_assigned", content: "Assigned Sam", actor: null, created_at: "2026-10-19T19:00:00Z" },
    ])
    expect(rows).toEqual([
      { id: 2, type: "item_moved", text: "Moved from Todo to Done", icon: "➡️", actor: "Alex", at: "2026-10-19T20:00:00Z" },
      { id: 1, type: "item_assigned", text: "Assigned Sam", icon: undefined, actor: undefined, at: "2026-10-19T19:00:00Z" },
    ])
  })

  test("drops what it cannot read rather than showing an empty row", () => {
    expect(readActivity([{ id: "x", content: "a" }, { id: 3 }, null])).toEqual([])
    expect(readActivity(undefined)).toEqual([])
  })
})
