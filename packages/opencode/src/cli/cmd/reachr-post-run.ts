/**
 * `iris reachr post-run`'s decisions, with no I/O (#192163): who may be messaged, what they are told,
 * whether a person's approval still holds, and what a run came to. See reachr-post-run.test.ts.
 */
import type { Lead } from "./reachr-core"

export const DEFAULT_LIMIT = 5
export const MAX_LIMIT = 25
export const DEFAULT_DAILY_CAP = 40
export const PLAN_MAX_AGE_MS = 24 * 60 * 60 * 1000
export const SOM_LOCK_MAX_AGE_MS = 30 * 60 * 1000

const handleOf = (v: unknown) => String(v ?? "").trim().replace(/^@/, "").toLowerCase()

export function postShortcode(url: unknown): string | null {
  const m = String(url ?? "").match(/^https?:\/\/(?:www\.)?instagram\.com\/(?:[A-Za-z0-9._]+\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i)
  return m ? m[1] : null
}

// ── wording ──────────────────────────────────────────────────────────────────

/** Did this person really comment on this post? Needs the post, the source and the comment itself. */
export function cameFromPost(lead: Lead, postUrl: string): boolean {
  const code = postShortcode(postUrl)
  return (
    !!code &&
    postShortcode(lead.source_url) === code &&
    lead.source === "leadgen:instagram:comments" &&
    !!String(lead.extra?.comment ?? "").trim()
  )
}

export const SOURCE_LINE = "Saw your comment on that post."
const COMMENT_CLAIM = /\b(your comment|you commented|commented on|saw your)\b/i

export type Composed = { message: string } | { refused: string }
export interface WordingInput {
  template: string
  lead: Lead
  postUrl: string
}
/** The seam for per-post wording (Stage 2): swap this and the plan, preview and send stay as they are. */
export type Wording = (i: WordingInput) => Composed

/** {handle} and {source}. A claim about the person's comment is refused unless the record backs it. */
export const templateWording: Wording = ({ template, lead, postUrl }) => {
  const verified = cameFromPost(lead, postUrl)
  if (!verified && (template.includes("{source}") || COMMENT_CLAIM.test(template)))
    return { refused: "the message mentions their comment, and no comment on this post is on record" }
  const message = template.replaceAll("{source}", SOURCE_LINE).replaceAll("{handle}", handleOf(lead.handle)).trim()
  const unknown = message.match(/\{[a-z_]+\}/i)
  if (unknown) return { refused: `the message has an unknown placeholder ${unknown[0]}` }
  if (!message) return { refused: "the message is empty" }
  return { message }
}

export function messageWarnings(template: string): string[] {
  const out: string[] = []
  if (/https?:\/\/|\b[a-z0-9-]+\.(io|com|net|ai|co)\b/i.test(template)) out.push("It contains a link; the playbook says no URLs in a first message.")
  return out
}

// ── who ──────────────────────────────────────────────────────────────────────

/** Already talked to, by what a lead's own record shows. An empty answer means no contact on record. */
export function contactReason(messages: unknown[], notes: unknown[]): string | null {
  if (messages.length) return "already contacted (outreach message on record)"
  const text = notes.map((n: any) => String(n?.content ?? n?.message ?? n ?? "")).join("\n")
  if (text.includes("[SOM DM]")) return "already contacted ([SOM DM] note)"
  if (text.includes("[SOM UNDELIVERABLE]")) return "marked undeliverable earlier"
  if (text.includes("[SOM FAIL]")) return "an earlier DM attempt failed, and it may have arrived"
  return null
}

export interface PlanTarget {
  handle: string
  name: string
  comment: string
  why: string
  message: string
  lead: Lead
}
export interface Skip {
  handle: string
  reason: string
}
export interface PlanInput {
  leads: Lead[]
  postUrl: string
  template: string
  account: string
  ownHandles: Iterable<string>
  /** handle → why they must not be messaged (ledger, the lead's record). */
  blocked: Map<string, string>
  limit: number
  remainingToday: number
  wording?: Wording
}

export function planRun(i: PlanInput): { targets: PlanTarget[]; skipped: Skip[]; overLimit: number } {
  const own = new Set([...i.ownHandles, i.account].map(handleOf))
  const wording = i.wording ?? templateWording
  const room = Math.max(0, Math.min(i.limit, i.remainingToday))
  const seen = new Set<string>()
  const targets: PlanTarget[] = []
  const skipped: Skip[] = []
  let overLimit = 0
  for (const lead of i.leads) {
    const handle = handleOf(lead.handle)
    if (!handle || seen.has(handle)) continue
    seen.add(handle)
    if (own.has(handle)) { skipped.push({ handle, reason: "our own account" }); continue }
    const blocked = i.blocked.get(handle)
    if (blocked) { skipped.push({ handle, reason: blocked }); continue }
    const composed = wording({ template: i.template, lead, postUrl: i.postUrl })
    if ("refused" in composed) { skipped.push({ handle, reason: composed.refused }); continue }
    if (targets.length >= room) { overLimit++; continue }
    const comment = String(lead.extra?.comment ?? "").trim()
    targets.push({
      handle,
      name: lead.name.v,
      comment,
      why: comment ? `commented on this post: "${comment.slice(0, 120)}"` : "listed as a commenter on this post (comment text not read)",
      message: composed.message,
      lead,
    })
  }
  return { targets, skipped, overLimit }
}

// ── approval ─────────────────────────────────────────────────────────────────

export interface SavedPlan {
  run_id: string
  created_at: string
  post_url: string
  account: string
  board_id: number
  targets: PlanTarget[]
}

/** A person read one list. Sending is refused unless this is that list, still current, and fits the cap. */
export function approvalError(
  plan: SavedPlan | null,
  a: { postUrl: string; account: string; boardId: number; confirmCount: unknown; remainingToday: number; now: number },
): string | null {
  const preview = "Run the preview first, read it, and confirm the count it prints."
  if (!plan) return `No preview on this machine for this post, account and board. ${preview}`
  if (postShortcode(plan.post_url) !== postShortcode(a.postUrl) || plan.account !== a.account || plan.board_id !== a.boardId)
    return `The saved preview is for a different post, account or board. ${preview}`
  const age = a.now - Date.parse(plan.created_at)
  if (!(age >= 0 && age <= PLAN_MAX_AGE_MS)) return `The saved preview is over 24 hours old. ${preview}`
  if (!plan.targets.length) return "The preview has nobody to message."
  if (a.confirmCount === undefined || a.confirmCount === null) return `--send needs --confirm-count ${plan.targets.length}, the number in the preview.`
  if (Number(a.confirmCount) !== plan.targets.length)
    return `--confirm-count ${a.confirmCount} does not match the preview, which lists ${plan.targets.length}. ${preview}`
  if (plan.targets.length > a.remainingToday)
    return `Only ${a.remainingToday} DM(s) left today on @${a.account}, and the preview lists ${plan.targets.length}. Preview again with a lower --limit, or wait until tomorrow.`
  return null
}

// ── results ──────────────────────────────────────────────────────────────────

export interface LedgerEntry {
  run_id: string
  shortcode: string
  handle: string
  lead_id: number
  outcome: "sent" | "undeliverable" | "unconfirmed" | "failed"
  reason?: string
  recorded?: boolean
  at?: string
}

/** Only a failure, which never reached the person, may be tried again. Same rule as the sender. */
export function ledgerBlocks(entries: LedgerEntry[]): Map<string, string> {
  const why: Record<string, string> = {
    sent: "already sent by a post run",
    undeliverable: "undeliverable in an earlier post run",
    unconfirmed: "an earlier post run could not confirm the send, and it may have arrived",
  }
  const out = new Map<string, string>()
  for (const e of entries) if (why[e.outcome]) out.set(handleOf(e.handle), why[e.outcome])
  return out
}

/** Handles the keyword-DM flow has reached, across every post in its ledger. */
export function keywordLedgerHandles(ledger: any): Map<string, string> {
  const out = new Map<string, string>()
  for (const post of Object.values<any>(ledger?.posts ?? {}))
    for (const e of post?.entries ?? []) if (e && !e.dry && e.status === "sent") out.set(handleOf(e.handle), "already sent by keyword-dm")
  return out
}

export function tally(entries: LedgerEntry[], approved: number) {
  const n = (o: LedgerEntry["outcome"]) => entries.filter((e) => e.outcome === o).length
  return {
    approved,
    sent: n("sent"),
    undeliverable: n("undeliverable"),
    unconfirmed: n("unconfirmed"),
    failed: n("failed"),
    not_attempted: Math.max(0, approved - entries.length),
    sent_not_recorded: entries.filter((e) => e.outcome === "sent" && !e.recorded).length,
  }
}

/** Sends per post from the ledger, latest attempt per person. */
export function perPost(entries: LedgerEntry[]): { shortcode: string; latest: LedgerEntry[] }[] {
  const byPost = new Map<string, Map<string, LedgerEntry>>()
  for (const e of entries) {
    if (!byPost.has(e.shortcode)) byPost.set(e.shortcode, new Map())
    byPost.get(e.shortcode)!.set(handleOf(e.handle), e)
  }
  return [...byPost].map(([shortcode, m]) => ({ shortcode, latest: [...m.values()] }))
}

// ── one browser per account ──────────────────────────────────────────────────

const SOM_JOB = /\b(batch-with-login|leadgen-scraper|instagram-[a-z-]+|capture-replies|send-approved-replies|post-run-send|inbox-followup)(\.spec)?(\.ts)?\b|\bsom(-all)?\.js\b|capture-replies\.sh/

/** Why a browser job must not start now, or null. Lock format: som-all.js's /tmp/som_batch.lock. */
export function busyReason(
  lock: unknown,
  psLines: string,
  o: { now: number; alive: (pid: number) => boolean },
): string | null {
  const l = lock as { pid?: unknown; started?: unknown } | null
  if (l && Number.isInteger(l.pid) && Number.isFinite(l.started) && o.alive(l.pid as number) && o.now - (l.started as number) < SOM_LOCK_MAX_AGE_MS)
    return `a SOM batch or post run holds the lock (pid ${l.pid})`
  // Only a process that is running a job: a shell, an editor or a grep can merely mention the name.
  const job = psLines.split("\n").find((line) => {
    const m = line.trim().match(/^\d+\s+(\S+)/)
    return !!m && /(^|\/)(node|npx|npm|xvfb-run)$/.test(m[1]!) && SOM_JOB.test(line)
  })
  if (job) return `a SOM browser job is running (pid ${job.trim().split(/\s+/)[0]})`
  return null
}

/** Is this board fed to a live campaign? A lead left on it can get the campaign's DM with nobody looking. */
export function liveCampaignOnBoard(cache: any, boardId: number): string | null {
  for (const [name, c] of Object.entries<any>(cache?.campaigns ?? {}))
    if (c?.active !== false && Number(c?.boardId) === boardId) return name
  return null
}
