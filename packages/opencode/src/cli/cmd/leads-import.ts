// ============================================================================
// Lead fields and bulk import (#193510 title, #193511 external id, #193512 product/segment,
// #193513 bulk import, #193514 partly hidden names). Parent: #193509.
//
// Pure functions only, so the parts that decide what gets written are testable without a
// server. The command wiring lives in platform-leads.ts.
//
// Server contract (fl-api, built in parallel — see the PR for its state):
//   POST /api/v1/leads/import
//     { bloq_id, dry_run, leads: [{ name, email?, phone?, company?, source?, status?, notes?,
//       title?, external_id?, product?, segment?, name_verified? }] }   (max 1000 rows)
//     upserts on (bloq_id, external_id)
//   -> { dry_run, created, merged, failed: [{ index, error }], ids }
// ============================================================================

import * as fs from "fs"
import * as path from "path"

export const LEAD_PRODUCTS = ["iris-terra", "iris-kinetic", "iris-orbit", "iris"] as const
export type LeadProduct = (typeof LEAD_PRODUCTS)[number]

/** The server's per-request cap. */
export const IMPORT_MAX_ROWS = 1000

/** Every field a lead row may carry on import, per the contract. */
export const IMPORT_FIELDS = [
  "name",
  "email",
  "phone",
  "company",
  "source",
  "status",
  "notes",
  "title",
  "external_id",
  "product",
  "segment",
  "name_verified",
] as const
export type ImportField = (typeof IMPORT_FIELDS)[number]

export type ImportLead = {
  name: string
  email?: string
  phone?: string
  company?: string
  source?: string
  status?: string
  notes?: string
  title?: string
  external_id?: string
  product?: LeadProduct
  segment?: string
  name_verified?: boolean
}

/**
 * `terra` / `Kinetic` / `IRIS Orbit` -> `iris-terra` / `iris-kinetic` / `iris-orbit`. Apollo
 * pulls and the `product-leads` dataset write the short name; the CRM stores the long one.
 * Returns null for anything that is not one of the four products.
 */
export function normalizeProduct(raw: unknown): LeadProduct | null {
  const v = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
  if (!v) return null
  if ((LEAD_PRODUCTS as readonly string[]).includes(v)) return v as LeadProduct
  const short = v.replace(/^iris-/, "")
  const long = `iris-${short}`
  if ((LEAD_PRODUCTS as readonly string[]).includes(long)) return long as LeadProduct
  return null
}

/** true/false/yes/no/1/0/y/n -> boolean; empty -> undefined; anything else -> null (an error). */
export function parseBool(raw: unknown): boolean | undefined | null {
  if (typeof raw === "boolean") return raw
  const v = String(raw ?? "").trim().toLowerCase()
  if (v === "") return undefined
  if (["true", "1", "yes", "y", "t"].includes(v)) return true
  if (["false", "0", "no", "n", "f"].includes(v)) return false
  return null
}

/**
 * The flags `leads create` and `leads update` share: --title --external-id --product --segment
 * --name-verified/--no-name-verified. Only flags that were passed are sent, so an update never
 * resets a field it was not asked to touch (and name_verified keeps its server default of true).
 */
export function leadFieldsFromFlags(args: Record<string, unknown>): { ok: true; fields: Partial<ImportLead> } | { ok: false; error: string } {
  const fields: Partial<ImportLead> = {}
  if (typeof args.title === "string") fields.title = args.title.trim()
  const ext = args["external-id"] ?? args.externalId
  if (typeof ext === "string") fields.external_id = ext.trim()
  if (args.product !== undefined) {
    const p = normalizeProduct(args.product)
    if (!p) return { ok: false, error: `--product must be one of ${LEAD_PRODUCTS.join(", ")} (got ${JSON.stringify(args.product)})` }
    fields.product = p
  }
  if (typeof args.segment === "string") fields.segment = args.segment.trim()
  const nv = args["name-verified"] ?? args.nameVerified
  if (nv !== undefined) fields.name_verified = Boolean(nv)
  return { ok: true, fields }
}

// ── parsing files ────────────────────────────────────────────────────────────

/**
 * RFC 4180 CSV: quoted cells may hold commas, doubled quotes and newlines; CRLF or LF.
 * Returns the header and one object per non-blank data row, with `line` = the file line the
 * row starts on (so an error can point at it).
 */
export function parseCsv(text: string): { header: string[]; rows: { line: number; cells: Record<string, string> }[] } {
  const src = text.replace(/^﻿/, "")
  const records: { line: number; cells: string[] }[] = []
  let cell = ""
  let row: string[] = []
  let inQuotes = false
  let line = 1
  let rowLine = 1
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"'
          i++
        } else inQuotes = false
      } else {
        if (ch === "\n") line++
        cell += ch
      }
      continue
    }
    if (ch === '"') inQuotes = true
    else if (ch === ",") {
      row.push(cell)
      cell = ""
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++
      row.push(cell)
      records.push({ line: rowLine, cells: row })
      row = []
      cell = ""
      line++
      rowLine = line
    } else cell += ch
  }
  if (cell !== "" || row.length) {
    row.push(cell)
    records.push({ line: rowLine, cells: row })
  }
  const nonBlank = records.filter((r) => r.cells.some((c) => c.trim() !== ""))
  if (nonBlank.length === 0) return { header: [], rows: [] }
  const header = nonBlank[0].cells.map((h) => h.trim())
  const rows = nonBlank.slice(1).map((r) => {
    const cells: Record<string, string> = {}
    header.forEach((h, i) => {
      if (h) cells[h] = (r.cells[i] ?? "").trim()
    })
    return { line: r.line, cells }
  })
  return { header, rows }
}

export type SourceRow = { row: number; line?: number; cells: Record<string, unknown> }

/** Read a .csv or .json file into rows. JSON: an array, or {leads|records|data: [...]}. */
export function readLeadFile(file: string): { ok: true; rows: SourceRow[]; columns: string[] } | { ok: false; error: string } {
  let raw: string
  try {
    raw = fs.readFileSync(file, "utf8")
  } catch (e: any) {
    return { ok: false, error: `Cannot read ${file}: ${e?.message ?? e}` }
  }
  const ext = path.extname(file).toLowerCase()
  const looksJson = ext === ".json" || (ext !== ".csv" && /^\s*[[{]/.test(raw))
  if (looksJson) {
    let parsed: any
    try {
      parsed = JSON.parse(raw)
    } catch (e: any) {
      return { ok: false, error: `Invalid JSON in ${file}: ${e?.message ?? e}` }
    }
    const list = Array.isArray(parsed) ? parsed : (parsed?.leads ?? parsed?.records ?? parsed?.data)
    if (!Array.isArray(list)) return { ok: false, error: `Expected a JSON array of leads, or {"leads": [...]}, in ${file}` }
    const columns = new Set<string>()
    const rows: SourceRow[] = list.map((r: any, i: number) => {
      // Atlas dataset exports are {external_id, data:{...}} — flatten so both shapes import.
      const cells = r && typeof r === "object" && r.data && typeof r.data === "object" && !Array.isArray(r.data)
        ? { ...r.data, ...(r.external_id && !r.data.external_id ? { external_id: r.external_id } : {}) }
        : r && typeof r === "object" ? r : {}
      Object.keys(cells).forEach((k) => columns.add(k))
      return { row: i + 1, cells }
    })
    return { ok: true, rows, columns: [...columns] }
  }
  const { header, rows } = parseCsv(raw)
  if (header.length === 0) return { ok: false, error: `${file} is empty` }
  if (rows.length === 0) return { ok: false, error: `${file} has a header row but no data rows` }
  return { ok: true, columns: header, rows: rows.map((r, i) => ({ row: i + 1, line: r.line, cells: r.cells })) }
}

// ── mapping ──────────────────────────────────────────────────────────────────

/** `--map col=field` (repeatable). The field must be one the import accepts. */
export function parseMapArgs(raw: unknown[] | undefined): { ok: true; map: Record<string, ImportField> } | { ok: false; error: string } {
  const map: Record<string, ImportField> = {}
  for (const entry of raw ?? []) {
    for (const part of String(entry).split(/,(?=[^,=]+=)/)) {
      const eq = part.indexOf("=")
      if (eq <= 0) return { ok: false, error: `--map wants column=field (got ${JSON.stringify(part)})` }
      const col = part.slice(0, eq).trim()
      const field = part.slice(eq + 1).trim() as ImportField
      if (!(IMPORT_FIELDS as readonly string[]).includes(field)) {
        return { ok: false, error: `--map ${col}=${field}: "${field}" is not a lead field (fields: ${IMPORT_FIELDS.join(", ")})` }
      }
      map[col] = field
    }
  }
  return { ok: true, map }
}

/** `--set field=value` (repeatable): one value for every row, unless the row has its own. */
export function parseSetArgs(raw: unknown[] | undefined): { ok: true; set: Partial<Record<ImportField, string>> } | { ok: false; error: string } {
  const set: Partial<Record<ImportField, string>> = {}
  for (const entry of raw ?? []) {
    const s = String(entry)
    const eq = s.indexOf("=")
    if (eq <= 0) return { ok: false, error: `--set wants field=value (got ${JSON.stringify(s)})` }
    const field = s.slice(0, eq).trim() as ImportField
    if (!(IMPORT_FIELDS as readonly string[]).includes(field)) {
      return { ok: false, error: `--set ${field}: not a lead field (fields: ${IMPORT_FIELDS.join(", ")})` }
    }
    set[field] = s.slice(eq + 1)
  }
  return { ok: true, set }
}

export type MappingPlan = {
  /** source column -> lead field */
  columns: Record<string, ImportField>
  /** Columns in the file that nothing reads — reported so a dropped column is never silent. */
  unused: string[]
  /** An Apollo search export: name built from first_name + last_name_hint. */
  apolloName: boolean
  /** Prefix added to external ids that have none (an `apollo_id` column -> `apollo:`). */
  externalIdPrefix?: string
}

/**
 * Decide which column feeds which field. Defaults: a column named like a field feeds it.
 * `--map` overrides. Apollo help: `first_name` + `last_name_hint` build the name, and an
 * `apollo_id` column becomes `external_id` as `apollo:<id>` (the key the product-leads
 * dataset already uses, so a lead and its dataset row share one id).
 */
export function planMapping(columns: string[], map: Record<string, ImportField>, opts: { externalIdPrefix?: string } = {}): MappingPlan {
  const plan: Record<string, ImportField> = {}
  const mappedFields = new Set(Object.values(map))
  for (const c of columns) {
    if (map[c]) plan[c] = map[c]
    else if ((IMPORT_FIELDS as readonly string[]).includes(c) && !mappedFields.has(c as ImportField)) plan[c] = c as ImportField
  }
  const fieldsFed = new Set(Object.values(plan))
  let externalIdPrefix = opts.externalIdPrefix
  if (!fieldsFed.has("external_id") && columns.includes("apollo_id")) {
    plan["apollo_id"] = "external_id"
    fieldsFed.add("external_id")
  }
  const idColumn = Object.keys(plan).find((c) => plan[c] === "external_id")
  if (externalIdPrefix === undefined && idColumn === "apollo_id") externalIdPrefix = "apollo:"
  const apolloName = !fieldsFed.has("name") && columns.includes("first_name") && (columns.includes("last_name_hint") || columns.includes("last_name"))
  const consumed = new Set([...Object.keys(plan), ...(apolloName ? ["first_name", "last_name_hint", "last_name"] : [])])
  return { columns: plan, unused: columns.filter((c) => !consumed.has(c)), apolloName, externalIdPrefix }
}

export type RowError = { row: number; line?: number; error: string }

/** Build one lead from one source row. */
export function buildLead(src: SourceRow, plan: MappingPlan, set: Partial<Record<ImportField, string>> = {}): { ok: true; lead: ImportLead } | { ok: false; error: string } {
  const v: Partial<Record<ImportField, unknown>> = {}
  for (const [field, value] of Object.entries(set)) v[field as ImportField] = value
  for (const [col, field] of Object.entries(plan.columns)) {
    const cell = src.cells[col]
    if (cell === undefined || cell === null || (typeof cell === "string" && cell.trim() === "")) continue
    v[field] = cell
  }

  let nameVerifiedAuto: boolean | undefined
  if (plan.apolloName && !v.name) {
    const first = String(src.cells.first_name ?? "").trim()
    const hint = String(src.cells.last_name_hint ?? src.cells.last_name ?? "").trim()
    const built = [first, hint].filter(Boolean).join(" ")
    if (built) v.name = built
    // Apollo hides most of a last name until enrichment ("Va***s"). Saved as-is, it becomes
    // "Hi Juan Va***s" in a draft and a false match in dedupe (#193514).
    if (hint.includes("*")) nameVerifiedAuto = false
  }

  const name = String(v.name ?? "").trim()
  if (!name) return { ok: false, error: "no name (map a column to name, or give first_name + last_name_hint)" }
  const lead: ImportLead = { name }
  for (const f of ["email", "phone", "company", "source", "status", "notes", "title", "segment"] as const) {
    if (v[f] !== undefined) {
      const s = String(v[f]).trim()
      if (s) lead[f] = s
    }
  }
  if (v.external_id !== undefined) {
    let id = String(v.external_id).trim()
    if (id && plan.externalIdPrefix && !id.includes(":")) id = plan.externalIdPrefix + id
    if (id) lead.external_id = id
  }
  if (v.product !== undefined) {
    const p = normalizeProduct(v.product)
    if (!p) return { ok: false, error: `product ${JSON.stringify(v.product)} is not one of ${LEAD_PRODUCTS.join(", ")}` }
    lead.product = p
  }
  if (v.name_verified !== undefined) {
    const b = parseBool(v.name_verified)
    if (b === null) return { ok: false, error: `name_verified ${JSON.stringify(v.name_verified)} is not true/false` }
    if (b !== undefined) lead.name_verified = b
  }
  // A masked name is never verified, whatever a column says.
  if (nameVerifiedAuto === false || name.includes("*")) lead.name_verified = false
  return { ok: true, lead }
}

/** Every row of the file -> the leads to send (with their source row numbers) and the rows refused here. */
export function buildLeads(rows: SourceRow[], plan: MappingPlan, set: Partial<Record<ImportField, string>> = {}) {
  const leads: ImportLead[] = []
  const rowOf: number[] = []
  const lineOf: (number | undefined)[] = []
  const errors: RowError[] = []
  const seenIds = new Map<string, number>()
  for (const r of rows) {
    const built = buildLead(r, plan, set)
    if (!built.ok) {
      errors.push({ row: r.row, line: r.line, error: built.error })
      continue
    }
    const id = built.lead.external_id
    if (id) {
      const first = seenIds.get(id)
      if (first !== undefined) {
        errors.push({ row: r.row, line: r.line, error: `external_id ${id} repeats row ${first}` })
        continue
      }
      seenIds.set(id, r.row)
    }
    leads.push(built.lead)
    rowOf.push(r.row)
    lineOf.push(r.line)
  }
  return { leads, rowOf, lineOf, errors }
}

export function chunk<T>(list: T[], size = IMPORT_MAX_ROWS): T[][] {
  const out: T[][] = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

export type ImportResponse = {
  dry_run?: boolean
  created?: number
  merged?: number
  failed?: { index: number; error: unknown }[]
  ids?: unknown[]
}

/** The server may wrap the result in {data: ...} like most fl-api routes; accept both. */
export function unwrapImportResponse(body: any): ImportResponse {
  const d = body && typeof body === "object" && body.data && typeof body.data === "object" && !Array.isArray(body.data) && ("created" in body.data || "merged" in body.data || "failed" in body.data) ? body.data : body
  return (d ?? {}) as ImportResponse
}
