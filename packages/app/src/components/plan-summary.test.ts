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
    expect(s.allowance).toStartWith("$0.75 left of $1.00 this week · resets ")
    expect(s.trial).toBeNull()
  })

  test("over the limit says used up, never a negative amount", () => {
    expect(planSummary({ allowance: allowance({ spendUsd: 1.4 }) }, now).allowance).toStartWith(
      "$1.00 this week used up",
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
