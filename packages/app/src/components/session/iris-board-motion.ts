/**
 * FLIP for the board (the drag preview): cards SLIDE to their new place instead of jumping.
 *
 * Measure every card, let `change` move the DOM (Solid applies a signal write synchronously), measure
 * again, and play each card from where it was to where it is. Elon's board gets the same from
 * SortableJS's `animation: 150`; the desktop board keeps native drag-and-drop — the Delegate rail
 * reads its `dataTransfer` — so the motion is done here instead.
 */
const MS = 150

export function slideCards(root: HTMLElement | undefined, change: () => void) {
  if (!root || matchMedia("(prefers-reduced-motion: reduce)").matches) return change()
  const cards = () => Array.from(root.querySelectorAll<HTMLElement>("[data-board-card]"))
  const before = new Map(cards().map((el) => [el.dataset.boardCard, el.getBoundingClientRect()]))
  change()
  for (const el of cards()) {
    const was = before.get(el.dataset.boardCard)
    if (!was) continue
    const now = el.getBoundingClientRect()
    const dx = was.left - now.left
    const dy = was.top - now.top
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue
    // `animate` is missing in some test DOMs; there, the card simply arrives without the slide.
    el.animate?.([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0, 0)" }], {
      duration: MS,
      easing: "cubic-bezier(0.2, 0, 0, 1)",
    })
  }
}
