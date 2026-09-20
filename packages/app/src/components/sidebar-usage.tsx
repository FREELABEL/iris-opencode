import { createMemo, createResource, createSignal, onCleanup, onMount, Show } from "solid-js"
import { useServer } from "@/context/server"
import { usePlatform } from "@/context/platform"
import { Tooltip } from "@opencode-ai/ui/tooltip"

type Billing = {
  measured: boolean
  reason?: string
  plan: string | null
  bypassed: boolean
  fraction: number
  bindingPeriod: string
  capUsd: number
  spentUsd: number
  resetsAt: string | null
  upgradeUrl: string | null
}

/**
 * A small ring in the sidebar footer showing spend against the binding cap.
 *
 * WHY THIS EXISTS AT ALL. Until now the only moment this app mentioned money was a 429 — a
 * refusal, delivered after the decision was already made, printed into the transcript as an
 * error. A user's first knowledge that a spending cap existed was the sentence telling them
 * they had hit it. This is the surface that makes the 80% moment possible, and on the measured
 * numbers it reaches far more people than the dialog does: the median active day is $0.35
 * against a $5.00 cap, so most users never see the wall at all.
 *
 * THREE THINGS IT DELIBERATELY DOES NOT DO:
 *
 *  - It does not render while `measured` is false. An unreachable endpoint and a user who has
 *    spent nothing both produce zero, and a reassuringly empty ring shown to someone about to
 *    hit a wall is worse than no ring. Same rule the fleet pill learned by getting it wrong.
 *  - It does not render for an account the gate bypasses. A ring that can never fill is a
 *    decoration that teaches people to ignore rings.
 *  - It hardcodes no price, no plan name and no URL. Every one of those comes from the server,
 *    because this client ships on its own release cadence and a fact baked into it is a fact we
 *    cannot correct without a release.
 */
// classList is not accepted on SVG children in this JSX typing, so the band resolves to a
// plain class string instead.
function toneClass(tone: string) {
  if (tone === "full") return "text-danger"
  if (tone === "warn") return "text-warning"
  return "text-icon-base opacity-60"
}

export function SidebarUsage(props: { compact?: boolean }) {
  const server = useServer()
  const platform = usePlatform()
  const [tick, setTick] = createSignal(0)

  const base = createMemo(() => server.current?.http?.url?.replace(/\/$/, ""))

  // Spend moves only when the user sends something, and the gate itself caches for 60s, so a
  // faster poll would show the same number and only cost requests.
  onMount(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 60_000)
    onCleanup(() => clearInterval(timer))
  })

  const key = createMemo(() => {
    const b = base()
    return b ? ([b, tick()] as const) : undefined
  })

  const [billing] = createResource(key, async () => {
    const res = await (platform.fetch ?? globalThis.fetch)(`${base()}/iris/billing`)
    return (await res.json()) as Billing
  })

  const show = createMemo(() => {
    const b = billing.latest
    return !!b && b.measured && !b.bypassed && b.capUsd > 0
  })

  const pct = createMemo(() => Math.min(100, Math.round((billing.latest?.fraction ?? 0) * 100)))

  // Three bands, and the thresholds are the argument: under 80% this is ambient information and
  // should not compete with anything; at 80% it is the last honest moment to offer an upgrade;
  // at 100% the product has stopped and the ring should say so before the user discovers it by
  // being refused.
  const tone = createMemo(() => (pct() >= 100 ? "full" : pct() >= 80 ? "warn" : "calm"))

  const label = createMemo(() => {
    const b = billing.latest
    if (!b) return ""
    const spent = b.spentUsd.toFixed(2)
    const cap = b.capUsd.toFixed(2)
    const period = b.bindingPeriod === "monthly" ? "this month" : "today"
    const head = `$${spent} of $${cap} ${period}`
    return pct() >= 100 ? `${head} — limit reached. Click to see plans.` : `${head}. Click to see plans.`
  })

  const open = () => {
    const url = billing.latest?.upgradeUrl
    if (url) platform.openExternal(url)
  }

  // Circumference of r=9 — the dash offset below is the fraction NOT yet spent.
  const C = 2 * Math.PI * 9

  return (
    <Show when={show()}>
      <Tooltip placement={props.compact ? "bottom" : "right"} value={label()}>
        <button
          type="button"
          onClick={open}
          aria-label={label()}
          class="relative flex items-center justify-center size-8 rounded-md hover:bg-background-element transition-colors"
          data-usage-tone={tone()}
        >
          <svg width="24" height="24" viewBox="0 0 24 24" class="-rotate-90">
            <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2.5" class="text-icon-base opacity-25" />
            <circle
              cx="12"
              cy="12"
              r="9"
              fill="none"
              stroke="currentColor"
              stroke-width="2.5"
              stroke-linecap="round"
              stroke-dasharray={String(C)}
              stroke-dashoffset={String(C * (1 - Math.min(1, pct() / 100)))}
              class={toneClass(tone())}
            />
          </svg>
        </button>
      </Tooltip>
    </Show>
  )
}
