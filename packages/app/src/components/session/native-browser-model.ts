/**
 * The native Browser's pure rules (#193051, spike #193062). No DOM, no Tauri: tested alone.
 */
import type { NativeBrowserBounds } from "@/context/platform"

/** The quick-launch tiles (epic Q7: Alex picks the final list). */
export const QUICK_SITES: { label: string; url: string }[] = [
  { label: "Google", url: "https://www.google.com" },
  { label: "YouTube", url: "https://www.youtube.com" },
  { label: "X", url: "https://x.com" },
  { label: "Instagram", url: "https://www.instagram.com" },
  { label: "TikTok", url: "https://www.tiktok.com" },
  { label: "LinkedIn", url: "https://www.linkedin.com" },
  { label: "GitHub", url: "https://github.com" },
  { label: "Spotify", url: "https://open.spotify.com" },
]

/**
 * Where the native view goes: the panel body's rect, in logical window pixels. The app's own
 * zoom scales CSS pixels; the window does not know about it, so multiply here. Rounded, because
 * a fractional bound makes the view shimmer by a pixel on every resize.
 *
 * Returns undefined when the body is not on screen (zero size: the tab is `hidden`), which is
 * the signal to hide the view, never to draw it at 1×1.
 */
export function boundsOf(
  rect: { left: number; top: number; width: number; height: number },
  zoom = 1,
): NativeBrowserBounds | undefined {
  if (!(rect.width > 1 && rect.height > 1)) return undefined
  const z = zoom > 0 ? zoom : 1
  return {
    x: Math.round(rect.left * z),
    y: Math.round(rect.top * z),
    width: Math.round(rect.width * z),
    height: Math.round(rect.height * z),
  }
}

export function sameBounds(a: NativeBrowserBounds | undefined, b: NativeBrowserBounds | undefined) {
  if (!a || !b) return a === b
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

/** Quiet time after the last placement before the view is placed once more regardless (#193405). */
export const BOUNDS_SETTLE_MS = 150

/** Placement numbers, shared by every pane in this app load, so they only ever go up. */
let placements = 0
export const nextPlacement = () => ++placements

type Timers = { set: (fn: () => void, ms: number) => unknown; clear: (handle: unknown) => void }
const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
}

/**
 * Keeps the native view on the panel body while the window is resized (#193405).
 *
 * `follow` sends a rect only when it differs from the last one sent, numbered so the native side
 * can drop one that lands late. That alone could leave the view wrong for good: a mid-drag rect
 * applied after the final one (or a rect read before macOS live resize settled), and then the
 * final rect is never sent again because it equals the last one SENT. So every send (and every
 * window resize, `arm`) restarts a short quiet timer; when it fires, `settle` re-measures and
 * the caller passes the rect back with `force`, which sends it once more whatever it is.
 */
export function boundsFollower(opts: {
  send: (bounds: NativeBrowserBounds, seq: number) => void
  settle: () => void
  wait?: number
  timers?: Timers
  next?: () => number
}) {
  const timers = opts.timers ?? realTimers
  const next = opts.next ?? nextPlacement
  let last: NativeBrowserBounds | undefined
  let timer: unknown
  const stop = () => {
    if (timer !== undefined) timers.clear(timer)
    timer = undefined
  }
  const arm = () => {
    stop()
    timer = timers.set(() => {
      timer = undefined
      opts.settle()
    }, opts.wait ?? BOUNDS_SETTLE_MS)
  }
  return {
    /** `show` put the view at `b` (it numbers its own call with `nextPlacement`). */
    placed(b: NativeBrowserBounds) {
      last = b
      arm()
    },
    follow(b: NativeBrowserBounds, force = false) {
      if (!force && sameBounds(b, last)) return
      last = b
      opts.send(b, next())
      if (!force) arm()
    },
    arm,
    stop,
  }
}

/**
 * Things that draw OVER the panel: dialogs, menus, popovers, the command palette, toasts.
 * The native view sits above the whole DOM, so while any of these is open it must be hidden or
 * it covers them. This is the overlay cost the spike exists to judge (epic Q1).
 */
export const OVERLAY_SELECTOR = [
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[role="menu"]',
  '[role="listbox"]',
  "[data-popper-positioner]",
  '[data-component="dialog"]',
  '[data-component="toast"]',
].join(",")

/** On by default where the platform has it; `iris.browser.native=0` turns it off (spike). */
export function nativeBrowserEnabled(storage: Pick<Storage, "getItem"> | undefined, available: boolean): boolean {
  if (!available) return false
  try {
    return storage?.getItem("iris.browser.native") !== "0"
  } catch {
    return true
  }
}
