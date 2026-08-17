import { describe, expect, test } from "bun:test"
import { fixBadge, latestFixCommit } from "./platform-bug"

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

/**
 * #180528 follow-on — `resolve` APPENDS a resolution block, so a bug closed more than once
 * carries every stamp it has ever had. Reading with `String.match()` returned the FIRST,
 * i.e. the oldest, which made correcting a wrong stamp impossible: #180525 was mis-stamped
 * a8a9cc45 (an unrelated repo), corrected twice to ebbf1f7c8, and still displayed a8a9cc45.
 */
describe("latestFixCommit", () => {
  test("returns the LAST stamp when a bug was closed more than once", () => {
    const content = [
      "### Resolution",
      "**Fix commit:** `a8a9cc45` (https://github.com/FREELABEL/fl-eco-docker/commit/a8a9cc45)",
      "### Resolution",
      "**Fix commit:** `ebbf1f7c8` (https://github.com/FREELABEL/iris-opencode/commit/ebbf1f7c8)",
    ].join("\n")

    expect(latestFixCommit(content)).toBe("ebbf1f7c8")
  })

  test("returns the only stamp when closed once", () => {
    expect(latestFixCommit("**Fix commit:** `fe89dafb4`")).toBe("fe89dafb4")
  })

  test("is undefined when nothing was ever stamped", () => {
    expect(latestFixCommit("### Resolution\nno commit recorded")).toBeUndefined()
  })

  /** Prose in the report body must not be mistaken for a stamp's hash. */
  test("ignores a bare hash that is not a Fix commit line", () => {
    expect(latestFixCommit("we thought a8a9cc45 was the fix\n**Fix commit:** `deadbeef`")).toBe("deadbeef")
  })
})
