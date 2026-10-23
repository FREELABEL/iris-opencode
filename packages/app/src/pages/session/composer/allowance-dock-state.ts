/**
 * What the allowance bar above the composer says (#190087) — shaped like the todos bar, shown only
 * when it matters: from 90% of the allowance, and in its "out" (gold, paused-on-you) state at 100%.
 * Tokens, never dollars (Alex, 2026-10-20). Every number comes from the server via /iris/plan.
 */
export interface AllowancePlan {
  measured: boolean
  fraction?: number | null
  tokensUsed?: number | null
  resetsAt?: string | null
}

export function allowanceDockState(plan: AllowancePlan | undefined, now: Date = new Date()) {
  const f = plan?.measured ? plan.fraction : null
  if (typeof f !== "number" || !Number.isFinite(f) || f < 0.9) return null
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
