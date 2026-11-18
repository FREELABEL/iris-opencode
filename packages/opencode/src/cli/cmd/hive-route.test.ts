import { describe, expect, test } from "bun:test"
import { classify, route, passRates, runtimeOf, MIN_TOTAL } from "./hive-route"

const v = (vendor: string, passed: boolean) => ({ author_vendor: vendor, passed })
const many = (vendor: string, n: number, pass: number) => Array.from({ length: n }, (_, i) => v(vendor, i < pass))

describe("hive route (#189154)", () => {
  test("classifies by what the task asks for", () => {
    expect(classify("Review the auth middleware for security holes")).toBe("review")
    expect(classify("Fix the typo in the README")).toBe("mechanical")
    expect(classify("Investigate why the worker crashes on boot")).toBe("triage")
    expect(classify("Add a --json flag to iris pulse")).toBe("build")
  })

  test("with no verdicts, the starting table decides — and says so", () => {
    const r = route("Fix the typo in the README")
    expect([r.runtime, r.source]).toEqual(["opencode", "table"])
    expect(r.why).toContain(`0 of ${MIN_TOTAL} verdicts`)
    expect(route("Review the payments refactor").runtime).toBe("claude_code")
  })

  test("enough verdicts: the runtime that passes its gates more often wins", () => {
    const verdicts = [...many("anthropic", 30, 18), ...many("openai", 30, 27)]
    const r = route("Add a --json flag to iris pulse", verdicts)
    expect([r.runtime, r.source]).toEqual(["opencode", "measured"])
    expect(r.why).toContain("opencode 90% of 30")
  })

  test("measured never sends review work outside its allowed set", () => {
    const verdicts = [...many("anthropic", 30, 10), ...many("openai", 30, 30)]
    expect(route("Review the payments refactor", verdicts).runtime).toBe("claude_code")
  })

  test("below the per-runtime floor, a runtime is not compared on a handful of results", () => {
    const verdicts = [...many("anthropic", 45, 20), ...many("openai", 5, 5)]
    const r = route("Add a flag", verdicts)
    expect([r.runtime, r.source]).toEqual(["claude_code", "table"])
  })

  test("verdicts without a pass/fail or an author are not counted", () => {
    expect(passRates([{ passed: null, author_vendor: "anthropic" }, { passed: true }]).total).toBe(0)
    expect(runtimeOf({ author_runtime: "gemini_cli" })).toBe("gemini_cli")
  })
})
