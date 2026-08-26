import { irisFetch } from "./iris-api"

/**
 * Cross-project mention search for people (#182461).
 *
 * `iris leads search` asked exactly one question — "is there a row in the CRM matching
 * this string?" — and reported its answer as though it were the answer to a different,
 * much bigger question: "do we know this person?"
 *
 * Those come apart the moment someone is real but was never entered as a lead. Tyler
 * Smith (Flo) is on the team and appears throughout bloq content; every lookup returned
 * "No leads matching", which reads as *we have nothing on them*. Richard Delgado
 * resolved only because a CRM row happened to exist (#15743) — not because the search
 * was any better at finding people.
 *
 * The correction is not a better fuzzy match on the leads table. It is to consult the
 * OTHER place people are written down — bloq item titles and content, across every
 * project — and to report both sources separately so the caller can tell which one
 * answered. A name found only in project content is a real finding, not a null result.
 *
 * DESIGN RULE, inherited from federated-search.ts and worth repeating: a source that
 * could not be consulted MUST be named. `searched: false` is not zero mentions. A
 * mention sweep whose HTTP call 500s and quietly returns [] is worse than none, because
 * "no mentions" would then be indistinguishable from "never looked".
 */

export interface MentionHit {
  itemId: number | string
  title: string
  bloqId: number | null
  bloqName: string | null
  listName: string | null
  when?: string
  snippet?: string
  /**
   * Lowercased title + flattened content, used to attribute a hit to a specific lead.
   * Carried on the hit rather than re-fetched, and never printed.
   */
  haystack: string
}

export interface MentionSearchResult {
  hits: MentionHit[]
  /** FALSE means the sweep did not run. Never render this as "0 mentions". */
  searched: boolean
  reason?: string
}

/** Where the evidence for a person came from. Named, not scored — see gradeEvidence. */
export type EvidenceSource = "crm+mentions" | "crm-only" | "crm-partial" | "mentions-only" | "none"

/**
 * How the CRM matched — and whether it matched the WHOLE query.
 *
 * `iris leads search "tyler smith"` falls back to searching one word at a time when the
 * full phrase returns nothing, and shows those partial hits. That is a reasonable thing
 * to do and a terrible thing to leave unlabelled: ten unrelated @tyler_* handles came
 * back looking exactly like answers to "tyler smith". A partial match must SAY it is
 * partial, or the fallback is just a confident wrong answer.
 */
export type CrmMatch = "exact" | "partial" | "none"

export interface Evidence {
  source: EvidenceSource
  mentions: number
  projects: string[]
  lastMentioned?: string
  /** One line explaining the label, so nobody has to guess what it measured. */
  why: string
}

/**
 * Flatten decoded bloq item content to searchable text.
 *
 * Item content is sometimes a JSON object (the page/card builders store structured
 * blocks), sometimes a plain string. Searching only the string form is how a name sitting
 * in a card's body went unfound while the API was matching it server-side.
 */
export function flattenContent(content: unknown, depth = 0): string {
  if (depth > 6 || content == null) return ""
  if (typeof content === "string") return content
  if (typeof content === "number" || typeof content === "boolean") return String(content)
  if (Array.isArray(content)) return content.map((c) => flattenContent(c, depth + 1)).join(" ")
  if (typeof content === "object") {
    return Object.values(content as Record<string, unknown>)
      .map((v) => flattenContent(v, depth + 1))
      .join(" ")
  }
  return ""
}

/** Tokens worth matching on. Sub-3-character fragments match everything and mean nothing. */
export function nameTokens(...parts: Array<string | null | undefined>): string[] {
  const raw = parts
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3)
  return [...new Set(raw)]
}

/**
 * Does this project mention refer to this lead?
 *
 * ALL name tokens must be present, or the email must be. A single shared surname
 * ("smith") attributed to whichever lead happened to come back first would be worse than
 * no attribution: it invents a link between a person and a document.
 */
export function hitMatchesLead(lead: Record<string, unknown>, hit: MentionHit): boolean {
  const email = String(lead.email ?? "").toLowerCase().trim()
  if (email && hit.haystack.includes(email)) return true

  const tokens = nameTokens(
    lead.name as string,
    lead.first_name as string,
    lead.last_name as string,
  )
  if (!tokens.length) return false
  return tokens.every((t) => hit.haystack.includes(t))
}

/**
 * Grade what we actually found, in terms of WHERE it came from.
 *
 * Deliberately a label and raw counts rather than a 0–100 score. A number implies a
 * calibrated model; this is two boolean sources and a count, and dressing that up as
 * "confidence: 72" would be the same false precision that has bitten every other
 * instrument in this repo. The counts are the evidence; the label is the summary.
 */
export function gradeEvidence(opts: {
  /** "partial" means the CRM matched only some of the query's words — see CrmMatch. */
  crm: CrmMatch
  hits: MentionHit[]
  /**
   * Did the project sweep actually RUN? Defaults to true because the sweep is on by
   * default, but `--crm-only`, a signed-out user and an HTTP failure all make it false.
   *
   * This exists because the first cut of this function got it wrong in the same way the
   * original bug did: with `--crm-only` it printed "nothing written about them in any
   * project" over a sweep that had never been performed. An unsearched source reported
   * as an empty one is the entire defect, and it does not stop being the defect when the
   * code asserting it is the fix.
   */
  mentionsSearched?: boolean
}): Evidence {
  const { crm, hits } = opts
  const mentionsSearched = opts.mentionsSearched ?? true
  const inCrm = crm !== "none"
  const projects = [...new Set(hits.map((h) => h.bloqName).filter((n): n is string => Boolean(n)))]
  const lastMentioned = hits
    .map((h) => h.when)
    .filter((w): w is string => Boolean(w))
    .sort()
    .pop()

  const mentions = hits.length
  // A partial CRM hit with corroborating mentions has earned "crm+mentions": the project
  // content matched EVERY name token, which is stronger evidence than the CRM fragment
  // that surfaced it. A partial hit with nothing behind it stays flagged as partial.
  const source: EvidenceSource =
    inCrm && mentions > 0
      ? "crm+mentions"
      : crm === "exact"
        ? "crm-only"
        : crm === "partial"
          ? "crm-partial"
          : mentions > 0
            ? "mentions-only"
            : "none"

  const projectLabel = projects.length === 1 ? "1 project" : `${projects.length} projects`

  // When the sweep did not run we can still say what the CRM found — we just may not say
  // anything about projects. "Not checked" and "checked, found nothing" are different
  // facts and must read differently.
  const unsearched = "project content was NOT searched — this is not the same as no mentions"
  const why = !mentionsSearched
    ? crm === "exact"
      ? `CRM record; ${unsearched}`
      : crm === "partial"
        ? `PARTIAL name match in the CRM — not all of your words matched; ${unsearched}`
        : `No CRM record; ${unsearched}`
    : source === "crm+mentions"
      ? `CRM record, plus ${mentions} mention(s) across ${projectLabel}`
      : source === "crm-only"
        ? "CRM record only — nothing written about them in any project"
        : source === "crm-partial"
          ? "PARTIAL name match only — the CRM matched some of your words, not all of them, and nothing in your projects mentions them"
          : source === "mentions-only"
            ? `No CRM record — ${mentions} mention(s) across ${projectLabel}`
            : "Nothing found in the CRM or in project content"

  return { source, mentions, projects, lastMentioned, why }
}

/** Pull ~60 characters either side of the first matching token, for context. */
function extractSnippet(text: string, tokens: string[]): string | undefined {
  if (!text) return undefined
  const lower = text.toLowerCase()
  let at = -1
  for (const t of tokens) {
    const i = lower.indexOf(t)
    if (i !== -1 && (at === -1 || i < at)) at = i
  }
  if (at === -1) at = 0
  const start = Math.max(0, at - 60)
  const slice = text.slice(start, start + 160).replace(/\s+/g, " ").trim()
  return (start > 0 ? "…" : "") + slice + (start + 160 < text.length ? "…" : "")
}

/**
 * Search every bloq the user owns for a name.
 *
 * Uses the CROSS-PROJECT endpoint (`bloqs/content-items`), which needs no bloq id. That
 * matters: federated search's bloq source required one and skipped itself with "no bloq
 * context" whenever it was absent, which is why there was no "search everything" path
 * for a person at all. Server-side matching ANDs the query's tokens, so "tyler smith"
 * finds "Tyler ... Smith" without the words being adjacent.
 */
export async function searchBloqMentions(
  query: string,
  userId: number,
  limit = 25,
): Promise<MentionSearchResult> {
  const tokens = nameTokens(query)
  try {
    const params = new URLSearchParams({ search: query, per_page: String(limit) })
    const res = await irisFetch(`/api/v1/user/${userId}/bloqs/content-items?${params}`)
    if (!res.ok) {
      return { hits: [], searched: false, reason: `HTTP ${res.status}` }
    }
    const data = (await res.json()) as any
    const rows: any[] = data?.data?.items ?? data?.items ?? data?.data ?? []
    if (!Array.isArray(rows)) return { hits: [], searched: true }

    const hits: MentionHit[] = rows.map((i) => {
      const title = String(i.title ?? "(untitled)")
      const body = flattenContent(i.content)
      return {
        itemId: i.id,
        title,
        bloqId: i.bloq_id ?? null,
        bloqName: i.bloq_name ?? null,
        listName: i.list_name ?? null,
        when: i.updated_at ?? i.created_at ?? undefined,
        snippet: extractSnippet(body || title, tokens),
        haystack: `${title} ${body}`.toLowerCase(),
      }
    })
    return { hits, searched: true }
  } catch (e: any) {
    return { hits: [], searched: false, reason: String(e?.message ?? e).slice(0, 120) }
  }
}

/** Group hits by the project they live in, largest first — how a person reads them. */
export function groupByProject(hits: MentionHit[]): Array<{ bloqId: number | null; bloqName: string; hits: MentionHit[] }> {
  const byKey = new Map<string, { bloqId: number | null; bloqName: string; hits: MentionHit[] }>()
  for (const h of hits) {
    const key = String(h.bloqId ?? h.bloqName ?? "unknown")
    if (!byKey.has(key)) {
      byKey.set(key, { bloqId: h.bloqId, bloqName: h.bloqName ?? "Unknown project", hits: [] })
    }
    byKey.get(key)!.hits.push(h)
  }
  return [...byKey.values()].sort((a, b) => b.hits.length - a.hits.length)
}
