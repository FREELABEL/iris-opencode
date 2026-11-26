import { describe, expect, test } from "bun:test"
import { toLead } from "../../src/iris/platform"

// #194358 — the panel's lead had no deal value and no notes: a $40,000 lead with three notes read
// as "score 0, hot no". These pin what fl-api's list row (read with include_notes) turns into.
describe("toLead", () => {
  const row = {
    id: 32345,
    name: "Dana Whitfield",
    status: "Qualified",
    price_bid: "40000.00",
    notes_count: 3,
    notes: [
      { id: 1, content: "Intro call booked for Tuesday.", created_at: "2026-11-21T10:00:00Z" },
      { id: 2, content: "Sent pricing deck; wants a pilot.", created_at: "2026-11-24T16:30:00Z" },
      { id: 3, content: "Lead status changed to Qualified", created_at: "2026-11-24T16:31:00Z", is_system_generated: true },
    ],
  }

  test("carries the deal value as a number", () => {
    expect(toLead(row).bid).toBe(40000)
  })

  test("the latest note is the newest one a person wrote, not the system's status line", () => {
    const l = toLead(row)
    expect(l.latestNote).toEqual({ text: "Sent pricing deck; wants a pilot.", createdAt: "2026-11-24T16:30:00Z" })
    expect(l.noteCount).toBe(3)
  })

  test("a system line without the flag is still skipped", () => {
    const l = toLead({ id: 1, name: "x", notes: [{ content: "Attached to board Demo", created_at: "2026-11-25" }, { content: "Call back Friday", created_at: "2026-11-20" }] })
    expect(l.latestNote?.text).toBe("Call back Friday")
  })

  test("no value and no notes say nothing, rather than $0 or an empty note", () => {
    for (const price_bid of [null, "", 0, "0", "abc"]) expect(toLead({ id: 1, name: "x", price_bid }).bid).toBeUndefined()
    expect(toLead({ id: 1, name: "x", notes: [] }).latestNote).toBeUndefined()
    expect(toLead({ id: 1, name: "x" }).noteCount).toBeUndefined()
  })

  test("a long note is cut to 280 characters", () => {
    const l = toLead({ id: 1, name: "x", notes: [{ content: "a".repeat(1000), created_at: "2026-11-25" }] })
    expect(l.latestNote!.text.length).toBe(280)
    expect(l.latestNote!.text.endsWith("…")).toBe(true)
  })

  test("the fields the panel already read are unchanged", () => {
    const l = toLead({ id: "7", full_name: "Kim", lead_score: 82, lead_type: "business", keywords: { source: null }, has_replied: true })
    expect(l).toMatchObject({ id: 7, name: "Kim", hot: true, score: 82, type: "business", repliedAt: true })
    expect(l.keywords).toBeUndefined()
  })
})
