import { describe, expect, test } from "bun:test"
import { allowanceLine, endDate, inviteWords, seatLines } from "./licence"

const VIEW = {
  seats: 3,
  occupied: 1,
  owner_email: "owner@x.example.com",
  expires_at: "2026-12-01T00:00:00Z",
  allowance_cents: 5000,
  allowance_used_cents: 1250,
  named_only: true,
  holders: [{ seat_id: 7, user_id: 1, email: "ana@x.example.com", last_active: "2026-10-30T10:00:00Z", lead_id: 44 }],
  pending: [{ email: "bo@x.example.com" }],
  released: [{ seat_id: 6, user_id: 2, email: "gone@x.example.com", released_at: "2026-10-01T00:00:00Z" }],
}

describe("licence seat view", () => {
  test("prints holders, who is reserved for, expiry and allowance", () => {
    const text = seatLines(VIEW).join("\n")
    expect(text).toContain("1 of 3 held, 1 reserved")
    expect(text).toContain("owner@x.example.com")
    expect(text).toContain("2026-12-01")
    expect(text).toContain("$12.50 used of $50.00")
    expect(text).toContain("named people only")
    expect(text).toMatch(/seat 7\s+ana@x\.example\.com\s+last active 2026-10-30\s+lead #44/)
    expect(text).toMatch(/reserved\s+bo@x\.example\.com/)
    expect(text).toMatch(/seat 6\s+gone@x\.example\.com\s+released 2026-10-01/)
  })
  test("the owner's view has no lead, so none is printed", () => {
    const { lead_id, ...holder } = VIEW.holders[0]
    expect(seatLines({ ...VIEW, holders: [holder] }).join("\n")).not.toContain("lead #")
  })
  test("an open licence says so, and a domain is named", () => {
    expect(seatLines({ named_only: false }).join("\n")).toContain("anyone with the key")
    expect(seatLines({ named_only: true, claim_domain: "x.io" }).join("\n")).toContain("@x.io")
  })
  test("end date: expiry, subscription period, or nothing, never invented", () => {
    expect(endDate({ expires_at: "2026-12-01T00:00:00Z" })).toBe("2026-12-01")
    expect(endDate({ current_period_end: "2026-11-05T00:00:00Z" })).toContain("renews")
    expect(endDate({})).toBe("none set")
  })
  test("no allowance reads as none, not $0.00", () => {
    expect(allowanceLine({ allowance_cents: 0 })).toBe("none")
  })
  test("a reserved seat is not described as assigned", () => {
    expect(inviteWords("invited")).toContain("reserved")
    expect(inviteWords("assigned")).toBe("seat assigned")
  })
})
