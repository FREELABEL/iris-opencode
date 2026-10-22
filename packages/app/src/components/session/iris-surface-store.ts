/**
 * THE PANEL'S SHARED STORE (#190231 phase 2).
 *
 * Each IRIS panel surface (Atlas, Agents, Pages…) was a resource keyed by what is on screen, so
 * leaving a tab threw its data away and coming back waited on the network again — the board you
 * were just reading went blank for a round trip. And nothing said whether what you saw was
 * current: the only signal was Atlas's "Updating…" pill.
 *
 * Two things live here, shared by every panel in the window:
 *  - the last payload per view (page 1, keyed by board + surface + sub-view + query), so going
 *    back to a view draws it at once and refreshes behind it;
 *  - each surface's SYNC STATE, which the panel's chip and the product tab strip read:
 *      checking — drawn from what we held, asking for what is current
 *      synced   — this is what the server said, at `at`
 *      offline  — the server could not be reached; showing this machine's copy
 *      error    — the server answered, and not with data (signed out, refused…)
 *
 * Not a store library: Solid's createStore is the reactive part, and a plain Map holds payloads
 * (nothing renders from it directly, so it needs no reactivity). Bounded, oldest first out.
 */
import { createStore } from "solid-js/store"

export type SyncState = "checking" | "synced" | "offline" | "error"
export interface SurfaceSync {
  state: SyncState
  /** When the server last answered with data (ms). */
  at?: number
  /** When the copy on screen was taken (ISO) — offline or checking from a copy. */
  copiedAt?: string
  reason?: string
}

export const MAX_HELD = 40
const held = new Map<string, unknown>()
const [sync, setSync] = createStore<Record<string, SurfaceSync>>({})

export function holdPayload(key: string, payload: unknown) {
  held.delete(key)
  held.set(key, payload)
  while (held.size > MAX_HELD) held.delete(held.keys().next().value as string)
}

/** The last payload for this view, if any — and it becomes the most recently used. */
export function heldPayload<T = unknown>(key: string): T | undefined {
  if (!held.has(key)) return undefined
  const p = held.get(key)
  held.delete(key)
  held.set(key, p)
  return p as T
}

export function setSurfaceSync(surface: string, s: SurfaceSync) {
  setSync(surface, s)
}

export function surfaceSync(surface: string): SurfaceSync | undefined {
  return sync[surface]
}

/** Tests only. */
export function resetSurfaceStore() {
  held.clear()
  for (const k of Object.keys(sync)) setSync(k, undefined as any)
}

/**
 * A payload's sync state. `loading` is true while a refresh is in flight with this payload on
 * screen. `__at` is when the payload arrived (stamped by the panel); `__held` marks one drawn
 * from this store rather than fetched.
 */
export function syncOfPayload(p: any, loading = false): SurfaceSync {
  if (!p) return { state: "checking" }
  if (p.offline) return { state: "offline", copiedAt: p.copiedAt, reason: p.reason }
  if (p.measured === false) return loading ? { state: "checking" } : { state: "error", reason: p.reason }
  if (loading || p.__held || p.source === "copy") return { state: "checking", at: p.__at, copiedAt: p.copiedAt }
  return { state: "synced", at: p.__at }
}

function ago(ms: number): string {
  const mins = Math.max(0, Math.round(ms / 60_000))
  return mins < 1 ? "just now" : mins < 60 ? `${mins}m ago` : `${Math.round(mins / 60)}h ago`
}

/** The chip's words. */
export function syncLabel(s: SurfaceSync | undefined, now: number): { text: string; title: string } | null {
  if (!s) return null
  if (s.state === "checking") return { text: "Checking…", title: "Showing what this panel last had while it asks IRIS for what is current." }
  if (s.state === "synced")
    return {
      text: s.at ? `Synced · ${ago(now - s.at)}` : "Synced",
      title: "This is what IRIS returned. Click to check again.",
    }
  if (s.state === "offline") {
    const when = s.copiedAt ? ago(now - Date.parse(s.copiedAt)) : ""
    return {
      text: when ? `Offline · copy from ${when}` : "Offline",
      title: `Could not reach IRIS (${s.reason ?? "no connection"}). Showing this machine's copy${when ? ` from ${when}` : ""}. Click to try again.`,
    }
  }
  return { text: "Couldn't update", title: `${s.reason ?? "IRIS did not return data"}. Click to try again.` }
}

/** Whether a surface's tab should carry a dot: it is showing something that is not current. */
export function needsAttention(s: SurfaceSync | undefined): boolean {
  return s?.state === "offline" || s?.state === "error"
}
