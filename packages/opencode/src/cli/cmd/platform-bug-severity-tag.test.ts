import { describe, expect, test } from "bun:test"
import { resolveTitleSeverity } from "./platform-bug"

// #190214 — "[HIGH] foo" with --severity high was saved as "[HIGH] [HIGH] foo".
describe("resolveTitleSeverity", () => {
  test("strips the title's tag so the server adds a single prefix", () => {
    expect(resolveTitleSeverity("[HIGH] Orbit/Terra engine", "high")).toEqual({ title: "Orbit/Terra engine", severity: "high" })
  })
  test("case-insensitive, repeated tags all go", () => {
    expect(resolveTitleSeverity("[high] [HIGH][Critical]  thing", "high").title).toBe("thing")
  })
  test("the flag wins when it disagrees with the tag", () => {
    expect(resolveTitleSeverity("[LOW] thing", "critical")).toEqual({ title: "thing", severity: "critical" })
  })
  test("no flag: the title's tag becomes the severity", () => {
    expect(resolveTitleSeverity("[CRITICAL] thing", undefined)).toEqual({ title: "thing", severity: "critical" })
  })
  test("no tag, no flag: medium, title untouched", () => {
    expect(resolveTitleSeverity("plain [HIGH] in the middle", undefined)).toEqual({ title: "plain [HIGH] in the middle", severity: "medium" })
  })
})
