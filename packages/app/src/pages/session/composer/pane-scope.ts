// A session pane is one chat: the whole window with one chat open, one column in split view
// (split-view.tsx). Anything a pane measures or focuses must be found inside that pane — a
// document-wide query finds the FIRST column's element, whichever column asked (#191780).

const COLUMN = '[data-component="session-split-column"]'
const PANEL = '[data-component="session-panel"]'

/** The column holding `el`, or undefined when only one chat is open. */
export function paneColumn(el: Element | null | undefined): HTMLElement | undefined {
  const column = el?.closest(COLUMN)
  return column instanceof HTMLElement ? column : undefined
}

/** The element to search for `el`'s own pane: its chat panel, else its column, else the document. */
export function paneRoot(el: Element | null | undefined): ParentNode {
  const panel = el?.closest(PANEL) ?? el?.closest(COLUMN)
  return panel ?? document
}

/** The conversation's scroller in `el`'s own pane. */
export function paneScroller(el: Element | null | undefined): HTMLElement | undefined {
  const scroller = paneRoot(el).querySelector(".scroll-view__viewport")
  return scroller instanceof HTMLElement ? scroller : undefined
}

/**
 * May a card that just appeared in `el`'s pane take keyboard focus? Only when the person is not
 * typing somewhere else: nothing is focused, or focus is already in this pane. With one chat open
 * the pane is the window, so the card always takes it, as before (#191781).
 */
export function mayTakeFocus(el: Element | null | undefined): boolean {
  const active = document.activeElement
  if (!active || active === document.body || active === document.documentElement) return true
  const column = paneColumn(el)
  if (!column) return true
  return column.contains(active)
}
