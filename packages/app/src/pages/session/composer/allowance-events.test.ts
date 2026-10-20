import { describe, expect, test } from "bun:test"
import { allowanceRefusal, markAllowanceRefused } from "./allowance-events"

describe("allowance refusal — the server said no, the tab opens (#190087)", () => {
  test("each refusal is a new event, carrying when the allowance resets", () => {
    const before = allowanceRefusal()?.count ?? 0
    markAllowanceRefused("2026-10-26T00:00:00Z")
    expect(allowanceRefusal()?.count).toBe(before + 1)
    expect(allowanceRefusal()?.resetsAt).toBe("2026-10-26T00:00:00Z")
    markAllowanceRefused()
    expect(allowanceRefusal()?.count).toBe(before + 2)
  })
})
