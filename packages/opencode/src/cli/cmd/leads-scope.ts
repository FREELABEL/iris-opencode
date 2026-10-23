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
  /**
   * How many rows the filter was applied to. `prospectedHidden` is counted over FETCHED
   * rows, not the whole book, so on its own it reads as a book-wide figure it is not:
   * the default list fetched 100, hid 73 of them, showed 20, and printed
   * "73 Prospected hidden" beside "20 of 28750" — two numbers that cannot both be
   * counts of the same population (#190003). Say the window when we know it.
   */
  scanned?: number
  /**
   * How the server picked the window, in words a reader can check — "most recently
   * active", "newest", "by name". The report QUOTES this, it does not assume it
   * (#184945). Saying "newest N of M" while the server ordered by something else is
   * the same defect as not saying anything: a sentence about the data that is not a
   * fact about the data. Defaults to the neutral "first" when the caller does not know.
   */
  ordering?: string
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

  const ordering = s.ordering && s.ordering.trim() ? s.ordering.trim() : "first"

  // The count is over the scanned window, so name the window when we know it. Otherwise
  // "73 Prospected hidden" sits next to "20 of 28750" and reads as a book-wide figure.
  const hidden = `Prospected hidden${s.scanned && s.scanned > s.shown ? ` of ${s.scanned} scanned` : ""}`

  const notes: string[] = []
  if (s.prospectedHidden > 0) notes.push(`${s.prospectedHidden} ${hidden} — use --all`)
  if (truncated) notes.push(`${ordering} ${s.shown} of ${s.total}`)

  const warnings: string[] = []
  if (truncated) warnings.push(`TRUNCATED: ${ordering} ${s.shown} of ${s.total}`)
  if (s.prospectedHidden > 0) warnings.push(`FILTERED: ${s.prospectedHidden} ${hidden} (pass --all)`)
  // Only when something was withheld. A clean answer that shouts about being clean
  // trains people to ignore the shout.
  if (warnings.length) warnings.push("This is a page, not a population — do not compute rates from it.")

  return { truncated, notes, warnings }
}
