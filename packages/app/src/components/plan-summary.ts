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
    /** Tokens used this window, same sources as the meter (fl-iris-api #190087). */
    tokensUsed?: number | null
  } | null
}

export interface PlanSummary {
  plan: string | null
  allowance: string | null
  trial: string | null
  /** Share of the allowance used, 0–100, FLOORED; null when unmeasured or uncapped (no meter). */
  percent: number | null
  /** Used up. Drives the yellow "out" state. */
  over: boolean
}

const usd = (n: number) => `$${n.toFixed(2)}`
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v)
/** 850K, 12.4M, 2.3B — how the plans describe compute. */
const tokenCount = (n: number) =>
  n >= 1e9
    ? `${+(n / 1e9).toFixed(1)}B`
    : n >= 1e6
      ? `${+(n / 1e6).toFixed(1)}M`
      : n >= 1e3
        ? `${Math.round(n / 1e3)}K`
        : String(n)

function shortDate(iso: string | null | undefined, now: Date): Date | null {
  if (!iso) return null
  const at = new Date(iso)
  if (Number.isNaN(at.getTime()) || at.getTime() <= now.getTime()) return null
  return at
}

export function planSummary(me: SummaryInput | undefined | null, now: Date = new Date()): PlanSummary {
  const out: PlanSummary = { plan: null, allowance: null, trial: null, percent: null, over: false }
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
      out.over = a.spendUsd >= a.capUsd
      out.percent = Math.min(100, Math.floor((a.spendUsd / a.capUsd) * 100))
      const window = a.window || "week"
      const reset = shortDate(a.resetsAt, now)
      const resets = reset
        ? ` · resets ${reset.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}`
        : ""
      // People see TOKENS and a share, never dollars (Alex, 2026-10-20): the plans are sold as
      // 5x / 20x and "M tokens", so the meter speaks the same language. Staff also get the
      // dollars, for debugging.
      const used = finite(a.tokensUsed) ? `${tokenCount(a.tokensUsed)} tokens used this ${window}` : null
      const words = out.over
        ? `This ${window}'s allowance is used up`
        : used
          ? `${used} · ${out.percent}% of your allowance`
          : `${out.percent}% of this ${window}'s allowance used`
      const staff = me.plan?.measured && (me.plan.label === "Staff" || me.plan.plan === null)
      const debug = staff ? ` · ${used && out.over ? `${used} · ` : ""}${usd(a.spendUsd)} of ${usd(a.capUsd)}` : ""
      out.allowance = `${words}${debug}${resets}`
    }
  }
  return out
}
