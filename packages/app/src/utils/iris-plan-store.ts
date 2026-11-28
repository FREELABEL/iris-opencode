import { createRoot, createSignal } from "solid-js"
import type { UsagePlan } from "@/components/usage/usage-model"

/**
 * /iris/plan, app-wide (epic #194525). The title bar pill, the allowance tab above the composer and
 * the context ring all show the same allowance, so they read ONE copy of it — not three pollers.
 * /iris/plan peeks (?peek=1): asking never consumes the weekly notice, so polling it is safe.
 * Never poll /iris/allowance.
 *
 * A signal, not a resource, on purpose: reading it can never suspend (#191772 — a dock that read an
 * unresolved resource handed the whole chat to <Suspense> and the column went black). Until the
 * first answer it is undefined, and every reader treats undefined as "show nothing new".
 */
type Fetch = (path: string, init?: RequestInit) => Promise<Response>

const store = createRoot(() => {
  const [plan, setPlan] = createSignal<UsagePlan | undefined>(undefined)
  const [fetcher, setFetcher] = createSignal<Fetch | null>(null)
  return { plan, setPlan, fetcher, setFetcher }
})

let timer: ReturnType<typeof setInterval> | null = null
let inflight: Promise<void> | null = null

/** The latest /iris/plan answer. Undefined until the first one; a failed read keeps the last. */
export const irisPlan = store.plan

/** Re-read now — after a refusal, after returning from Stripe, after a top-up. */
export function refreshIrisPlan(): Promise<void> {
  const fetcher = store.fetcher()
  if (!fetcher) return Promise.resolve()
  if (inflight) return inflight
  inflight = (async () => {
    try {
      const res = await fetcher("/iris/plan")
      const j = (await res.json()) as UsagePlan
      if (j && typeof j === "object" && typeof j.measured === "boolean") store.setPlan(j)
    } catch {
      // Keep the last reading. A sidecar restarting is not "you have no plan".
    } finally {
      inflight = null
    }
  })()
  return inflight
}

/**
 * Start the shared read (once a minute, and the moment the window comes back — paying happens in
 * the browser, so returning is when the plan most likely changed, #190190). Idempotent: the first
 * caller's fetch is used; later callers only make sure it is running.
 */
export function watchIrisPlan(doFetch: Fetch) {
  if (!store.fetcher()) store.setFetcher(() => doFetch)
  if (timer) return
  void refreshIrisPlan()
  timer = setInterval(() => void refreshIrisPlan(), 60_000)
  if (typeof window !== "undefined") window.addEventListener("focus", () => void refreshIrisPlan())
}

/** Test seam. */
export function setIrisPlanForTest(plan: UsagePlan | undefined) {
  store.setPlan(plan)
}
