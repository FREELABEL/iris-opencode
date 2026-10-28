import { createSignal } from "solid-js"

/**
 * A session tab being dragged out of the titlebar (#191484), and where the pointer is. The tab
 * strip writes it; the split view reads it to draw the drop zone and takes the drop. One titlebar
 * per window, so one channel per window: module state, like the other titlebar signals.
 */
export type TabDrag = { server: string; sessionId: string; x: number; y: number }

const [drag, setDrag] = createSignal<TabDrag>()
let onDrop: ((drag: TabDrag) => boolean) | undefined

export const tabDrag = drag

export function startTabDrag(input: TabDrag) {
  setDrag(input)
}

export function moveTabDrag(x: number, y: number) {
  setDrag((d) => (d ? { ...d, x, y } : d))
}

/** End the drag. True when the split view took it — the strip must then not reorder or select. */
export function endTabDrag(canceled: boolean) {
  const last = drag()
  setDrag(undefined)
  if (canceled || !last || !onDrop) return false
  return onDrop(last)
}

/** The split view's drop handler; returns the unregister function. */
export function handleTabDrop(fn: (drag: TabDrag) => boolean) {
  onDrop = fn
  return () => {
    if (onDrop === fn) onDrop = undefined
  }
}
