/**
 * Mint scenarios — the arithmetic behind a financial model, and the scoring that makes it
 * more than a spreadsheet.
 *
 * Two rules run through everything here, and both exist because the alternative is a
 * confident wrong number:
 *
 *  1. MONEY IS INTEGER CENTS until the moment it is reported. Rounding per row and then
 *     summing loses money in a way that only shows up at scale.
 *  2. AN UNKNOWN IS NULL, NEVER ZERO. §24 of the pricing model assigns margins "by workload
 *     class rather than measurement" because spend is not yet attributed per client or
 *     product. A blend computed over that guess is false precision — at $2M revenue the
 *     blended margin is worth ~$1.39M/mo, so a ten-point error is $200,000. So a scenario
 *     with any unmeasured line reports NO blended margin and names the lines responsible,
 *     rather than quietly averaging a guess into a decimal.
 */

export type ScenarioLine = {
  label: string
  unit_price: number
  units: number
  /** null = not measured. Deliberately distinct from 0, which means "measured, and zero". */
  margin_pct: number | null
}

export type LineResult = ScenarioLine & { monthly: number; margin_amount: number | null }

export type Rollup = {
  lines: LineResult[]
  units: number
  monthly: number
  margin_amount: number | null
  blended_margin_pct: number | null
  unmeasured_lines: string[]
}

const toCents = (dollars: number): number => Math.round(dollars * 100)
const toDollars = (cents: number): number => cents / 100

export function computeLine(line: ScenarioLine): LineResult {
  const monthlyCents = toCents(line.unit_price) * line.units
  const marginCents = line.margin_pct === null ? null : Math.round(monthlyCents * line.margin_pct)
  return {
    ...line,
    monthly: toDollars(monthlyCents),
    margin_amount: marginCents === null ? null : toDollars(marginCents),
  }
}

export function rollup(lines: ScenarioLine[]): Rollup {
  const computed = lines.map(computeLine)
  const unmeasured = lines.filter((l) => l.margin_pct === null).map((l) => l.label)

  let unitsTotal = 0
  let monthlyCents = 0
  let marginCents = 0
  for (const l of lines) {
    unitsTotal += l.units
    const m = toCents(l.unit_price) * l.units
    monthlyCents += m
    if (l.margin_pct !== null) marginCents += Math.round(m * l.margin_pct)
  }

  // One unmeasured line poisons the blend for the whole scenario. Reporting the blend of
  // just the measured lines would be worse than reporting nothing: it looks like the
  // answer, and it silently excludes exactly the part nobody has measured.
  const anyUnmeasured = unmeasured.length > 0
  const hasLines = lines.length > 0

  return {
    lines: computed,
    units: unitsTotal,
    monthly: toDollars(monthlyCents),
    margin_amount: anyUnmeasured || !hasLines ? null : toDollars(marginCents),
    blended_margin_pct:
      anyUnmeasured || !hasLines || monthlyCents === 0 ? null : marginCents / monthlyCents,
    unmeasured_lines: unmeasured,
  }
}

export type ActualLine = { label: string; monthly: number }

export type ScoredLine = {
  label: string
  planned: number
  actual: number | null
  variance: number | null
  variance_pct: number | null
  status: "scored" | "no_actuals"
}

export type Score = {
  lines: ScoredLine[]
  unmatched_actual: string[]
  totals: {
    planned_all: number
    /** Only the planned lines that HAVE actuals — the only honest comparison base. */
    planned_scored: number
    actual: number
    variance: number
    lines_without_actuals: number
  }
}

const key = (s: string): string => s.trim().toLowerCase()

export function scoreScenario(planned: ScenarioLine[], actual: ActualLine[]): Score {
  const actualByKey = new Map<string, number>()
  for (const a of actual) {
    actualByKey.set(key(a.label), (actualByKey.get(key(a.label)) ?? 0) + toCents(a.monthly))
  }

  const matched = new Set<string>()
  const lines: ScoredLine[] = planned.map((p) => {
    const plannedCents = toCents(p.unit_price) * p.units
    const k = key(p.label)
    const hasActual = actualByKey.has(k)
    if (hasActual) matched.add(k)
    const actualCents = hasActual ? (actualByKey.get(k) as number) : null

    // A line with no actuals is UNKNOWN, not zero. Zero would assert "we earned nothing
    // here"; the truth is "nothing was recorded here". Mint already draws that distinction
    // between a failed run and a zero — scoring inherits it rather than inventing a 0.
    return {
      label: p.label,
      planned: toDollars(plannedCents),
      actual: actualCents === null ? null : toDollars(actualCents),
      variance: actualCents === null ? null : toDollars(actualCents - plannedCents),
      variance_pct:
        actualCents === null || plannedCents === 0 ? null : (actualCents - plannedCents) / plannedCents,
      status: actualCents === null ? "no_actuals" : "scored",
    }
  })

  let plannedAllCents = 0
  let plannedScoredCents = 0
  let actualCentsTotal = 0
  let without = 0
  for (const p of planned) {
    const c = toCents(p.unit_price) * p.units
    plannedAllCents += c
    if (actualByKey.has(key(p.label))) plannedScoredCents += c
    else without++
  }
  for (const k of matched) actualCentsTotal += actualByKey.get(k) as number

  return {
    lines,
    // Revenue that arrived against no plan is a finding, not noise — it means the model is
    // missing a line, which is the sort of thing a scenario exists to reveal.
    unmatched_actual: actual.filter((a) => !matched.has(key(a.label))).map((a) => a.label),
    totals: {
      planned_all: toDollars(plannedAllCents),
      planned_scored: toDollars(plannedScoredCents),
      actual: toDollars(actualCentsTotal),
      variance: toDollars(actualCentsTotal - plannedScoredCents),
      lines_without_actuals: without,
    },
  }
}
