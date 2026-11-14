import { describe, expect, test } from "bun:test"
import { decideLeadMatch } from "./comms-send"

/**
 * The rows /api/v1/leads?search=user9@firm-a.example.com actually returned on 2026-09-14.
 * Two leads, one address. The old resolvers took rows[0] and a client status email landed on
 * the Stripe duplicate instead of the record carrying the relationship (#185438, EPIC #185439).
 */
const ROWS = [
  { id: 21623, name: "Rodney Damond Mayo", email: "user9@firm-a.example.com", source: "stripe_subscription" },
  { id: 10394, name: "Rodney Mayo", email: "user9@firm-a.example.com", source: null },
]

describe("decideLeadMatch", () => {
  test("refuses a tie instead of picking the first row", () => {
    const r = decideLeadMatch(ROWS, "user9@firm-a.example.com")
    expect(r.reason).toBe("ambiguous")
    expect(r.ok).toBe(false)
    expect(r.leadId).toBeUndefined()
    // Both candidates are returned, because the operator is the only one who can break the tie.
    expect(r.matches.map((m) => m.id).sort()).toEqual([10394, 21623])
  })

  test("resolves when exactly one lead owns the address", () => {
    const r = decideLeadMatch([ROWS[1]], "user9@firm-a.example.com")
    expect(r.reason).toBe("ok")
    expect(r.leadId).toBe(10394)
  })

  test("reports none rather than guessing when nobody owns it", () => {
    const r = decideLeadMatch(ROWS, "someone.else@example.com")
    expect(r.reason).toBe("none")
    expect(r.matches).toHaveLength(0)
  })

  test("ignores fuzzy search hits that do not actually hold the address", () => {
    // ?search= matches names and notes too, so a row can come back without the address on it.
    const noisy = [{ id: 999, name: "Rodney's assistant", email: "assistant@elsewhere.com" }, ROWS[1]]
    const r = decideLeadMatch(noisy, "user9@firm-a.example.com")
    expect(r.reason).toBe("ok")
    expect(r.leadId).toBe(10394)
  })

  test("matches case-insensitively and on contact_info.email", () => {
    const rows = [{ id: 77, name: "Alt", contact_info: { email: "User9@Firm-A.Example.Com" } }]
    const r = decideLeadMatch(rows, "user9@firm-a.example.com")
    expect(r.reason).toBe("ok")
    expect(r.leadId).toBe(77)
  })

  test("an empty result set is 'none', not a crash", () => {
    expect(decideLeadMatch([], "x@y.com").reason).toBe("none")
  })
})
