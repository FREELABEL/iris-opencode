import { describe, expect, test } from "bun:test"
import { fleetDotClass, fleetLabel, inboxLabel, planBadge, TITLEBAR_UPGRADE_URL } from "./titlebar-iris-pills"

describe("fleetDotClass", () => {
  // The dot is a verdict, so its colours must obey the same three-fact rule as the label:
  // loading is grey, unreachable is danger, measured-with-someone-up is green. A not-yet-
  // fetched fleet wearing green is the not-yet-measured-as-verdict bug fleetLabel caught.
  test("loading is grey, not green", () => {
    expect(fleetDotClass(undefined, true)).toBe("text-v2-text-text-weak")
    expect(fleetDotClass(undefined, false)).toBe("text-v2-text-text-danger")
  })
  test("a measured fleet with a machine up is green", () => {
    expect(
      fleetDotClass({ measured: true, nodes: [{ online: true, name: "n" }, { online: false, name: "n" }] }),
    ).toBe("text-v2-state-fg-success")
  })
  test("measured and all down is muted, NOT danger — reachable and dead are different facts", () => {
    expect(fleetDotClass({ measured: true, nodes: [{ online: false, name: "n" }] })).toBe("text-v2-text-text-weak")
  })
})

describe("fleetLabel", () => {
  test("LOADING is not unreachable", () => {
    // Caught by an e2e run, not by a unit test: two consecutive runs read "●3/4" and "●—",
    // because the in-flight state and the failed state rendered the same glyph. A pill that
    // says "unreachable" for the first second of every launch trains people to ignore it.
    expect(fleetLabel(undefined, true)).toBe("·")
    expect(fleetLabel(undefined, false)).toBe("—")
  })

  test("an unreachable fleet is a dash, never 0/0", () => {
    // "0/0" says we looked and everything is down — which sends someone to go check a machine
    // that is probably fine. "—" says we could not look.
    expect(fleetLabel({ measured: false, reason: "iris-api 401", nodes: [] })).toBe("—")
    expect(fleetLabel(undefined)).toBe("—")
  })

  test("a measured fleet counts online against total", () => {
    expect(fleetLabel({ measured: true, nodes: [{ online: true, name: "n" }, { online: false, name: "n" }, { online: true, name: "n" }] })).toBe("2/3")
  })

  test("a measured fleet that really is all down says so", () => {
    expect(fleetLabel({ measured: true, nodes: [{ online: false, name: "n" }] })).toBe("0/1")
  })
})

describe("inboxLabel", () => {
  test("shows nothing while loading, rather than a dash", () => {
    expect(inboxLabel(undefined, true)).toBeNull()
    expect(inboxLabel({ unread: null, unreadable: true }, true)).toBeNull()
  })

  test("nothing waiting shows nothing — a permanent 0 is furniture", () => {
    expect(inboxLabel({ unread: 0, unreadable: false })).toBeNull()
  })

  test("an unreadable manifest is a dash, not silence", () => {
    // Silence here would be indistinguishable from an empty inbox, which is the exact failure
    // that let four messages sit unread on 2026-09-11.
    expect(inboxLabel({ unread: null, unreadable: true })).toBe("—")
    expect(inboxLabel({ unread: null, unreadable: false })).toBe("—")
  })

  test("unread shows the count", () => {
    expect(inboxLabel({ unread: 4, unreadable: false })).toBe("4")
  })
})


describe("planBadge", () => {
  test("only an account we KNOW has not paid sees Upgrade", () => {
    expect(planBadge({ measured: true, plan: "free", paid: false, upgradeUrl: "https://x.test/plans" })).toEqual({
      text: "Upgrade",
      url: "https://x.test/plans",
    })
    expect(planBadge({ measured: true, plan: "free", paid: false, upgradeUrl: null })?.url).toBe(TITLEBAR_UPGRADE_URL)
  })

  test("a paying customer whose plan name maps to free is NOT told to upgrade", () => {
    // The bug this keys on `paid` to avoid: "IRIS Solo" normalises to the free tier server-side.
    expect(planBadge({ measured: true, plan: "free", paid: true, upgradeUrl: null })).toBeNull()
    expect(planBadge({ measured: true, plan: "pro", paid: true, upgradeUrl: null })).toBeNull()
  })

  test("unknown, unmeasured, or a server too old to report paid shows nothing", () => {
    expect(planBadge(undefined)).toBeNull()
    expect(planBadge({ measured: false, plan: "free", paid: false, upgradeUrl: null })).toBeNull()
    expect(planBadge({ measured: true, plan: "free", paid: null, upgradeUrl: null })).toBeNull()
    expect(planBadge({ measured: true, plan: "free", upgradeUrl: null })).toBeNull()
  })
})
