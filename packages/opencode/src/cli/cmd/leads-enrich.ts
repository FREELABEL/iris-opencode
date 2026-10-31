/**
 * #191700 — `iris leads enrich`, one contract for one lead and for a whole bloq.
 *
 * The bug: `--id` answered "requires confirmation" while the API had already saved a note and
 * five tags about a different business (a soda company named like the coffee shop), and
 * `--bloq` sent a Hive task that called the Instagram-only endpoint first, so every lead
 * without an Instagram handle failed (0 ok / 17 failed).
 *
 * Now both modes call the same web-research endpoint, POST /api/v1/leads/{id}/enrich:
 *   - without --apply the body is {} and the API saves nothing; it answers with the proposed
 *     per-field changes and its entity guard's verdict (matched / ambiguous / rejected + why);
 *   - with --apply the body is {apply: true}; the API applies only a "matched" result, field by
 *     field, with provenance (source URL, provider, time) stored per field.
 * Instagram is one optional source the API uses when the lead has a handle — never the path.
 */

export type GuardStatus = "matched" | "ambiguous" | "rejected" | "unknown"

export type ProposedChange = {
  field: string
  value: string
  current: string | null
  action: "set" | "keep_existing" | string
  passes_guard: boolean
  guard_reason?: string | null
  provenance?: { source_url?: string | null; provider?: string; researched_at?: string }
}

export type EnrichOutcome = {
  lead_id: number
  ok: boolean
  error?: string
  status: GuardStatus
  reasons: string[]
  evidence: string[]
  result_business: string | null
  proposed_changes: ProposedChange[]
  applied: boolean
  applied_fields: string[]
  apply_refused_reason: string | null
  persisted: boolean
  /** The API said it wrote something without the guard passing — must never happen. */
  integrity_violation: string | null
}

/** The request body. Confirmation is sent only when the user asked for it. */
export function enrichRequestBody(apply: boolean): Record<string, unknown> {
  return apply ? { apply: true } : {}
}

/** Read the API's enrich response into one outcome. */
export function summarizeEnrich(leadId: number, out: any, apply: boolean): EnrichOutcome {
  const data = out?.data ?? {}
  const match = data.entity_match ?? null
  const status: GuardStatus = (["matched", "ambiguous", "rejected"] as const).includes(match?.status)
    ? match.status
    : "unknown"
  const applied = data.applied === true
  const persisted = out?.persisted === true || applied
  let integrity: string | null = null
  if (persisted && !apply) integrity = "the API saved changes although --apply was not given"
  else if (persisted && status !== "matched") integrity = `the API saved changes for a result its guard called ${status}`
  else if (status === "unknown" && out?.success)
    integrity = "the API returned no entity guard verdict (fl-api older than #191700?) — treat as unverified"

  return {
    lead_id: leadId,
    ok: out?.success === true,
    error: out?.success === true ? undefined : String(out?.message ?? out?.error ?? "enrich failed"),
    status,
    reasons: Array.isArray(match?.reasons) ? match.reasons.map(String) : [],
    evidence: Array.isArray(match?.evidence) ? match.evidence.map(String) : [],
    result_business: match?.result_business ?? null,
    proposed_changes: Array.isArray(data.proposed_changes) ? data.proposed_changes : [],
    applied,
    applied_fields: Array.isArray(data.applied_fields) ? data.applied_fields.map(String) : [],
    apply_refused_reason: data.apply_refused_reason ?? null,
    persisted,
    integrity_violation: integrity,
  }
}

export type EnrichFetch = (path: string, body: Record<string, unknown>) => Promise<{ ok: boolean; status: number; json: () => Promise<any>; text: () => Promise<string> }>

/** Enrich one lead through the shared contract. */
export async function enrichOne(leadId: number, apply: boolean, post: EnrichFetch): Promise<EnrichOutcome> {
  const res = await post(`/api/v1/leads/${leadId}/enrich`, enrichRequestBody(apply))
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    return { ...summarizeEnrich(leadId, { success: false, message: `HTTP ${res.status} ${body.slice(0, 200)}` }, apply), integrity_violation: null }
  }
  return summarizeEnrich(leadId, await res.json(), apply)
}

export type BulkTally = { total: number; matched: number; ambiguous: number; rejected: number; unknown: number; applied: number; failed: number; integrity_violations: number }

/** Bulk = the single-lead contract, once per lead. No Instagram-only step. */
export async function enrichMany(
  leadIds: number[],
  apply: boolean,
  post: EnrichFetch,
  onEach?: (o: EnrichOutcome) => void,
): Promise<{ outcomes: EnrichOutcome[]; tally: BulkTally }> {
  const outcomes: EnrichOutcome[] = []
  const tally: BulkTally = { total: leadIds.length, matched: 0, ambiguous: 0, rejected: 0, unknown: 0, applied: 0, failed: 0, integrity_violations: 0 }
  for (const id of leadIds) {
    let o: EnrichOutcome
    try {
      o = await enrichOne(id, apply, post)
    } catch (e) {
      o = { ...summarizeEnrich(id, { success: false, message: e instanceof Error ? e.message : String(e) }, apply), integrity_violation: null }
    }
    outcomes.push(o)
    if (!o.ok) tally.failed++
    else tally[o.status]++
    if (o.applied) tally.applied++
    if (o.integrity_violation && o.persisted) tally.integrity_violations++
    onEach?.(o)
  }
  return { outcomes, tally }
}

/** Human-readable lines for one outcome. */
export function formatOutcome(o: EnrichOutcome, apply: boolean): string[] {
  if (!o.ok) return [`✗ lead ${o.lead_id}: ${o.error}`]
  const lines: string[] = []
  const who = o.result_business ? ` — result: "${o.result_business}"` : ""
  lines.push(`lead ${o.lead_id}: guard ${o.status.toUpperCase()}${who}`)
  for (const r of o.reasons) lines.push(`    why: ${r}`)
  for (const e of o.evidence) lines.push(`    evidence: ${e}`)
  for (const c of o.proposed_changes) {
    const mark = o.applied_fields.includes(c.field) ? "applied" : c.action !== "set" ? "keep existing" : c.passes_guard ? "would apply" : "held"
    const src = c.provenance?.source_url ? `  ← ${c.provenance.source_url}` : ""
    const held = !c.passes_guard && c.guard_reason ? ` (${c.guard_reason})` : ""
    lines.push(`    ${c.field.padEnd(12)} ${String(c.value)}  [${mark}]${held}${src}`)
  }
  if (o.proposed_changes.length === 0) lines.push("    no changes proposed")
  if (o.integrity_violation) lines.push(`    ⚠ ${o.integrity_violation}`)
  if (apply) {
    if (o.applied) lines.push(`    ✓ applied ${o.applied_fields.length} field(s), provenance stored per field`)
    else lines.push(`    nothing applied${o.apply_refused_reason ? ` — ${o.apply_refused_reason}` : ""}`)
  } else {
    lines.push("    preview only — nothing saved." + (o.status === "matched" ? " Re-run with --apply to save the fields marked 'would apply'." : ""))
  }
  return lines
}

export const ENRICH_DESCRIBE =
  "research one lead (--id) or a bloq's leads (--bloq) with AI web research (LeadEnrichmentService; Instagram only as an extra source when the lead has a handle). Preview-only by default: shows proposed per-field changes and the entity guard's verdict, saves nothing. --apply saves only results the guard matched (name + location/domain/phone), field by field, with provenance."
