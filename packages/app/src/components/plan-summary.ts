/**
 * The three facts the Upgrade dialog and Settings > Plans state above the plan cards (#189988):
 * which plan you are on, how much of the allowance is LEFT, and when a trial ends.
 *
 * Pure, so every case is testable without a browser. Nothing here is policy: the cap, window and
 * reset all come from the server.
 */
export interface SummaryInput {
  signedIn?: boolean
  plan?: { measured: boolean; plan: string | null; label?: string | null; trialEndsAt?: string | null } | null
  allowance?: {
    measured: boolean
    window: string
    capUsd: number | null
    uncapped: boolean
    spendUsd: number | null
    resetsAt: string | null
  } | null
}

export interface PlanSummary {
  plan: string | null
  allowance: string | null
  trial: string | null
}

const usd = (n: number) => `$${n.toFixed(2)}`
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v)

function shortDate(iso: string | null | undefined, now: Date): Date | null {
  if (!iso) return null
  const at = new Date(iso)
  if (Number.isNaN(at.getTime()) || at.getTime() <= now.getTime()) return null
  return at
}

export function planSummary(me: SummaryInput | undefined | null, now: Date = new Date()): PlanSummary {
  const out: PlanSummary = { plan: null, allowance: null, trial: null }
  if (!me) return out

  const p = me.plan
  if (p?.measured) {
    const label = typeof p.label === "string" && p.label.trim() ? p.label.trim() : p.plan === null ? "Staff" : p.plan
    out.plan = label ? label.charAt(0).toUpperCase() + label.slice(1) : null
    const trialAt = shortDate(p.trialEndsAt, now)
    if (trialAt) {
      const days = Math.max(1, Math.ceil((trialAt.getTime() - now.getTime()) / 86_400_000))
      out.trial = `Trial ends ${trialAt.toLocaleDateString(undefined, { month: "short", day: "numeric" })} (${days} day${days === 1 ? "" : "s"} left)`
    }
  }

  const a = me.allowance
  if (a?.measured) {
    if (a.uncapped || a.capUsd === null) {
      out.allowance = "No weekly limit"
    } else if (finite(a.capUsd) && a.capUsd > 0 && finite(a.spendUsd) && a.spendUsd >= 0) {
      const left = Math.max(0, a.capUsd - a.spendUsd)
      const window = a.window || "week"
      const reset = shortDate(a.resetsAt, now)
      const resets = reset
        ? ` · resets ${reset.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}`
        : ""
      out.allowance =
        left > 0
          ? `${usd(left)} left of ${usd(a.capUsd)} this ${window}${resets}`
          : `${usd(a.capUsd)} this ${window} used up${resets}`
    }
  }
  return out
}
