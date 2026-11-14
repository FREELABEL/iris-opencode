import { describe, test, expect } from "bun:test"
import { computeLine, rollup, scoreScenario, ledgerToActuals, applyCategoryMapping } from "./mint-scenarios"

/**
 * GOLDEN FIXTURE — §24 of /p/iris-labs-pricing-model, "Simulation — the path to $2M MRR".
 *
 * Used because it is a real published model with a documented self-correction: the page
 * states units are 6,950 (an earlier draft overcounted by 500) and the blended margin is
 * 69.7% "weighting each line by its own revenue", not a flat average. Both of those are
 * exactly the mistakes this module must not make, so the fixture tests the arithmetic AND
 * the two known wrong answers.
 */
const S24 = [
  { label: "OS · Solo", unit_price: 99, units: 2000, margin_pct: 0.73 },
  { label: "OS · Team", unit_price: 399, units: 1000, margin_pct: 0.78 },
  { label: "OS · Scale", unit_price: 999, units: 500, margin_pct: 0.79 },
  { label: "Legal Lexicon, per seat", unit_price: 149, units: 2000, margin_pct: 0.79 },
  { label: "Standalone heavy", unit_price: 149, units: 1300, margin_pct: 0.74 },
  { label: "Agency FDE", unit_price: 2750, units: 150, margin_pct: 0.4 },
]

describe("computeLine", () => {
  test("monthly is price x units", () => {
    expect(computeLine({ label: "x", unit_price: 99, units: 2000, margin_pct: 0.73 }).monthly).toBe(198000)
  })

  test("margin_amount is monthly x margin_pct", () => {
    expect(computeLine({ label: "x", unit_price: 99, units: 2000, margin_pct: 0.73 }).margin_amount).toBe(144540)
  })

  // Money is computed in cents and rounded ONCE, never per-row-then-summed.
  test("fractional prices do not drift", () => {
    const r = computeLine({ label: "x", unit_price: 0.1, units: 3, margin_pct: 0.5 })
    expect(r.monthly).toBe(0.3)
    expect(r.margin_amount).toBe(0.15)
  })

  test("an UNMEASURED margin stays null — it does not become zero", () => {
    const r = computeLine({ label: "x", unit_price: 100, units: 10, margin_pct: null })
    expect(r.monthly).toBe(1000)
    expect(r.margin_amount).toBeNull()
  })
})

describe("rollup — against the published §24 numbers", () => {
  const r = rollup(S24)

  test("units total 6,950 (the page's own corrected figure)", () => {
    expect(r.units).toBe(6950)
  })

  test("monthly totals $2,000,700", () => {
    expect(r.monthly).toBe(2000700)
  })

  test("margin dollars are ~$1.39M, as the page states", () => {
    expect(r.margin_amount).toBeCloseTo(1394123, 0)
  })

  test("blended margin is 69.7% — REVENUE-WEIGHTED", () => {
    expect(r.blended_margin_pct).toBeCloseTo(0.697, 3)
  })

  // The two documented wrong answers must not be reproducible.
  test("blended margin is NOT the flat average of the percentages", () => {
    const flat = S24.reduce((a, l) => a + (l.margin_pct as number), 0) / S24.length
    expect(flat).toBeCloseTo(0.705, 3)
    expect(r.blended_margin_pct).not.toBeCloseTo(flat, 3)
  })

  test("units are not the 7,450 overcount", () => {
    expect(r.units).not.toBe(7450)
  })
})

describe("rollup — honesty about unmeasured inputs", () => {
  const mixed = [
    { label: "measured", unit_price: 100, units: 10, margin_pct: 0.5 },
    { label: "unmeasured", unit_price: 100, units: 10, margin_pct: null },
  ]

  // The whole point. §24's own caveat is that margins are assigned by workload class rather
  // than measured; a blend computed over a guess is false precision with a six-figure error
  // bar at scale. If any line is unmeasured the blend is NOT a number.
  test("one unmeasured line makes the blended margin null, not a smaller number", () => {
    expect(rollup(mixed).blended_margin_pct).toBeNull()
  })

  test("it names which lines are unmeasured", () => {
    expect(rollup(mixed).unmeasured_lines).toEqual(["unmeasured"])
  })

  test("revenue still totals — only the margin is withheld", () => {
    expect(rollup(mixed).monthly).toBe(2000)
    expect(rollup(mixed).margin_amount).toBeNull()
  })

  test("an all-measured scenario reports no unmeasured lines", () => {
    expect(rollup(S24).unmeasured_lines).toEqual([])
  })

  test("an empty scenario is empty, not zero-with-confidence", () => {
    const r = rollup([])
    expect(r.units).toBe(0)
    expect(r.monthly).toBe(0)
    expect(r.blended_margin_pct).toBeNull()
  })
})

describe("scoreScenario — the part that justifies building this", () => {
  const planned = [
    { label: "OS · Solo", unit_price: 99, units: 2000, margin_pct: 0.73 },
    { label: "Agency FDE", unit_price: 2750, units: 150, margin_pct: 0.4 },
  ]

  test("variance is actual minus planned, per line", () => {
    const s = scoreScenario(planned, [{ label: "OS · Solo", monthly: 150000 }])
    const line = s.lines.find((l) => l.label === "OS · Solo")!
    expect(line.planned).toBe(198000)
    expect(line.actual).toBe(150000)
    expect(line.variance).toBe(-48000)
  })

  // A line with no actuals is UNKNOWN, not zero. Reporting 0 would say "we earned nothing
  // here", when the truth is "nothing was recorded here" — the exact distinction Mint's run
  // log already makes between a failed run and a zero.
  test("a line with no actuals is unknown, not zero", () => {
    const s = scoreScenario(planned, [{ label: "OS · Solo", monthly: 150000 }])
    const fde = s.lines.find((l) => l.label === "Agency FDE")!
    expect(fde.actual).toBeNull()
    expect(fde.variance).toBeNull()
    expect(fde.status).toBe("no_actuals")
  })

  test("actual revenue with no matching scenario line is surfaced, not dropped", () => {
    const s = scoreScenario(planned, [{ label: "Consulting", monthly: 5000 }])
    expect(s.unmatched_actual).toEqual(["Consulting"])
  })

  test("totals only sum lines that HAVE actuals", () => {
    const s = scoreScenario(planned, [{ label: "OS · Solo", monthly: 150000 }])
    expect(s.totals.actual).toBe(150000)
    expect(s.totals.planned_scored).toBe(198000)
    expect(s.totals.lines_without_actuals).toBe(1)
  })

  test("label matching ignores case and surrounding whitespace", () => {
    const s = scoreScenario(planned, [{ label: "  os · solo ", monthly: 1 }])
    expect(s.lines.find((l) => l.label === "OS · Solo")!.actual).toBe(1)
  })

  test("scoring nothing against nothing is not a pass", () => {
    const s = scoreScenario([], [])
    expect(s.totals.lines_without_actuals).toBe(0)
    expect(s.totals.actual).toBe(0)
    expect(s.lines).toEqual([])
  })
})

describe("ledgerToActuals — turning the ledger into scoreable revenue", () => {
  const TX = [
    {
      type: "revenue",
      amount_cents: 375000,
      category: "Membership Revenue",
      transaction_date: "2026-04-04T00:00:00Z",
      metadata: { scope: "business" },
    },
    {
      type: "revenue",
      amount_cents: 245000,
      category: "Membership Revenue",
      transaction_date: "2026-04-04T00:00:00Z",
      metadata: { scope: "business" },
    },
    {
      type: "expense",
      amount_cents: 1200000,
      category: "contracts",
      transaction_date: "2026-04-15T00:00:00Z",
      metadata: { scope: "business" },
    },
    {
      type: "revenue",
      amount_cents: 100000,
      category: "Client Services",
      transaction_date: "2026-07-01T00:00:00Z",
      metadata: { scope: "business" },
    },
    {
      type: "revenue",
      amount_cents: 50000,
      category: "Side gig",
      transaction_date: "2026-04-10T00:00:00Z",
      metadata: { scope: "personal" },
    },
  ]

  // An expense counted as revenue would invent income. This is the single most important
  // assertion in the file.
  test("EXPENSES ARE NEVER COUNTED AS REVENUE", () => {
    const a = ledgerToActuals(TX, {})
    expect(a.find((x) => x.label === "contracts")).toBeUndefined()
  })

  test("groups revenue by category and sums it", () => {
    const a = ledgerToActuals(TX, {})
    expect(a.find((x) => x.label === "Membership Revenue")!.monthly).toBe(6200)
  })

  test("cents are summed as integers, converted once", () => {
    const a = ledgerToActuals(
      [
        { type: "revenue", amount_cents: 1, category: "x", transaction_date: "2026-04-01T00:00:00Z" },
        { type: "revenue", amount_cents: 2, category: "x", transaction_date: "2026-04-01T00:00:00Z" },
      ],
      {},
    )
    expect(a[0].monthly).toBe(0.03)
  })

  test("date window is inclusive of both ends", () => {
    const a = ledgerToActuals(TX, { from: "2026-04-04", to: "2026-04-04" })
    expect(a).toHaveLength(1)
    expect(a[0].monthly).toBe(6200)
  })

  test("a window that excludes everything yields NO lines, not zeroed ones", () => {
    expect(ledgerToActuals(TX, { from: "2027-01-01", to: "2027-12-31" })).toEqual([])
  })

  test("scope filters, and business excludes personal", () => {
    const a = ledgerToActuals(TX, { scope: "business" })
    expect(a.find((x) => x.label === "Side gig")).toBeUndefined()
  })

  // Silently dropping uncategorised money would hide revenue entirely; it must surface so
  // scoreScenario can report it as unmatched.
  test("uncategorised revenue is surfaced, not dropped", () => {
    const a = ledgerToActuals([{ type: "revenue", amount_cents: 500, transaction_date: "2026-04-01T00:00:00Z" }], {})
    expect(a).toEqual([{ label: "(uncategorised)", monthly: 5 }])
  })

  test("an empty ledger yields no lines", () => {
    expect(ledgerToActuals([], {})).toEqual([])
  })
})

describe("applyCategoryMapping — explicit line to ledger-category wiring", () => {
  const actuals = [
    { label: "Membership Revenue", monthly: 6200 },
    { label: "Consulting", monthly: 900 },
  ]

  test("relabels a mapped category to its scenario line", () => {
    const m = applyCategoryMapping(actuals, [{ label: "OS · Solo", ledger_category: "Membership Revenue" }])
    expect(m.find((a) => a.label === "OS · Solo")!.monthly).toBe(6200)
  })

  test("an unmapped category keeps its own name so it surfaces as unmatched", () => {
    const m = applyCategoryMapping(actuals, [{ label: "OS · Solo", ledger_category: "Membership Revenue" }])
    expect(m.find((a) => a.label === "Consulting")).toBeTruthy()
  })

  // A line with no mapping must NOT silently absorb a same-named category by accident, but
  // an exact label match is a legitimate mapping.
  test("a line with no ledger_category still matches an identically named category", () => {
    const m = applyCategoryMapping([{ label: "Consulting", monthly: 900 }], [{ label: "Consulting" }])
    expect(m).toEqual([{ label: "Consulting", monthly: 900 }])
  })

  test("two lines mapped to the same category both receive it", () => {
    const m = applyCategoryMapping(actuals, [
      { label: "A", ledger_category: "Membership Revenue" },
      { label: "B", ledger_category: "Membership Revenue" },
    ])
    expect(
      m
        .filter((a) => a.monthly === 6200)
        .map((a) => a.label)
        .sort(),
    ).toEqual(["A", "B"])
  })
})
