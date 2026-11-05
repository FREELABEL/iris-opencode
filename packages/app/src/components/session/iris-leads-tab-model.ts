/**
 * The Leads tab (#192544, epic #192479): Elon's BloqLeadsTab layout, with Reachr's approval queue
 * folded in. What its counts, filters and bands mean, with no I/O. Every number is read from a route
 * the panel already has (`/iris/leads-api` list + meta, `/iris/reachr/batches`); a number with no
 * such source is left off rather than guessed.
 */

// ── Urgency: ELON's bands (leadUrgency.js), by hours since anything happened on the lead ──

export type Band = "fresh" | "follow" | "urgent" | "critical"
export const BANDS: { id: Band; label: string; hint: string; from: number; to?: number }[] = [
  { id: "fresh", label: "Fresh", hint: "Active in the last day", from: 0, to: 24 },
  { id: "follow", label: "Follow up", hint: "Needs attention: 1–2 days quiet", from: 24, to: 48 },
  { id: "urgent", label: "Urgent", hint: "Urgent follow up: 2–3 days quiet", from: 48, to: 72 },
  { id: "critical", label: "Critical", hint: "Going cold: more than 3 days quiet", from: 72 },
]

/** fl-api compares `updated_at` with the string it is given; MySQL's own UTC form. */
export const sqlTime = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ")

/** The list filters that select one band: last touched between `to` and `from` hours ago. */
export function bandQuery(band: Band, now: number): Record<string, string> {
  const b = BANDS.find((x) => x.id === band)!
  const q: Record<string, string> = { updated_before: sqlTime(now - b.from * 3_600_000) }
  if (b.to !== undefined) q.updated_after = sqlTime(now - b.to * 3_600_000)
  if (b.from === 0) delete q.updated_before
  return q
}

/** Elon's health score: the share of leads still Fresh or Follow up. Unknown without both numbers. */
export function healthScore(u: Partial<Record<Band, number>>, total: number | undefined): number | undefined {
  if (u.fresh === undefined || u.follow === undefined || !total) return undefined
  return Math.round(((u.fresh + u.follow) / total) * 100)
}
export const healthWord = (n: number) => (n >= 70 ? "Healthy" : n >= 40 ? "Fair" : "Critical")

// ── Stages ──

/** One stage however it was typed: "Follow Up", "follow-up" and "Follow_Up" are the same stage. */
export const stageKey = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, "")

/** The pipeline's order, so stages read like the board does, not alphabetically. */
export const STAGE_ORDER = ["Prospected", "New", "Contacted", "Follow Up", "Responded", "Interested", "Qualified", "Proposal", "Negotiation", "In Negotiation", "Won", "Converted", "Lost", "On Hold", "Inactive"]

/**
 * Leads by stage, from fl-api's filter-metadata (`statuses: { [status]: count }`, the leads-api
 * `meta` op). Spellings of one stage are one row — counts summed, named by the commonest spelling —
 * and the row keeps every spelling so its filter asks for all of them. The data is left as it is.
 */
export type Stage = { status: string; count: number; statuses: string[] }
export function stagesOf(meta: any): Stage[] | undefined {
  const raw = meta?.data?.statuses ?? meta?.statuses
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined
  const byKey = new Map<string, { status: string; count: number }[]>()
  for (const [status, n] of Object.entries(raw)) {
    const count = Number(n) || 0
    if (!status || count <= 0) continue
    byKey.set(stageKey(status), [...(byKey.get(stageKey(status)) ?? []), { status, count }])
  }
  const rows: Stage[] = [...byKey.values()].map((spellings) => {
    const sorted = [...spellings].sort((a, b) => b.count - a.count || a.status.localeCompare(b.status))
    return { status: sorted[0]!.status, count: sorted.reduce((t, s) => t + s.count, 0), statuses: sorted.map((s) => s.status) }
  })
  const at = (s: string) => {
    const i = STAGE_ORDER.findIndex((x) => stageKey(x) === stageKey(s))
    return i === -1 ? STAGE_ORDER.length : i
  }
  return rows.sort((a, b) => at(a.status) - at(b.status) || b.count - a.count || a.status.localeCompare(b.status))
}

/** The stage a lead's status belongs to, among the merged rows (for the status filter's options). */
export const sameStage = (a: string, b: string) => stageKey(a) === stageKey(b)

// ── The list ──

export type LeadsFilters = {
  search: string
  /** A stage, with every spelling of it. */
  stage?: { status: string; statuses: string[] }
  band?: Band
  replied: boolean
  sort: "updated_at" | "created_at" | "nickname" | "price_bid"
  order: "asc" | "desc"
}
export const NO_FILTERS: LeadsFilters = { search: "", replied: false, sort: "updated_at", order: "desc" }

/** How many filters narrow the list — the number on the Filters button. Search and sort don't count. */
export const activeFilterCount = (f: LeadsFilters) => (f.stage ? 1 : 0) + (f.band ? 1 : 0) + (f.replied ? 1 : 0)

/**
 * The list query, as Elon sends it. Empty filters are left out, not sent blank. A merged stage is
 * asked for one spelling at a time (`status` names which) — fl-api matches status exactly.
 */
export function listQuery(f: LeadsFilters & { bloqId?: number; page: number; perPage?: number; status?: string; now: number }): Record<string, string> {
  const q: Record<string, string> = { page: String(f.page), per_page: String(f.perPage ?? 50), sort: f.sort, order: f.order }
  if (f.bloqId !== undefined) q.bloq_id = String(f.bloqId)
  if (f.search.trim()) q.search = f.search.trim()
  if (f.stage) q.status = f.status ?? f.stage.statuses[0] ?? f.stage.status
  if (f.replied) q.has_replied = "1"
  if (f.band) Object.assign(q, bandQuery(f.band, f.now))
  return q
}

/** One page of a merged stage, from one page per spelling: newest first, totals summed. */
export function mergePages<R extends Record<string, any>>(pages: { rows: R[]; total: number; lastPage: number }[], sort = "updated_at", order = "desc") {
  const dir = order === "asc" ? 1 : -1
  const rows = pages
    .flatMap((p) => p.rows)
    .sort((a, b) => dir * String(a[sort] ?? "").localeCompare(String(b[sort] ?? ""), undefined, { numeric: true }))
  return { rows, total: pages.reduce((t, p) => t + p.total, 0), lastPage: Math.max(1, ...pages.map((p) => p.lastPage)) }
}

/** Elon's "Showing 50 of 7,693 leads". */
export function showingLine(shown: number, total: number | undefined): string {
  if (total === undefined) return ""
  return shown >= total ? `All ${total.toLocaleString()} ${total === 1 ? "lead" : "leads"} loaded` : `Showing ${shown.toLocaleString()} of ${total.toLocaleString()} leads`
}

/** A stage's tone, so a status reads in both themes (the CSS mixes it with the text colour). */
export type Tone = "new" | "warm" | "good" | "bad" | "idle"
const TONES: [RegExp, Tone][] = [
  [/^(new|lead|prospected)/, "new"],
  [/^(contacted|follow|responded|replied|interested|qualified|proposal|negotiation|in negotiation)/, "warm"],
  [/^(won|closed|converted)/, "good"],
  [/^lost/, "bad"],
]
export function toneOf(status: string | null | undefined): Tone {
  const s = (status ?? "").toLowerCase()
  return TONES.find(([re]) => re.test(s))?.[1] ?? "idle"
}

/** The band a lead is in now, for the pill under its date. */
export function bandOf(updatedAt: string | null | undefined, now: number): Band | undefined {
  if (!updatedAt) return undefined
  const t = new Date(updatedAt).getTime()
  if (Number.isNaN(t)) return undefined
  const h = (now - t) / 3_600_000
  return BANDS.find((b) => h >= b.from && (b.to === undefined || h < b.to))?.id
}
