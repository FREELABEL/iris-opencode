import { describe, test, expect } from "bun:test"
import { claimPreview } from "../src/cli/cmd/platform-bounties"

/**
 * `iris bounty claim` shows the figure CashoutService will pay (#193085), from the dry run of
 * POST /api/v1/marketplace/cashout — not /bounty/me's bug-bounty "unpaid", a different balance.
 */
describe("claimPreview", () => {
  const ready = { success: true, data: { status: "ready", amount_cents: 2042, cashable_cents: 2042 } }

  test("shows the cash-out's own figure", () => {
    expect(claimPreview(ready, { earnings: { unpaidCents: 0, unpaid: "$0.00" } })).toEqual({ payable: true, owed: "$20.42", message: "" })
  })

  test("a Hive seller with earnings is not told 'nothing owed' because no bug is unpaid", () => {
    expect(claimPreview(ready, { earnings: { unpaidCents: 0 } }).payable).toBe(true)
  })

  test("below the minimum: the server's reason, and nothing is claimed", () => {
    const r = claimPreview({ data: { status: "below_threshold", amount_cents: 1500, reason: "Cashable $15.00 is below the $20.00 minimum" } }, {})
    expect(r.payable).toBe(false)
    expect(r.message).toContain("below the $20.00 minimum")
  })

  test("nothing cashable but verified bugs waiting: says where that money goes", () => {
    const r = claimPreview({ data: { status: "below_threshold", amount_cents: 0 } }, { earnings: { unpaidCents: 17400, unpaid: "$174.00" } })
    expect(r.payable).toBe(false)
    expect(r.message).toContain("$174.00 of verified bugs")
  })

  test("no preview (request failed): falls back to /bounty/me", () => {
    expect(claimPreview(null, { earnings: { unpaidCents: 0 } }).payable).toBe(false)
    expect(claimPreview(null, { earnings: { unpaidCents: 500, unpaid: "$5.00" } })).toEqual({ payable: true, owed: "$5.00", message: "" })
  })
})
