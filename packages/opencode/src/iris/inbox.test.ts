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
    expect(countInbox("")).toEqual({ unread: 0, total: 0, unreadable: false })
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
  })
})
