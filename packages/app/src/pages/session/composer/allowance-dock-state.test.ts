import { describe, expect, test } from "bun:test"
import { allowanceDockState, outCardState } from "./allowance-dock-state"

const now = new Date("2026-10-20T12:00:00Z")
const plan = (over: object = {}) => ({
  measured: true,
  fraction: 1.2,
  tokensUsed: 12_400_000,
  resetsAt: "2026-10-26T00:00:00Z",
  ...over,
})

describe("allowanceDockState — the bar above the composer (#190087)", () => {
  test("out of allowance: the dock says so, with tokens, and is the gold 'paused on you' state", () => {
    const s = allowanceDockState(plan(), now)!
    expect(s.tone).toBe("out")
    expect(s.title).toBe("Out of allowance · 12.4M tokens used this week")
    expect(s.percent).toBe(100)
    expect(s.resets).toStartWith("Resets ")
  })

  test("from 90%: a warning, not the out state", () => {
    const s = allowanceDockState(plan({ fraction: 0.93 }), now)!
    expect(s.tone).toBe("warning")
    expect(s.title).toBe("93% of this week's allowance used · 12.4M tokens")
  })

  test("below 90%, unmeasured or uncapped: no dock at all", () => {
    expect(allowanceDockState(plan({ fraction: 0.5 }), now)).toBeNull()
    expect(allowanceDockState(plan({ measured: false }), now)).toBeNull()
    expect(allowanceDockState(plan({ fraction: null }), now)).toBeNull()
    expect(allowanceDockState(undefined, now)).toBeNull()
  })

  test("no token count yet: the words alone, never a dollar figure", () => {
    expect(allowanceDockState(plan({ tokensUsed: null }), now)!.title).toBe("Out of allowance")
    expect(JSON.stringify(allowanceDockState(plan(), now))).not.toContain("$")
  })
})

describe("drawing on a top-up (#194529)", () => {
  test("past 100% with top-up tokens left: nothing is paused, so no dock", () => {
    expect(allowanceDockState(plan({ fraction: 1.1, grantTokens: 52_000_000 }), now)).toBeNull()
    expect(allowanceDockState(plan({ fraction: 1.1, grantTokens: 0 }), now)!.tone).toBe("out")
  })
})

describe("outCardState — the three choices at 100% (#194530)", () => {
  const offers = [
    { slug: "iris-solo-monthly", title: "Solo", price: 29, period: "month", features: ["5x compute"] },
    { slug: "iris-pro-monthly", title: "Pro", price: 199, period: "month", features: ["20x compute"] },
  ]
  const local = new Date(2026, 10, 27, 15, 0) // Friday 3pm, local
  const out = (over: object = {}) =>
    plan({
      fraction: 1,
      paid: false,
      tokensUsed: 9_400_000,
      capTokens: 9_400_000,
      resetsAt: new Date(2026, 10, 30, 0, 0).toISOString(),
      nextTier: { slug: "iris-solo-monthly", label: "Solo", priceUsd: 29, period: "month", capTokensWeek: 47_000_000 },
      ...over,
    })

  test("work is safe first; then top up, the cheapest plan that fits, or wait", () => {
    const c = outCardState(out(), offers, local)!
    expect(c.heading).toBe("You've used this week's 9.4M tokens")
    expect(c.line).toBe("Your work is saved. It picks up the moment you choose.")
    expect(c.plan).toMatchObject({ slug: "iris-solo-monthly", fit: "20%" })
    expect(c.plan!.detail).toBe("47M tokens a week. You'd have used 20% of it this week.")
    expect(c.wait!.title).toBe("Wait for Monday")
    expect(c.wait!.detail).toBe("Your week resets Monday at 12:00am. That's in 2 days, 9 hours.")
    expect(c.upgrade).toBe(true)
  })

  test("today's server (no cap, no tier): still a card, with what it can say", () => {
    const c = outCardState(plan({ fraction: 1.2 }), [], now)!
    expect(c.heading).toBe("You've used this week's tokens")
    expect(c.plan).toBeNull()
    expect(c.wait!.title).toStartWith("Wait for ")
  })

  test("someone who pays is not asked to upgrade; under 100% or on a top-up there is no card", () => {
    expect(outCardState(out({ paid: true }), offers, local)!.upgrade).toBe(false)
    expect(outCardState(out({ paid: true }), offers, local)!.plan).toBeNull()
    expect(outCardState(out({ fraction: 0.95 }), offers, local)).toBeNull()
    expect(outCardState(out({ grantTokens: 10_000_000 }), offers, local)).toBeNull()
    expect(outCardState(out({ resetsAt: null }), offers, local)!.wait).toBeNull()
  })
})
