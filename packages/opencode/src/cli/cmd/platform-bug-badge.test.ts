import { describe, expect, test } from "bun:test"
import { fixBadge } from "./platform-bug"

/**
 * #177916 — a reopened bug kept its green "✓ FIXED <commit>" stamp because the badge keyed
 * off "a resolution exists" with no status check. `todo` and `✓ FIXED` rendered side by side,
 * so a wrongly-closed bug still read as fixed to anyone scanning the board.
 */
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "")

describe("fixBadge", () => {
  test("shows FIXED only when the bug is actually done", () => {
    expect(strip(fixBadge("done", true, "07b98eb"))).toBe("✓ FIXED 07b98eb")
  })

  test("a resolution on a REOPENED bug reads as contradicted, not as fixed (the #177893 case)", () => {
    const out = strip(fixBadge("todo", true, "fd678579"))
    expect(out).toBe("was marked fixed fd678579 — REOPENED")
    expect(out).not.toContain("✓ FIXED")
  })

  test("no resolution renders nothing at all", () => {
    expect(fixBadge("done", false, undefined)).toBe("")
    expect(fixBadge("todo", false, "abc1234")).toBe("")
  })

  test("handles a missing commit hash", () => {
    expect(strip(fixBadge("done", true, undefined))).toBe("✓ FIXED")
    expect(strip(fixBadge("todo", true, undefined))).toBe("was marked fixed — REOPENED")
  })

  test("status matching is case-insensitive and null-safe", () => {
    expect(strip(fixBadge("DONE", true, "abc1234"))).toBe("✓ FIXED abc1234")
    expect(strip(fixBadge(undefined, true, "abc1234"))).toContain("REOPENED")
    expect(strip(fixBadge("in_progress", true, "abc1234"))).toContain("REOPENED")
  })
})
