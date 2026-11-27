import { describe, expect, test } from "bun:test"
import { leadSummary } from "./iris-leads-model"

// #194358 — opening a lead shows its value and the newest note a person wrote, before anything else.
describe("leadSummary", () => {
  test("value as money, latest person-written note, system lines skipped", () => {
    const s = leadSummary({
      price_bid: "40000.00",
      notes: [
        { id: 1, content: "Intro call booked.", created_at: "2026-11-21T10:00:00Z" },
        { id: 2, content: "Wants a pilot for 3 clinics.", created_at: "2026-11-24T16:30:00Z" },
        { id: 3, content: "Lead status changed to Qualified", created_at: "2026-11-24T16:31:00Z", is_system_generated: true },
      ] as any,
    })
    expect(s.value).toBe("$40,000")
    expect(s.note).toEqual({ text: "Wants a pilot for 3 clinics.", at: "2026-11-24T16:30:00Z" })
  })

  test("nothing to say renders nothing — no $0, no empty note", () => {
    expect(leadSummary({ price_bid: 0, notes: [] })).toEqual({})
    expect(leadSummary({ price_bid: null })).toEqual({})
    expect(leadSummary({ notes: [{ id: 1, content: "  ", created_at: "2026-11-24" }] as any })).toEqual({})
  })

  test("a long note is cut", () => {
    const s = leadSummary({ notes: [{ id: 1, content: "a".repeat(500), created_at: "2026-11-24" }] as any }, 200)
    expect(s.note!.text.length).toBe(200)
  })
})
