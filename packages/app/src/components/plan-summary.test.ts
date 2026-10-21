import { describe, expect, test } from "bun:test"
import { planSummary } from "./plan-summary"

const now = new Date("2026-10-19T12:00:00Z")
const allowance = (over: object = {}) => ({
  measured: true,
  window: "week",
  capUsd: 1,
  uncapped: false,
  spendUsd: 0.25,
  resetsAt: "2026-10-26T00:00:00Z",
  ...over,
})

describe("planSummary", () => {
  test("names the plan, the money LEFT, and the reset", () => {
    const s = planSummary({ plan: { measured: true, plan: "free", label: "Free" }, allowance: allowance() }, now)
    expect(s.plan).toBe("Free")
    expect(s.allowance).toStartWith("25% of this week's allowance used · resets ")
    expect(s.trial).toBeNull()
  })

  test("over the limit says used up, never a negative amount", () => {
    expect(planSummary({ allowance: allowance({ spendUsd: 1.4 }) }, now).allowance).toStartWith(
      "This week's allowance is used up",
    )
  })

  test("a future trial shows its end and the days left; a past one shows nothing", () => {
    const future = planSummary({ plan: { measured: true, plan: "free", trialEndsAt: "2026-10-26T12:00:00Z" } }, now)
    expect(future.trial).toContain("(7 days left)")
    expect(
      planSummary({ plan: { measured: true, plan: "free", trialEndsAt: "2026-10-18T00:00:00Z" } }, now).trial,
    ).toBeNull()
  })

  test("uncapped and unmeasured are their own answers, never $0 left", () => {
    expect(planSummary({ allowance: allowance({ uncapped: true, capUsd: null }) }, now).allowance).toBe(
      "No weekly limit",
    )
    expect(planSummary({ allowance: allowance({ measured: false }) }, now).allowance).toBeNull()
    expect(planSummary({ plan: { measured: false, plan: "free" } }, now).plan).toBeNull()
  })

  test("staff (plan null) read Staff when the server sends no label", () => {
    expect(planSummary({ plan: { measured: true, plan: null } }, now).plan).toBe("Staff")
  })
})

describe("planSummary — the usage meter", () => {
  const me = (over: object) => ({
    allowance: { measured: true, window: "week", capUsd: 1, uncapped: false, spendUsd: 0.25, resetsAt: null, ...over },
  })
  test("percent of the allowance used, floored", () => {
    expect(planSummary(me({ spendUsd: 0.257 }), now).percent).toBe(25)
    expect(planSummary(me({ spendUsd: 0.899 }), now).percent).toBe(89)
  })
  test("over the allowance is a full meter, never past 100", () => {
    expect(planSummary(me({ spendUsd: 2.98 }), now).percent).toBe(100)
    expect(planSummary(me({ spendUsd: 2.98 }), now).over).toBe(true)
    expect(planSummary(me({ spendUsd: 0.5 }), now).over).toBe(false)
  })
  test("no meter when we could not measure or there is no limit — never an empty bar that reads as 0%", () => {
    expect(planSummary(me({ measured: false }), now).percent).toBeNull()
    expect(planSummary(me({ uncapped: true, capUsd: null }), now).percent).toBeNull()
  })
})

describe("planSummary — tokens for people, dollars for staff (#190087)", () => {
  const me = (
    over: object,
    plan: { measured: boolean; plan: string | null; label?: string } = { measured: true, plan: "free", label: "Free" },
  ) => ({
    plan,
    allowance: {
      measured: true,
      window: "week",
      capUsd: 1,
      uncapped: false,
      spendUsd: 0.28,
      resetsAt: "2026-10-26T00:00:00Z",
      tokensUsed: 12_400_000,
      ...over,
    },
  })
  test("a person sees tokens and a share, never dollars", () => {
    const a = planSummary(me({}), now).allowance!
    expect(a).toStartWith("12.4M tokens used this week · 28% of your allowance · resets ")
    expect(a).not.toContain("$")
  })
  test("used up says so in words, without the price of it", () => {
    const a = planSummary(me({ spendUsd: 1.4 }), now).allowance!
    expect(a).toStartWith("This week's allowance is used up · 12.4M tokens used this week · resets ")
    expect(a).not.toContain("$")
  })
  test("no token count yet: the share alone", () => {
    expect(planSummary(me({ tokensUsed: null }), now).allowance).toStartWith(
      "28% of this week's allowance used · resets ",
    )
  })
  test("staff see tokens too — no dollars for anyone (Alex, 2026-10-20)", () => {
    const a = planSummary(me({}, { measured: true, plan: null, label: "Staff" }), now).allowance!
    expect(a).toContain("12.4M tokens used this week")
    expect(a).not.toContain("$")
    expect(
      planSummary(me({ spendUsd: 3 }, { measured: true, plan: null, label: "Staff" }), now).allowance,
    ).not.toContain("$")
  })
  test("token counts read like the plans: K, M, B", () => {
    expect(planSummary(me({ tokensUsed: 850_000 }), now).allowance).toStartWith("850K tokens")
    expect(planSummary(me({ tokensUsed: 2_300_000_000 }), now).allowance).toStartWith("2.3B tokens")
  })
})
