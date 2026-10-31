// ============================================================================
// `iris datasets schemas draft "<sentence>"` — a prompt DRAFTS a schema, never creates one (#187903)
//
// Removes the blank-schema step (Starter Kits) without letting a model silently classify PHI as
// public (#185139). The draft is printed for review; creation stays the separate, explicit
// `schemas create`, which can take the draft on stdin (`--fields -`) and `--dry-run` it first.
//
// The model is reached through the IRIS model route (/api/v6/openai/chat/completions) and never
// a provider directly: that route carries the PHI egress guard and writes the metering row, and a
// CLI that called a provider itself would skip both.
//
// Everything below the model call is pure and deterministic, so the guarantees hold whatever the
// model answers:
//   - every field carries a recognised `visibility`; unknown or missing → "private";
//   - name hints mirrored from fl-api can only RAISE visibility (public < private < phi), never
//     lower it — a model saying "public" does not get the last word on `date_of_birth`;
//   - types are clamped to the set fl-api accepts, keys are snake_case and unique.
// ============================================================================

export const VISIBILITIES = ["public", "private", "phi"] as const
export type Visibility = (typeof VISIBILITIES)[number]

/** fl-api AtlasSchemaValidator::$validTypes — a type outside this set is a 422 on create. */
export const FIELD_TYPES = [
  "text", "string", "number", "money", "date", "datetime",
  "enum", "boolean", "url", "email", "phone",
  "array", "object", "reference",
] as const

const RANK: Record<Visibility, number> = { public: 0, private: 1, phi: 2 }

/**
 * Mirrors fl-api app/Services/Atlas/AtlasFieldVisibility::NAME_HINTS (the server's own "this
 * looks like …" hint). Matched against key + label with `_`/`-` folded to spaces, as the server
 * does, so `date_of_birth` and "Date of Birth" are the same field.
 */
const NAME_HINTS: Array<[RegExp, Visibility, string]> = [
  [/\b(ssn|social security|tax id|ein)\b/i, "phi", "a government identifier"],
  [/(diagnos|icd ?10|\bcpt\b|treatment|medication|\brx\b)/i, "phi", "clinical data"],
  [/\b(dob|date of birth|birth date)\b/i, "phi", "a date of birth"],
  [/\b(patient|beneficiary)\b/i, "phi", "a patient identifier"],
  [/\b(cond|condition) /i, "phi", "a health condition"],
  [/\b(mrn|chart no|case id)\b/i, "phi", "a medical record locator"],
  // Not in the server table, but squarely health-plan identifiers under HIPAA — the sentence in
  // the ticket ("patient intake with insurance") produces exactly these.
  [/\b(insurance|insurer|policy (no|number|id)|member id|group (no|number)|subscriber|payer)\b/i, "phi", "health-plan data"],
  [/\b(allerg|symptom|medical|health|prescri)/i, "phi", "clinical data"],
  [/\b(bill|charge|reduction|settlement|payout) ?amount\b/i, "private", "a financial amount"],
  [/\b(salary|compensation|bank|routing|iban|card) /i, "private", "financial detail"],
  [/\b(e ?mail|phone|mobile|address|street|zip|postcode)\b/i, "private", "contact detail"],
  [/\b(full|first|last) ?name\b|\bsurname\b/i, "private", "a personal name"],
  [/\b(attorney|law firm|counsel)\b/i, "private", "a legal party"],
]

export function hintFor(key: string, label?: string): { visibility: Visibility; reason: string } | null {
  // Trailing space so patterns written with a trailing space (`card `) match at the end too.
  const subject = `${key} ${label ?? ""}`.toLowerCase().replace(/[_\-]+/g, " ").replace(/\s+/g, " ").trim() + " "
  let best: { visibility: Visibility; reason: string } | null = null
  for (const [re, vis, reason] of NAME_HINTS) {
    if (re.test(subject) && (!best || RANK[vis] > RANK[best.visibility])) best = { visibility: vis, reason }
  }
  return best
}

export interface DraftField {
  key: string
  label: string
  type: string
  visibility: Visibility
  required?: boolean
  options?: string[]
}

export interface Draft {
  /** Marks this as a reviewed-before-create draft; `schemas create` reads only `.fields` from it. */
  draft: true
  created: false
  sentence: string
  name: string
  fields: DraftField[]
  /** Why each field got its visibility, for the human reviewing it. */
  review: Array<{ key: string; visibility: Visibility; why: string }>
}

function snake(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64)
}

function titleCase(key: string): string {
  return key.split("_").filter(Boolean).map((w) => w[0]!.toUpperCase() + w.slice(1)).join(" ")
}

/**
 * Turn whatever the model said into a draft that is safe to show and to pipe into create.
 * Accepts `{name, fields:[...]}` or a bare array. Never throws on shape; drops what it cannot use.
 */
export function normalizeDraft(raw: unknown, sentence: string): Draft {
  const obj: any = Array.isArray(raw) ? { fields: raw } : raw && typeof raw === "object" ? raw : {}
  const list: any[] = Array.isArray(obj.fields) ? obj.fields : []
  const fields: DraftField[] = []
  const review: Draft["review"] = []
  const seen = new Set<string>()

  for (const f of list) {
    if (!f || typeof f !== "object") continue
    let key = snake(String(f.key ?? f.name ?? f.label ?? ""))
    if (!key) continue
    if (seen.has(key)) {
      let n = 2
      while (seen.has(`${key}_${n}`)) n++
      key = `${key}_${n}`
    }
    seen.add(key)

    const label = typeof f.label === "string" && f.label.trim() ? f.label.trim() : titleCase(key)
    const type = (FIELD_TYPES as readonly string[]).includes(f.type) ? String(f.type) : "text"

    // DEFAULT PRIVATE WHEN UNSURE (#187903 / #185139): a missing or unrecognised answer is not
    // "public" — public is a decision someone has to make, not a fallback.
    const said = (VISIBILITIES as readonly string[]).includes(f.visibility) ? (f.visibility as Visibility) : null
    let visibility: Visibility = said ?? "private"
    let why = said ? `model suggested ${said}` : "no clear answer — defaulted to private"

    // Name hints only RAISE. A model's "public" never outranks a field named like PHI.
    const hint = hintFor(key, label)
    if (hint && RANK[hint.visibility] > RANK[visibility]) {
      why = `${said ? `model said ${said}; ` : ""}raised to ${hint.visibility}: name looks like ${hint.reason}`
      visibility = hint.visibility
    }

    const field: DraftField = { key, label, type, visibility }
    if (f.required === true) field.required = true
    if (type === "enum") {
      const opts = Array.isArray(f.options) ? f.options.filter((o: unknown) => typeof o === "string" && o.trim()) : []
      if (opts.length) field.options = opts.map((o: string) => o.trim())
      else field.type = "text" // an enum with no options is a text field that will 422 later
    }
    fields.push(field)
    review.push({ key, visibility, why })
  }

  const name = typeof obj.name === "string" && obj.name.trim() ? obj.name.trim() : sentence.trim().slice(0, 80)
  return { draft: true, created: false, sentence, name, fields, review }
}

/**
 * What `schemas create` will send as `fields`. A draft is unwrapped to `{fields}` so its review
 * notes and metadata are not stored inside the schema definition; anything else keeps the
 * existing behaviour (bare array → `{fields}`, object passed through).
 */
export function fieldsForCreate(input: unknown): any {
  if (Array.isArray(input)) return { fields: input }
  if (input && typeof input === "object" && (input as any).draft === true && Array.isArray((input as any).fields)) {
    return { fields: (input as any).fields }
  }
  return input
}

/**
 * Local checks for `schemas create --dry-run`: the same refusals fl-api would give, without the
 * write. Returns human-readable problems; empty means it would be accepted on these counts.
 */
export function checkFields(fields: any): string[] {
  const list: any[] = Array.isArray(fields?.fields) ? fields.fields : []
  if (!Array.isArray(fields?.fields)) return ['fields must be {"fields": [...]} or a bare array']
  if (!list.length) return ["no fields — a draft with nothing in it is not worth creating"]
  const problems: string[] = []
  const keys = new Set<string>()
  list.forEach((f, i) => {
    const key = f?.key
    if (!key) return void problems.push(`field ${i}: missing key`)
    if (keys.has(key)) problems.push(`${key}: duplicate key`)
    keys.add(key)
    if (!(FIELD_TYPES as readonly string[]).includes(f.type)) problems.push(`${key}: type '${f.type}' is not one of ${FIELD_TYPES.join(", ")}`)
    if (!(VISIBILITIES as readonly string[]).includes(f.visibility)) {
      problems.push(`${key}: declares no visibility (public | private | phi) — every field must say what it is (#185139)`)
    }
  })
  return problems
}

export const DRAFT_SYSTEM_PROMPT = [
  "You design a dataset schema from a one-sentence description. Answer ONLY a JSON object:",
  '{"name": "<short dataset name>", "fields": [{"key": "snake_case", "label": "Human Label", "type": "<type>", "visibility": "public|private|phi", "required": true|false, "options": ["only", "for", "enum"]}]}',
  `type is one of: ${FIELD_TYPES.join(", ")}.`,
  "visibility: phi = protected health information (anything about a person's health, care, insurance/health plan, diagnoses, medications, or identifiers tied to them: DOB, SSN, member id, MRN);",
  "private = personal or business-sensitive but not health (names, email, phone, address, money);",
  "public = safe to show anyone. When unsure, choose private. Never mark a person's identifiers public.",
  "Keep it to the fields the description implies, 4–20 fields. No commentary.",
].join("\n")

/** Pull the first JSON object out of a model answer (tolerates fences and preambles). */
export function parseModelJson(content: string): unknown {
  const stripped = content.replace(/<think>[\s\S]*?<\/think>/g, "")
  const m = stripped.match(/\{[\s\S]*\}/)
  if (!m) return null
  try {
    return JSON.parse(m[0])
  } catch {
    return null
  }
}
