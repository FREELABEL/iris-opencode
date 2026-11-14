// Pure helpers for `iris segment` (#193484): --filter parsing and the breakdown / members tables.
// No network, no process state — everything here is unit-tested in segment-core.test.ts.
//
// A segment is a saved filter over one board's leads (fl-api SomSegment). The keys and their
// types mirror fl-api App\Services\Segments\SegmentFilters::KEYS, in the same order — the
// order the server's breakdown walks. The server is the authority (it refuses unknown keys
// with a 422); this copy exists so a typo fails before a network call, with the allowed list.

export type FilterType = "string" | "list" | "bool" | "int"

export const FILTER_KEYS: Record<string, FilterType> = {
  source_post: "string",
  comment_contains: "string",
  discovery_mode: "string",
  status_in: "list",
  replied: "bool",
  contacted: "bool",
  niche_in: "list",
  role_in: "list",
  city_contains: "string",
  followers_min: "int",
  followers_max: "int",
  has_email: "bool",
}

export type Filters = Record<string, string | string[] | boolean | number>

export class FilterError extends Error {}

/** "https://www.instagram.com/p/De9Uw8Ilhne/" -> "De9Uw8Ilhne"; a bare shortcode is kept. */
export function shortcode(value: string): string {
  const m = value.trim().match(/\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/)
  return m ? m[1] : value.trim().replace(/^\/+|\/+$/g, "")
}

/** "5k" -> 5000, "1.2m" -> 1200000, "40,000" -> 40000. Whole numbers >= 0 only. */
export function parseCount(raw: string, key: string): number {
  const s = raw.trim().toLowerCase().replace(/,/g, "").replace(/_/g, "")
  const m = s.match(/^(\d+(?:\.\d+)?)([km]?)$/)
  if (!m) throw new FilterError(`${key} must be a whole number (e.g. 5000 or 5k), got "${raw}"`)
  const n = Number(m[1]) * (m[2] === "k" ? 1_000 : m[2] === "m" ? 1_000_000 : 1)
  if (!Number.isInteger(n) || n < 0) throw new FilterError(`${key} must be a whole number, got "${raw}"`)
  return n
}

export function parseBool(raw: string, key: string): boolean {
  const s = raw.trim().toLowerCase()
  if (["true", "yes", "y", "1", "on"].includes(s)) return true
  if (["false", "no", "n", "0", "off"].includes(s)) return false
  throw new FilterError(`${key} must be true or false, got "${raw}"`)
}

/** One value, typed by its key. */
export function coerceFilter(key: string, raw: unknown): string | string[] | boolean | number {
  const type = FILTER_KEYS[key]
  if (!type) throw new FilterError(unknownKeyMessage([key]))
  switch (type) {
    case "string": {
      if (typeof raw !== "string" && typeof raw !== "number") throw new FilterError(`${key} must be text`)
      const s = String(raw).trim()
      if (!s) throw new FilterError(`${key} is empty`)
      return key === "source_post" ? shortcode(s) : s
    }
    case "list": {
      const items = Array.isArray(raw) ? raw.map(String) : String(raw).split(",")
      const list = [...new Set(items.map((v) => v.trim()).filter(Boolean))]
      if (list.length === 0) throw new FilterError(`${key} needs at least one value`)
      return list
    }
    case "bool":
      return typeof raw === "boolean" ? raw : parseBool(String(raw), key)
    case "int":
      return parseCount(String(raw), key)
  }
}

export function unknownKeyMessage(keys: string[]): string {
  return `Unknown filter key(s): ${keys.join(", ")}. Allowed: ${Object.keys(FILTER_KEYS).join(", ")}`
}

/**
 * `--filter key=value` flags -> a filters object. A bare boolean key (`--filter replied`)
 * means true. Later flags win over earlier ones and over `base` (a --filters-file object).
 * Values are split on the FIRST "=", so a comment filter can contain "=".
 */
export function parseFilterArgs(flags: readonly string[] | undefined, base: Record<string, unknown> = {}): Filters {
  const out: Filters = {}
  const unknown = Object.keys(base).filter((k) => !FILTER_KEYS[k])
  if (unknown.length) throw new FilterError(unknownKeyMessage(unknown))
  for (const [k, v] of Object.entries(base)) {
    if (v === null || v === undefined) continue
    out[k] = coerceFilter(k, v)
  }
  for (const flag of flags ?? []) {
    const eq = flag.indexOf("=")
    const key = (eq === -1 ? flag : flag.slice(0, eq)).trim()
    if (!FILTER_KEYS[key]) throw new FilterError(unknownKeyMessage([key]))
    if (eq === -1) {
      if (FILTER_KEYS[key] !== "bool") throw new FilterError(`--filter ${key} needs a value: --filter ${key}=…`)
      out[key] = true
      continue
    }
    out[key] = coerceFilter(key, flag.slice(eq + 1))
  }
  if (typeof out.followers_min === "number" && typeof out.followers_max === "number" && out.followers_min > out.followers_max) {
    throw new FilterError("followers_min is greater than followers_max")
  }
  return orderFilters(out)
}

/** Filters in the server's breakdown order, so what you see is the order it shrinks in. */
export function orderFilters(f: Filters): Filters {
  const out: Filters = {}
  for (const k of Object.keys(FILTER_KEYS)) if (k in f) out[k] = f[k]
  return out
}

/** `segment update`: current filters, plus --filter flags, minus --unset keys. */
export function mergeFilters(current: Filters, changes: Filters, unset: readonly string[] = []): Filters {
  const bad = unset.filter((k) => !FILTER_KEYS[k])
  if (bad.length) throw new FilterError(unknownKeyMessage(bad))
  const out: Filters = { ...current, ...changes }
  for (const k of unset) delete out[k]
  return orderFilters(out)
}

// ─── rendering ───────────────────────────────────────────────────────────────

export interface BreakdownStep {
  key: string
  value: unknown
  before: number
  known: number
  unknown: number
  matched: number
  of: number
  known_in_board: number
  field_always_known: boolean
}

export interface Breakdown {
  of: number
  matched: number
  steps: BreakdownStep[]
}

export interface MemberRow {
  id: number
  handle: string | null
  name: string | null
  status: string | null
  comment: string | null
  source_post_url: string | null
  niche: string | null
  role: string | null
  city: string | null
  followers: number | null
}

export function fmtNum(n: number): string {
  return n.toLocaleString("en-US")
}

export function fmtValue(v: unknown): string {
  if (Array.isArray(v)) return v.join(", ")
  return String(v)
}

function pad(s: string, w: number): string {
  return s.length >= w ? s : s + " ".repeat(w - s.length)
}

function padL(s: string, w: number): string {
  return s.length >= w ? s : " ".repeat(w - s.length) + s
}

function clip(s: string, w: number): string {
  return s.length <= w ? s : s.slice(0, Math.max(0, w - 1)) + "…"
}

/**
 * One honest line per step. The rule (#193484): a count over a field most leads do not have
 * must say how many it could judge. "0 match" is never printed where the truth is "we do not
 * know for 6,046".
 */
export function stepNote(s: BreakdownStep): string | null {
  if (s.field_always_known || s.unknown === 0) return null
  if (s.known === 0) {
    return `${s.key}: no lead that reached this filter has this field (${fmtNum(s.before)} unknown) — it cannot be judged yet, not "0 match"`
  }
  return `${s.key}: ${fmtNum(s.matched)} match among ${fmtNum(s.known)} known — unknown for ${fmtNum(s.unknown)} (not counted, never treated as 0)`
}

/** The filter-by-filter table: watch the count shrink. Plain text; the caller adds colour. */
export function renderBreakdown(b: Breakdown): string[] {
  const lines: string[] = []
  const header = `  ${pad("#", 3)}${pad("filter", 18)}${pad("value", 26)}${padL("before", 9)}${padL("known", 9)}${padL("unknown", 9)}${padL("matched", 9)}`
  lines.push(header)
  lines.push(`  ${pad("", 3)}${pad("(board)", 18)}${pad("", 26)}${padL("", 9)}${padL("", 9)}${padL("", 9)}${padL(fmtNum(b.of), 9)}`)
  b.steps.forEach((s, i) => {
    const known = s.field_always_known ? "all" : fmtNum(s.known)
    const unknown = s.field_always_known ? "-" : fmtNum(s.unknown)
    lines.push(
      `  ${pad(String(i + 1), 3)}${pad(s.key, 18)}${pad(clip(fmtValue(s.value), 25), 26)}${padL(fmtNum(s.before), 9)}${padL(known, 9)}${padL(unknown, 9)}${padL(fmtNum(s.matched), 9)}`,
    )
  })
  // Leads dropped because a filter could not judge them are not "non-matches". Say how many,
  // on the summary line itself, so "0 of 6,050" is never read alone.
  const unjudged = b.steps.filter((s) => !s.field_always_known && s.unknown > 0)
  const dropped = unjudged.reduce((n, s) => n + s.unknown, 0)
  lines.push(
    dropped > 0
      ? `  → ${fmtNum(b.matched)} of ${fmtNum(b.of)} leads match on what is known — ${fmtNum(dropped)} more could not be judged (${unjudged.map((s) => s.key).join(", ")} unknown)`
      : `  → ${fmtNum(b.matched)} of ${fmtNum(b.of)} leads match`,
  )
  for (const s of b.steps) {
    const n = stepNote(s)
    if (n) lines.push(`  ! ${n}`)
  }
  return lines
}

export function renderMembers(rows: MemberRow[]): string[] {
  if (rows.length === 0) return ["  (no members)"]
  const lines = [`  ${pad("id", 8)}${pad("handle", 24)}${pad("status", 12)}${padL("followers", 10)}  ${pad("niche", 16)}comment`]
  for (const r of rows) {
    lines.push(
      `  ${pad(String(r.id), 8)}${pad(clip(r.handle ? "@" + r.handle : r.name ?? "?", 23), 24)}${pad(clip(r.status ?? "", 11), 12)}${padL(r.followers === null ? "?" : fmtNum(r.followers), 10)}  ${pad(clip(r.niche ?? "", 15), 16)}${clip((r.comment ?? "").replace(/\s+/g, " "), 40)}`,
    )
  }
  return lines
}

/**
 * What `--watch` compares between polls. Counts, filters and name only — a timestamp or
 * member order changing is not a change worth redrawing for.
 */
export function watchSignature(seg: { name?: string; filters?: unknown; breakdown?: Breakdown | null }): string {
  const b = seg.breakdown
  return JSON.stringify({
    name: seg.name ?? null,
    filters: seg.filters ?? null,
    of: b?.of ?? null,
    matched: b?.matched ?? null,
    steps: (b?.steps ?? []).map((s) => [s.key, s.before, s.known, s.matched]),
  })
}
