import { describe, expect, test } from "bun:test"
import { countInbox } from "./platform"

const row = (o: Record<string, unknown>) => JSON.stringify(o)

describe("countInbox", () => {
  test("counts unread and names the newest sender", () => {
    const raw = [
      row({ read: true, from_node: "old", received_at: "2026-09-01T00:00:00Z" }),
      row({ read: false, from_node: "MacBookPro", received_at: "2026-09-11T00:00:00Z" }),
      row({ read: false, from_node: "newest", received_at: "2026-09-12T00:00:00Z" }),
    ].join("\n")
    const s = countInbox(raw)
    expect(s.unread).toBe(2)
    expect(s.total).toBe(3)
    expect(s.from).toBe("newest")
    expect(s.unreadable).toBe(false)
  })

  test("an empty manifest is a genuine zero", () => {
    expect(countInbox("")).toEqual({ unread: 0, total: 0, unreadable: false, items: [], unparsed: 0 })
  })

  test("a fully corrupt manifest is NOT an empty one", () => {
    // This is the whole point of the null. Returning 0 here reports "nothing waiting" for a
    // file we could not parse, and the badge goes quiet exactly when something is wrong.
    const s = countInbox("not json\nalso not json")
    expect(s.unread).toBeNull()
    expect(s.unreadable).toBe(true)
  })

  test("a partially corrupt manifest still counts what it can, and does not claim to be broken", () => {
    const s = countInbox(["garbage", row({ read: false, from_node: "a" })].join("\n"))
    expect(s.unread).toBe(1)
    expect(s.unreadable).toBe(false)
    // And it says what it dropped. A shorter list with no explanation is the silent undercount.
    expect(s.unparsed).toBe(1)
    expect(s.items).toHaveLength(1)
  })

  test("item indexes are MANIFEST positions, not positions in the returned array", () => {
    // The number is what `iris hive inbox read <n>` takes. Renumbering the rows we kept — after
    // dropping a corrupt one, or after sorting unread to the top — prints a number that opens a
    // different message.
    const s = countInbox(
      [
        row({ read: true, type: "message", message: "first", received_at: "2026-09-01T00:00:00Z" }),
        "garbage",
        row({ read: false, type: "message", message: "third", received_at: "2026-09-03T00:00:00Z" }),
      ].join("\n"),
    )
    expect(s.items.map((i) => i.index)).toEqual([3, 1])
    expect(s.items[0].label).toBe("third")
  })
})
