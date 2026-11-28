import { describe, expect, test } from "bun:test"
import {
  protectionChange,
  protectionLines,
  requestProtection,
} from "../../src/cli/cmd/platform-hive-market"

/**
 * #193080 option (c): a seller's marketplace earnings are protected by default, and the seller is
 * asked once. `iris hive market earnings` shows the protection; --allow-spending / --protect flip it
 * through fl-api; a refused debit (HTTP 402, code EARNINGS_PROTECTED) is shown as its sentence and
 * the command, never as JSON, and is not retried.
 */

const SENTENCE =
  "This would use your marketplace earnings ($20.40). Run `iris hive market earnings --allow-spending` to allow it, or add credits."

describe("iris hive market earnings — protection status", () => {
  test("protected (the default): how much, and the one command that allows it", () => {
    const out = protectionLines({ allow_spending: false, answered: false, protected_cents: 2040, spendable_cents: 0, wallet_cents: 2040, cashable_cents: 2040 }).join("\n")
    expect(out).toContain("Protected")
    expect(out).toContain("$20.40")
    expect(out).toContain("iris hive market earnings --allow-spending")
  })

  test("allowed: says usage may spend them, and how to protect them again", () => {
    const out = protectionLines({ allow_spending: true, answered: true, protected_cents: 0, spendable_cents: 2040, wallet_cents: 2040, cashable_cents: 2040 }).join("\n")
    expect(out).toContain("may spend")
    expect(out).toContain("iris hive market earnings --protect")
    expect(out).not.toContain("--allow-spending")
  })

  test("--allow-spending and --protect are one change each, never both", () => {
    expect(protectionChange({})).toBeNull()
    expect(protectionChange({ "allow-spending": true })).toEqual({ allow_spending: true })
    expect(protectionChange({ protect: true })).toEqual({ allow_spending: false })
    expect(protectionChange({ "allow-spending": true, protect: true })).toEqual({ error: expect.stringContaining("not both") })
  })

  test("signed out is a sentence that says how to sign in", async () => {
    const fake = async () => new Response(JSON.stringify({ success: false, error: "Authentication required." }), { status: 401 })
    await expect(requestProtection(fake as any, null)).rejects.toThrow("not signed in — run: iris auth login")
  })

  test("the change is a PUT of exactly what was asked, and returns the new status", async () => {
    const seen: any[] = []
    const fake = async (path: string, init: RequestInit = {}) => {
      seen.push({ path, method: init.method ?? "GET", body: init.body })
      return new Response(JSON.stringify({ success: true, data: { allow_spending: true, answered: true, protected_cents: 0 } }), { status: 200 })
    }
    const s = await requestProtection(fake as any, { allow_spending: true })
    expect(s.allow_spending).toBe(true)
    expect(seen).toEqual([{ path: "/api/v1/marketplace/earnings/protection", method: "PUT", body: JSON.stringify({ allow_spending: true }) }])
  })
})
