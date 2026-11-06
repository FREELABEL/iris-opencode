/**
 * A LIST NEVER RENDERS ALL ITS CARDS AT ONCE (#192670). Board, List and Timeline used to loop over
 * every card: IRIS CLI Bug Reports holds 6,899, which made 88k–199k DOM nodes, froze the page for
 * 3.7–5.3 s, and crashed the desktop app's webview in Timeline. A list shows its first PAGE cards,
 * then a "Show 50 more · N left" control. Counts still say the true total.
 */
export const ATLAS_PAGE = 50

/** The cards a list shows, given how many the person has asked for (default one page). */
export function windowOf<T>(items: readonly T[], shown: number | undefined): readonly T[] {
  const n = shown ?? ATLAS_PAGE
  return items.length <= n ? items : items.slice(0, n)
}

/** What "Show more" would add, or undefined when everything is already shown. */
export function moreOf(total: number, shown: number | undefined): { next: number; left: number } | undefined {
  const n = shown ?? ATLAS_PAGE
  if (total <= n) return undefined
  return { next: Math.min(ATLAS_PAGE, total - n), left: total - n }
}

export const moreLabel = (m: { next: number; left: number }) =>
  `Show ${m.next} more · ${m.left.toLocaleString("en-US")} left`
