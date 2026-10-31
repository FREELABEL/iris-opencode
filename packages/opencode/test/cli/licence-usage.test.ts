import { describe, expect, test } from "bun:test"
import { allowanceLine, seatCapLine, usageLines } from "../../src/cli/cmd/licence"

describe("licence usage view (#191945)", () => {
  const usage = {
    period: "2026-10",
    allowance_cents_per_month: 2000,
    allowance_used_cents_this_month: 575,
    seat_cap_cents: 500,
    seats_total: 3,
    seats_claimed: 2,
    seats_unclaimed: 1,
    seats_active_this_month: 1,
    seats: [
      { seat_id: 1, user_id: 7, email: "a@x.test", spend_cents_this_month: 500, spend_cents_total: 575, last_active_at: "2026-10-30T10:00:00Z", at_cap: true },
      { seat_id: 2, user_id: 8, email: null, spend_cents_this_month: 0, spend_cents_total: 0, last_active_at: null, at_cap: false },
      { seat_id: 3, user_id: 9, email: "c@x.test", spend_cents_this_month: 0, spend_cents_total: 75, released_at: "2026-10-02T00:00:00Z", at_cap: false },
    ],
  }

  test("answers who claimed, who is active and spend per seat", () => {
    const out = usageLines(usage)
    expect(out[0]).toBe("2 of 3 seats claimed, 1 unclaimed, 1 active in 2026-10")
    expect(out[1]).toContain("$5.75 of $20.00 used this month")
    expect(out[2]).toContain("a@x.test")
    expect(out[2]).toContain("$5.00 this month, $5.75 total")
    expect(out[2]).toContain("last active 2026-10-30")
    expect(out[2]).toContain("AT CAP")
    expect(out[3]).toContain("user 8")
    expect(out[3]).toContain("not active yet")
    expect(out[3]).not.toContain("AT CAP")
    expect(out[4]).toContain("released 2026-10-02")
  })

  test("prints nothing against a server without usage", () => {
    expect(usageLines(undefined)).toEqual([])
  })
})

describe("licence allowance wording (#191941)", () => {
  test("says the allowance is monthly and shared", () => {
    expect(allowanceLine(5000, 4)).toBe("$50.00 per month, shared by 4 seat(s)")
  })

  test("no cap reads as none, not as zero", () => {
    expect(seatCapLine(null)).toBe("none")
    expect(seatCapLine(undefined)).toBe("none")
    expect(seatCapLine(500)).toBe("$5.00 per seat per month")
  })
})
