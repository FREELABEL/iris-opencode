import { beforeEach, describe, expect, test } from "bun:test"
import { resetPromptedForTest } from "@/utils/upgrade-funnel"
import { announceAsk } from "./usage-asks"
import type { UsagePlan } from "./usage-model"

/**
 * #191267 — the server allow-lists upgrade.prompted; the desktop simply never sent it from the new
 * surfaces. These prove the POST happens, with the right label, and only when it is an ask.
 */
const sent: { path: string; body: any }[] = []
const post = async (path: string, init?: RequestInit) => {
  sent.push({ path, body: init?.body ? JSON.parse(String(init.body)) : null })
  return new Response(null, { status: 204 })
}
const free = (over: Partial<UsagePlan> = {}): UsagePlan => ({
  measured: true,
  paid: false,
  fraction: 1,
  tokensUsed: 9_400_000,
  capTokens: 9_400_000,
  resetsAt: new Date(Date.now() + 86_400_000).toISOString(),
  ...over,
})

beforeEach(() => {
  sent.length = 0
  resetPromptedForTest()
})

describe("upgrade.prompted from the usage surfaces (#191267)", () => {
  test("the popover showing Upgrade sends it — once", () => {
    expect(announceAsk(post, "ring", free({ fraction: 0.5 }))).toBe(true)
    expect(announceAsk(post, "ring", free({ fraction: 0.5 }))).toBe(false)
    expect(sent).toEqual([{ path: "/iris/onboarding/track", body: { event: "upgrade.prompted", label: "ring" } }])
  })

  test("the out card sends it with its own label", () => {
    expect(announceAsk(post, "out-card", free())).toBe(true)
    expect(sent).toEqual([{ path: "/iris/onboarding/track", body: { event: "upgrade.prompted", label: "out-card" } }])
  })

  test("no ask, no event: someone who pays, staff, unmeasured, or not out", () => {
    expect(announceAsk(post, "ring", free({ paid: true }))).toBe(false)
    expect(announceAsk(post, "ring", free({ uncapped: true }))).toBe(false)
    expect(announceAsk(post, "ring", { measured: false })).toBe(false)
    expect(announceAsk(post, "out-card", free({ paid: true }))).toBe(false)
    expect(announceAsk(post, "out-card", free({ fraction: 0.95 }))).toBe(false)
    expect(sent).toEqual([])
  })
})
