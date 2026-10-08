import { describe, expect, test } from "bun:test"
import { accountStatus, meterView, planLabel, sourceNote, type AccountState } from "./account"

const allowance = (over: Partial<AccountState["allowance"]> = {}): AccountState["allowance"] => ({
  measured: true,
  window: "week",
  capUsd: 5,
  uncapped: false,
  spendUsd: 3.1,
  fraction: 0.62,
  resetsAt: "2026-10-12T00:00:00Z",
  thresholds: [0.9],
  upgradeUrl: null,
  ...over,
})

describe("Settings > Account (#187966)", () => {
  test("the meter is the gate's fraction, in dollars, with the one 90% notice marked", () => {
    const m = meterView(allowance(), new Date("2026-10-07T00:00:00Z"))
    expect(m.kind).toBe("meter")
    if (m.kind !== "meter") return
    expect(m.percent).toBe(62)
    expect(m.text).toBe("$3.10 of $5.00 this week (62%)")
    expect(m.marks).toEqual([90])
    expect(m.resets).toStartWith("Resets ")
  })

  test("could-not-ask and no-limit are never drawn as an empty bar", () => {
    expect(meterView(undefined).kind).toBe("unknown")
    expect(meterView(allowance({ measured: false })).kind).toBe("unknown")
    expect(meterView(allowance({ fraction: null })).kind).toBe("unknown")
    expect(meterView(allowance({ uncapped: true, capUsd: null, fraction: null })).kind).toBe("uncapped")
  })

  test("over the cap clamps to 100 rather than drawing past the bar", () => {
    const m = meterView(allowance({ fraction: 1.4, spendUsd: 7 }))
    expect(m.kind === "meter" && m.percent).toBe(100)
  })

  test("an unmeasured plan is Unknown, never Free; staff have no plan", () => {
    expect(planLabel(undefined)).toBe("Unknown")
    expect(planLabel({ measured: false, plan: "free", paid: false, uncapped: false, upgradeUrl: null })).toBe("Unknown")
    expect(planLabel({ measured: true, plan: "pro", paid: true, uncapped: false, upgradeUrl: null })).toBe("Pro")
    // User 193 as measured on 2026-10-07: staff, paid, and still capped at $5.
    expect(planLabel({ measured: true, plan: null, paid: true, uncapped: false, upgradeUrl: null })).toBe("Staff")
  })

  test("a Hive node key is called out as a machine, not a person", () => {
    expect(sourceNote("~/.iris/config.json (node_api_key)")).toContain("Hive node key")
    expect(sourceNote("~/.iris/sdk/.env")).toBe("Credential from ~/.iris/sdk/.env.")
    expect(sourceNote("none (not signed in)")).toBeNull()
  })

  test("each reason nobody is signed in as a person gets its own words and fix (#188505, #188507)", () => {
    const base = {
      measured: true,
      signedIn: false,
      panelsDiffer: false,
      tokenSource: "",
      id: null,
      name: null,
      email: null,
    } as any
    expect(accountStatus(undefined, false)).toMatchObject({ title: "Couldn't load your account", action: "retry" })
    expect(accountStatus({ ...base, credential: "machine" }, false)).toMatchObject({
      title: "Signed in as this computer's Hive node",
      action: "sign-in",
    })
    expect(accountStatus({ ...base, credential: "rejected", reason: "fl-api 401" }, false).title).toBe(
      "Your sign-in was refused",
    )
    expect(accountStatus({ ...base, credential: "none" }, false).action).toBe("sign-in")
    expect(
      accountStatus({ ...base, credential: "personal", measured: false, reason: "fl-api 502" }, false),
    ).toMatchObject({
      title: "Can't reach IRIS",
      action: "retry",
    })
  })
})
