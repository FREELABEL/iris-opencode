/**
 * `iris som preflight` — read-only readiness checks for every SOM campaign, before a run.
 *
 * #191274 — a board running dry was found mid-run ("All leads already have outreach"); nothing
 * turned the eligible count into days of supply at the daily cap or warned below a threshold.
 * #191276 — nothing compared a board's leads with the audience its strategy is written for:
 * board 529's "Guest Feature" invite would go to 100+ people who typed "Site" on a giveaway post.
 *
 * Report only: these functions never change a lead, list, campaign or strategy.
 *
 * "Eligible" is the pool a SOM batch draws first-contact leads from (batch-with-login.spec.ts):
 *   GET /api/v1/leads?bloq_id=B&outreach_status=no_outreach&has_social=1&sort=updated_at&order=desc
 * It is an upper bound — the batch also skips leads that carry an old [SOM DM] note.
 */

export type PoolLead = {
  id?: number | string
  source?: string | null
  custom_fields?: Record<string, any> | null
}

export type Audience = {
  /** Instagram post shortcodes the strategy says its leads come from. */
  posts: string[]
  /** Quoted words the strategy says its leads typed (e.g. 'Roadmap'). */
  keywords: string[]
  /** Everything the strategy says, lowercased — name, description, first-step script, audience. */
  text: string
}

export type PoolSummary = {
  scanned: number
  posts: Array<{ post: string; count: number }>
  comments: Array<{ comment: string; count: number }>
  noPost: number
}

export type SupplyLevel = "empty" | "low" | "ok"
export type AudienceLevel = "match" | "mismatch" | "unstated" | "no-leads"

/** Shortcode of an Instagram post/reel URL, or null. */
export function postKey(url: unknown): string | null {
  const m = /instagram\.com\/(?:[^/?#]+\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i.exec(String(url ?? ""))
  return m ? m[1] : null
}

/** A comment reduced to what it says: lowercase, no punctuation or emoji, short ones only. */
export function commentKeyword(comment: unknown): string | null {
  const c = String(comment ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
  if (!c || c.split(" ").length > 3) return null
  return c
}

const QUOTED = /['"‘“]([^'"’”\n]{2,30})['"’”]/g

/** What the strategy (and the campaign) says about who it is for. */
export function audienceOf(
  strategy: { name?: string; description?: string | null; steps?: Array<{ order?: number; instructions?: string | null }> } | null,
  campaign: { label?: string; audience?: string | null } = {},
): Audience {
  const steps = [...(strategy?.steps ?? [])].sort((a, b) => (a?.order ?? 0) - (b?.order ?? 0))
  const said = [strategy?.description ?? "", campaign.audience ?? ""].join("\n")
  const posts = new Set<string>()
  for (const m of said.matchAll(/instagram\.com\/(?:[^/\s]+\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/gi)) posts.add(m[1])
  const keywords = new Set<string>()
  for (const m of said.matchAll(QUOTED)) {
    const k = commentKeyword(m[1])
    if (k) keywords.add(k)
  }
  const text = [strategy?.name ?? "", strategy?.description ?? "", steps[0]?.instructions ?? "", campaign.audience ?? "", campaign.label ?? ""]
    .join("\n")
    .toLowerCase()
  return { posts: [...posts], keywords: [...keywords], text }
}

function top<T extends string>(counts: Map<T, number>, n: number) {
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n)
}

/** Where the eligible leads came from: post, and what they commented. */
export function summarizePool(leads: PoolLead[], n = 5): PoolSummary {
  const posts = new Map<string, number>()
  const comments = new Map<string, number>()
  let noPost = 0
  for (const l of leads) {
    const cf = l.custom_fields ?? {}
    const p = postKey(cf.source_post_url)
    if (p) posts.set(p, (posts.get(p) ?? 0) + 1)
    else noPost++
    const k = commentKeyword(cf.comment)
    if (k) comments.set(k, (comments.get(k) ?? 0) + 1)
  }
  return {
    scanned: leads.length,
    posts: top(posts, n).map(([post, count]) => ({ post, count })),
    comments: top(comments, n).map(([comment, count]) => ({ comment, count })),
    noPost,
  }
}

/** Days of supply at the daily cap, and whether that is below the threshold. */
export function supply(eligible: number, dailyCap: number, minDays: number): { days: number | null; level: SupplyLevel } {
  if (eligible <= 0) return { days: 0, level: "empty" }
  if (!(dailyCap > 0)) return { days: null, level: "ok" }
  const days = Math.round((eligible / dailyCap) * 10) / 10
  return { days, level: days < minDays ? "low" : "ok" }
}

function matchesAudience(l: PoolLead, aud: Audience): boolean {
  const cf = l.custom_fields ?? {}
  if (aud.posts.length) {
    const p = postKey(cf.source_post_url)
    if (p && aud.posts.includes(p)) return true
  }
  if (aud.keywords.length) {
    const k = commentKeyword(cf.comment)
    if (k && aud.keywords.some((w) => k.includes(w))) return true
  }
  return false
}

const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : 0)

/**
 * Do the eligible leads match who the strategy is written for?
 *  - The strategy names a post or a quoted keyword → the share of scanned leads from it.
 *  - It names neither, but most leads came from one post → mismatch unless the strategy
 *    mentions that post's shortcode or the word those leads typed.
 *  - Neither → "unstated": nothing to check against; the top sources are shown for a person.
 */
export function audienceCheck(
  aud: Audience,
  leads: PoolLead[],
  opts: { minShare?: number; dominantShare?: number } = {},
): { level: AudienceLevel; matching: number | null; scanned: number; reason: string } {
  const minShare = opts.minShare ?? 0.8
  const dominantShare = opts.dominantShare ?? 0.5
  const scanned = leads.length
  if (scanned === 0) return { level: "no-leads", matching: null, scanned, reason: "no eligible leads to check" }

  if (aud.posts.length || aud.keywords.length) {
    const matching = leads.filter((l) => matchesAudience(l, aud)).length
    const named = [...aud.posts.map((p) => `post /p/${p}`), ...aud.keywords.map((k) => `"${k}" commenters`)].join(" or ")
    const ok = matching / scanned >= minShare
    return {
      level: ok ? "match" : "mismatch",
      matching,
      scanned,
      reason: `strategy is written for ${named}; ${matching} of ${scanned} eligible leads scanned (${pct(matching, scanned)}%) are`,
    }
  }

  const sum = summarizePool(leads, 1)
  const lead = sum.posts[0]
  if (lead && lead.count / scanned >= dominantShare) {
    const fromPost = leads.filter((l) => postKey(l.custom_fields?.source_post_url) === lead.post)
    const word = summarizePool(fromPost, 1).comments[0]?.comment
    const mentioned = aud.text.includes(lead.post.toLowerCase()) || (!!word && new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(aud.text))
    const who = `${lead.count} of ${scanned} eligible leads scanned (${pct(lead.count, scanned)}%) came from post /p/${lead.post}${word ? ` (most commented "${word}")` : ""}`
    return mentioned
      ? { level: "match", matching: lead.count, scanned, reason: `${who}; the strategy mentions ${aud.text.includes(lead.post.toLowerCase()) ? "that post" : `"${word}"`}` }
      : { level: "mismatch", matching: 0, scanned, reason: `${who}; the strategy never mentions that post or that word` }
  }
  return { level: "unstated", matching: null, scanned, reason: "the strategy does not say which leads it is for, and no single source dominates the list" }
}

export type CampaignReport = {
  campaign: string
  active: boolean
  board: number
  strategy: string
  strategy_found: boolean
  eligible: number
  scanned: number
  daily_cap: number
  days_of_supply: number | null
  supply: SupplyLevel
  audience: AudienceLevel
  audience_reason: string
  matching_eligible: number | null
  matching_days_of_supply: number | null
  /** false = only part of the pool was read, so matching_eligible is a lower bound. */
  matching_complete: boolean
  top_posts: PoolSummary["posts"]
  top_comments: PoolSummary["comments"]
  no_source_post: number
  warnings: string[]
}

/** One campaign's report, from data already fetched. Pure. */
export function campaignReport(input: {
  campaign: string
  active: boolean
  board: number
  strategyName: string
  strategy: Parameters<typeof audienceOf>[0]
  audienceNote?: string | null
  eligible: number
  leads: PoolLead[]
  dailyCap: number
  minDays: number
}): CampaignReport {
  const aud = audienceOf(input.strategy, { audience: input.audienceNote })
  const s = supply(input.eligible, input.dailyCap, input.minDays)
  const a = audienceCheck(aud, input.leads)
  const pool = summarizePool(input.leads)
  const warnings: string[] = []
  if (!input.strategy) warnings.push(`strategy "${input.strategyName}" not found on board ${input.board}`)
  if (s.level === "empty") warnings.push("no eligible leads — a run would send nothing")
  else if (s.level === "low") warnings.push(`${s.days} days of supply at ${input.dailyCap}/day (below ${input.minDays})`)

  // When the strategy names its audience, what lasts is the MATCHING leads, not the board.
  let matchingEligible: number | null = null
  let matchingDays: number | null = null
  if ((aud.posts.length || aud.keywords.length) && a.matching !== null && input.leads.length > 0) {
    // Counted, never extrapolated: the pool is sorted, so matches bunch at the front (board 38:
    // 704 roadmap commenters, then thousands of leads from nowhere). A partial scan is a floor.
    matchingEligible = a.matching
    const ms = supply(matchingEligible, input.dailyCap, input.minDays)
    matchingDays = ms.days
    if (a.level === "mismatch" && ms.level !== "ok")
      warnings.push(`${input.leads.length >= input.eligible ? "" : "at least "}${matchingEligible} leads match the strategy's audience — ${ms.days} days at ${input.dailyCap}/day`)
  }
  if (a.level === "mismatch") warnings.push(`audience mismatch: ${a.reason}`)

  return {
    campaign: input.campaign,
    active: input.active,
    board: input.board,
    strategy: input.strategyName,
    strategy_found: !!input.strategy,
    eligible: input.eligible,
    scanned: input.leads.length,
    daily_cap: input.dailyCap,
    days_of_supply: s.days,
    supply: s.level,
    audience: a.level,
    audience_reason: a.reason,
    matching_eligible: matchingEligible,
    matching_days_of_supply: matchingDays,
    matching_complete: input.leads.length >= input.eligible,
    top_posts: pool.posts,
    top_comments: pool.comments,
    no_source_post: pool.noPost,
    warnings,
  }
}

/** The eligible-pool URL a SOM first-contact batch uses (see batch-with-login.spec.ts). */
export function eligiblePoolPath(board: number, opts: { social: boolean; perPage: number; page: number }): string {
  const social = opts.social ? "&has_social=1" : ""
  return `/api/v1/leads?bloq_id=${board}&outreach_status=no_outreach${social}&sort=updated_at&order=desc&per_page=${opts.perPage}&page=${opts.page}`
}
