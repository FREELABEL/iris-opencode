import { describe, expect, test } from "bun:test"
import { confidentPick, RUN_MIN } from "./platform-intent-select"

// --run turns a pick into an action. On 2026-10-08 three of five onboarding phrasings came back at
// 28–47%, and "reply to … in my email" went to `sites reply`. Unsure picks must not run unasked (#188613).
describe("#188613 --run acts only on a confident pick", () => {
  test("a model pick at or above the bar is confident", () => {
    expect(confidentPick("decide:jev (platform)", RUN_MIN)).toBe(true)
    expect(confidentPick("decide:jev (platform)", 0.92)).toBe(true)
  })
  test("a model pick under the bar is not", () => {
    expect(confidentPick("decide:jev (platform)", 0.66)).toBe(false) // a nonsense request scored this
    expect(confidentPick("decide:jev (platform)", 0.47)).toBe(false)
    expect(confidentPick("decide:jev (platform)", 0.28)).toBe(false)
  })
  test("keyword order — no model answered — is never confident, whatever the number", () => {
    expect(confidentPick("keyword", 0.99)).toBe(false)
    expect(confidentPick("decide:jev (platform)", null)).toBe(false)
  })
  test("a request with exactly one candidate is", () => {
    expect(confidentPick("only candidate", undefined)).toBe(true)
  })
})
