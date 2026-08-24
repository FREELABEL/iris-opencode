/**
 * How much of the population an answer actually covers, and how to say so.
 *
 * Extracted from the `leads list` handler so it can be tested (#182078). It was
 * inline, and the reporting is the part that failed: the command hides Prospected by
 * default, caps by recency, and reported only the page size. Each is defensible
 * alone. Together, with no population figure, they produce a confident partial
 * answer indistinguishable from a complete one — and six funnel KPIs were computed
 * from it over 56 rows out of 28,522.
 */
export type ListScope = {
  /** rows actually being shown */
  shown: number
  /** the POPULATION, from the paginator — not the page size */
  total: number
  /** rows removed by the default Prospected filter */
  prospectedHidden: number
}

export type ScopeReport = {
  truncated: boolean
  /** human-facing, appended to the count line */
  notes: string[]
  /** machine-facing, written to stderr so piped stdout stays parseable */
  warnings: string[]
}

export function describeListScope(s: ListScope): ScopeReport {
  // `>` not `!==`: a total that is somehow below `shown` is bad data, not truncation,
  // and inventing a negative remainder would be its own silent lie.
  const truncated = s.total > s.shown

  const notes: string[] = []
  if (s.prospectedHidden > 0) notes.push(`${s.prospectedHidden} Prospected hidden — use --all`)
  if (truncated) notes.push(`newest ${s.shown} of ${s.total}`)

  const warnings: string[] = []
  if (truncated) warnings.push(`TRUNCATED: newest ${s.shown} of ${s.total} by id`)
  if (s.prospectedHidden > 0) warnings.push(`FILTERED: ${s.prospectedHidden} Prospected hidden (pass --all)`)
  // Only when something was withheld. A clean answer that shouts about being clean
  // trains people to ignore the shout.
  if (warnings.length) warnings.push("This is a page, not a population — do not compute rates from it.")

  return { truncated, notes, warnings }
}
