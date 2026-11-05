import { createSignal } from "solid-js"
/**
 * THE split between the page on the left and the IRIS panel on the right (#192535) — one number
 * for Home, the new-chat page and a chat. It is the LEFT side's share of the row, not a width in
 * pixels: Home used to save the panel's pixels and a chat the chat column's pixels, so a 1/3 : 2/3
 * set on Home snapped back the moment you opened a chat. A share also survives a window resize.
 */
const KEY = "iris.split"
const MIN = 0.2
const MAX = 0.8
const clamp = (v: number) => Math.min(MAX, Math.max(MIN, v))
const initial = (() => {
  try {
    const saved = Number(localStorage.getItem(KEY))
    if (saved > 0) return clamp(saved)
    // First run after this change: keep the split Home already had.
    const home = JSON.parse(localStorage.getItem("iris.home.panel") ?? "{}") as { width?: number }
    if (typeof home.width === "number" && window.innerWidth > 0) return clamp(1 - home.width / window.innerWidth)
  } catch {}
  return 0.5
})()
const [share, setShare] = createSignal(initial)
export const irisSplitShare = share
export function setIrisSplitShare(value: number) {
  if (!Number.isFinite(value)) return
  setShare(clamp(value))
  try {
    localStorage.setItem(KEY, String(share()))
  } catch {}
}
