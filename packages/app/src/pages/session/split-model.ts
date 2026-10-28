/**
 * THE SPLIT, AS DATA (#191484). Two or three sessions side by side in one window.
 *
 * The URL still names one session — the focused column — so everything window-level (titlebar,
 * tabs, shortcuts, deep links) keeps meaning what it meant. The split is the ordered list of
 * sessions on screen, kept per window. These functions are the rules; split-view.tsx draws them.
 */
export type PaneRef = { server: string; sessionId: string }

/** Narrowest a column may get before the split drops one: chat is fine at 360, code blocks are not. */
export const PANE_MIN_WIDTH = 480
export const PANE_MAX = 3
export const PANE_GAP = 8

export const paneKey = (p: PaneRef) => `${p.server}\n${p.sessionId}`
export const samePane = (a: PaneRef, b: PaneRef) => a.server === b.server && a.sessionId === b.sessionId

/** How many columns fit: derived from width, never a fixed 3 (a 1440 laptop with the sidebar open fits 2). */
export function maxColumns(width: number | undefined) {
  if (width === undefined) return PANE_MAX
  return Math.max(1, Math.min(PANE_MAX, Math.floor((width + PANE_GAP) / (PANE_MIN_WIDTH + PANE_GAP))))
}

/**
 * The split after the route moved to `route`. Under two panes there is no split. A route that is
 * already a column just moves focus. A route that is not — the user picked another tab — takes
 * the place of the column they were last in, the way an editor group does.
 */
export function reconcile(panes: PaneRef[], route: PaneRef, lastFocused: number): PaneRef[] {
  if (panes.length < 2) return panes
  if (panes.some((p) => samePane(p, route))) return panes
  const at = Math.min(Math.max(lastFocused, 0), panes.length - 1)
  return panes.map((p, i) => (i === at ? route : p))
}

/** Add `next` beside `focused` (to its right). Starting a split seeds it with the focused session. */
export function open(panes: PaneRef[], focused: PaneRef, next: PaneRef): PaneRef[] {
  if (samePane(focused, next)) return panes
  const base = panes.some((p) => samePane(p, focused)) ? panes : [focused]
  if (base.some((p) => samePane(p, next))) return base
  const at = base.findIndex((p) => samePane(p, focused))
  return [...base.slice(0, at + 1), next, ...base.slice(at + 1)].slice(0, PANE_MAX)
}

/** Remove a column. One left means no split at all. */
export function close(panes: PaneRef[], target: PaneRef): PaneRef[] {
  const next = panes.filter((p) => !samePane(p, target))
  return next.length < 2 ? [] : next
}

/**
 * Close a column and say where focus goes. Closing the focused one hands focus to the column that
 * slides into its place (or the one before, at the right edge) — including the last one left,
 * when the split ends. Closing any other column leaves focus where it is.
 */
export function closeColumn(panes: PaneRef[], target: PaneRef, route: PaneRef): { panes: PaneRef[]; focus?: PaneRef } {
  const next = close(panes, target)
  if (!samePane(target, route)) return { panes: next }
  const rest = panes.filter((p) => !samePane(p, target))
  const at = panes.findIndex((p) => samePane(p, target))
  return { panes: next, focus: rest[Math.min(at, rest.length - 1)] }
}

/** Drop columns whose session no longer has a tab. The route's own session is exempt (it gets its tab just after). */
export function prune(panes: PaneRef[], route: PaneRef, open: Set<string>): PaneRef[] {
  const kept = panes.filter((p) => samePane(p, route) || open.has(paneKey(p)))
  if (kept.length === panes.length) return panes
  return kept.length < 2 ? [] : kept
}

/**
 * The columns drawn when not all fit: a run of `max` that always includes the focused one, kept
 * as far left as it can be so columns do not shuffle as focus moves among the visible ones.
 */
export function visible(panes: PaneRef[], route: PaneRef, max: number): PaneRef[] {
  if (panes.length <= max) return panes
  const at = Math.max(
    0,
    panes.findIndex((p) => samePane(p, route)),
  )
  const start = Math.min(Math.max(0, at - max + 1), panes.length - max)
  return panes.slice(start, start + max)
}
