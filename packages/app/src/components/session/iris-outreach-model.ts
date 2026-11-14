/**
 * OUTREACH (#193487, epic #193481), as pure functions: what the Today queue, the Campaigns grid and
 * the Scripts list show, from the engine's /iris/outreach/* routes (packages/opencode/src/iris/outreach.ts),
 * /iris/comms (the Inbox's conversations) and /iris/reachr/batches (Needs approval's batches).
 *
 * What the platform does not hold yet is said, never filled in: a campaign's owner, sends today per
 * account, lead demographics. A number that was not measured is null here and "—" on screen.
 */
import type { Conversation } from "./iris-inbox-model"
import { bucketOf, type ReviewBatch } from "./iris-reachr-review-model"

export type CampaignRow = {
  id: number
  name: string
  label: string
  bloq_id: number
  strategy_template_id: number | null
  strategy_name: string
  ig_account: string | null
  tw_account: string | null
  active: boolean
  is_live: boolean
  geo_tag: string | null
  starts_at: string | null
  ends_at: string | null
  audience_note: string | null
  /** #193486: absent (null/undefined) until fl-api sends campaign members. */
  members?: CampaignMember[] | null
  eligible: number | null
  daily_cap: number
  cap_source: "default" | "environment"
  days_of_supply: number | null
  fits: number | null
}

export type CampaignMember = { type: "user" | "agent"; id: number; name: string; role: string }

/** "Dani (owner), Emily" — owners first; "No one assigned" when nobody is, or the platform does not say yet. */
export function peopleWord(members: CampaignMember[] | null | undefined): string {
  if (!members?.length) return "No one assigned"
  return [...members]
    .sort((a, b) => Number(b.role === "owner") - Number(a.role === "owner"))
    .map((m) => `${m.name || `${m.type} ${m.id}`}${m.role === "owner" ? " (owner)" : ""}${m.type === "agent" ? " · agent" : ""}`)
    .join(", ")
}

/** The Mine filter: only when fl-api answered /campaigns/mine (`mine` is an array). */
export function filterMine<T extends { id: number }>(rows: T[], mine: number[] | null | undefined, on: boolean): T[] {
  return on && Array.isArray(mine) ? rows.filter((r) => mine.includes(r.id)) : rows
}

export type StrategyStep = {
  id?: number
  title: string
  type: string | null
  instructions: string
  order: number
  delay_hours: number
  ai_prompt: string | null
  auto_execute: boolean
}
export type Strategy = {
  id: number
  bloq_id: number
  name: string
  description: string | null
  category: string | null
  usage_count: number | null
  replies: number | null
  last_reply_at: string | null
  steps: StrategyStep[]
  campaigns?: { id: number; label: string; active: boolean }[]
}

export type AudienceReport = {
  campaign: string
  eligible: number
  scanned: number
  daily_cap: number
  days_of_supply: number | null
  supply: "empty" | "low" | "ok"
  audience: "match" | "mismatch" | "unstated" | "no-leads"
  audience_reason: string
  matching_eligible: number | null
  matching_days_of_supply: number | null
  matching_complete: boolean
  top_posts: { post: string; count: number }[]
  top_comments: { comment: string; count: number }[]
  no_source_post: number
  warnings: string[]
}
export type AudiencePost = { post: string; count: number; url: string; comments: { comment: string; count: number }[] }
export type AudienceAnswer = {
  campaign: CampaignRow | null
  report: AudienceReport | null
  posts: AudiencePost[]
  strategy: Strategy | null
  scan_limit: number
}

export type Payload<T> = { measured: boolean; reason?: string; data: T }

// ─── Numbers ──────────────────────────────────────────────────────────────────

export const fmt = (n: number | null | undefined) => (n === null || n === undefined ? "—" : n.toLocaleString("en-US"))
export const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : 0)

/** "5.7 days", "151 days", "empty", or "—" when the pool was not read. */
export function daysWord(days: number | null | undefined, eligible?: number | null): string {
  if (eligible === 0) return "empty"
  if (days === null || days === undefined) return "—"
  return `${days >= 100 ? Math.round(days) : days} ${days === 1 ? "day" : "days"}`
}

// ─── Campaigns ────────────────────────────────────────────────────────────────

export type CampaignView = {
  id: number
  label: string
  board: string
  sender: string
  on: boolean
  script: string
  eligible: string
  fits: string
  days: string
  /** Days left is short — the run would stop within a week. */
  short: boolean
  cap: string
  people: string
}

/** On first, then by label. A campaign with no Instagram account sends on LinkedIn (CLI rule). */
export function campaignViews(rows: CampaignRow[]): CampaignView[] {
  return [...rows]
    .sort((a, b) => Number(b.active) - Number(a.active) || a.label.localeCompare(b.label))
    .map((c) => {
      // The supply that matters is what fits the script, once it has been counted.
      const days = c.fits !== null && c.fits !== undefined ? Math.round((c.fits / c.daily_cap) * 10) / 10 : c.days_of_supply
      return {
        id: c.id,
        label: c.label,
        board: `#${c.bloq_id}`,
        sender: c.ig_account ? `@${c.ig_account.replace(/^@/, "")}` : "LinkedIn",
        on: c.active,
        script: c.strategy_name || "no script",
        eligible: fmt(c.eligible),
        fits: c.fits === null || c.fits === undefined ? "—" : fmt(c.fits),
        days: daysWord(days, c.fits ?? c.eligible),
        short: days !== null && days !== undefined && days < 7,
        cap: `${c.daily_cap}/day${c.cap_source === "default" ? " (default)" : ""}`,
        people: peopleWord(c.members),
      }
    })
}

export const onCount = (rows: CampaignRow[]) => rows.filter((c) => c.active).length

// ─── Audience ─────────────────────────────────────────────────────────────────

export type AudienceGroup = {
  key: string
  label: string
  /** The stored source-post URL — what the Leads column filters on. Absent for "no source post". */
  url?: string
  count: number
  share: number
  words: string
  /** The script is written for this post. */
  target: boolean
}

/**
 * Where a campaign's eligible leads came from: one group per source post (with the words its
 * commenters typed), then the leads with no source post. Biggest first; shares of what was scanned.
 */
export function audienceGroups(a: AudienceAnswer | null | undefined): AudienceGroup[] {
  const r = a?.report
  if (!r) return []
  const scanned = r.scanned
  const posts = a.posts.map(
    (p): AudienceGroup => ({
      key: p.post,
      label: `/p/${p.post}`,
      url: p.url,
      count: p.count,
      share: pct(p.count, scanned),
      words: p.comments.map((c) => `"${c.comment}" ${c.count.toLocaleString("en-US")}`).join(" · "),
      target: r.audience_reason.includes(`/p/${p.post}`) && r.audience !== "unstated",
    }),
  )
  const groups = r.no_source_post > 0
    ? [...posts, { key: "", label: "No source post", count: r.no_source_post, share: pct(r.no_source_post, scanned), words: "", target: false }]
    : posts
  return groups.sort((x, y) => y.count - x.count)
}

/** The sentence under the groups, or nothing when the list fits its script. */
export function audienceWarning(r: AudienceReport | null | undefined): string | undefined {
  if (!r) return undefined
  if (r.audience === "mismatch") return `Mismatch: ${r.audience_reason}.`
  if (r.supply === "empty") return "No eligible leads: a run would send nothing."
  if (r.audience === "unstated") return `Unchecked: ${r.audience_reason}.`
  return undefined
}

// ─── Leads in a segment ───────────────────────────────────────────────────────

export type LeadView = { id: number; name: string; comment: string; status: string; step: string; replied: boolean }

export function leadView(l: any): LeadView {
  const done = Number(l?.outreach_completed_count ?? l?.completed_outreach_steps_count ?? 0) || 0
  const steps = Number(l?.outreach_steps_count ?? 0) || 0
  return {
    id: Number(l?.id),
    name: String(l?.name || l?.nickname || `Lead ${l?.id}`),
    comment: String(l?.custom_fields?.comment ?? "").trim(),
    status: String(l?.status ?? "—"),
    step: steps ? `${done}/${steps}` : "—",
    replied: !!Number(l?.has_replied ?? 0) || l?.has_replied === true,
  }
}

/** The fl-api lead-list query for one segment of a campaign: its board, and the post if one is chosen. */
export function segmentQuery(board: number, url: string | undefined, page: number, perPage = 25): Record<string, string> {
  return {
    bloq_id: String(board),
    ...(url ? { custom_field_key: "source_post_url", custom_field_value: url } : {}),
    sort: "updated_at",
    order: "desc",
    per_page: String(perPage),
    page: String(page),
  }
}

// ─── Scripts ──────────────────────────────────────────────────────────────────

/** "day 0", "+48h", "+3 days" — when a step goes, from the one before it. */
export function delayWord(hours: number): string {
  if (!hours) return "day 0"
  if (hours % 24 === 0 && hours >= 72) return `+${hours / 24} days`
  return `+${hours}h`
}

/** Strategies a campaign runs first, then by use. */
export function strategyOrder(list: Strategy[]): Strategy[] {
  return [...list].sort(
    (a, b) =>
      Number((b.campaigns?.length ?? 0) > 0) - Number((a.campaigns?.length ?? 0) > 0) ||
      (b.usage_count ?? 0) - (a.usage_count ?? 0) ||
      a.name.localeCompare(b.name),
  )
}

// ─── Today ────────────────────────────────────────────────────────────────────

export type TodayItem =
  | { kind: "reply"; key: string; leadId?: number; name: string; preview: string; channel: string; at: string; conv: Conversation }
  | { kind: "review"; key: string; batchId: number; name: string; inReview: number; at: string | null }

/** Messages waiting "In review" in one batch, from fl-api's per-status counts. */
export function batchInReview(b: Pick<ReviewBatch, "counts">): number {
  let n = 0
  for (const [status, count] of Object.entries(b.counts ?? {})) if (bucketOf(status) === "review") n += Number(count) || 0
  return n
}

/**
 * ONE LIST, DONE AT ZERO. Replies that need an answer first (newest first — a person is waiting),
 * then batches with messages in review (oldest start first). Nothing else.
 */
export function todayQueue(conversations: Conversation[] | null | undefined, batches: ReviewBatch[] | null | undefined): TodayItem[] {
  const replies = (conversations ?? [])
    .filter((c) => c.needsReply)
    .sort((a, b) => (b.lastInboundAt ?? b.lastAt).localeCompare(a.lastInboundAt ?? a.lastAt))
    .map((c): TodayItem => ({ kind: "reply", key: `reply:${c.key}`, leadId: c.leadId, name: c.name, preview: c.preview, channel: c.channel, at: c.lastInboundAt ?? c.lastAt, conv: c }))
  const review = (batches ?? [])
    .map((b) => ({ b, n: batchInReview(b) }))
    .filter((x) => x.n > 0)
    .sort((x, y) => (x.b.starts_at ?? "").localeCompare(y.b.starts_at ?? "") || x.b.id - y.b.id)
    .map((x): TodayItem => ({ kind: "review", key: `review:${x.b.id}`, batchId: x.b.id, name: x.b.name, inReview: x.n, at: x.b.starts_at }))
  return [...replies, ...review]
}

/** The tab's number: replies waiting plus messages in review. Unknown when neither was read. */
export function todayCount(conversations: Conversation[] | undefined, batches: ReviewBatch[] | undefined): number | undefined {
  if (!conversations && !batches) return undefined
  const replies = (conversations ?? []).filter((c) => c.needsReply).length
  const review = (batches ?? []).reduce((n, b) => n + batchInReview(b), 0)
  return replies + review
}

/** Said when the account has no campaigns. Generic: any account, any board. */
export const NO_CAMPAIGNS =
  "No SOM campaigns on this account yet. Create one with `iris som campaign create` (a name, a board, a strategy and the Instagram account it sends from), then it shows here."
