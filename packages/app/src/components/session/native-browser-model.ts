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
