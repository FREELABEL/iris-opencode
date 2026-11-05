// ============================================================================
// ad-campaigns-core — the pure half of `iris campaigns` (#192625, epic #192614)
//
// Request bodies, the words a person reads, and nothing that touches the network, so every
// line here is testable without a server. The command lives in platform-ad-campaigns.ts.
//
// The server is fl-api /api/v1/campaigns (CampaignsController). It owns the rules: the board
// decides who may read, write and review; a review records who and when from the signed-in
// account; a rejection must say why. This file only shapes what is sent and what is shown.
// ============================================================================

export const APPROVAL_STATES = ["draft", "in_review", "approved", "rejected", "changes_requested"] as const
export type ApprovalState = (typeof APPROVAL_STATES)[number]

export const CAMPAIGN_STATES = ["draft", "active", "paused", "ended"] as const

/** What a person reads for each approval state. */
export const STATE_WORDS: Record<ApprovalState, string> = {
  draft: "Draft",
  in_review: "Waiting for review",
  approved: "Approved",
  rejected: "Rejected",
  changes_requested: "Changes requested",
}

export type Decision = "approve" | "reject" | "request_changes"

export const DECISION_WORDS: Record<Decision, string> = {
  approve: "Approved",
  reject: "Rejected",
  request_changes: "Asked for changes on",
}

/** "instagram, x" | ["instagram","x"] | ["instagram,x"] → ["instagram","x"]; nothing → undefined. */
export function splitList(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined
  const parts = (Array.isArray(raw) ? raw : [raw])
    .flatMap((v) => String(v).split(","))
    .map((s) => s.trim())
    .filter(Boolean)
  return parts.length ? parts : undefined
}

/**
 * A budget in dollars, the way a person writes one ("500", "$1,250.50", "1250.5") → cents.
 * Returns null for something that is not an amount, so the command can say so instead of
 * sending a zero.
 */
export function dollarsToCents(raw: unknown): number | null | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined
  const s = String(raw).replace(/[$,\s]/g, "")
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null
  return Math.round(Number(s) * 100)
}

export function centsToDollars(cents: unknown): string {
  const n = Number(cents)
  if (!Number.isFinite(n)) return "—"
  return "$" + (n / 100).toLocaleString("en-US", { minimumFractionDigits: n % 100 ? 2 : 0, maximumFractionDigits: 2 })
}

/** Drop undefined so a flag left out stays out of the request. */
function clean<T extends Record<string, unknown>>(o: T): Partial<T> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v
  return out as Partial<T>
}

export type CampaignFlags = {
  name: string
  brand?: string
  objective?: string
  channels?: unknown
  starts?: string
  ends?: string
  budget?: unknown
  owner?: string
  state?: string
}

export function campaignBody(bloqId: number, f: CampaignFlags): { body?: Record<string, unknown>; error?: string } {
  const budget = dollarsToCents(f.budget)
  if (budget === null) return { error: `"${f.budget}" is not an amount. Write the budget in dollars, e.g. --budget 500 or --budget 1250.50.` }
  if (f.state && !(CAMPAIGN_STATES as readonly string[]).includes(f.state)) {
    return { error: `A campaign is ${CAMPAIGN_STATES.join(", ")} — not "${f.state}".` }
  }
  return {
    body: clean({
      bloq_id: bloqId,
      name: f.name,
      brand: f.brand,
      objective: f.objective,
      channels: splitList(f.channels),
      starts_at: f.starts,
      ends_at: f.ends,
      budget_cents: budget,
      owner: f.owner,
      state: f.state,
    }),
  }
}

export type CreativeFlags = {
  headline: string
  text?: string
  textX?: string
  product?: string
  concept?: string
  tags?: string
  image?: string
  video?: string
  poster?: string
  landingPage?: string
  landingUrl?: string
  utmContent?: string
  adNo?: number
  abPair?: string
  hypothesis?: string
  notes?: string
  slides?: unknown
  submit?: boolean
}

/** Slides go up as {url, type, alt}, the order given — the shape FREELABEL's carousel rows use. */
export function slidesFrom(raw: unknown): Array<{ url: string; type: string; alt: string }> | undefined {
  const urls = splitList(raw)
  if (!urls) return undefined
  return urls.map((url) => ({ url, type: /\.(mp4|mov|webm)(\?|$)/i.test(url) ? "video" : "image", alt: "" }))
}

export function creativeBody(bloqId: number, f: CreativeFlags): Record<string, unknown> {
  return clean({
    bloq_id: bloqId,
    headline: f.headline,
    post_text: f.text,
    post_text_x: f.textX,
    product: f.product,
    concept: f.concept,
    tags: f.tags,
    image_url: f.image,
    video_url: f.video,
    poster_url: f.poster,
    landing_page: f.landingPage,
    landing_url: f.landingUrl,
    utm_content: f.utmContent,
    ad_no: f.adNo,
    ab_pair: f.abPair,
    hypothesis: f.hypothesis,
    notes: f.notes,
    slides: slidesFrom(f.slides),
    submit: f.submit ? true : undefined,
  })
}

/**
 * The review request — or the sentence that says what is missing. A rejection and a change
 * request carry a reason; the server refuses them without one too, this just says it first.
 */
export function reviewBody(bloqId: number, decision: Decision, note?: string): { body?: Record<string, unknown>; error?: string } {
  const n = (note ?? "").trim()
  if (decision === "reject" && !n) return { error: 'Say why it was rejected: --reason "…" (it goes on the creative for whoever made it).' }
  if (decision === "request_changes" && !n) return { error: 'Say what needs to change: --note "…" (it goes on the creative for whoever made it).' }
  return { body: clean({ bloq_id: bloqId, decision, note: n || undefined }) }
}

/** "5 Nov, 3:04 PM" in the reader's own zone; the ISO string stays in --json. */
export function when(iso: unknown): string {
  if (!iso) return ""
  const d = new Date(String(iso))
  if (Number.isNaN(d.getTime())) return String(iso)
  return d.toLocaleString("en-US", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })
}

export function stateWord(s: unknown): string {
  return STATE_WORDS[s as ApprovalState] ?? String(s ?? "Draft")
}

/** One line per creative: "#12  Approved  “Headline” — by a@b.c, 5 Nov 3:04 PM · note". */
export function creativeLine(c: any): string {
  const state = stateWord(c?.approval_state)
  const who = c?.approved_by && c?.approval_state !== "draft" && c?.approval_state !== "in_review"
    ? ` — by ${c.approved_by}${c.approved_at ? `, ${when(c.approved_at)}` : ""}`
    : ""
  const note = c?.approval_note ? ` · "${c.approval_note}"` : ""
  return `#${c?.id}  ${state.padEnd(18)} "${c?.headline ?? "(no headline)"}"${who}${note}`
}

/** "2 approved · 1 rejected" — only the states that have something in them. */
export function countsLine(counts: Record<string, number> | undefined): string {
  if (!counts) return "no creatives yet"
  const parts = APPROVAL_STATES.filter((s) => (counts[s] ?? 0) > 0).map((s) => `${counts[s]} ${STATE_WORDS[s].toLowerCase()}`)
  return parts.length ? parts.join(" · ") : "no creatives yet"
}

/** The id a person types: "12" or "#12". */
export function parseId(raw: unknown): number | null {
  const s = String(raw ?? "").trim().replace(/^#/, "")
  return /^\d+$/.test(s) && Number(s) > 0 ? Number(s) : null
}
