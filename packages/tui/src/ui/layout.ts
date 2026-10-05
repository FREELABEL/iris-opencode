export const SESSION_SIDEBAR_WIDTH = 42
export const SESSION_TABS_COMPACT_WIDTH = 5
export const SESSION_TABS_COMPACT_BREAKPOINT = 12
export const SESSION_SIDEBAR_MAX_WIDTH = 72
const SESSION_CONTENT_MIN_WIDTH = 44
const SESSION_CONTENT_PREFERRED_WIDTH = 64

export function sessionTabsFitVertically(total: number, width = SESSION_SIDEBAR_WIDTH) {
  return total >= width + SESSION_CONTENT_PREFERRED_WIDTH
}

export function clampSessionTabsWidth(width: number, total: number) {
  return Math.max(
    SESSION_TABS_COMPACT_WIDTH,
    Math.min(width, SESSION_SIDEBAR_MAX_WIDTH, total - SESSION_CONTENT_MIN_WIDTH),
  )
}

export function clampSessionPaneWidth(width: number, total: number) {
  const half = Math.max(1, Math.floor(total / 2))
  // Preserve the equal split when there is not enough room for both pane minima.
  return Math.max(Math.min(24, half), Math.min(width, Math.max(half, total - SESSION_CONTENT_MIN_WIDTH)))
}

// [IRIS] The session sidebar is resizable (drag its left edge, or the palette's Widen/Narrow
// sidebar). SESSION_SIDEBAR_WIDTH stays upstream's 42 because it also sizes the vertical tabs rail.
export const IRIS_SIDEBAR_WIDTH = 68
export const IRIS_SIDEBAR_STEPS = [44, 56, 68, 80, 92] as const
const IRIS_SIDEBAR_MIN_WIDTH = 36

export function clampSidebarWidth(width: number, total: number) {
  if (!Number.isFinite(width)) return IRIS_SIDEBAR_WIDTH
  return Math.max(IRIS_SIDEBAR_MIN_WIDTH, Math.min(Math.round(width), total - SESSION_CONTENT_MIN_WIDTH))
}

/** The next ladder step wider (+1) or narrower (-1) than `width`, as v1's sidebar did. */
export function stepSidebarWidth(width: number, direction: 1 | -1) {
  const steps = direction > 0 ? IRIS_SIDEBAR_STEPS : [...IRIS_SIDEBAR_STEPS].reverse()
  return steps.find((s) => (direction > 0 ? s > width : s < width)) ?? steps[steps.length - 1]
}
