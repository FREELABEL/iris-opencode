import { describe, expect, test } from "bun:test"
import { isCliReleaseTag, pickLatestCliTag } from "./pick-release"

/**
 * Live shape from the API on 2026-08-28, newest first — the day desktop shipped eleven times
 * and `iris update` stopped being able to find the CLI at all.
 */
const REAL = [
  { tag_name: "desktop-v1.18.35" },
  { tag_name: "desktop-v1.18.34" },
  { tag_name: "desktop-v1.18.33" },
  { tag_name: "v1.3.214" },
  { tag_name: "v1.3.213" },
]

describe("isCliReleaseTag", () => {
  test("a bare semver tag is the CLI", () => {
    expect(isCliReleaseTag("v1.3.214")).toBe(true)
  })

  test("desktop tags are not — this is the whole bug", () => {
    expect(isCliReleaseTag("desktop-v1.18.35")).toBe(false)
  })

  test("other satellite lines are excluded too", () => {
    expect(isCliReleaseTag("vscode-v0.0.13")).toBe(false)
    expect(isCliReleaseTag("backup/pre-rebase-1653")).toBe(false)
  })

  test("undefined is not a tag", () => {
    expect(isCliReleaseTag(undefined)).toBe(false)
  })
})

describe("pickLatestCliTag", () => {
  test("skips desktop releases and finds the CLI beneath them", () => {
    expect(pickLatestCliTag(REAL)).toBe("v1.3.214")
  })

  test("recency wins, not semver order — a re-cut release must be able to win", () => {
    expect(pickLatestCliTag([{ tag_name: "v1.3.9" }, { tag_name: "v1.3.214" }])).toBe("v1.3.9")
  })

  test("drafts are not releases", () => {
    expect(pickLatestCliTag([{ tag_name: "v1.9.9", draft: true }, { tag_name: "v1.3.214" }])).toBe("v1.3.214")
  })

  test("a page with no CLI release returns null rather than a desktop tag", () => {
    expect(pickLatestCliTag([{ tag_name: "desktop-v1.18.35" }])).toBeNull()
  })

  test("a non-array is null, not a crash", () => {
    expect(pickLatestCliTag(null)).toBeNull()
    expect(pickLatestCliTag(undefined)).toBeNull()
  })
})
