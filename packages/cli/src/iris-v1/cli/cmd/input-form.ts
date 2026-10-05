// ============================================================================
// Input Form — render a form from a workflow/skill `input_schema`
// ----------------------------------------------------------------------------
// Turns a stored `input_schema` (JSON-Schema / function-calling style, or the
// simpler `{ field: { type, required } }` map) into:
//   1. an interactive terminal form (via @clack/prompts), and
//   2. a non-interactive resolver for `--input '<json>'` / `--set key=value`.
//
// The canonical schema is JSON-Schema-ish:
//   { type: "object",
//     properties: { name: { type, description, enum, default, title, x-widget, placeholder } },
//     required: ["name"], "x-order": ["name", ...] }
// Extra `title` / `x-widget` / `placeholder` keys are UI hints — the AI ignores
// them, the form uses them. The older `{ field: { type, required } }` map form
// (used by some workflows) is also accepted.
// ============================================================================

import * as prompts from "./clack"

export interface InputField {
  name: string
  label: string
  type: "string" | "number" | "boolean" | "enum"
  widget?: string // x-widget UI hint: textarea | select | file | url | date | password
  description?: string
  placeholder?: string
  required: boolean
  default?: unknown
  enum?: string[]
}

// ----------------------------------------------------------------------------
// Normalization
// ----------------------------------------------------------------------------

export function normalizeInputSchema(schema: unknown): InputField[] {
  if (!schema || typeof schema !== "object") return []
  const s = schema as Record<string, any>

  // JSON-Schema / function-calling object form
  if (s.properties && typeof s.properties === "object") {
    const required: string[] = Array.isArray(s.required) ? s.required.map(String) : []
    const ordered: string[] = Array.isArray(s["x-order"]) ? s["x-order"].map(String) : []
    const keys = [...new Set([...ordered, ...Object.keys(s.properties)])].filter((k) => s.properties[k])
    return keys.map((name) => propToField(name, s.properties[name], required.includes(name)))
  }

  // Simple map form: { field: { type, required, description, enum, default } }
  return Object.entries(s).map(([name, def]) => propToField(name, def, Boolean((def as any)?.required)))
}

function propToField(name: string, rawDef: unknown, required: boolean): InputField {
  const def = (rawDef && typeof rawDef === "object" ? rawDef : {}) as Record<string, any>
  const rawType = String(def.type ?? "string").toLowerCase()
  const enumVals = Array.isArray(def.enum) && def.enum.length ? def.enum.map(String) : undefined

  let type: InputField["type"] = "string"
  if (enumVals) type = "enum"
  else if (rawType === "number" || rawType === "integer") type = "number"
  else if (rawType === "boolean") type = "boolean"

  const example = Array.isArray(def.examples) && def.examples.length ? def.examples[0] : undefined

  return {
    name,
    label: String(def.title ?? def.label ?? name),
    type,
    widget: def["x-widget"] ?? def.widget,
    description: def.description ? String(def.description) : undefined,
    placeholder:
      def.placeholder != null ? String(def.placeholder) : example != null ? String(example) : undefined,
    required,
    default: def.default,
    enum: enumVals,
  }
}

// ----------------------------------------------------------------------------
// Coercion + validation (mirrors skill/executor.ts resolveArgs semantics)
// ----------------------------------------------------------------------------

export function coerceValue(field: InputField, raw: unknown): unknown {
  if (raw === undefined || raw === null) return raw
  if (field.type === "number") {
    const n = Number(raw)
    return Number.isNaN(n) ? raw : n
  }
  if (field.type === "boolean") {
    if (typeof raw === "boolean") return raw
    const str = String(raw).toLowerCase()
    return str === "true" || str === "1" || str === "yes"
  }
  return raw
}

export function validateInputs(fields: InputField[], values: Record<string, unknown>): string[] {
  const errors: string[] = []
  for (const f of fields) {
    const v = values[f.name]
    if (f.required && (v === undefined || v === null || v === "")) {
      errors.push(`Missing required input: ${f.name}`)
      continue
    }
    if (v === undefined || v === "" || v === null) continue
    if (f.enum && !f.enum.includes(String(v))) {
      errors.push(`Invalid value for "${f.name}": ${v}. Must be one of: ${f.enum.join(", ")}`)
    }
    if (f.type === "number" && Number.isNaN(Number(v))) {
      errors.push(`"${f.name}" must be a number, got: ${v}`)
    }
  }
  return errors
}

// ----------------------------------------------------------------------------
// Non-interactive resolution (--input '<json>' + --set key=value)
// ----------------------------------------------------------------------------

export function parseSetFlags(setFlags: readonly (string | number)[] | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const entry of setFlags ?? []) {
    const str = String(entry)
    const eq = str.indexOf("=")
    if (eq === -1) {
      out[str] = "true" // bare `--set flag` → boolean-ish true
      continue
    }
    out[str.slice(0, eq)] = str.slice(eq + 1)
  }
  return out
}

export function resolveInputsNonInteractive(
  fields: InputField[],
  jsonInput: string | undefined,
  setFlags: readonly (string | number)[] | undefined,
): { inputs: Record<string, unknown>; errors: string[] } {
  const values: Record<string, unknown> = {}

  // defaults first
  for (const f of fields) if (f.default !== undefined) values[f.name] = f.default

  // --input JSON object
  if (jsonInput) {
    let parsed: unknown
    try {
      parsed = JSON.parse(jsonInput)
    } catch (e) {
      return { inputs: {}, errors: [`--input is not valid JSON: ${(e as Error).message}`] }
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { inputs: {}, errors: ["--input must be a JSON object, e.g. --input '{\"field\":\"value\"}'"] }
    }
    Object.assign(values, parsed)
  }

  // --set key=value overrides
  for (const [k, v] of Object.entries(parseSetFlags(setFlags))) values[k] = v

  // coerce known fields
  const byName = new Map(fields.map((f) => [f.name, f]))
  for (const [k, v] of Object.entries(values)) {
    const f = byName.get(k)
    if (f) values[k] = coerceValue(f, v)
  }

  return { inputs: values, errors: validateInputs(fields, values) }
}

// ----------------------------------------------------------------------------
// Interactive form
// ----------------------------------------------------------------------------

/** Prompt the user for each field. Returns null if the user cancels. */
export async function promptForInputs(fields: InputField[]): Promise<Record<string, unknown> | null> {
  const inputs: Record<string, unknown> = {}

  for (const f of fields) {
    const message = f.required ? f.label : `${f.label} (optional)`

    if (f.type === "boolean") {
      const v = await prompts.confirm({ message, initialValue: f.default === true })
      if (prompts.isCancel(v)) return null
      inputs[f.name] = v
      continue
    }

    if (f.type === "enum" && f.enum) {
      const v = await prompts.select({
        message,
        options: f.enum.map((e) => ({ value: e, label: e })),
        initialValue: f.default !== undefined ? String(f.default) : undefined,
      })
      if (prompts.isCancel(v)) return null
      inputs[f.name] = v
      continue
    }

    const v = await prompts.text({
      message,
      placeholder: f.placeholder ?? f.description,
      initialValue: f.default !== undefined ? String(f.default) : undefined,
      validate: (val) => {
        const str = String(val ?? "")
        if (f.required && str.trim() === "") return `${f.name} is required`
        if (f.type === "number" && str !== "" && Number.isNaN(Number(str))) return "Must be a number"
        return undefined
      },
    })
    if (prompts.isCancel(v)) return null
    const str = String(v ?? "")
    inputs[f.name] = f.type === "number" && str !== "" ? Number(str) : str
  }

  return inputs
}

/** Flatten resolved inputs into a readable text block — used as a `query`
 *  fallback so endpoints that only read `query` still get usable content
 *  until server-side `inputs` consumption (Phase 0) ships. */
export function renderInputsAsText(inputs: Record<string, unknown>): string {
  return Object.entries(inputs)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
    .join("\n")
}
