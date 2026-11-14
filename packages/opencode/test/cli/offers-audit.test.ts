import { describe, expect, test } from "bun:test"
import { auditOffers, carriesDestination, componentsOf, effortModeOf, priceBands, stackMath } from "../../src/cli/cmd/offers-audit"

/**
 * The audit makes claims about somebody's catalogue, so every rule has to be checkable.
 *
 * Fixtures are shaped like the real platform catalogue (24 packages, `features` carrying
 * kind/unit/seats/sales_led/displayFeatures) rather than an idealised offer, because the first
 * version of these rules was written against a three-key preview of that column and got the
 * catalogue wrong — it reported "no stack" over packages that had one, and "one mode forever"
 * over a catalogue that already encoded its own ladder in `sales_led`.
 */

const diy = (title: string, price: number, display: string[] = ["a", "b", "c", "d"]): any => ({
  title,
  price,
  features: { kind: "product", unit: "seat", seats: 1, sales_led: false, displayFeatures: display },
})

const dfy = (title: string, price: number): any => ({
  title,
  price,
  features: { kind: "agency", unit: "engagement", seats: 1, sales_led: true, displayFeatures: ["x", "y"] },
})

describe("componentsOf", () => {
  test("finds the stack in displayFeatures, not the billing mechanics", () => {
    // The bug this pins: `kind`, `unit` and `seats` are pricing mechanics. Counting them as
    // components makes a stackless package look stacked.
    expect(componentsOf(diy("Atlas", 99, ["Search", "Vectors", "Exports"]))).toEqual(["Search", "Vectors", "Exports"])
  })

  test("a package with only mechanics has no stack", () => {
    expect(componentsOf({ features: { kind: "product", unit: "seat", seats: 1 } } as any)).toEqual([])
  })

  test("a bare list of strings is a stack", () => {
    expect(componentsOf({ features: ["Weekly call", "Templates"] } as any)).toEqual(["Weekly call", "Templates"])
  })

  test("objects in the list contribute their name or label", () => {
    expect(componentsOf({ features: [{ name: "Onboarding" }, { label: "Hotline" }] } as any)).toEqual([
      "Onboarding",
      "Hotline",
    ])
  })
})

describe("effortModeOf", () => {
  test("reads the continuum from sales_led, which the catalogue already sets", () => {
    expect(effortModeOf(dfy("Onboard Pilot", 6000))).toBe("DFY")
    expect(effortModeOf(diy("ReachR", 149))).toBe("DIY")
  })

  test("absent is unknown, not DIY", () => {
    // Guessing self-serve for an unlabelled package would quietly claim a ladder that may not
    // exist — the same "absent read as a value" failure the audit is built to catch.
    expect(effortModeOf({ features: { kind: "product" } } as any)).toBe("unknown")
    expect(effortModeOf({} as any)).toBe("unknown")
  })
})

describe("priceBands", () => {
  test("groups by order of magnitude, so 49 and 99 are one conversation", () => {
    const b = priceBands([diy("a", 49), diy("b", 99), diy("c", 4999)])
    expect(b.get(1)).toEqual(["a", "b"])
    expect(b.get(3)).toEqual(["c"])
  })

  test("free and unpriced packages do not land in a band", () => {
    expect([...priceBands([diy("free", 0), { title: "x" } as any]).keys()]).toEqual([])
  })
})

describe("carriesDestination", () => {
  test("an abstract product name carries no destination on its own", () => {
    expect(carriesDestination({ title: "Lexicon" } as any)).toBe(false)
    expect(carriesDestination({ title: "Pulse" } as any)).toBe(false)
  })

  test("outcome language in a subtitle counts — the check reads both", () => {
    expect(carriesDestination({ title: "ReachR", subtitle: "AI-powered outreach & lead gen" } as any)).toBe(true)
  })

  test("a result or a number is destination language", () => {
    expect(carriesDestination({ title: "Fill your gym in 30 days" } as any)).toBe(true)
    expect(carriesDestination({ title: "Book 10 clients" } as any)).toBe(true)
  })
})

describe("auditOffers", () => {
  test("flags the missing middle when both ends of the ladder exist", () => {
    const a = auditOffers([diy("Atlas", 99), diy("Solo", 199), dfy("Onboard Pilot", 6000)])
    const f = a.findings.find((x) => x.code === "no-dwy")
    expect(f).toBeDefined()
    expect(f!.severity).toBe("high")
    expect(f!.what).toContain("6000")
  })

  test("does NOT invent a missing middle when there is only one end", () => {
    // A catalogue of pure self-serve has no gap to fall into; reporting one would be noise, and
    // noise is how a check gets ignored.
    const a = auditOffers([diy("Atlas", 99), diy("Solo", 199)])
    expect(a.findings.some((x) => x.code === "no-dwy")).toBe(false)
  })

  test("flags a price band that has become a menu", () => {
    const a = auditOffers([49, 59, 69, 79, 89].map((p, i) => diy(`m${i}`, p)))
    expect(a.findings.some((x) => x.code === "price-cluster")).toBe(true)
  })

  test("does not call a real stack stackless", () => {
    // The regression from the first draft: these packages DO carry components.
    const a = auditOffers([diy("Atlas", 99, ["Search", "Vectors", "Exports", "API"])])
    expect(a.findings.some((x) => x.code === "no-stack")).toBe(false)
  })

  test("flags a missing price anchor, which is the finding that survives everything else", () => {
    const a = auditOffers([diy("Atlas", 99)])
    expect(a.findings.some((x) => x.code === "no-anchor")).toBe(true)
  })

  test("a per-component value satisfies the anchor check", () => {
    const withValue: any = {
      title: "Bundle",
      price: 500,
      features: { displayFeatures: [{ name: "Templates", value: 400 }, { name: "Hotline", value: 900 }] },
    }
    expect(auditOffers([withValue]).findings.some((x) => x.code === "no-anchor")).toBe(false)
  })

  test("flags a catalogue with no risk reversal anywhere", () => {
    expect(auditOffers([diy("Atlas", 99)]).findings.some((x) => x.code === "no-guarantee")).toBe(true)
  })

  test("guarantee language anywhere clears the risk-reversal check", () => {
    const a = auditOffers([diy("Atlas", 99, ["30-day money back guarantee", "Search"])])
    expect(a.findings.some((x) => x.code === "no-guarantee")).toBe(false)
  })

  test("ALWAYS reports what it could not measure, even when it found things", () => {
    // The load-bearing one. A short findings list must never read as a good score, so the
    // unmeasured block is unconditional and names the field that would unlock each check.
    const a = auditOffers([diy("Atlas", 99)])
    expect(a.findings.length).toBeGreaterThan(0)
    expect(a.unmeasured.length).toBeGreaterThan(0)
    expect(a.unmeasured.every((u) => u.blockedBy.length > 0)).toBe(true)
    expect(a.unmeasured.some((u) => u.code === "trim-2x2")).toBe(true)
  })

  test("findings come back worst-first so the renderer does not have to decide", () => {
    const a = auditOffers([diy("Atlas", 99), diy("Solo", 199), dfy("Pilot", 6000)])
    const rank = { high: 0, medium: 1, low: 2 } as const
    const seq = a.findings.map((f) => rank[f.severity])
    expect([...seq].sort((x, y) => x - y)).toEqual(seq)
  })
})

describe("stackMath — the subtraction the prospect performs", () => {
  const withComponents = (comps: any[], price = 500): any => ({
    title: "Bundle",
    price,
    features: { kind: "product", seats: 1, sales_led: false, displayFeatures: comps },
  })

  test("sums standalone value across components", () => {
    const m = stackMath(withComponents([{ name: "a", value: 400 }, { name: "b", value: 900 }]))
    expect(m.separately).toBe(1300)
    expect(m.valued).toBe(2)
    expect(m.components).toBe(2)
  })

  test("bare strings contribute nothing and are still counted as components", () => {
    // The half-filled stack: 1 of 3 valued. The sum must not pretend to be complete.
    const m = stackMath(withComponents([{ name: "a", value: 400 }, "b", "c"]))
    expect(m.separately).toBe(400)
    expect(m.valued).toBe(1)
    expect(m.components).toBe(3)
  })

  test("cost is null when nothing carries one — not zero", () => {
    // Zero cost and unknown cost are different claims, and zero would compute a 100% margin.
    expect(stackMath(withComponents([{ name: "a", value: 400 }])).cost).toBeNull()
  })

  test("cost sums when present", () => {
    const m = stackMath(withComponents([{ name: "a", value: 400, cost: 25 }, { name: "b", value: 100, cost: 5 }]))
    expect(m.cost).toBe(30)
    expect(m.costed).toBe(2)
  })

  test("accepts the synonyms a catalogue actually uses", () => {
    const m = stackMath(withComponents([{ name: "a", worth: 200, cost_to_deliver: 10 }]))
    expect(m.separately).toBe(200)
    expect(m.cost).toBe(10)
  })
})

describe("auditOffers — stack findings", () => {
  const pkg = (comps: any[], price: number): any => ({
    title: "Bundle",
    price,
    features: { kind: "product", seats: 1, sales_led: false, displayFeatures: comps },
  })

  test("flags a partially valued stack — the dangerous one", () => {
    const a = auditOffers([pkg([{ name: "a", value: 900 }, "b", "c"], 200)])
    const f = a.findings.find((x) => x.code === "partial-anchor")
    expect(f).toBeDefined()
    expect(f!.evidence[0]).toContain("1/3")
  })

  test("flags a package priced at or above its own stack", () => {
    // No gap means no steal — the mechanism inverted.
    const a = auditOffers([pkg([{ name: "a", value: 100 }, { name: "b", value: 100 }], 500)])
    expect(a.findings.some((x) => x.code === "no-gap")).toBe(true)
  })

  test("a real gap raises neither anchor finding", () => {
    const a = auditOffers([pkg([{ name: "a", value: 900 }, { name: "b", value: 900 }], 300)])
    expect(a.findings.some((x) => x.code === "no-anchor")).toBe(false)
    expect(a.findings.some((x) => x.code === "no-gap")).toBe(false)
    expect(a.findings.some((x) => x.code === "partial-anchor")).toBe(false)
  })

  test("computes margin against the ~80% compass when cost is present", () => {
    const a = auditOffers([pkg([{ name: "a", value: 900, cost: 200 }], 500)])
    expect(a.findings.some((x) => x.code === "thin-margin")).toBe(true)
  })

  test("STOPS reporting trim as unmeasurable once cost exists", () => {
    // A permanent "cannot measure" on something now measurable is the same lie as a false pass,
    // pointing the other way.
    const without = auditOffers([pkg([{ name: "a", value: 900 }], 300)])
    expect(without.unmeasured.some((u) => u.code === "trim-2x2")).toBe(true)

    const withCost = auditOffers([pkg([{ name: "a", value: 900, cost: 10 }], 300)])
    expect(withCost.unmeasured.some((u) => u.code === "trim-2x2")).toBe(false)
  })
})
