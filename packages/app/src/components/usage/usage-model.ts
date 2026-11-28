/**
 * Usage as a progression (epic #194525) — every judgement the ring, its popover, the out card and
 * the plans dialog make, as pure functions so each case is tested without a browser.
 *
 * Rules that hold across all of them:
 * - Tokens, never dollars, for usage (Alex, 2026-10-20). Prices appear only on a plan or a pack.
 * - Loading or unknown is never a verdict (#190087): unmeasured input returns null, and the caller
 *   renders what it rendered before this epic.
 * - Only measured facts. Nothing estimated ("hours saved") is shown.
 * - Every field from the epic is optional: today's server sends none of them.
 */

export interface NextTier {
  slug: string
  label: string
  priceUsd: number | null
  period: string
  capTokensWeek: number | null
}

export interface UsageProgress {
  level: { key: string; label: string } | null
  nextLevel: { key: string; label: string; requires: string | null } | null
  checklist: { key: string; label: string; done: boolean; rewardTokens: number | null }[]
  streakWeeks: number | null
}

export interface LastWeek {
  runs: number | null
  tokens: number | null
  agentRuns: number | null
  pagesPublished: number | null
}

/** What /iris/plan answers. Everything past `measured` may be missing. */
export interface UsagePlan {
  measured: boolean
  plan?: string | null
  paid?: boolean | null
  label?: string | null
  upgradeUrl?: string | null
  fraction?: number | null
  tokensUsed?: number | null
  resetsAt?: string | null
  uncapped?: boolean
  capTokens?: number | null
  grantTokens?: number | null
  nextTier?: NextTier | null
  runoutAt?: string | null
  progress?: UsageProgress | null
  lastWeek?: LastWeek | null
}

/** A plan on sale (/iris/plans) — the fields this file reads. */
export interface Offer {
  slug: string
  title: string
  subtitle?: string | null
  price: number
  period: string
  features: string[]
}

export const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v)

/** 850K, 12.4M, 2.3B — how the plans describe compute. */
export function tokenCount(n: number): string {
  if (n >= 1e9) return `${+(n / 1e9).toFixed(1)}B`
  if (n >= 1e6) return `${+(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${Math.round(n / 1e3)}K`
  return String(Math.round(n))
}

function validDate(iso: string | null | undefined): Date | null {
  if (!iso) return null
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : d
}

// ─── The ring ────────────────────────────────────────────────────────────────

/**
 * calm < 70% · heads-up 70–90% · low ≥ 90% · out ≥ 100% · grants = past 100% but drawing on top-up
 * tokens · uncapped = staff, no cap to draw. Null = we do not know, so the ring shows only the chat.
 */
export type RingTone = "calm" | "heads-up" | "low" | "out" | "grants" | "uncapped"

export function drawingOnGrants(plan: UsagePlan | undefined): boolean {
  const f = plan?.measured ? plan.fraction : null
  return finite(f) && f >= 1 && finite(plan?.grantTokens) && plan!.grantTokens! > 0
}

export function ringTone(plan: UsagePlan | undefined): RingTone | null {
  if (!plan?.measured) return null
  if (plan.uncapped) return "uncapped"
  const f = plan.fraction
  if (!finite(f) || f < 0) return null
  if (f >= 1) return drawingOnGrants(plan) ? "grants" : "out"
  if (f >= 0.9) return "low"
  if (f >= 0.7) return "heads-up"
  return "calm"
}

/** The outer arc's colour, as a design token (never a hex where a token exists). */
export const RING_COLOR: Record<RingTone, string> = {
  calm: "var(--v2-icon-icon-muted)",
  "heads-up": "var(--v2-icon-icon-accent)",
  low: "var(--v2-state-fg-warning)",
  out: "var(--v2-state-fg-danger)",
  grants: "var(--v2-state-fg-success)",
  uncapped: "var(--v2-icon-icon-muted)",
}

/** The same tone as a text class, for the compact label beside the ring. */
export const RING_TEXT: Record<RingTone, string> = {
  calm: "text-v2-text-text-muted",
  "heads-up": "text-v2-icon-icon-accent",
  low: "text-v2-state-fg-warning",
  out: "text-v2-state-fg-danger",
  grants: "text-v2-state-fg-success",
  uncapped: "text-v2-text-text-muted",
}

export interface RingState {
  tone: RingTone
  /** Outer arc, 0–1. Null for uncapped: there is no week to fill. */
  week: number | null
  /** Floored percent of the week; null when uncapped. */
  percent: number | null
  /** Words beside the ring — only from 90%, and for the top-up state. */
  label: string | null
}

export function ringState(plan: UsagePlan | undefined): RingState | null {
  const tone = ringTone(plan)
  if (!tone) return null
  if (tone === "uncapped") return { tone, week: null, percent: null, label: null }
  const f = plan!.fraction!
  const percent = Math.floor(f * 100)
  const label =
    tone === "low"
      ? `${percent}% of week`
      : tone === "out"
        ? "Week used up"
        : tone === "grants"
          ? `+${tokenCount(plan!.grantTokens!)} top-up left`
          : null
  return { tone, week: Math.min(1, Math.max(0, f)), percent, label }
}

// ─── Time ────────────────────────────────────────────────────────────────────

/** "2pm", "2:30pm", "12:00am" — the clock the way people say it. */
export function clock(d: Date): string {
  const h = d.getHours()
  const m = d.getMinutes()
  const ampm = h < 12 ? "am" : "pm"
  const h12 = h % 12 === 0 ? 12 : h % 12
  return m === 0 && h12 !== 12 ? `${h12}${ampm}` : `${h12}:${String(m).padStart(2, "0")}${ampm}`
}

const weekday = (d: Date) => d.toLocaleDateString("en-US", { weekday: "long" })

/** "2d 9h", "9h", "40m". */
export function shortDuration(ms: number): string {
  const mins = Math.max(0, Math.floor(ms / 60_000))
  const d = Math.floor(mins / 1440)
  const h = Math.floor((mins % 1440) / 60)
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`
  if (h > 0) return `${h}h`
  return `${Math.max(1, mins)}m`
}

/** "2 days, 9 hours" — the out card's long form. */
export function longDuration(ms: number): string {
  const mins = Math.max(0, Math.floor(ms / 60_000))
  const d = Math.floor(mins / 1440)
  const h = Math.floor((mins % 1440) / 60)
  const part = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`
  if (d > 0) return h > 0 ? `${part(d, "day")}, ${part(h, "hour")}` : part(d, "day")
  if (h > 0) return part(h, "hour")
  return part(Math.max(1, mins), "minute")
}

/** "Resets Monday 12:00am · in 2d 9h". Null when the reset is unknown or already past. */
export function resetLine(resetsAt: string | null | undefined, now: Date = new Date()): string | null {
  const at = validDate(resetsAt)
  if (!at || at.getTime() <= now.getTime()) return null
  return `Resets ${weekday(at)} ${clock(at)} · in ${shortDuration(at.getTime() - now.getTime())}`
}

function dayWord(at: Date, now: Date): string {
  const start = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const days = Math.round((start(at) - start(now)) / 86_400_000)
  if (days <= 0) return "today"
  if (days === 1) return "tomorrow"
  return `on ${weekday(at)}`
}

/**
 * The forecast from the server's runoutAt. Only said when it means something: a run-out after
 * the reset is no run-out at all, and a missing runoutAt says nothing (unknown is not "you're fine").
 */
export function forecastLine(plan: UsagePlan | undefined, now: Date = new Date()): string | null {
  if (!plan?.measured || plan.uncapped) return null
  const f = plan.fraction
  if (!finite(f) || f >= 1) return null
  const at = validDate(plan.runoutAt)
  if (!at || at.getTime() <= now.getTime()) return null
  const reset = validDate(plan.resetsAt)
  if (reset && at.getTime() >= reset.getTime()) return null
  return `At today's pace you'll run out ${dayWord(at, now)} around ${clock(at)}.`
}

// ─── Numbers ─────────────────────────────────────────────────────────────────

/** "8.6M of 9.4M tokens", or just what was used when there is no cap to compare it with. */
export function weekLine(plan: UsagePlan | undefined): string | null {
  if (!plan?.measured || !finite(plan.tokensUsed)) return null
  const used = tokenCount(plan.tokensUsed)
  if (!plan.uncapped && finite(plan.capTokens) && plan.capTokens > 0) return `${used} of ${tokenCount(plan.capTokens)} tokens`
  return `${used} tokens this week`
}

/** Last week's counted facts, as tiles. Only what was measured; a null count is left out, not 0. */
export function lastWeekTiles(w: LastWeek | null | undefined): { value: string; label: string }[] {
  if (!w) return []
  const tiles: { value: string; label: string }[] = []
  if (finite(w.runs)) tiles.push({ value: w.runs.toLocaleString("en-US"), label: w.runs === 1 ? "run last week" : "runs last week" })
  if (finite(w.agentRuns))
    tiles.push({ value: w.agentRuns.toLocaleString("en-US"), label: w.agentRuns === 1 ? "agent run" : "agent runs" })
  if (finite(w.pagesPublished))
    tiles.push({
      value: w.pagesPublished.toLocaleString("en-US"),
      label: w.pagesPublished === 1 ? "page published" : "pages published",
    })
  if (tiles.length < 3 && finite(w.tokens)) tiles.push({ value: tokenCount(w.tokens), label: "tokens last week" })
  return tiles.slice(0, 3)
}

// ─── Plans ───────────────────────────────────────────────────────────────────

/** "5x compute" in a plan's features → 5. The catalogue says it; nothing is compiled in. */
export function computeMultiplier(offer: Pick<Offer, "features" | "subtitle">): number | null {
  for (const line of [...(offer.features ?? []), offer.subtitle ?? ""]) {
    const m = /(\d+(?:\.\d+)?)\s*[x×]\s*(?:the\s+)?compute/i.exec(line)
    if (m) return Number(m[1])
  }
  return null
}

/**
 * The free weekly cap, the unit every multiplier multiplies. Someone on Free has it as their own
 * cap; for anyone else it is the next tier's weekly tokens over that tier's multiplier.
 */
export function freeCapTokens(plan: UsagePlan | undefined, offers: Offer[]): number | null {
  if (!plan?.measured || plan.uncapped) return null
  if (plan.paid !== true && finite(plan.capTokens) && plan.capTokens > 0) return plan.capTokens
  const t = plan.nextTier
  if (t && finite(t.capTokensWeek)) {
    const offer = offers.find((o) => o.slug === t.slug)
    const mult = offer ? computeMultiplier(offer) : null
    if (mult) return t.capTokensWeek / mult
  }
  return null
}

/** One plan's weekly tokens: the server's own number for the next tier, else multiplier × free cap. */
export function planWeeklyTokens(offer: Offer, plan: UsagePlan | undefined, freeCap: number | null): number | null {
  const t = plan?.nextTier
  if (t && t.slug === offer.slug && finite(t.capTokensWeek)) return t.capTokensWeek
  const mult = computeMultiplier(offer)
  return mult && freeCap ? mult * freeCap : null
}

/** This week's tokens as a share of a plan's week, 0–100+ (unrounded). */
export function fitPercent(used: number | null | undefined, weekly: number | null | undefined): number | null {
  if (!finite(used) || !finite(weekly) || weekly <= 0) return null
  return (used / weekly) * 100
}

/** "18%", "<1%". */
export function fitLabel(pct: number): string {
  if (pct > 0 && pct < 1) return "<1%"
  return `${Math.round(pct)}%`
}

export interface PlanFit {
  slug: string
  weekly: number | null
  percent: number | null
}

/** Every plan's fit for this week, in catalogue order. Unmeasured usage → no fits. */
export function planFits(offers: Offer[], plan: UsagePlan | undefined): PlanFit[] {
  if (!plan?.measured || plan.uncapped || !finite(plan.tokensUsed)) return []
  const free = freeCapTokens(plan, offers)
  return offers.map((o) => {
    const weekly = planWeeklyTokens(o, plan, free)
    return { slug: o.slug, weekly, percent: fitPercent(plan.tokensUsed, weekly) }
  })
}

/** The cheapest plan this week would use at most 80% of — "Fits you best". */
export function bestFit(offers: Offer[], plan: UsagePlan | undefined): { offer: Offer; percent: number; weekly: number } | null {
  const fits = planFits(offers, plan)
  let best: { offer: Offer; percent: number; weekly: number } | null = null
  for (const o of offers) {
    const f = fits.find((x) => x.slug === o.slug)
    if (!f || f.percent === null || f.weekly === null || f.percent > 80) continue
    if (!best || o.price < best.offer.price) best = { offer: o, percent: f.percent, weekly: f.weekly }
  }
  return best
}

export interface LadderStep {
  key: string
  label: string
  weekly: number | null
  current: boolean
  next: boolean
}

/** Free → Solo → Pro → Team, from the catalogue, with where you are and the next rung marked. */
export function ladder(offers: Offer[], plan: UsagePlan | undefined): LadderStep[] {
  if (!plan?.measured || plan.uncapped || offers.length === 0) return []
  const free = freeCapTokens(plan, offers)
  const label = (plan.label ?? "").toLowerCase()
  const isCurrent = (o: Offer) => plan.paid === true && !!label && label.includes(o.title.toLowerCase())
  const steps: LadderStep[] = offers.map((o) => ({
    key: o.slug,
    label: o.title,
    weekly: planWeeklyTokens(o, plan, free),
    current: isCurrent(o),
    next: plan.nextTier?.slug === o.slug,
  }))
  const hasFree = offers.some((o) => o.price === 0)
  if (!hasFree) steps.unshift({ key: "free", label: "Free", weekly: free, current: plan.paid !== true, next: false })
  return steps
}

const per = (period: string) => (period === "year" ? "/yr" : period === "month" ? "/mo" : `/${period}`)

/** "Upgrade to Solo · 5x every week · $29/mo". Parts the server did not give are left out. */
export function upgradeLabel(plan: UsagePlan | undefined): string | null {
  const t = plan?.nextTier
  if (!t) return null
  const parts = [`Upgrade to ${t.label}`]
  if (finite(t.capTokensWeek) && finite(plan?.capTokens) && plan!.capTokens! > 0) {
    const x = Math.round(t.capTokensWeek / plan!.capTokens!)
    if (x >= 2) parts.push(`${x}x every week`)
  }
  if (finite(t.priceUsd)) parts.push(`$${Math.round(t.priceUsd).toLocaleString("en-US")}${per(t.period)}`)
  return parts.join(" · ")
}

/**
 * What the popover may ask for. Staff/uncapped: nothing. Someone who pays: their plan, top-ups,
 * auto top-up — never an Upgrade nag (#189544). Everyone else: Upgrade.
 */
export function usageAsk(plan: UsagePlan | undefined): "none" | "plan" | "upgrade" {
  if (!plan?.measured || plan.uncapped) return "none"
  if (plan.paid === true) return "plan"
  return "upgrade"
}

/** Checklist rows while any is left; once all are done it has done its job and goes. */
export function openChecklist(progress: UsageProgress | null | undefined) {
  const list = progress?.checklist ?? []
  return list.some((c) => !c.done) ? list : []
}

/** "Builder: Publish a page" — what the next level asks. */
export function levelLine(progress: UsageProgress | null | undefined): string | null {
  const lvl = progress?.level
  if (!lvl) return null
  const next = progress?.nextLevel
  if (!next) return `Level: ${lvl.label}`
  return next.requires ? `Level: ${lvl.label} · next, ${next.label}: ${next.requires}` : `Level: ${lvl.label} · next, ${next.label}`
}

/** The plans dialog heading when there is a week worth talking about (#194531). */
export function usageDialogCopy(plan: UsagePlan | undefined): { title: string; description: string } | null {
  if (!plan?.measured || plan.uncapped || plan.paid === true) return null
  if (!finite(plan.tokensUsed) || plan.tokensUsed <= 0) return null
  const week = weekLine(plan)
  return {
    title: "You did a lot with IRIS this week.",
    description: `${week ? (week.endsWith("this week") ? `${week}. ` : `${week} this week. `) : ""}Here's how this week would look on each plan:`,
  }
}

/** A top-up pack as a button reads: "70M tokens · $10". */
export function packLabel(pack: { tokens: number; priceUsd: number; label?: string | null }): string {
  return `${tokenCount(pack.tokens)} tokens · $${+pack.priceUsd.toFixed(2)}`
}
