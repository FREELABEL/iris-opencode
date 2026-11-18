/**
 * Terminals side by side in the side panel's Terminal tab (#193785), as iTerm splits a tab.
 *
 * A split is a GROUP of terminals shown together. The tab strip still lists every terminal:
 * picking one in the group focuses its pane; picking one outside it shows that terminal alone,
 * and the group comes back when you pick one of its members again. Closing a terminal takes it
 * out of the group. Kept as plain data so the rules are tested without a DOM.
 */
export const MAX_SPLIT = 4

/** What is on screen: the group when the active terminal is in it, else the active one alone. */
export function shownTerminals(group: readonly string[], alive: readonly string[], active: string | undefined) {
  if (!active || !alive.includes(active)) return []
  const live = group.filter((id) => alive.includes(id))
  return live.length > 1 && live.includes(active) ? live : [active]
}

/** The group after splitting what is on screen with a new terminal; at the cap, unchanged. */
export function splitWith(shown: readonly string[], next: string) {
  if (shown.length >= MAX_SPLIT) return [...shown]
  return [...shown.filter((id) => id !== next), next]
}

/** The group after a pane leaves it ("Unsplit" on that pane, or the terminal closing). */
export function leaveSplit(group: readonly string[], id: string) {
  return group.filter((x) => x !== id)
}
