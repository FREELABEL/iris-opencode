import { createEffect, onCleanup } from "solid-js"
import { inReviewCount, type ReviewBatch } from "./iris-reachr-review-model"
import { setSurfaceCount } from "./iris-surface-store"

/**
 * The Outreach tab's "in review" badge (#192483), kept current while the tab is in the strip.
 *
 * The same request the Outreach pane makes first (/iris/reachr/batches, no new endpoint), asked
 * once when the panel opens and every couple of minutes after, only while the window is visible.
 * While the pane itself is open it reads the batches and sets the badge (iris-reachr-review.tsx),
 * so this stands down. A failed read leaves the last count alone rather than showing a false 0.
 */
const POLL_MS = 120_000

export function watchOutreachBadge(input: {
  doFetch: (path: string) => Promise<Response>
  /** Outreach is in the strip — there is a tab to put the number on. */
  shown: () => boolean
  /** The Outreach pane is on screen and counts for itself. */
  paneOpen: () => boolean
}) {
  let inFlight = false
  const read = async () => {
    if (inFlight || !input.shown() || input.paneOpen() || document.visibilityState === "hidden") return
    inFlight = true
    try {
      const r = (await (await input.doFetch("/iris/reachr/batches")).json()) as { measured?: boolean; data?: ReviewBatch[] }
      if (r?.measured) setSurfaceCount("outreach", inReviewCount(r.data))
    } catch {
      // Unknown stays as it was. The pane says why when opened.
    } finally {
      inFlight = false
    }
  }
  createEffect(() => {
    if (input.shown()) void read()
  })
  const timer = setInterval(() => void read(), POLL_MS)
  const onVisible = () => void read()
  document.addEventListener("visibilitychange", onVisible)
  onCleanup(() => {
    clearInterval(timer)
    document.removeEventListener("visibilitychange", onVisible)
  })
}
