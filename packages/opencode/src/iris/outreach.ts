import { FL_API, irisFetch, type PlatformResult } from "./platform"
import { campaignReport, eligiblePoolPath, postKey, postUrls, summarizePool, supply, type CampaignReport, type PoolLead } from "./som-preflight"

/**
 * OUTREACH (#193487, epic #193481): the signed-in account's SOM campaigns, what their lead lists
 * hold, and the scripts they run — read from the same fl-api endpoints `iris som campaign list`,
 * `iris som preflight` and `iris reachr list` call, with preflight's rules ported (som-preflight.ts)
 * rather than shelled out to.
 *
 * Nothing here names a board, a campaign or an account: every id comes from the signed-in user's
 * own `/api/v1/som/campaigns`. Read-only: no route here changes a campaign, lead or strategy.
 *
 * NOT here because the platform does not hold it yet (do not invent it): a campaign's owner/rep
 * (#193485), sends today per account (the ledger is a file on the sending Mac, #193486), lead
 * demographics (#193482, #193483). The daily cap is not stored per campaign either: it is the
 * same default the CLI uses, and every row says so (`cap_source`).
 */

export type SomCampaign = {
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
  /** People and agents on the campaign (#193486, fl-api). null = the platform did not send the field. */
  members: CampaignMember[] | null
}
export type CampaignMember = { type: "user" | "agent"; id: number; name: string; role: "owner" | "rep" | string }

export type CampaignRow = SomCampaign & {
  /** First-contact pool a SOM batch draws from; null = fl-api did not answer for this board. */
  eligible: number | null
  daily_cap: number
  cap_source: "default" | "environment"
  days_of_supply: number | null
  /** Leads that fit the script, once the board's pool has been scanned on this engine; else null. */
  fits: number | null
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
}

/** How long a board's scanned pool is reused. A scan reads up to SCAN_LIMIT leads, 500 a page. */
const POOL_TTL_MS = 5 * 60_000
export const SCAN_LIMIT = 10_000
const PER_PAGE = 500

const num = (v: unknown): number | null => {
  const n = Number(v)
  return v === null || v === undefined || v === "" || !Number.isFinite(n) ? null : n
}
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null)

/** One fl-api campaign row, typed. Unknown fields are dropped; nothing is filled in. */
export function shapeCampaign(c: any): SomCampaign {
  return {
    id: Number(c?.id),
    name: String(c?.name ?? ""),
    label: String(c?.label || c?.name || ""),
    bloq_id: Number(c?.bloq_id),
    strategy_template_id: num(c?.strategy_template_id),
    strategy_name: String(c?.strategy_name ?? ""),
    ig_account: str(c?.ig_account),
    tw_account: str(c?.tw_account),
    active: !!c?.active,
    is_live: !!c?.is_live,
    geo_tag: str(c?.geo_tag),
    starts_at: str(c?.starts_at),
    ends_at: str(c?.ends_at),
    audience_note: str(c?.metadata?.audience),
    members: Array.isArray(c?.members)
      ? c.members.map((m: any) => ({ type: m?.type === "agent" ? "agent" : "user", id: Number(m?.id), name: String(m?.name ?? ""), role: String(m?.role ?? "rep") }))
      : null,
  }
}

/** The CLI's cap rule (platform-som.ts preflight): $DAILY_DM_CAP or 40 for Instagram, 25 for LinkedIn. */
export function dailyCap(c: Pick<SomCampaign, "ig_account">, env = process.env.DAILY_DM_CAP): { cap: number; source: CampaignRow["cap_source"] } {
  if (!c.ig_account) return { cap: 25, source: "default" }
  const n = Number(env)
  return n > 0 ? { cap: n, source: "environment" } : { cap: 40, source: "default" }
}

/** One fl-api strategy template, typed; steps in order. */
export function shapeStrategy(t: any, bloq: number): Strategy {
  const steps: StrategyStep[] = (Array.isArray(t?.steps) ? t.steps : [])
    .map((s: any) => ({
      id: num(s?.id) ?? undefined,
      title: String(s?.title ?? ""),
      type: str(s?.type),
      instructions: String(s?.instructions ?? ""),
      order: num(s?.order) ?? 0,
      delay_hours: num(s?.delay_hours) ?? 0,
      ai_prompt: str(s?.ai_prompt),
      auto_execute: !!s?.auto_execute,
    }))
    .sort((a: StrategyStep, b: StrategyStep) => a.order - b.order)
  return {
    id: Number(t?.id),
    bloq_id: num(t?.bloq_id) ?? bloq,
    name: String(t?.name ?? ""),
    description: str(t?.description),
    category: str(t?.category),
    usage_count: num(t?.usage_count),
    replies: num(t?.metadata?.stats?.replies),
    last_reply_at: str(t?.metadata?.stats?.last_reply_at),
    steps,
  }
}

/** Each top post with the words its leads commented — the Audience column's groups. Pure. */
export function postBreakdown(leads: PoolLead[], posts: { post: string; count: number }[], n = 3) {
  const urls = postUrls(leads)
  return posts.map((p) => ({
    ...p,
    url: urls[p.post] ?? `https://www.instagram.com/p/${p.post}/`,
    comments: summarizePool(
      leads.filter((l) => postKey(l.custom_fields?.source_post_url) === p.post),
      n,
    ).comments,
  }))
}

// ─── fl-api ───────────────────────────────────────────────────────────────────

async function flJson(path: string): Promise<{ ok: true; body: any } | { ok: false; reason: string }> {
  try {
    const res = await irisFetch(path, FL_API)
    const body = (await res.json().catch(() => null)) as any
    if (!res.ok) return { ok: false, reason: body?.error ?? body?.message ?? `fl-api ${res.status}` }
    return { ok: true, body }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
}

async function readCampaigns(): Promise<PlatformResult<SomCampaign[]>> {
  const r = await flJson("/api/v1/som/campaigns")
  if (!r.ok) return { measured: false, reason: r.reason, data: [] }
  const list = r.body?.data?.campaigns ?? r.body?.data ?? []
  return { measured: true, data: Array.isArray(list) ? list.map(shapeCampaign) : [] }
}

type Pool = { at: number; eligible: number; leads: PoolLead[]; complete: boolean }
const pools = new Map<string, Pool>()
const poolKey = (board: number, social: boolean) => `${board}:${social}`

/** The eligible pool's size only — one lead's worth of request. */
async function eligibleCount(board: number, social: boolean): Promise<number | null> {
  const hit = pools.get(poolKey(board, social))
  if (hit && Date.now() - hit.at < POOL_TTL_MS) return hit.eligible
  const r = await flJson(eligiblePoolPath(board, { social, perPage: 1, page: 1 }))
  if (!r.ok) return null
  return num(r.body?.total ?? r.body?.data?.total)
}

/** The eligible pool, scanned the way `iris som preflight` scans it (up to SCAN_LIMIT leads). */
async function scanPool(board: number, social: boolean, refresh = false): Promise<Pool | { reason: string }> {
  const key = poolKey(board, social)
  const hit = pools.get(key)
  if (hit && !refresh && Date.now() - hit.at < POOL_TTL_MS) return hit
  const leads: PoolLead[] = []
  let eligible = 0
  for (let page = 1; leads.length < SCAN_LIMIT; page++) {
    const r = await flJson(eligiblePoolPath(board, { social, perPage: PER_PAGE, page }))
    if (!r.ok) {
      if (page === 1) return { reason: r.reason }
      break
    }
    const rows: any[] = r.body?.data?.data ?? r.body?.data ?? []
    if (page === 1) eligible = Number(r.body?.total ?? r.body?.data?.total ?? rows.length) || 0
    // Only what the report reads: a 10,000-lead pool held whole is most of a lead's PII for nothing.
    for (const l of rows.slice(0, SCAN_LIMIT - leads.length))
      leads.push({ id: l?.id, custom_fields: { source_post_url: l?.custom_fields?.source_post_url, comment: l?.custom_fields?.comment } })
    const last = Number(r.body?.last_page ?? r.body?.data?.last_page ?? page)
    if (!rows.length || page >= last) break
  }
  const pool = { at: Date.now(), eligible, leads, complete: leads.length >= eligible }
  pools.set(key, pool)
  return pool
}

async function readStrategies(bloq: number): Promise<PlatformResult<Strategy[]>> {
  const r = await flJson(`/api/v1/bloqs/${bloq}/outreach-strategy-templates`)
  if (!r.ok) return { measured: false, reason: r.reason, data: [] }
  const list = r.body?.data?.templates ?? r.body?.templates ?? r.body?.data ?? []
  return { measured: true, data: Array.isArray(list) ? list.map((t: any) => shapeStrategy(t, bloq)) : [] }
}

/** The fits count from this engine's last audience read of a campaign, if any. */
const fitsSeen = new Map<number, number | null>()

// ─── Routes ───────────────────────────────────────────────────────────────────

/**
 * The ids of the campaigns the signed-in person is on (#193486). null when fl-api does not have the
 * route yet (404) or did not answer — the Mine filter is then hidden, not shown empty.
 */
async function readMine(): Promise<number[] | null> {
  const r = await flJson("/api/v1/som/campaigns/mine")
  if (!r.ok) return null
  const list = r.body?.data?.campaigns ?? r.body?.data ?? r.body?.campaigns ?? r.body
  return Array.isArray(list) ? list.map((c: any) => Number(c?.id ?? c)).filter((n: number) => Number.isFinite(n)) : null
}

/** GET /iris/outreach/campaigns — every SOM campaign on the account, with its supply. */
export async function fetchOutreachCampaigns(): Promise<PlatformResult<{ campaigns: CampaignRow[]; mine_ids: number[] | null }>> {
  const [list, mine] = await Promise.all([readCampaigns(), readMine()])
  if (!list.measured) return { measured: false, reason: list.reason, data: { campaigns: [], mine_ids: null } }
  const keys = [...new Set(list.data.map((c) => poolKey(c.bloq_id, !!c.ig_account)))]
  const counts = new Map(
    await Promise.all(
      keys.map(async (k) => {
        const [b, s] = k.split(":")
        return [k, await eligibleCount(Number(b), s === "true")] as const
      }),
    ),
  )
  const campaigns = list.data.map((c): CampaignRow => {
    const eligible = counts.get(poolKey(c.bloq_id, !!c.ig_account)) ?? null
    const cap = dailyCap(c)
    return {
      ...c,
      eligible,
      daily_cap: cap.cap,
      cap_source: cap.source,
      days_of_supply: eligible === null ? null : supply(eligible, cap.cap, 7).days,
      fits: fitsSeen.get(c.id) ?? null,
    }
  })
  return { measured: true, data: { campaigns, mine_ids: mine } }
}

export type AudienceAnswer = {
  campaign: CampaignRow | null
  report: CampaignReport | null
  posts: ReturnType<typeof postBreakdown>
  strategy: Strategy | null
  scan_limit: number
}

/** GET /iris/outreach/campaigns/:id/audience — preflight for one campaign, plus where its leads came from. */
export async function fetchCampaignAudience(id: number, refresh = false): Promise<PlatformResult<AudienceAnswer>> {
  const empty: AudienceAnswer = { campaign: null, report: null, posts: [], strategy: null, scan_limit: SCAN_LIMIT }
  const list = await readCampaigns()
  if (!list.measured) return { measured: false, reason: list.reason, data: empty }
  const c = list.data.find((x) => x.id === id)
  if (!c) return { measured: false, reason: `campaign ${id} is not one of this account's SOM campaigns`, data: empty }
  const social = !!c.ig_account
  const [pool, strategies] = await Promise.all([scanPool(c.bloq_id, social, refresh), readStrategies(c.bloq_id)])
  if ("reason" in pool) return { measured: false, reason: pool.reason, data: empty }
  const strategy =
    strategies.data.find((s) => c.strategy_template_id !== null && s.id === c.strategy_template_id) ??
    strategies.data.find((s) => s.name === c.strategy_name) ??
    null
  const cap = dailyCap(c)
  const report = campaignReport({
    campaign: c.name,
    active: c.active,
    board: c.bloq_id,
    strategyName: c.strategy_name,
    strategy: strategy ? { name: strategy.name, description: strategy.description, steps: strategy.steps } : null,
    audienceNote: c.audience_note,
    eligible: pool.eligible,
    leads: pool.leads,
    dailyCap: cap.cap,
    minDays: 7,
  })
  fitsSeen.set(c.id, report.matching_eligible)
  const row: CampaignRow = {
    ...c,
    eligible: pool.eligible,
    daily_cap: cap.cap,
    cap_source: cap.source,
    days_of_supply: report.days_of_supply,
    fits: report.matching_eligible,
  }
  return {
    measured: true,
    reason: strategies.measured ? undefined : `strategies: ${strategies.reason}`,
    data: { campaign: row, report, posts: postBreakdown(pool.leads, report.top_posts), strategy, scan_limit: SCAN_LIMIT },
  }
}

/**
 * GET /iris/outreach/strategies?bloq=38,80 — the strategies on those boards; no `bloq` = the boards
 * the account's campaigns use. Each strategy lists the campaigns that run it (`campaigns`).
 */
export async function fetchOutreachStrategies(
  bloqParam?: string,
): Promise<PlatformResult<{ boards: number[]; strategies: (Strategy & { campaigns: { id: number; label: string; active: boolean }[] })[] }>> {
  const list = await readCampaigns()
  const asked = (bloqParam ?? "")
    .split(",")
    .map((x) => Number(x.trim()))
    .filter((n) => Number.isInteger(n) && n > 0)
  if (!asked.length && !list.measured) return { measured: false, reason: list.reason, data: { boards: [], strategies: [] } }
  const boards = asked.length ? [...new Set(asked)] : [...new Set(list.data.map((c) => c.bloq_id))]
  const reads = await Promise.all(boards.map((b) => readStrategies(b)))
  const failed = reads.map((r, i) => (r.measured ? null : `board ${boards[i]}: ${r.reason}`)).filter(Boolean)
  if (boards.length && failed.length === boards.length) return { measured: false, reason: failed.join("; "), data: { boards, strategies: [] } }
  const campaigns = list.data
  const strategies = reads
    .flatMap((r) => r.data)
    .map((s) => ({
      ...s,
      campaigns: campaigns
        .filter((c) => c.bloq_id === s.bloq_id && (c.strategy_template_id === s.id || (c.strategy_template_id === null && c.strategy_name === s.name)))
        .map((c) => ({ id: c.id, label: c.label, active: c.active })),
    }))
  return { measured: true, reason: failed.length ? failed.join("; ") : undefined, data: { boards, strategies } }
}
