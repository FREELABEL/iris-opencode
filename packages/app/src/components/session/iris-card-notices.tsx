/**
 * Desktop notifications for your own Atlas cards (#189799), app-wide — mounted by the layout,
 * so you hear about a card assigned to you whatever you have open, not only while Atlas is.
 *
 * The sidecar holds the Pusher connection to private-user.{you} and streams `notice` events;
 * this turns each into an OS notification that, clicked, opens the card. When the sidecar is
 * unreachable or you are signed out, it waits and tries again — quietly, because a missing
 * notification channel is not something to put in front of anyone.
 */
import { onCleanup, onMount } from "solid-js"
import { readSse } from "./iris-atlas-live"
import { requestIrisNav } from "./iris-nav"

export interface CardNoticeEvent {
  kind: "assign" | "mention" | "due"
  text: string
  excerpt?: string
  bloqId: number
  itemId: number
  title?: string
  by?: string
}

/** Title and body for the OS notification. Never more than fl-api sent — a PHI board sends no title or excerpt. */
export function noticeCopy(n: CardNoticeEvent): { title: string; body: string } {
  const title = n.kind === "assign" ? "Assigned to you" : n.kind === "mention" ? "You were mentioned" : "Due tomorrow"
  return { title, body: n.excerpt ? `${n.text}\n“${n.excerpt}”` : n.text }
}

export function IrisCardNotices(props: {
  url: () => string
  fetch?: typeof globalThis.fetch
  notify: (title: string, body?: string, onClick?: () => void) => Promise<void> | void
  open?: () => void
}) {
  onMount(() => {
    let stopped = false
    let ctrl: AbortController | undefined
    let wait: ReturnType<typeof setTimeout> | undefined
    const run = async () => {
      if (stopped) return
      ctrl = new AbortController()
      try {
        const res = await (props.fetch ?? globalThis.fetch)(`${props.url().replace(/\/$/, "")}/iris/me/live`, { signal: ctrl.signal })
        if (res.ok && res.body)
          await readSse(res.body, (event, body) => {
            if (event !== "notice") return
            const n = body as CardNoticeEvent
            if (!n || typeof n.text !== "string" || !Number.isFinite(n.bloqId) || !Number.isFinite(n.itemId)) return
            const { title, body: text } = noticeCopy(n)
            void props.notify(title, text, () => {
              props.open?.()
              requestIrisNav({ surface: "atlas", bloqId: n.bloqId, itemId: n.itemId })
            })
          })
      } catch {}
      if (!stopped) wait = setTimeout(() => void run(), 15_000)
    }
    void run()
    onCleanup(() => {
      stopped = true
      if (wait) clearTimeout(wait)
      ctrl?.abort()
    })
  })
  return null
}
