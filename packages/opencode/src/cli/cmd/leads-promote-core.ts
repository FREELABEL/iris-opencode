// ============================================================================
// `iris leads promote` — the pure half (#193515)
// ============================================================================
//
// Staged Apollo prospects live in an Atlas dataset (`product-leads`, schema #522,
// board 746) until they are worth working. Apollo search returns no email and a
// partly hidden last name ("Ed***s"); revealing them is a separate, PAID
// `enrich_person` call (about 1 credit a person). Promoting a prospect to a CRM
// lead is the moment that credit is worth spending — and only for the people we
// will actually work.
//
// Everything here is pure so the money-relevant decisions (who is picked, who
// would be enriched, how many credits that costs, who is skipped and why) are
// testable without a live API, a live Apollo key or a live CRM:
//
//   parseWhere        "product=iris-terra,fit=strong|check"  → filters
//   planPromotion     rows → per-company picks + credit count + skips with reasons
//   nameMatchesHint   does an enriched name match the hint search gave us?
//
// The impure half (reading the dataset, enriching, importing) lives in
// platform-leads-promote.ts behind the LeadImporter / PersonEnricher interfaces.

export interface DatasetRow {
  id: number
  external_id?: string | null
  data: Record<string, unknown>
}

// ── --where ──────────────────────────────────────────────────────────────────

export interface WhereClause {
  key: string
  /** Any of these values matches (a|b|c). Compared case-insensitively as strings. */
  values: string[]
  negate: boolean
}

/**
 * Parse `--where 'product=iris-terra,fit=strong|check,stage!=dropped'`.
 * Commas separate clauses (AND); `|` separates alternatives (OR); `!=` negates.
 * Throws on a clause with no `=`, so a typo never silently selects everyone.
 */
export function parseWhere(input: string | undefined | null): WhereClause[] {
  if (!input || !input.trim()) return []
  return input
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((clause) => {
      const m = clause.match(/^([A-Za-z0-9_.-]+)\s*(!=|=)\s*(.*)$/)
      if (!m) throw new Error(`--where clause "${clause}" is not key=value (or key!=value)`)
      const values = m[3]
        .split("|")
        .map((v) => v.trim())
        .filter((v) => v !== "")
      if (values.length === 0) throw new Error(`--where clause "${clause}" has no value`)
      return { key: m[1], values, negate: m[2] === "!=" }
    })
}

function fieldString(v: unknown): string {
  if (v === null || v === undefined) return ""
  return String(v).trim().toLowerCase()
}

export function rowMatches(row: DatasetRow, where: WhereClause[]): boolean {
  return where.every((c) => {
    const actual = fieldString(c.key === "external_id" ? (row.external_id ?? row.data.external_id) : row.data[c.key])
    const hit = c.values.some((v) => v.toLowerCase() === actual)
    return c.negate ? !hit : hit
  })
}

// ── identity ─────────────────────────────────────────────────────────────────

/** "apollo:6845d2…" → "6845d2…". Null when the row is not an Apollo person. */
export function apolloIdOf(row: DatasetRow): string | null {
  const ext = String(row.external_id ?? row.data.external_id ?? "").trim()
  const m = ext.match(/^apollo:([A-Za-z0-9]+)$/)
  return m ? m[1] : null
}

/** The external_id the CRM lead is keyed by — the same value as the dataset row. */
export function externalIdOf(row: DatasetRow): string | null {
  const id = apolloIdOf(row)
  return id ? `apollo:${id}` : null
}

/**
 * Group key for "per company". Domain when we have one (two spellings of a name are
 * one company), else the name with legal suffixes and punctuation stripped.
 */
export function companyKey(row: DatasetRow): string {
  const domain = fieldString(row.data.company_domain).replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "")
  if (domain) return `domain:${domain}`
  const name = fieldString(row.data.company)
    .replace(/[.,'’"()&]/g, " ")
    .replace(/\b(inc|llc|l l c|ltd|co|corp|corporation|company|plc|lp|llp|group)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  return name ? `name:${name}` : `row:${row.id}`
}

// ── ranking ──────────────────────────────────────────────────────────────────

/** Higher is more senior. Buyers first: an owner can say yes; a coordinator cannot. */
export function seniorityScore(title: unknown): number {
  const t = fieldString(title)
  if (!t) return 0
  if (/\b(owner|founder|co-founder|cofounder|ceo|chief executive|president|principal|managing partner)\b/.test(t)) return 6
  if (/\b(chief|cto|coo|cfo|cio|cmo|partner)\b/.test(t)) return 5
  if (/\b(vp|vice president|svp|evp)\b/.test(t)) return 4
  if (/\b(head|director)\b/.test(t)) return 3
  if (/\b(manager|lead|superintendent|supervisor)\b/.test(t)) return 2
  if (/\b(coordinator|assistant|intern|associate)\b/.test(t)) return 0
  return 1
}

function truthy(v: unknown): boolean {
  if (typeof v === "boolean") return v
  const s = fieldString(v)
  return s === "true" || s === "yes" || s === "1"
}

function personRank(row: DatasetRow): number[] {
  return [
    fieldString(row.data.fit) === "strong" ? 1 : 0,
    seniorityScore(row.data.title),
    truthy(row.data.has_email) ? 1 : 0,
    truthy(row.data.has_direct_phone) ? 1 : 0,
  ]
}

function compareRank(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (b[i] ?? 0) - (a[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

// ── the plan ─────────────────────────────────────────────────────────────────

export type PickAction =
  /** Email already on the row (enriched before): import, no credit. */
  | "import"
  /** Needs enrich_person: 1 credit, then import if an email comes back. */
  | "enrich"
  /** Would need a credit but --max-credits is used up: left staged, not imported. */
  | "over_cap"
  /** Apollo says it has no email; enriching would spend a credit on nothing. Left staged. */
  | "no_email_on_file"
  /** --enrich not passed and no email on the row: imported without email would be unworkable. Left staged. */
  | "needs_enrich"

export interface Pick {
  row: DatasetRow
  externalId: string
  apolloId: string
  company: string
  companyKey: string
  action: PickAction
  credits: number
}

export type SkipReason =
  | "not_apollo"
  | "already_in_crm"
  | "lead_exists"
  | "dropped"
  | "already_enriched_no_email"
  | "needs_review"

export interface Skip {
  row: DatasetRow
  reason: SkipReason
  detail?: string
}

export interface PlanOptions {
  perCompany: number
  /** Max companies to take (best first). */
  limit: number
  /** --enrich: allowed to spend credits. Without it the plan still counts what it WOULD spend. */
  enrich: boolean
  /** Cap on credits. undefined = no cap (only legal in a dry run; the command enforces that). */
  maxCredits?: number
  /** Also enrich rows Apollo marks has_email=false (spends a credit that usually returns nothing). */
  includeNoEmail?: boolean
}

export interface CompanyPlan {
  key: string
  name: string
  eligible: number
  picks: Pick[]
}

export interface PromotionPlan {
  matched: number
  companies: CompanyPlan[]
  picks: Pick[]
  skips: Skip[]
  /** Credits the run would spend (enrich picks only, after the cap). */
  credits: number
  /** Credits it would have spent with no cap — so a dry run shows what the cap cut. */
  creditsUncapped: number
  counts: Record<PickAction, number>
  companiesAvailable: number
}

/**
 * Decide who gets promoted and what it costs. Pure: the caller hands in the
 * dataset rows (already filtered by --where) and the external_ids that already
 * have a CRM lead, and gets back exactly what a run would do.
 *
 * Idempotency lives here: a row with crm_lead_id, a row whose external_id is
 * already a lead, or a row already enriched (enriched_at / email set) never
 * costs a credit again.
 */
export function planPromotion(
  rows: DatasetRow[],
  opts: PlanOptions,
  existingLeadExternalIds: ReadonlySet<string> = new Set(),
): PromotionPlan {
  const skips: Skip[] = []
  const eligible: DatasetRow[] = []
  const seenApollo = new Set<string>()

  for (const row of rows) {
    const ext = externalIdOf(row)
    if (!ext) { skips.push({ row, reason: "not_apollo", detail: String(row.external_id ?? "") }); continue }
    if (seenApollo.has(ext)) continue // same person staged twice: plan them once
    seenApollo.add(ext)
    const stage = fieldString(row.data.stage)
    if (row.data.crm_lead_id) { skips.push({ row, reason: "already_in_crm", detail: `lead #${row.data.crm_lead_id}` }); continue }
    if (existingLeadExternalIds.has(ext)) { skips.push({ row, reason: "lead_exists", detail: ext }); continue }
    if (stage === "dropped" || fieldString(row.data.fit) === "drop") { skips.push({ row, reason: "dropped" }); continue }
    if (stage === "needs_review") { skips.push({ row, reason: "needs_review", detail: "enriched name did not match — a person decides" }); continue }
    if (row.data.enriched_at && !row.data.email) {
      skips.push({ row, reason: "already_enriched_no_email", detail: `paid ${row.data.enriched_at}; Apollo returned no email` })
      continue
    }
    eligible.push(row)
  }

  // Group, rank people inside each company, then rank companies.
  const groups = new Map<string, DatasetRow[]>()
  for (const row of eligible) {
    const k = companyKey(row)
    const g = groups.get(k)
    if (g) g.push(row)
    else groups.set(k, [row])
  }
  const ranked = [...groups.entries()].map(([key, members]) => {
    members.sort((a, b) => compareRank(personRank(a), personRank(b)) || a.id - b.id)
    const top = members.slice(0, opts.perCompany)
    // Company rank: how deep we can go (capped at per-company), then the best
    // person's rank, then strong-fit count. Going DEEP at fewer companies (#193518).
    // People we can actually email (or pay to reveal) count first, so a company whose
    // picks Apollo has no email for never takes a slot from one we can work.
    const workable = top.filter((m) => !!fieldString(m.data.email) || opts.includeNoEmail || m.data.has_email === undefined || m.data.has_email === null || truthy(m.data.has_email)).length
    const depth = top.length
    const strong = members.filter((m) => fieldString(m.data.fit) === "strong").length
    return { key, members, top, score: [workable, depth, ...personRank(top[0]), strong] }
  })
  ranked.sort((a, b) => compareRank(a.score, b.score) || a.key.localeCompare(b.key))

  const chosen = ranked.slice(0, Math.max(0, opts.limit))
  const counts: Record<PickAction, number> = { import: 0, enrich: 0, over_cap: 0, no_email_on_file: 0, needs_enrich: 0 }
  let credits = 0
  let creditsUncapped = 0
  const picks: Pick[] = []
  const companies: CompanyPlan[] = []

  for (const c of chosen) {
    const cp: CompanyPlan = { key: c.key, name: String(c.top[0].data.company ?? c.key), eligible: c.members.length, picks: [] }
    for (const row of c.top) {
      const hasEmailOnRow = !!fieldString(row.data.email)
      const apolloHasEmail = row.data.has_email === undefined || row.data.has_email === null ? true : truthy(row.data.has_email)
      let action: PickAction
      let cost = 0
      if (hasEmailOnRow) action = "import"
      else if (!apolloHasEmail && !opts.includeNoEmail) action = "no_email_on_file"
      else {
        creditsUncapped += 1
        if (!opts.enrich) action = "needs_enrich"
        else if (opts.maxCredits !== undefined && credits >= opts.maxCredits) action = "over_cap"
        else { action = "enrich"; cost = 1; credits += 1 }
      }
      counts[action]++
      const pick: Pick = {
        row,
        externalId: externalIdOf(row)!,
        apolloId: apolloIdOf(row)!,
        company: cp.name,
        companyKey: c.key,
        action,
        credits: cost,
      }
      cp.picks.push(pick)
      picks.push(pick)
    }
    companies.push(cp)
  }

  return { matched: rows.length, companies, picks, skips, credits, creditsUncapped, counts, companiesAvailable: ranked.length }
}

// ── enrichment checks ────────────────────────────────────────────────────────

/**
 * Does the person Apollo enriched look like the one search showed us?
 * Search gives a first name and a masked last name ("Ed***s"). The enriched last
 * name must start and end with the visible letters; the first name must match
 * (case-insensitive, either may be a prefix of the other: "Chris" / "Christopher").
 * A mismatch means the credit bought someone else — never import that silently.
 */
export function nameMatchesHint(
  hint: { first_name?: unknown; last_name_hint?: unknown },
  enriched: { first_name?: unknown; last_name?: unknown },
): { ok: boolean; why?: string } {
  const hf = fieldString(hint.first_name)
  const ef = fieldString(enriched.first_name)
  if (hf && ef && !(hf.startsWith(ef) || ef.startsWith(hf))) {
    return { ok: false, why: `first name "${enriched.first_name}" ≠ hint "${hint.first_name}"` }
  }
  const hl = fieldString(hint.last_name_hint)
  const el = fieldString(enriched.last_name)
  if (hl && el) {
    const parts = hl.split(/\*+/)
    const head = parts[0] ?? ""
    const tail = parts.length > 1 ? parts[parts.length - 1] : ""
    const plain = parts.length === 1
    const ok = plain ? el === hl : el.startsWith(head) && el.endsWith(tail) && el.length >= head.length + tail.length
    if (!ok) return { ok: false, why: `last name "${enriched.last_name}" does not fit hint "${hint.last_name_hint}"` }
  }
  if (!ef && !el) return { ok: false, why: "Apollo returned no name" }
  return { ok: true }
}

// ── output ───────────────────────────────────────────────────────────────────

export const ACTION_LABEL: Record<PickAction, string> = {
  import: "import (email on file, 0 credits)",
  enrich: "enrich + import (1 credit)",
  over_cap: "over --max-credits: left staged",
  no_email_on_file: "Apollo has no email: left staged",
  needs_enrich: "needs --enrich (1 credit): left staged",
}

export function personLabel(row: DatasetRow): string {
  const first = String(row.data.first_name ?? "").trim()
  const last = String(row.data.last_name ?? row.data.last_name_hint ?? "").trim()
  const name = [first, last].filter(Boolean).join(" ") || "(no name)"
  const title = String(row.data.title ?? "").trim()
  return title ? `${name} — ${title}` : name
}

/** Plain-text plan, one line per person, grouped by company. */
export function formatPlan(plan: PromotionPlan, opts: PlanOptions): string[] {
  const out: string[] = []
  out.push(
    `${plan.matched} row(s) matched · ${plan.companiesAvailable} eligible compan${plan.companiesAvailable === 1 ? "y" : "ies"} · ` +
      `taking ${plan.companies.length} (up to ${opts.perCompany} each) → ${plan.picks.length} people`,
  )
  for (const c of plan.companies) {
    out.push(`  ${c.name}  (${c.picks.length} of ${c.eligible})`)
    for (const p of c.picks) out.push(`    ${p.externalId}  ${personLabel(p.row)}  · ${ACTION_LABEL[p.action]}`)
  }
  out.push("")
  for (const a of Object.keys(plan.counts) as PickAction[]) if (plan.counts[a]) out.push(`  ${String(plan.counts[a]).padStart(4)}  ${ACTION_LABEL[a]}`)
  const bySkip = new Map<SkipReason, number>()
  for (const s of plan.skips) bySkip.set(s.reason, (bySkip.get(s.reason) ?? 0) + 1)
  for (const [r, n] of bySkip) out.push(`  ${String(n).padStart(4)}  skipped: ${r.replace(/_/g, " ")}`)
  out.push("")
  out.push(
    opts.enrich
      ? `CREDITS: this run would spend ${plan.credits} Apollo credit(s)` +
          (plan.creditsUncapped > plan.credits ? ` (capped by --max-credits ${opts.maxCredits}; ${plan.creditsUncapped} uncapped)` : "")
      : `CREDITS: 0 spent without --enrich · enriching these would cost ${plan.creditsUncapped} credit(s)`,
  )
  return out
}

/** The JSON shape of a plan — ids and decisions, no full rows. */
export function planJson(plan: PromotionPlan, opts: PlanOptions) {
  return {
    matched: plan.matched,
    companies_available: plan.companiesAvailable,
    companies_taken: plan.companies.length,
    per_company: opts.perCompany,
    credits: plan.credits,
    credits_uncapped: plan.creditsUncapped,
    max_credits: opts.maxCredits ?? null,
    enrich: opts.enrich,
    counts: plan.counts,
    picks: plan.picks.map((p) => ({
      row_id: p.row.id,
      external_id: p.externalId,
      company: p.company,
      name: personLabel(p.row),
      action: p.action,
      credits: p.credits,
    })),
    skips: plan.skips.map((s) => ({ row_id: s.row.id, external_id: s.row.external_id ?? null, reason: s.reason, detail: s.detail ?? null })),
  }
}
