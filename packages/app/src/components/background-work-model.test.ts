import { describe, expect, test } from "bun:test"
import { backgroundRows } from "./background-work-model"

const sessions: Record<string, { id: string; title?: string; parentID?: string }> = {
  a: { id: "a", title: "Receipts to books" },
  b: { id: "b", title: "Genesis rebuild" },
  c: { id: "c", title: "Review changes", parentID: "a" },
  d: { id: "d" },
  me: { id: "me", title: "This chat" },
}
const base = {
  info: (id: string) => sessions[id],
  untitled: "New chat",
}

describe("backgroundRows", () => {
  test("lists running sessions except the one being viewed, matching the chip's count", () => {
    const status = { a: { type: "busy" }, b: { type: "idle" }, me: { type: "busy" } }
    const rows = backgroundRows({ ...base, status, working: (id) => status[id as keyof typeof status]?.type !== "idle", current: "me" })
    expect(rows.map((r) => r.id)).toEqual(["a"])
  })

  test("a sub-agent names its parent chat and sorts after top-level chats", () => {
    const status = { c: { type: "busy" }, b: { type: "busy" } }
    const rows = backgroundRows({ ...base, status, working: () => true })
    expect(rows.map((r) => r.id)).toEqual(["b", "c"])
    expect(rows[1]).toMatchObject({ subagent: true, parent: "Receipts to books" })
  })

  test("an untitled session and a retry are labelled, never blank", () => {
    const status = { d: { type: "retry" } }
    const rows = backgroundRows({ ...base, status, working: () => true })
    expect(rows[0]).toMatchObject({ title: "New chat", retrying: true })
  })

  test("nothing running gives an empty list", () => {
    expect(backgroundRows({ ...base, status: {}, working: () => true })).toEqual([])
  })
})
