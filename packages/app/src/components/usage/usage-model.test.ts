import { describe, expect, test } from "bun:test"
import {
  bestFit,
  clock,
  computeMultiplier,
  fitLabel,
  fitPercent,
  forecastLine,
  freeCapTokens,
  ladder,
  lastWeekTiles,
  levelLine,
  openChecklist,
  planFits,
  resetLine,
  ringState,
  ringTone,
  upgradeLabel,
  usageAsk,
  usageDialogCopy,
  weekLine,
  type Offer,
  type UsagePlan,
} from "./usage-model"

// Local time throughout, so the words do not depend on the machine's zone.
const now = new Date(2026, 10, 27, 15, 0) // Friday 27 Nov 2026, 3pm
const monday = new Date(2026, 10, 30, 0, 0) // Monday 12:00am
const OFFERS: Offer[] = [
  { slug: "iris-solo-monthly", title: "Solo", price: 29, period: "month", features: ["Full OS Suite", "5x compute — ~200M tokens a month"] },
  { slug: "iris-pro-monthly", title: "Pro", price: 199, period: "month", features: ["Everything in Solo", "20x compute"] },
  { slug: "iris-team-monthly", title: "Team", price: 799, period: "month", features: ["5 seats", "100x compute — 4–8B tokens a month"] },
]
const plan = (over: Partial<UsagePlan> = {}): UsagePlan => ({
  measured: true,
  plan: "free",
  paid: false,
  label: "Free",
  fraction: 0.92,
  tokensUsed: 8_600_000,
  resetsAt: monday.toISOString(),
  uncapped: false,
  capTokens: 9_400_000,
  grantTokens: 0,
  nextTier: { slug: "iris-solo-monthly", label: "Solo", priceUsd: 29, period: "month", capTokensWeek: 47_000_000 },
  ...over,
})

describe("the ring's states (#194529)", () => {
  test("calm, heads-up, low, out, and drawing on a top-up", () => {
    expect(ringTone(plan({ fraction: 0.3 }))).toBe("calm")
    expect(ringTone(plan({ fraction: 0.7 }))).toBe("heads-up")
    expect(ringTone(plan({ fraction: 0.89 }))).toBe("heads-up")
    expect(ringTone(plan({ fraction: 0.9 }))).toBe("low")
    expect(ringTone(plan({ fraction: 1 }))).toBe("out")
    expect(ringTone(plan({ fraction: 1.2, grantTokens: 52_000_000 }))).toBe("grants")
  })

  test("words beside the ring only from 90%", () => {
    expect(ringState(plan({ fraction: 0.3 }))!.label).toBeNull()
    expect(ringState(plan({ fraction: 0.78 }))!.label).toBeNull()
    expect(ringState(plan({ fraction: 0.934 }))).toEqual({ tone: "low", week: 0.934, percent: 93, label: "93% of week" })
    expect(ringState(plan({ fraction: 1.3 }))).toMatchObject({ tone: "out", week: 1, label: "Week used up" })
    expect(ringState(plan({ fraction: 1.1, grantTokens: 52_000_000 }))!.label).toBe("+52M top-up left")
  })

  test("unknown is never a verdict: unmeasured, missing or loading → no ring", () => {
    expect(ringState(undefined)).toBeNull()
    expect(ringState(plan({ measured: false }))).toBeNull()
    expect(ringState(plan({ fraction: null }))).toBeNull()
    expect(ringState({ measured: true })).toBeNull()
  })

  test("staff: uncapped, no week to draw, nothing to say", () => {
    expect(ringState(plan({ uncapped: true, fraction: null }))).toEqual({ tone: "uncapped", week: null, percent: null, label: null })
    expect(usageAsk(plan({ uncapped: true }))).toBe("none")
  })
})

describe("time words", () => {
  test("clock and reset", () => {
    expect(clock(new Date(2026, 0, 1, 14, 0))).toBe("2pm")
    expect(clock(new Date(2026, 0, 1, 0, 0))).toBe("12:00am")
    expect(clock(new Date(2026, 0, 1, 9, 30))).toBe("9:30am")
    expect(resetLine(monday.toISOString(), now)).toBe("Resets Monday 12:00am · in 2d 9h")
    expect(resetLine(new Date(2026, 10, 1).toISOString(), now)).toBeNull()
    expect(resetLine(null, now)).toBeNull()
  })

  test("the forecast: tomorrow, today, a weekday — and silence when it means nothing", () => {
    const at = (d: Date) => plan({ runoutAt: d.toISOString() })
    expect(forecastLine(at(new Date(2026, 10, 28, 14, 0)), now)).toBe("At today's pace you'll run out tomorrow around 2pm.")
    expect(forecastLine(at(new Date(2026, 10, 27, 21, 0)), now)).toBe("At today's pace you'll run out today around 9pm.")
    expect(forecastLine(plan({ resetsAt: new Date(2026, 11, 7).toISOString(), runoutAt: new Date(2026, 10, 30, 10).toISOString() }), now)).toBe(
      "At today's pace you'll run out on Monday around 10am.",
    )
    // after the reset → no run-out at all
    expect(forecastLine(at(new Date(2026, 10, 30, 9, 0)), now)).toBeNull()
    expect(forecastLine(plan({ runoutAt: null }), now)).toBeNull()
    expect(forecastLine(plan({ fraction: 1.1, runoutAt: new Date(2026, 10, 28).toISOString() }), now)).toBeNull()
  })
})

describe("numbers — tokens, never dollars, only what was measured", () => {
  test("week line", () => {
    expect(weekLine(plan())).toBe("8.6M of 9.4M tokens")
    expect(weekLine(plan({ capTokens: undefined }))).toBe("8.6M tokens this week")
    expect(weekLine(plan({ uncapped: true }))).toBe("8.6M tokens this week")
    expect(weekLine(plan({ tokensUsed: null }))).toBeNull()
  })

  test("last week's tiles leave out what was not counted; nothing is estimated", () => {
    expect(lastWeekTiles({ runs: 38, tokens: 7e6, agentRuns: 12, pagesPublished: 4 })).toEqual([
      { value: "38", label: "runs last week" },
      { value: "12", label: "agent runs" },
      { value: "4", label: "pages published" },
    ])
    expect(lastWeekTiles({ runs: 1, tokens: 7_100_000, agentRuns: null, pagesPublished: null })).toEqual([
      { value: "1", label: "run last week" },
      { value: "7.1M", label: "tokens last week" },
    ])
    expect(lastWeekTiles(null)).toEqual([])
    expect(JSON.stringify(lastWeekTiles({ runs: 3, tokens: 1, agentRuns: 1, pagesPublished: 1 }))).not.toContain("hour")
  })
})

describe("fit — this week on each plan (#194531)", () => {
  test("the multiplier comes from the catalogue's own words", () => {
    expect(computeMultiplier(OFFERS[0])).toBe(5)
    expect(computeMultiplier(OFFERS[2])).toBe(100)
    expect(computeMultiplier({ features: ["Lots"], subtitle: "10× compute" })).toBe(10)
    expect(computeMultiplier({ features: [] })).toBeNull()
  })

  test("the free cap: your own cap on Free; next tier ÷ its multiplier when you pay", () => {
    expect(freeCapTokens(plan(), OFFERS)).toBe(9_400_000)
    expect(freeCapTokens(plan({ paid: true, capTokens: 47_000_000, nextTier: { slug: "iris-pro-monthly", label: "Pro", priceUsd: 199, period: "month", capTokensWeek: 188_000_000 } }), OFFERS)).toBe(9_400_000)
    expect(freeCapTokens(plan({ paid: true, nextTier: null }), OFFERS)).toBeNull()
  })

  test("weekly tokens per plan: the server's number for the next tier, multiplier × free cap for the rest", () => {
    const fits = planFits(OFFERS, plan())
    expect(fits.map((f) => f.weekly)).toEqual([47_000_000, 188_000_000, 940_000_000])
    expect(fits.map((f) => fitLabel(f.percent!))).toEqual(["18%", "5%", "<1%"])
  })

  test("fits you best: the cheapest plan this week uses ≤ 80% of", () => {
    expect(bestFit(OFFERS, plan())!.offer.slug).toBe("iris-solo-monthly")
    // a heavy week: 45M of Solo's 47M is 96% → Pro
    expect(bestFit(OFFERS, plan({ tokensUsed: 45_000_000 }))!.offer.slug).toBe("iris-pro-monthly")
    expect(bestFit(OFFERS, plan({ measured: false }))).toBeNull()
    expect(bestFit(OFFERS, plan({ tokensUsed: null }))).toBeNull()
  })

  test("fitPercent refuses nonsense", () => {
    expect(fitPercent(1, 0)).toBeNull()
    expect(fitPercent(null, 10)).toBeNull()
    expect(fitPercent(5, 10)).toBe(50)
  })
})

describe("the ladder and the asks", () => {
  test("Free → Solo → Pro → Team, with you and the next rung marked", () => {
    const steps = ladder(OFFERS, plan())
    expect(steps.map((s) => s.label)).toEqual(["Free", "Solo", "Pro", "Team"])
    expect(steps.map((s) => s.weekly)).toEqual([9_400_000, 47_000_000, 188_000_000, 940_000_000])
    expect(steps.find((s) => s.current)!.label).toBe("Free")
    expect(steps.find((s) => s.next)!.label).toBe("Solo")
    const paid = ladder(OFFERS, plan({ paid: true, label: "IRIS Solo", nextTier: null }))
    expect(paid.find((s) => s.current)!.label).toBe("Solo")
    expect(ladder([], plan())).toEqual([])
  })

  test("the upgrade button says what changes, from the server's numbers", () => {
    expect(upgradeLabel(plan())).toBe("Upgrade to Solo · 5x every week · $29/mo")
    expect(upgradeLabel(plan({ capTokens: null }))).toBe("Upgrade to Solo · $29/mo")
    expect(upgradeLabel(plan({ nextTier: null }))).toBeNull()
  })

  test("paid → their plan, never an Upgrade nag; staff → nothing; everyone else → upgrade", () => {
    expect(usageAsk(plan({ paid: true }))).toBe("plan")
    expect(usageAsk(plan({ paid: null }))).toBe("upgrade")
    expect(usageAsk(plan())).toBe("upgrade")
    expect(usageAsk(undefined)).toBe("none")
  })

  test("checklist until all done; the level says what the next one asks", () => {
    const progress = {
      level: { key: "explorer", label: "Explorer" },
      nextLevel: { key: "builder", label: "Builder", requires: "Publish a page" },
      checklist: [
        { key: "a", label: "Run an agent", done: true, rewardTokens: 1e6 },
        { key: "b", label: "Publish a page", done: false, rewardTokens: 2e6 },
      ],
      streakWeeks: 2,
    }
    expect(openChecklist(progress)).toHaveLength(2)
    expect(openChecklist({ ...progress, checklist: progress.checklist.map((c) => ({ ...c, done: true })) })).toEqual([])
    expect(levelLine(progress)).toBe("Level: Explorer · next, Builder: Publish a page")
    expect(levelLine({ ...progress, nextLevel: null })).toBe("Level: Explorer")
    expect(levelLine(null)).toBeNull()
  })

  test("the plans dialog heading talks about the week — but not to someone who pays (#189544)", () => {
    expect(usageDialogCopy(plan())).toEqual({
      title: "You did a lot with IRIS this week.",
      description: "8.6M of 9.4M tokens this week. Here's how this week would look on each plan:",
    })
    expect(usageDialogCopy(plan({ paid: true }))).toBeNull()
    expect(usageDialogCopy(plan({ measured: false }))).toBeNull()
    expect(usageDialogCopy(plan({ tokensUsed: 0 }))).toBeNull()
  })
})
