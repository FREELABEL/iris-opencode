import { createMemo, createSignal } from "solid-js"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import snapshot from "./snapshot"
import { mergeDetails, type DetailsDoc } from "./model-details"

const bundled = snapshot as unknown as DetailsDoc

// One copy for the whole app: every picker open reads it, at most one request is in flight,
// and it is asked again only after it has gone stale.
const [live, setLive] = createSignal<Partial<DetailsDoc> | undefined>()
let fetchedAt = 0
let inFlight: Promise<void> | undefined
const STALE_MS = 10 * 60 * 1000

/**
 * The details document the picker shows (#194383): the copy bundled with the app, with the live
 * one from /iris/model-details laid over it once it arrives. Call `refresh()` when the picker
 * opens — never on a timer.
 */
export function useModelDetails() {
  const platform = usePlatform()
  const server = useServer()
  const base = () => server.current?.http?.url?.replace(/\/$/, "")

  const refresh = () => {
    if (inFlight || Date.now() - fetchedAt < STALE_MS) return
    const url = base()
    if (!url) return
    const fetcher = platform.fetch ?? globalThis.fetch
    inFlight = (async () => {
      try {
        const res = await fetcher(`${url}/iris/model-details`)
        if (!res.ok) return
        const body = (await res.json()) as { measured?: boolean; data?: Partial<DetailsDoc> }
        // measured=false: we could not ask. Keep the bundled copy; do not show it as "live".
        if (body?.measured && body.data) setLive(body.data)
      } catch {
        // Offline or an older engine without the route: the bundled copy is already showing.
      } finally {
        fetchedAt = Date.now()
        inFlight = undefined
      }
    })()
  }

  const doc = createMemo(() => mergeDetails(bundled, live()))
  return { doc, refresh }
}
