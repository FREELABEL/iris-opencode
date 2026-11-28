/**
 * audience.v1 — who a brand sells to (#194610). ONE definition: the types, the allowed values, an
 * empty template, the validator and a one-line summary per segment.
 *
 * Stored on the brand as `brand.metadata.audience` (fl-api brands.metadata is already JSON, so there
 * is no migration). Agents, campaigns, pages and ads read the same shape, so this file is the
 * contract. It has no imports on purpose: the SAME FILE is copied, byte for byte, to
 *
 *   iris/1.18.23  packages/opencode/src/iris/brand-audience.ts                  (engine)
 *   iris/1.18.23  packages/app/src/components/session/iris-brand-audience-schema.ts (Desktop editor)
 *   main          packages/opencode/src/cli/cmd/brand-audience.ts               (CLI)
 *
 * Change one, copy it to all three. On iris/1.18.23 a test fails when the two copies differ.
 *
 * Naming: a brand's older "personas" are its AI VOICE (tone, system prompt, hashtags) and are shown
 * to people as "Voices". The customer profiles here are SEGMENTS, and a segment may carry 1–3
 * example PERSONAS (named, made-up people).
 */

export const AUDIENCE_SCHEMA = "audience.v1"

/** Every closed list. Fields agents filter on are enums so "25-34" means the same thing everywhere. */
export const AUDIENCE_ENUMS = {
  priority: ["primary", "secondary", "emerging"],
  market: ["b2b", "b2c", "b2b2c"],
  age_band: ["18-24", "25-34", "35-44", "45-54", "55-64", "65+"],
  gender_skew: ["even", "mostly_women", "mostly_men", "n/a"],
  settlement: ["urban", "suburban", "rural"],
  income_band: ["<35k", "35-75k", "75-150k", "150-300k", "300k+"],
  education: ["high_school", "some_college", "bachelors", "graduate", "n/a"],
  household: ["single", "couple", "kids_at_home", "empty_nest", "multigenerational"],
  seniority: ["owner", "exec", "manager", "ic"],
  company_size: ["solo", "2-10", "11-50", "51-200", "201-1000", "1000+"],
  revenue_band: ["<250k", "250k-1M", "1-10M", "10-50M", "50M+"],
  tech_maturity: ["low", "medium", "high"],
  price_sensitivity: ["low", "medium", "high"],
  decision: ["self", "with_partner", "committee"],
  cycle: ["impulse", "days", "weeks", "months"],
  confidence: ["assumed", "observed", "validated"],
} as const

export type AudienceEnum = keyof typeof AUDIENCE_ENUMS
export type EnumValue<K extends AudienceEnum> = (typeof AUDIENCE_ENUMS)[K][number]

export type Priority = EnumValue<"priority">
export type Market = EnumValue<"market">
export type AgeBand = EnumValue<"age_band">
export type Confidence = EnumValue<"confidence">

export interface Demographics {
  /** Several may apply. */
  age_band?: AgeBand[]
  gender_skew?: EnumValue<"gender_skew">
  /** Countries, regions, metros. */
  locations?: string[]
  settlement?: EnumValue<"settlement">[]
  /** ISO 639 codes: en, es, pt-BR. */
  languages?: string[]
  /** B2C. In local currency. */
  income_band?: EnumValue<"income_band">
  education?: EnumValue<"education">
  household?: EnumValue<"household">
}

/** B2B only — shown when the segment's market includes b2b. */
export interface Firmographics {
  role?: string
  seniority?: EnumValue<"seniority">
  industry?: string[]
  company_size?: EnumValue<"company_size">
  revenue_band?: EnumValue<"revenue_band">
  tech_maturity?: EnumValue<"tech_maturity">
}

export interface Psychographics {
  values?: string[]
  motivations?: string[]
  frustrations?: string[]
  fears?: string[]
  /** One line: "I'm the one who makes things happen". */
  self_image?: string
}

export interface DayInLife {
  routine?: { morning?: string; work?: string; evening?: string }
  tools_they_use?: string[]
  media?: string[]
  where_they_hang_out?: string[]
  /** "weekday mornings, 7–9am local". */
  best_time_to_reach?: string
}

/** A job to be done: When <trigger>, they want to <job>, so they can <outcome>. Today they use <current fix>. */
export interface Job {
  when?: string
  want_to?: string
  so_they_can?: string
  today_they_use?: string
}

export interface Buying {
  what_they_buy?: string[]
  /** Typical spend, in words: "$50–150 a month". */
  budget?: string
  price_sensitivity?: EnumValue<"price_sensitivity">
  buying_triggers?: string[]
  objections?: string[]
  decision?: EnumValue<"decision">
  /** Who influences the decision. */
  influencers?: string[]
  where_they_buy?: string[]
  cycle?: EnumValue<"cycle">
}

export interface Interests {
  hobbies?: string[]
  topics?: string[]
  communities?: string[]
  follows?: string[]
}

export interface Messaging {
  resonates?: string[]
  words_to_use?: string[]
  words_to_avoid?: string[]
  proof_they_need?: string[]
  best_cta?: string
  best_channels?: string[]
}

export interface Evidence {
  /** Required: how sure we are. */
  confidence: Confidence
  /** "Interviews, 2026-11 (5 people)", "CRM export 2026-10". */
  sources?: string[]
  /** YYYY-MM-DD. */
  last_reviewed?: string
}

/** An example person inside a segment (1–3 per segment). Made up, never a real customer's data. */
export interface Persona {
  name: string
  photo?: string
  age?: number
  role?: string
  quote?: string
  typical_tuesday?: string
  goals?: string[]
  frustrations?: string[]
  what_would_make_them_switch?: string
}

export interface Segment {
  /** Stable short id ("solo-agency-owner") — what brand-level use cases point at. */
  id?: string
  name: string
  summary?: string
  priority?: Priority
  market?: Market
  /** Rough % of customers or revenue, 0–100. */
  share?: number
  demographics?: Demographics
  firmographics?: Firmographics
  psychographics?: Psychographics
  day_in_life?: DayInLife
  jobs?: Job[]
  buying?: Buying
  interests?: Interests
  messaging?: Messaging
  evidence: Evidence
  personas?: Persona[]
}

export interface BrandUseCase {
  name: string
  /** Segment ids (or names) it is for. */
  for_segments?: string[]
  problem?: string
  how_we_solve_it?: string
  outcome_metric?: string
  example?: string
}

/** Who we deliberately do not target, and why. */
export interface NotFor {
  who: string
  why?: string
}

export interface Positioning {
  /** One sentence. */
  statement?: string
  category?: string
  /** What they would use instead of us. */
  alternatives?: string[]
}

export interface Audience {
  schema: typeof AUDIENCE_SCHEMA
  segments: Segment[]
  use_cases?: BrandUseCase[]
  not_for?: NotFor[]
  positioning?: Positioning
}

// ── the field spec: drives the validator, the template, and the editor's labels ─────────────────

export type FieldKind = "text" | "list" | "enum" | "enums" | "number" | "date" | "url" | "routine"
export interface FieldSpec {
  key: string
  kind: FieldKind
  enum?: AudienceEnum
  required?: boolean
  min?: number
  max?: number
  /** One line for the template and for agents; the Desktop has its own translated labels. */
  hint: string
}

export type SegmentGroupKey =
  | "identity"
  | "demographics"
  | "firmographics"
  | "psychographics"
  | "day_in_life"
  | "jobs"
  | "buying"
  | "interests"
  | "messaging"
  | "evidence"
  | "personas"

export interface GroupSpec {
  key: SegmentGroupKey
  /** identity: fields sit on the segment itself. jobs / personas: a list of objects. */
  shape: "flat" | "object" | "rows"
  /** Firmographics: only when the market includes b2b. */
  when?: "b2b"
  fields: FieldSpec[]
}

const f = (key: string, kind: FieldKind, hint: string, more: Partial<FieldSpec> = {}): FieldSpec => ({ key, kind, hint, ...more })

export const SEGMENT_GROUPS: GroupSpec[] = [
  {
    key: "identity",
    shape: "flat",
    fields: [
      f("id", "text", "stable short id, e.g. solo-agency-owner (use cases point at it)"),
      f("name", "text", 'who they are, e.g. "Solo agency owner"', { required: true }),
      f("summary", "text", "one sentence about them"),
      f("priority", "enum", "how much this segment matters now", { enum: "priority" }),
      f("market", "enum", "how we sell to them", { enum: "market" }),
      f("share", "number", "rough % of customers or revenue, 0-100", { min: 0, max: 100 }),
    ],
  },
  {
    key: "demographics",
    shape: "object",
    fields: [
      f("age_band", "enums", "one or more age bands", { enum: "age_band" }),
      f("gender_skew", "enum", "who they mostly are", { enum: "gender_skew" }),
      f("locations", "list", "countries, regions or metros"),
      f("settlement", "enums", "where they live", { enum: "settlement" }),
      f("languages", "list", "ISO codes, e.g. en, es, pt-BR"),
      f("income_band", "enum", "B2C: household income, local currency", { enum: "income_band" }),
      f("education", "enum", "highest education", { enum: "education" }),
      f("household", "enum", "who they live with", { enum: "household" }),
    ],
  },
  {
    key: "firmographics",
    shape: "object",
    when: "b2b",
    fields: [
      f("role", "text", "their job title"),
      f("seniority", "enum", "how senior", { enum: "seniority" }),
      f("industry", "list", "industries"),
      f("company_size", "enum", "people at the company", { enum: "company_size" }),
      f("revenue_band", "enum", "the company's yearly revenue", { enum: "revenue_band" }),
      f("tech_maturity", "enum", "how comfortable they are with software", { enum: "tech_maturity" }),
    ],
  },
  {
    key: "psychographics",
    shape: "object",
    fields: [
      f("values", "list", 'what they care about ("independence")'),
      f("motivations", "list", 'what drives them ("look professional")'),
      f("frustrations", "list", "what annoys them"),
      f("fears", "list", "what worries them"),
      f("self_image", "text", `one line: "I'm the one who makes things happen"`),
    ],
  },
  {
    key: "day_in_life",
    shape: "object",
    fields: [
      f("routine", "routine", "morning, work and evening: one line each"),
      f("tools_they_use", "list", "apps and products they use every day"),
      f("media", "list", "podcasts, newsletters, creators, publications"),
      f("where_they_hang_out", "list", "platforms, communities, events, places"),
      f("best_time_to_reach", "text", 'e.g. "weekday mornings, 7-9am local"'),
    ],
  },
  {
    key: "jobs",
    shape: "rows",
    fields: [
      f("when", "text", "the trigger"),
      f("want_to", "text", "the job they want done"),
      f("so_they_can", "text", "the outcome"),
      f("today_they_use", "text", "what they use for it today"),
    ],
  },
  {
    key: "buying",
    shape: "object",
    fields: [
      f("what_they_buy", "list", "categories and brands they already pay for"),
      f("budget", "text", 'typical spend, e.g. "$50-150 a month"'),
      f("price_sensitivity", "enum", "how much price decides it", { enum: "price_sensitivity" }),
      f("buying_triggers", "list", "what makes them buy now"),
      f("objections", "list", "why they say no"),
      f("decision", "enum", "who decides", { enum: "decision" }),
      f("influencers", "list", "who influences them"),
      f("where_they_buy", "list", "online, retail, sales call, marketplace"),
      f("cycle", "enum", "how long they take to decide", { enum: "cycle" }),
    ],
  },
  {
    key: "interests",
    shape: "object",
    fields: [
      f("hobbies", "list", "what they do for fun"),
      f("topics", "list", "what they read and talk about"),
      f("communities", "list", "groups they belong to"),
      f("follows", "list", "people and accounts they follow"),
    ],
  },
  {
    key: "messaging",
    shape: "object",
    fields: [
      f("resonates", "list", "angles that work"),
      f("words_to_use", "list", "words that land"),
      f("words_to_avoid", "list", "words that put them off"),
      f("proof_they_need", "list", "testimonials, numbers, demos, guarantees"),
      f("best_cta", "text", "the call to action that works best"),
      f("best_channels", "list", "where to reach them"),
    ],
  },
  {
    key: "evidence",
    shape: "object",
    fields: [
      f("confidence", "enum", "assumed, observed or validated", { enum: "confidence", required: true }),
      f("sources", "list", 'where this comes from, with dates: "Interviews, 2026-11 (5 people)"'),
      f("last_reviewed", "date", "YYYY-MM-DD"),
    ],
  },
  {
    key: "personas",
    shape: "rows",
    fields: [
      f("name", "text", "a made-up name", { required: true }),
      f("photo", "url", "an image URL"),
      f("age", "number", "their age", { min: 0, max: 120 }),
      f("role", "text", "what they do"),
      f("quote", "text", "something they would say"),
      f("typical_tuesday", "text", "a typical Tuesday, in a few lines"),
      f("goals", "list", "what they want"),
      f("frustrations", "list", "what gets in their way"),
      f("what_would_make_them_switch", "text", "what would make them switch to us"),
    ],
  },
]

export const USE_CASE_FIELDS: FieldSpec[] = [
  f("name", "text", "the use case", { required: true }),
  f("for_segments", "list", "segment ids it is for"),
  f("problem", "text", "the problem"),
  f("how_we_solve_it", "text", "how we solve it"),
  f("outcome_metric", "text", "the number that moves"),
  f("example", "text", "a real-sounding example"),
]
export const NOT_FOR_FIELDS: FieldSpec[] = [
  f("who", "text", "who we deliberately don't target", { required: true }),
  f("why", "text", "why not"),
]
export const POSITIONING_FIELDS: FieldSpec[] = [
  f("statement", "text", "one sentence"),
  f("category", "text", "our category"),
  f("alternatives", "list", "what they'd use instead of us"),
]

/** Firmographics apply to B2B and B2B2C segments; a segment with no market yet shows them too. */
export const isB2b = (market: unknown) => market == null || market === "" || market === "b2b" || market === "b2b2c"

// ── templates ─────────────────────────────────────────────────────────────────────────────────

export function emptyAudience(): Audience {
  return { schema: AUDIENCE_SCHEMA, segments: [], use_cases: [], not_for: [], positioning: {} }
}

export function emptySegment(name = ""): Segment {
  return { id: slugify(name) || undefined, name, evidence: { confidence: "assumed" } }
}

export function emptyPersona(name = ""): Persona {
  return { name }
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
}

/** An id no other segment has — "studio-leads", then "studio-leads-2". */
export function uniqueSegmentId(name: string, taken: Iterable<string | undefined>): string {
  const used = new Set([...taken].filter(Boolean))
  const base = slugify(name) || "segment"
  if (!used.has(base)) return base
  for (let n = 2; ; n++) if (!used.has(`${base}-${n}`)) return `${base}-${n}`
}

// ── validation ────────────────────────────────────────────────────────────────────────────────

export type AudienceIssueCode = "required" | "type" | "enum" | "range" | "date" | "url" | "unknown" | "reference" | "schema" | "language"
export interface AudienceIssue {
  /** Where: "segments[0].demographics.age_band[1]". */
  path: string
  message: string
  code: AudienceIssueCode
}
export interface AudienceValidation {
  ok: boolean
  errors: AudienceIssue[]
  /** Unknown keys, odd language codes, use cases pointing at no segment. Saved anyway. */
  warnings: AudienceIssue[]
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)
const DATE = /^\d{4}-\d{2}-\d{2}$/
const LANG = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/

function checkField(spec: FieldSpec, v: unknown, path: string, out: AudienceValidation) {
  const err = (code: AudienceIssueCode, message: string, at = path) => out.errors.push({ path: at, code, message })
  if (v === undefined || v === null || v === "") {
    if (spec.required) err("required", `${spec.key} is required`)
    return
  }
  switch (spec.kind) {
    case "text":
      if (typeof v !== "string") err("type", `${spec.key} must be text`)
      else if (spec.required && !v.trim()) err("required", `${spec.key} is required`)
      return
    case "url":
      if (typeof v !== "string" || !/^https?:\/\/\S+$/i.test(v.trim())) err("url", `${spec.key} must be an http(s) URL`)
      return
    case "date":
      if (typeof v !== "string" || !DATE.test(v) || Number.isNaN(Date.parse(v))) err("date", `${spec.key} must be a date, YYYY-MM-DD`)
      return
    case "number":
      if (typeof v !== "number" || !Number.isFinite(v)) return err("type", `${spec.key} must be a number`)
      if ((spec.min != null && v < spec.min) || (spec.max != null && v > spec.max)) err("range", `${spec.key} must be between ${spec.min} and ${spec.max}`)
      return
    case "list":
      if (!Array.isArray(v)) return err("type", `${spec.key} must be a list of text`)
      v.forEach((x, i) => {
        if (typeof x !== "string") err("type", `${spec.key} must be a list of text`, `${path}[${i}]`)
        else if (spec.key === "languages" && !LANG.test(x.trim()))
          out.warnings.push({ path: `${path}[${i}]`, code: "language", message: `"${x}" is not an ISO language code (en, es, pt-BR)` })
      })
      return
    case "enum": {
      const allowed = AUDIENCE_ENUMS[spec.enum!] as readonly string[]
      if (typeof v !== "string" || !allowed.includes(v)) err("enum", `${spec.key} must be one of: ${allowed.join(", ")}`)
      return
    }
    case "enums": {
      const allowed = AUDIENCE_ENUMS[spec.enum!] as readonly string[]
      if (!Array.isArray(v)) return err("type", `${spec.key} must be a list of: ${allowed.join(", ")}`)
      v.forEach((x, i) => {
        if (typeof x !== "string" || !allowed.includes(x)) err("enum", `${spec.key} must be one of: ${allowed.join(", ")}`, `${path}[${i}]`)
      })
      return
    }
    case "routine": {
      if (!isObj(v)) return err("type", `${spec.key} must have morning, work and evening`)
      for (const [k, x] of Object.entries(v)) {
        if (!["morning", "work", "evening"].includes(k)) out.warnings.push({ path: `${path}.${k}`, code: "unknown", message: `"${k}" is not part of a routine (morning, work, evening)` })
        else if (x != null && typeof x !== "string") err("type", `${k} must be text`, `${path}.${k}`)
      }
      return
    }
  }
}

function checkObject(v: unknown, fields: FieldSpec[], path: string, out: AudienceValidation, what: string, skip: string[] = []) {
  if (!isObj(v)) {
    out.errors.push({ path, code: "type", message: `${what} must be an object` })
    return
  }
  const known = new Set([...fields.map((x) => x.key), ...skip])
  for (const spec of fields) checkField(spec, v[spec.key], `${path}.${spec.key}`, out)
  for (const k of Object.keys(v)) if (!known.has(k)) out.warnings.push({ path: `${path}.${k}`, code: "unknown", message: `"${k}" is not an audience.v1 field; it is kept` })
}

function checkRows(v: unknown, fields: FieldSpec[], path: string, out: AudienceValidation, what: string) {
  if (v === undefined || v === null) return
  if (!Array.isArray(v)) {
    out.errors.push({ path, code: "type", message: `${what} must be a list` })
    return
  }
  v.forEach((row, i) => checkObject(row, fields, `${path}[${i}]`, out, what))
}

/**
 * Check a value against audience.v1. Errors stop a save; warnings do not (unknown keys are kept, so
 * a newer writer's extra fields survive an older reader's save).
 */
export function validateAudience(x: unknown): AudienceValidation {
  const out: AudienceValidation = { ok: true, errors: [], warnings: [] }
  if (!isObj(x)) {
    out.errors.push({ path: "", code: "type", message: "the audience must be an object" })
    out.ok = false
    return out
  }
  if (x.schema !== AUDIENCE_SCHEMA)
    out.errors.push({ path: "schema", code: "schema", message: `schema must be "${AUDIENCE_SCHEMA}"${x.schema == null ? "" : `, not ${JSON.stringify(x.schema)}`}` })
  const top = new Set(["schema", "segments", "use_cases", "not_for", "positioning"])
  for (const k of Object.keys(x)) if (!top.has(k)) out.warnings.push({ path: k, code: "unknown", message: `"${k}" is not an audience.v1 field; it is kept` })

  const segments = x.segments
  if (segments === undefined) out.errors.push({ path: "segments", code: "required", message: "segments is required (an empty list is fine)" })
  else if (!Array.isArray(segments)) out.errors.push({ path: "segments", code: "type", message: "segments must be a list" })
  else
    segments.forEach((s, i) => {
      const at = `segments[${i}]`
      if (!isObj(s)) return out.errors.push({ path: at, code: "type", message: "a segment must be an object" })
      const identity = SEGMENT_GROUPS.find((g) => g.key === "identity")!
      const groupKeys = SEGMENT_GROUPS.filter((g) => g.shape !== "flat").map((g) => g.key)
      checkObject(s, identity.fields, at, out, "a segment", groupKeys)
      for (const g of SEGMENT_GROUPS) {
        if (g.shape === "flat") continue
        const v = s[g.key]
        if (g.key === "evidence") {
          if (v === undefined || v === null)
            out.errors.push({ path: `${at}.evidence.confidence`, code: "required", message: "confidence is required (assumed, observed or validated)" })
          else checkObject(v, g.fields, `${at}.evidence`, out, "evidence")
          continue
        }
        if (v === undefined || v === null) continue
        if (g.shape === "rows") checkRows(v, g.fields, `${at}.${g.key}`, out, g.key === "jobs" ? "a use case" : "a persona")
        else checkObject(v, g.fields, `${at}.${g.key}`, out, g.key)
      }
    })

  const ids = Array.isArray(segments) ? segments.filter(isObj).flatMap((s) => [s.id, s.name].filter((v): v is string => typeof v === "string")) : []
  if (Array.isArray(segments)) {
    const seen = new Map<string, number>()
    segments.forEach((s, i) => {
      if (!isObj(s) || typeof s.id !== "string" || !s.id) return
      if (seen.has(s.id)) out.errors.push({ path: `segments[${i}].id`, code: "reference", message: `two segments share the id "${s.id}"` })
      seen.set(s.id, i)
    })
  }
  checkRows(x.use_cases, USE_CASE_FIELDS, "use_cases", out, "a use case")
  if (Array.isArray(x.use_cases))
    x.use_cases.forEach((u, i) => {
      if (!isObj(u) || !Array.isArray(u.for_segments)) return
      u.for_segments.forEach((ref, j) => {
        if (typeof ref === "string" && !ids.includes(ref))
          out.warnings.push({ path: `use_cases[${i}].for_segments[${j}]`, code: "reference", message: `no segment is called "${ref}"` })
      })
    })
  checkRows(x.not_for, NOT_FOR_FIELDS, "not_for", out, "a not-for entry")
  if (x.positioning !== undefined && x.positioning !== null) checkObject(x.positioning, POSITIONING_FIELDS, "positioning", out, "positioning")

  out.ok = out.errors.length === 0
  return out
}

// ── reading and storing ───────────────────────────────────────────────────────────────────────

/**
 * Whatever is stored (or nothing) → a full Audience the editor can bind to: every group present,
 * lists as lists. Unknown keys are kept. Never throws.
 */
export function normalizeAudience(x: unknown): Audience {
  const src = isObj(x) ? (JSON.parse(JSON.stringify(x)) as Record<string, any>) : {}
  const list = (v: unknown) => (Array.isArray(v) ? v : [])
  const obj = (v: unknown) => (isObj(v) ? v : {})
  const segments = list(src.segments).filter(isObj).map((s: Record<string, any>) => {
    const seg: Record<string, any> = { ...s, name: typeof s.name === "string" ? s.name : "" }
    for (const g of SEGMENT_GROUPS) {
      if (g.shape === "flat") continue
      if (g.shape === "rows") seg[g.key] = list(s[g.key]).filter(isObj)
      else seg[g.key] = obj(s[g.key])
    }
    if (!seg.evidence.confidence) seg.evidence.confidence = "assumed"
    seg.day_in_life.routine = obj(seg.day_in_life.routine)
    return seg as Segment
  })
  return {
    ...src,
    schema: AUDIENCE_SCHEMA,
    segments,
    use_cases: list(src.use_cases).filter(isObj) as unknown as BrandUseCase[],
    not_for: list(src.not_for).filter(isObj) as unknown as NotFor[],
    positioning: obj(src.positioning) as Positioning,
  }
}

/** Empty text, empty lists and empty objects dropped (recursively), text trimmed. Nothing is added. */
function pruneValue(v: unknown): unknown {
  if (typeof v === "string") return v.trim() === "" ? undefined : v.trim()
  if (Array.isArray(v)) {
    const out = v.map(pruneValue).filter((x) => x !== undefined)
    return out.length ? out : undefined
  }
  if (isObj(v)) {
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v)) {
      const p = pruneValue(x)
      if (p !== undefined) out[k] = p
    }
    return Object.keys(out).length ? out : undefined
  }
  return v === null ? undefined : v
}

/**
 * A file as someone filled it in (the template, half done) → what is checked and stored: empty
 * fields, rows and groups are dropped, so an untouched template row is not an error. Nothing is
 * added — a segment without a confidence still fails validation.
 */
export function cleanAudienceInput(x: unknown): unknown {
  if (!isObj(x)) return x
  const out = (pruneValue(x) as Record<string, unknown> | undefined) ?? {}
  if (Array.isArray(x.segments) && out.segments === undefined) out.segments = []
  return out
}

/**
 * What the editor stores: empty text, empty lists and empty groups dropped, text trimmed, so a
 * saved audience holds only what someone said. `schema`, `segments` and each `evidence.confidence` stay.
 */
export function pruneAudience(a: Audience): Audience {
  const out = (pruneValue(a) as Record<string, any>) ?? {}
  out.schema = AUDIENCE_SCHEMA
  out.segments = (Array.isArray(out.segments) ? out.segments : []).map((s: Record<string, any>) => ({
    ...s,
    name: s.name ?? "",
    evidence: { ...(s.evidence ?? {}), confidence: s.evidence?.confidence ?? "assumed" },
  }))
  return out as Audience
}

// ── summaries ─────────────────────────────────────────────────────────────────────────────────

const ageRange = (bands: string[] | undefined): string | undefined => {
  if (!bands?.length) return undefined
  const order = AUDIENCE_ENUMS.age_band as readonly string[]
  const sorted = [...bands].filter((b) => order.includes(b)).sort((a, b) => order.indexOf(a) - order.indexOf(b))
  if (!sorted.length) return undefined
  const lo = sorted[0]!.split("-")[0]!.replace("+", "")
  const last = sorted[sorted.length - 1]!
  if (last === "65+") return `${lo}+`
  return `${lo}-${last.split("-")[1]}`
}

/**
 * One line about a segment, from what is filled in: "primary · b2b · 25-44 · 2-10 people · Austin, Remote — Runs a small studio".
 * For list rows and for agents.
 */
export function segmentSummary(s: Segment): string {
  const facts = [
    s.priority,
    s.market,
    ageRange(s.demographics?.age_band),
    s.firmographics?.company_size ? `${s.firmographics.company_size === "solo" ? "solo" : `${s.firmographics.company_size} people`}` : undefined,
    s.demographics?.income_band ? `income ${s.demographics.income_band}` : undefined,
    s.demographics?.locations?.slice(0, 2).join(", ") || undefined,
    s.share != null ? `${s.share}%` : undefined,
  ].filter(Boolean)
  const head = facts.join(" · ")
  const tail = s.summary?.trim()
  return [head, tail].filter(Boolean).join(" — ")
}

/** One line per segment: "Solo agency owner (assumed): primary · b2b · …". For agents and list rows. */
export function audienceSummary(a: unknown): string[] {
  const n = normalizeAudience(a)
  return n.segments.map((s) => {
    const line = segmentSummary(s)
    return `${s.name || "(unnamed)"} (${s.evidence?.confidence ?? "assumed"})${line ? `: ${line}` : ""}`
  })
}

// ── the commented YAML template (`iris brands audience template`) ─────────────────────────────

/** An empty audience.v1 as YAML, every field commented with what goes there and what values it takes. */
export function audienceTemplateYaml(): string {
  const allowed = (s: FieldSpec) => (s.enum ? ` [${(AUDIENCE_ENUMS[s.enum] as readonly string[]).join(" | ")}]` : "")
  const empty = (s: FieldSpec) =>
    s.kind === "list" || s.kind === "enums" ? "[]" : s.kind === "number" ? "" : s.kind === "routine" ? "" : '""'
  const line = (s: FieldSpec, pad: string, first = false) => {
    const lead = first ? `${pad.slice(0, -2)}- ` : pad
    const value = s.key === "confidence" ? "assumed" : empty(s)
    const head = `${lead}${s.key}:${value ? ` ${value}` : ""}`
    const out = [`${head.padEnd(44)} # ${s.required ? "REQUIRED. " : ""}${s.hint}${allowed(s)}`]
    if (s.kind === "routine") for (const k of ["morning", "work", "evening"]) out.push(`${pad}  ${k}: ""`)
    return out
  }
  const out: string[] = [
    "# audience.v1: who this brand sells to. Fill in what you know; leave the rest empty.",
    "# Check it:  iris brands audience validate --file audience.yaml",
    "# Save it:   iris brands audience set <brand> --file audience.yaml --dry-run   (then without --dry-run)",
    `schema: ${AUDIENCE_SCHEMA}`,
    "",
    "segments:                                    # one or more customer segments",
  ]
  SEGMENT_GROUPS.forEach((g) => {
    if (g.shape === "flat") {
      g.fields.forEach((s, i) => out.push(...line(s, "    ", i === 0)))
      return
    }
    out.push("")
    const title = { demographics: "", firmographics: "  # B2B only", jobs: "  # use cases: When … they want to … so they can … Today they use …", personas: "  # 1-3 example people (made up)" }[g.key as string] ?? ""
    out.push(`    ${g.key}:${title}`)
    if (g.shape === "rows") g.fields.forEach((s, i) => out.push(...line(s, "        ", i === 0)))
    else g.fields.forEach((s) => out.push(...line(s, "      ")))
  })
  out.push("", "use_cases:                                   # brand-level use cases")
  USE_CASE_FIELDS.forEach((s, i) => out.push(...line(s, "    ", i === 0)))
  out.push("", "not_for:                                     # who we deliberately don't target")
  NOT_FOR_FIELDS.forEach((s, i) => out.push(...line(s, "    ", i === 0)))
  out.push("", "positioning:")
  POSITIONING_FIELDS.forEach((s) => out.push(...line(s, "  ")))
  return out.join("\n") + "\n"
}
