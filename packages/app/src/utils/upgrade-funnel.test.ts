import { beforeEach, describe, expect, test } from "bun:test"
import {
  UPGRADE_EVENTS,
  resetPromptedForTest,
  trackPromptedOnce,
  trackUpgrade,
  upgradeTrackRequest,
} from "./upgrade-funnel"

// #190373 — the ask to pay, measured.

describe("upgrade funnel events", () => {
  beforeEach(() => resetPromptedForTest())

  test("the names are exactly fl-iris-api GenesisEvent::DESKTOP_UPGRADE, and none claims a sale", () => {
    // The server drops any other name with a silent 204, so a drift here measures nothing.
    expect([...UPGRADE_EVENTS]).toEqual(["upgrade.prompted", "upgrade.opened", "upgrade.checkout_started"])
    expect(UPGRADE_EVENTS.some((e) => e.includes("paid"))).toBe(false)
  })

  test("posts to the sidecar's onboarding pipe as JSON", () => {
    const [path, init] = upgradeTrackRequest("upgrade.checkout_started", "iris-solo-monthly")
    expect(path).toBe("/iris/onboarding/track")
    expect(init.method).toBe("POST")
    expect(JSON.parse(String(init.body))).toEqual({ event: "upgrade.checkout_started", label: "iris-solo-monthly" })
    expect(JSON.parse(String(upgradeTrackRequest("upgrade.opened")[1].body))).toEqual({ event: "upgrade.opened" })
  })

  test("prompted is sent once per kind per run, however often the pill re-renders", () => {
    const sent: string[] = []
    const post = async (_p: string, init?: RequestInit) => sent.push(String(init?.body))
    expect(trackPromptedOnce(post, "out")).toBe(true)
    expect(trackPromptedOnce(post, "out")).toBe(false)
    expect(trackPromptedOnce(post, "almost")).toBe(true)
    expect(sent.map((b) => JSON.parse(b).label)).toEqual(["out", "almost"])
  })

  test("a failing or throwing fetcher never breaks the ask", async () => {
    expect(() => trackUpgrade(() => Promise.reject(new Error("offline")), "upgrade.opened", "pill")).not.toThrow()
    expect(() =>
      trackUpgrade(() => {
        throw new Error("no server")
      }, "upgrade.opened", "pill"),
    ).not.toThrow()
    await new Promise((r) => setTimeout(r, 0))
  })
})
