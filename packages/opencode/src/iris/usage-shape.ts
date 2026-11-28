/**
 * Usage as a progression (epic #194525): the fields fl-iris-api adds to /api/v6/allowance/me, and
 * the fl-api top-up / invite / auto top-up answers, reshaped into the app's casing.
 *
 * Pure and import-free, so the wire contract is tested without a network. EVERY field is optional
 * on the way in: a server that does not send it yet leaves it out on the way out, and the app keeps
 * rendering what it renders today. Nothing here is policy — caps, prices and rewards are the
 * server's; the client only renders them.
 */

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null)
const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null)

export interface NextTier {
  slug: string
  label: string
  priceUsd: number | null
  period: string
  capTokensWeek: number | null
}

export interface UsageLevel {
  key: string
  label: string
}

export interface UsageProgress {
  level: UsageLevel | null
  nextLevel: (UsageLevel & { requires: string | null }) | null
  checklist: { key: string; label: string; done: boolean; rewardTokens: number | null }[]
  streakWeeks: number | null
}

export interface LastWeek {
  runs: number | null
  tokens: number | null
  agentRuns: number | null
  pagesPublished: number | null
}

/** The new fields. A key is present only when the server sent something usable for it. */
export interface PlanUsage {
  capTokens?: number | null
  grantTokens?: number | null
  nextTier?: NextTier | null
  runoutAt?: string | null
  progress?: UsageProgress | null
  lastWeek?: LastWeek | null
}

function level(v: any): UsageLevel | null {
  const key = text(v?.key)
  if (!key) return null
  return { key, label: text(v?.label) ?? key }
}

/** Pick the usage fields out of an allowance/me body. Absent stays absent; broken reads as null. */
export function planUsageFrom(j: any): PlanUsage {
  const out: PlanUsage = {}
  if (!j || typeof j !== "object") return out
  if ("cap_tokens" in j) out.capTokens = num(j.cap_tokens)
  if ("grant_tokens" in j) out.grantTokens = num(j.grant_tokens)
  if ("runout_at" in j) out.runoutAt = text(j.runout_at)
  if ("next_tier" in j) {
    const t = j.next_tier
    const slug = text(t?.slug)
    out.nextTier = slug
      ? {
          slug,
          label: text(t?.label) ?? slug,
          priceUsd: num(t?.price_usd),
          period: text(t?.period) ?? "month",
          capTokensWeek: num(t?.cap_tokens_week),
        }
      : null
  }
  if ("progress" in j) {
    const p = j.progress
    out.progress =
      p && typeof p === "object"
        ? {
            level: level(p.level),
            nextLevel: level(p.next_level) ? { ...level(p.next_level)!, requires: text(p.next_level?.requires) } : null,
            checklist: (Array.isArray(p.checklist) ? p.checklist : [])
              .filter((c: any) => text(c?.key) && text(c?.label))
              .map((c: any) => ({
                key: text(c.key)!,
                label: text(c.label)!,
                done: c.done === true,
                rewardTokens: num(c.reward_tokens),
              })),
            streakWeeks: num(p.streak_weeks),
          }
        : null
  }
  if ("last_week" in j) {
    const w = j.last_week
    out.lastWeek =
      w && typeof w === "object"
        ? { runs: num(w.runs), tokens: num(w.tokens), agentRuns: num(w.agent_runs), pagesPublished: num(w.pages_published) }
        : null
  }
  return out
}

export interface TopupPack {
  key: string
  tokens: number
  priceUsd: number
  label: string | null
}

/** fl-api GET /api/v1/usage/topups/packs → the packs on sale. Anything unpriced is dropped. */
export function topupPacksFrom(j: any): TopupPack[] {
  const rows = Array.isArray(j?.packs) ? j.packs : Array.isArray(j?.data?.packs) ? j.data.packs : []
  return rows
    .map((p: any) => ({ key: text(p?.key), tokens: num(p?.tokens), priceUsd: num(p?.price_usd), label: text(p?.label) }))
    .filter((p: any) => p.key && p.tokens !== null && p.tokens > 0 && p.priceUsd !== null)
    .map((p: any): TopupPack => ({ key: p.key, tokens: p.tokens, priceUsd: p.priceUsd, label: p.label }))
}

export interface Invite {
  url: string
  code: string | null
  rewardTokens: number | null
  invited: number | null
  rewarded: number | null
}

/** fl-api GET /api/v1/usage/invite. No URL = nothing to share, so null. */
export function inviteFrom(j: any): Invite | null {
  const b = j?.data && typeof j.data === "object" && !("url" in (j ?? {})) ? j.data : j
  const url = text(b?.url)
  if (!url) return null
  return {
    url,
    code: text(b?.code),
    rewardTokens: num(b?.reward_tokens),
    invited: num(b?.invited),
    rewarded: num(b?.rewarded),
  }
}

/**
 * An invite code (epic #194525): fl-api's own rule (UsageInviteService::normalise) — trimmed,
 * lowercased, 4–32 letters and digits. Null when it can't be one, so nothing malformed is sent.
 */
export function normaliseInviteCode(v: unknown): string | null {
  if (typeof v !== "string") return null
  const code = v.trim().toLowerCase()
  return /^[a-z0-9]{4,32}$/.test(code) ? code : null
}

export type InviteClaimOutcome =
  | "attributed"
  | "self_invite"
  | "already_attributed"
  | "too_old"
  | "invalid_code"
  | "signed_out"
  | "error"
  | "unreachable"

export interface InviteClaim {
  ok: boolean
  outcome: InviteClaimOutcome
  message: string
}

/** One sentence per outcome, shown as it is (#194575). */
export const INVITE_CLAIM_SENTENCE: Record<InviteClaimOutcome, string> = {
  attributed: "You're in — you'll both get +25M tokens after your first agent run.",
  self_invite: "That's your own code.",
  already_attributed: "This account already used an invite.",
  too_old: "Invite codes work in your first 14 days.",
  invalid_code: "We couldn't find that code.",
  signed_out: "Your sign-in has expired. Sign in again, then try the code.",
  error: "That code couldn't be checked right now. Try again later.",
  unreachable: "Couldn't reach IRIS to check that code. Try again in a moment.",
}

const CLAIM_OUTCOMES = new Set<string>(["attributed", "self_invite", "already_attributed", "too_old", "invalid_code"])

/**
 * fl-api POST /api/v1/usage/invite/claim → {ok, outcome, message}. fl-api answers 200 with the
 * outcome, or 422 for invalid_code; anything else is not an outcome and reads as "error".
 */
export function inviteClaimFrom(status: number, j: any): InviteClaim {
  const said = typeof j?.outcome === "string" ? j.outcome : typeof j?.data?.outcome === "string" ? j.data.outcome : null
  const outcome: InviteClaimOutcome =
    status === 401 || status === 403
      ? "signed_out"
      : said && CLAIM_OUTCOMES.has(said)
        ? (said as InviteClaimOutcome)
        : status === 422
          ? "invalid_code"
          : "error"
  return { ok: outcome === "attributed", outcome, message: INVITE_CLAIM_SENTENCE[outcome] }
}

export interface AutoTopup {
  enabled: boolean
  pack: string | null
  monthlyCapUsd: number | null
  spentThisMonthUsd: number | null
  lastChargedAt: string | null
  /** Why the last automatic charge failed, in fl-api's words. Shown as is. */
  lastError: string | null
  /** False = no card on file, so auto top-up cannot run; the toggle is disabled. Null = not said. */
  hasSavedCard: boolean | null
}

/** fl-api GET/PUT /api/v1/usage/auto-topup. Null when the body is not an auto top-up at all. */
export function autoTopupFrom(j: any): AutoTopup | null {
  const b = j?.data && typeof j.data === "object" && !("enabled" in (j ?? {})) ? j.data : j
  if (!b || typeof b.enabled !== "boolean") return null
  return {
    enabled: b.enabled,
    pack: text(b.pack),
    monthlyCapUsd: num(b.monthly_cap_usd),
    spentThisMonthUsd: num(b.spent_this_month_usd),
    lastChargedAt: text(b.last_charged_at),
    lastError: text(b.last_error),
    hasSavedCard: typeof b.has_saved_card === "boolean" ? b.has_saved_card : null,
  }
}

/** What fl-api's PUT expects, from the app's casing. Only the keys the caller set. */
export function autoTopupBody(v: { enabled: boolean; pack?: string | null; monthlyCapUsd?: number | null }) {
  const body: Record<string, unknown> = { enabled: v.enabled }
  if (v.pack !== undefined) body.pack = v.pack
  if (v.monthlyCapUsd !== undefined) body.monthly_cap_usd = v.monthlyCapUsd
  return body
}
