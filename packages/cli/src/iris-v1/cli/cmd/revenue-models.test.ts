import { describe, test, expect } from "bun:test"
import {
  REVENUE_MODELS,
  DEFAULT_REVENUE_MODEL,
  getRevenueModel,
  isKnownRevenueModel,
  resolveRevenueModel,
  kpiAppliesTo,
  partitionByModel,
  listRevenueModels,
} from "./revenue-models"

describe("revenue-model profiles (RO-7 #182271)", () => {
  test("both load-bearing profiles are declared, with distinct nouns", () => {
    const sub = REVENUE_MODELS.subscription
    const pay = REVENUE_MODELS.payer_billed
    expect(sub.workItem).toBe("opportunity")
    expect(pay.workItem).toBe("claim")
    expect(sub.terminalUnpaid).toBe("lost")
    expect(pay.terminalUnpaid).toBe("denied")
    // The reason taxonomy is the row that proves this is an abstraction, not a rename:
    // a loss reason is free text, a CARC is a controlled vocabulary.
    expect(pay.reasonTaxonomy).toBe("carc_rarc")
    expect(pay.recovery).toBe("appeal")
  })

  test("every profile fills every spine slot — no half-declared profile", () => {
    for (const m of listRevenueModels()) {
      for (const k of ["key", "label", "workItem", "terminalPaid", "terminalUnpaid", "reasonTaxonomy", "recovery", "whenToUse"] as const) {
        expect(String(m[k] ?? "")).not.toBe("")
      }
      expect(m.cycleMetric.from).not.toBe("")
      expect(m.cycleMetric.to).not.toBe("")
      expect(m.costRatio.num).not.toBe("")
      expect(m.costRatio.den).not.toBe("")
    }
  })

  test("days_in_ar starts at SERVICE, not submission — charge lag is part of the number", () => {
    // Measuring A/R from claim submission hides charge lag, which is itself an HFMA MAP Key
    // (PB-4 Total Charge Lag Days). Starting the clock late flatters the metric.
    expect(REVENUE_MODELS.payer_billed.cycleMetric.from).toBe("service_date")
  })
})

describe("resolveRevenueModel — a default is not a decision", () => {
  test("an undeclared bloq resolves to the default and reports declared:false", () => {
    const r = resolveRevenueModel({})
    expect(r.profile.key).toBe(DEFAULT_REVENUE_MODEL)
    expect(r.declared).toBe(false)
    expect(r.rawValue).toBeNull()
    expect(r.unknown).toBe(false)
  })

  test("the default preserves existing behaviour — no board silently changes meaning", () => {
    expect(DEFAULT_REVENUE_MODEL).toBe("subscription")
  })

  test("a declared model reports declared:true", () => {
    const r = resolveRevenueModel({ revenue_model: "payer_billed" })
    expect(r.profile.key).toBe("payer_billed")
    expect(r.declared).toBe(true)
  })

  test("REGRESSION-SHAPE: an unknown value is flagged, not silently defaulted", () => {
    // A typo must never read as a deliberate choice. This is the same failure family as a
    // gate reporting "gated" without saying gated to whom.
    const r = resolveRevenueModel({ revenue_model: "payerbilled" })
    expect(r.unknown).toBe(true)
    expect(r.declared).toBe(false)
    expect(r.rawValue).toBe("payerbilled")
    expect(r.profile.key).toBe(DEFAULT_REVENUE_MODEL) // still usable, but caller must warn
  })

  test("whitespace and casing do not create a phantom unknown", () => {
    const r = resolveRevenueModel({ revenue_model: "  Payer_Billed " })
    expect(r.profile.key).toBe("payer_billed")
    expect(r.declared).toBe(true)
    expect(r.unknown).toBe(false)
  })

  test("an empty string is treated as undeclared, not as an unknown model", () => {
    const r = resolveRevenueModel({ revenue_model: "   " })
    expect(r.declared).toBe(false)
    expect(r.unknown).toBe(false)
  })

  test("null/undefined context does not throw", () => {
    expect(resolveRevenueModel(null).profile.key).toBe(DEFAULT_REVENUE_MODEL)
    expect(resolveRevenueModel(undefined).profile.key).toBe(DEFAULT_REVENUE_MODEL)
  })

  test("isKnownRevenueModel gates the --model override", () => {
    expect(isKnownRevenueModel("payer_billed")).toBe(true)
    expect(isKnownRevenueModel("nonsense")).toBe(false)
    expect(isKnownRevenueModel(null)).toBe(false)
  })

  test("getRevenueModel never returns undefined", () => {
    expect(getRevenueModel("nonsense").key).toBe(DEFAULT_REVENUE_MODEL)
    expect(getRevenueModel(undefined).key).toBe(DEFAULT_REVENUE_MODEL)
  })
})

describe("kpiAppliesTo — an untagged KPI must never vanish", () => {
  test("absent applies_to means it applies everywhere", () => {
    // The whole 19-KPI set on #624 is untagged today. If absence meant 'hidden', turning
    // this feature on would empty the board — and a metric that vanishes reads as
    // 'we don't track that', which is indistinguishable from 'we track it and it's fine'.
    expect(kpiAppliesTo({ name: "MRR" }, "payer_billed")).toBe(true)
    expect(kpiAppliesTo({ name: "MRR", applies_to: null }, "payer_billed")).toBe(true)
  })

  test("an empty array also means everywhere, not nowhere", () => {
    expect(kpiAppliesTo({ applies_to: [] }, "subscription")).toBe(true)
  })

  test("a tagged KPI only applies to its listed profiles", () => {
    const k = { applies_to: ["payer_billed"] }
    expect(kpiAppliesTo(k, "payer_billed")).toBe(true)
    expect(kpiAppliesTo(k, "subscription")).toBe(false)
  })

  test("a spine KPI listing both applies under both", () => {
    const k = { applies_to: ["subscription", "payer_billed"] }
    expect(kpiAppliesTo(k, "subscription")).toBe(true)
    expect(kpiAppliesTo(k, "payer_billed")).toBe(true)
  })

  test("a bare string is accepted as a one-element list", () => {
    expect(kpiAppliesTo({ applies_to: "payer_billed" }, "payer_billed")).toBe(true)
    expect(kpiAppliesTo({ applies_to: "payer_billed" }, "subscription")).toBe(false)
  })

  test("casing and whitespace in stored tags do not drop a KPI", () => {
    expect(kpiAppliesTo({ applies_to: [" Payer_Billed "] }, "payer_billed")).toBe(true)
  })
})

describe("partitionByModel — report what was set aside", () => {
  test("splits rather than silently filtering", () => {
    const items = [
      { name: "MRR" }, // untagged → active everywhere
      { name: "Clean claim rate", applies_to: ["payer_billed"] },
      { name: "Pipeline coverage", applies_to: ["subscription"] },
    ]
    const { active, hidden } = partitionByModel(items, "payer_billed")
    expect(active.map((a: any) => a.name)).toEqual(["MRR", "Clean claim rate"])
    expect(hidden.map((h: any) => h.name)).toEqual(["Pipeline coverage"])
  })

  test("every item lands in exactly one half", () => {
    const items = [{ a: 1 }, { applies_to: ["subscription"] }, { applies_to: ["payer_billed"] }]
    const { active, hidden } = partitionByModel(items, "subscription")
    expect(active.length + hidden.length).toBe(items.length)
  })
})
