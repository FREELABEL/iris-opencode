/**
 * The ask to pay, measured (#190373, Leak 4 of EPIC #188414). The $1 weekly allowance now asks
 * about one free week in four; until these existed nothing said what happened after the ask.
 *
 * These go through the sidecar's onboarding pipe (/iris/onboarding/track), which adds this
 * machine's install id and the signed-in user, and only forwards names on its own list. The
 * names must match fl-iris-api GenesisEvent::DESKTOP_UPGRADE exactly: that endpoint drops any
 * other name with a silent 204. "Paid" is deliberately not an event — fl-iris-api reads it from
 * billing, because a public endpoint must not let a client claim a sale.
 */
export const UPGRADE_EVENTS = ["upgrade.prompted", "upgrade.opened", "upgrade.checkout_started"] as const
export type UpgradeEvent = (typeof UPGRADE_EVENTS)[number]

/** Where the ask came from. `prompted` uses out / almost / refused; `opened` uses pill / dock / settings / menu. */
export type UpgradeSource = "out" | "almost" | "refused" | "pill" | "dock" | "settings" | "menu"

type Post = (path: string, init?: RequestInit) => Promise<unknown>

/** The request the sidecar expects. Pure, so the contract is tested without a network. */
export function upgradeTrackRequest(event: UpgradeEvent, label?: string): [string, RequestInit] {
  return [
    "/iris/onboarding/track",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(label ? { event, label } : { event }),
    },
  ]
}

/** Fire and forget: measurement never breaks the ask itself. */
export function trackUpgrade(post: Post, event: UpgradeEvent, label?: string): void {
  try {
    void Promise.resolve(post(...upgradeTrackRequest(event, label))).catch(() => undefined)
  } catch {
    // A synchronous throw from the fetcher is still only a lost measurement.
  }
}

/**
 * The pill and the tab re-render and re-poll all day, so "prompted" is sent once per kind per
 * app run. The funnel counts distinct installs either way; this only keeps the table quiet.
 */
const prompted = new Set<string>()
export function trackPromptedOnce(post: Post, kind: "out" | "almost" | "refused"): boolean {
  if (prompted.has(kind)) return false
  prompted.add(kind)
  trackUpgrade(post, "upgrade.prompted", kind)
  return true
}

/** Test seam: forget what has been sent this run. */
export function resetPromptedForTest(): void {
  prompted.clear()
}
