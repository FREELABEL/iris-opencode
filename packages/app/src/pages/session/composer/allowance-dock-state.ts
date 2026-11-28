/**
 * What the allowance bar above the composer says (#190087) — shaped like the todos bar, shown only
 * when it matters: from 90% of the allowance, and in its "out" (gold, paused-on-you) state at 100%.
 * Tokens, never dollars (Alex, 2026-10-20). Every number comes from the server via /iris/plan.
 */
import {
  bestFit,
  clock,
  drawingOnGrants,
  fitLabel,
  longDuration,
  tokenCount as compute,
  type Offer,
  type UsagePlan,
} from "@/components/usage/usage-model"

/** /iris/plan. Every usage field beyond these is optional (epic #194525). */
export type AllowancePlan = UsagePlan

export function allowanceDockState(plan: AllowancePlan | undefined, now: Date = new Date()) {
  const f = plan?.measured ? plan.fraction : null
  if (typeof f !== "number" || !Number.isFinite(f) || f < 0.9) return null
  // Past the week but drawing on top-up tokens: nothing is paused, so there is nothing to say here —
  // the ring's green "+NM top-up left" says it (#194529).
  if (drawingOnGrants(plan)) return null
  const percent = Math.min(100, Math.floor(f * 100))
  const tokens =
    typeof plan?.tokensUsed === "number" && Number.isFinite(plan.tokensUsed) ? tokenCount(plan.tokensUsed) : null
  const reset = plan?.resetsAt ? new Date(plan.resetsAt) : null
  const resets =
    reset && !Number.isNaN(reset.getTime()) && reset.getTime() > now.getTime()
      ? `Resets ${reset.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })}`
      : null
  if (f >= 1) {
    return {
      tone: "out" as const,
      title: tokens ? `Out of allowance · ${tokens} tokens used this week` : "Out of allowance",
      percent,
      resets,
    }
  }
  return {
    tone: "warning" as const,
    title: `${percent}% of this week's allowance used${tokens ? ` · ${tokens} tokens` : ""}`,
    percent,
    resets,
  }
}

/** 850K, 12.4M, 2.3B — how the plans describe compute. */
function tokenCount(n: number) {
  if (n >= 1e9) return `${+(n / 1e9).toFixed(1)}B`
  if (n >= 1e6) return `${+(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${Math.round(n / 1e3)}K`
  return String(n)
}

/**
 * The out card (#194530): what the allowance tab shows at 100% instead of its one line. The work is
 * safe first, then three honest choices — pay once (top up), pay monthly (the cheapest plan this
 * week fits), or wait for the reset. Pure: the dock renders it, tests pin it.
 */
export interface OutCard {
  heading: string
  line: string
  /** The cheapest plan this week fits, with this week's share of it. Null = no plan we can measure. */
  plan: { slug: string; title: string; price: number; period: string; weekly: number; fit: string; detail: string } | null
  /** "Wait for Monday" + its detail. Null when the reset is unknown or past. */
  wait: { title: string; detail: string; at: string } | null
  /** Someone who pays is not asked to upgrade (#189544). */
  upgrade: boolean
}

export function outCardState(plan: AllowancePlan | undefined, offers: Offer[], now: Date = new Date()): OutCard | null {
  const s = allowanceDockState(plan, now)
  if (!s || s.tone !== "out") return null
  const cap = typeof plan?.capTokens === "number" && Number.isFinite(plan.capTokens) && plan.capTokens > 0 ? plan.capTokens : null
  const upgrade = plan?.paid !== true
  const fit = upgrade ? bestFit(offers, plan) : null
  const reset = plan?.resetsAt ? new Date(plan.resetsAt) : null
  const wait =
    reset && !Number.isNaN(reset.getTime()) && reset.getTime() > now.getTime()
      ? {
          title: `Wait for ${reset.toLocaleDateString("en-US", { weekday: "long" })}`,
          detail: `Your week resets ${reset.toLocaleDateString("en-US", { weekday: "long" })} at ${clock(reset)}. That's in ${longDuration(reset.getTime() - now.getTime())}.`,
          at: reset.toISOString(),
        }
      : null
  return {
    heading: cap ? `You've used this week's ${compute(cap)} tokens` : "You've used this week's tokens",
    line: "Your work is saved. It picks up the moment you choose.",
    plan: fit
      ? {
          slug: fit.offer.slug,
          title: fit.offer.title,
          price: fit.offer.price,
          period: fit.offer.period,
          weekly: fit.weekly,
          fit: fitLabel(fit.percent),
          detail: `${compute(fit.weekly)} tokens a week. You'd have used ${fitLabel(fit.percent)} of it this week.`,
        }
      : null,
    wait,
    upgrade,
  }
}
