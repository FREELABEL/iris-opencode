import { createEffect, onCleanup } from "solid-js"
import type { Conversation } from "./iris-inbox-model"
import { todayCount } from "./iris-outreach-model"
import { inReviewCount, type ReviewBatch } from "./iris-reachr-review-model"
import { setSurfaceCount } from "./iris-surface-store"

/**
 * The Leads tab's "in review" badge (#192483; on Leads since #192544), kept current while the tab is in the strip.
 *
 * The same request the Leads console makes first (/iris/reachr/batches, no new endpoint), asked
 * once when the panel opens and every couple of minutes after, only while the window is visible.
 * While the pane itself is open it reads the batches and sets the badge (iris-reachr-review.tsx),
 * so this stands down. A failed read leaves the last count alone rather than showing a false 0.
 */
const POLL_MS = 120_000

export function watchOutreachBadge(input: {
  doFetch: (path: string) => Promise<Response>
  /** Leads is in the strip — there is a tab to put the number on. */
  shown: () => boolean
  /** The Leads console is on screen and counts for itself. */
  paneOpen: () => boolean
}) {
  let inFlight = false
  const read = async () => {
    if (inFlight || !input.shown() || input.paneOpen() || document.visibilityState === "hidden") return
    inFlight = true
    try {
      const r = (await (await input.doFetch("/iris/reachr/batches")).json()) as { measured?: boolean; data?: ReviewBatch[] }
      if (r?.measured) setSurfaceCount("leads", inReviewCount(r.data))
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

/**
 * The Outreach tab's number (#193487): replies that need an answer plus messages in review — the
 * Today list's length in messages. The same two requests Today makes (/iris/comms, /iris/reachr/batches),
 * on the same schedule as the badge above. Either one failing still counts the other; both failing
 * leaves the last number alone.
 */
export function watchOutreachTodayBadge(input: { doFetch: (path: string) => Promise<Response>; shown: () => boolean; paneOpen: () => boolean }) {
  let inFlight = false
  const json = (path: string) =>
    input
      .doFetch(path)
      .then((r) => r.json())
      .catch(() => null)
  const read = async () => {
    if (inFlight || !input.shown() || input.paneOpen() || document.visibilityState === "hidden") return
    inFlight = true
    try {
      const [c, b] = (await Promise.all([json("/iris/comms?days=14"), json("/iris/reachr/batches")])) as [
        { measured?: boolean; conversations?: Conversation[] } | null,
        { measured?: boolean; data?: ReviewBatch[] } | null,
      ]
      const n = todayCount(c?.measured ? c.conversations : undefined, b?.measured ? b.data : undefined)
      if (n !== undefined) setSurfaceCount("outreach", n)
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
