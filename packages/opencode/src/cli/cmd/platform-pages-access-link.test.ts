import { describe, expect, test } from "bun:test"
import { MAX_HOURS, parseExpiryHours } from "./platform-pages-access-link"

/** #192508 — the expiry a sign-in link is issued with. The server caps it too; refuse early and plainly. */
describe("parseExpiryHours", () => {
  test("default is 24 hours", () => {
    expect(parseExpiryHours(undefined)).toBe(24)
    expect(parseExpiryHours("")).toBe(24)
  })

  test("units", () => {
    expect(parseExpiryHours("3h")).toBe(3)
    expect(parseExpiryHours("2d")).toBe(48)
    expect(parseExpiryHours("1w")).toBe(168)
    expect(parseExpiryHours("90m")).toBe(2)
    expect(parseExpiryHours("12")).toBe(12)
  })

  test("refuses beyond 7 days, zero, and nonsense", () => {
    expect(parseExpiryHours("8d")).toBeNull()
    expect(parseExpiryHours(String(MAX_HOURS + 1))).toBeNull()
    expect(parseExpiryHours("0h")).toBeNull()
    expect(parseExpiryHours("soon")).toBeNull()
  })
})
