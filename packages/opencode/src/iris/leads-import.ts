// ============================================================================
// New lead and CSV import for the Leads tab (#194506).
//
// The mapping is the CLI's (`iris leads import`, packages/opencode/src/cli/cmd/leads-import.ts on
// main): the same fields, the same RFC 4180 parser, the same status mapping (case, spaces, - and _
// ignored; an unknown status is dropped WITH a warning and the row comes in as Prospected, #194368).
// Desktop ships from a branch that does not carry that file, so the pure parts live here too; keep
// the two in step.
//
// What this adds for a person picking a spreadsheet rather than typing flags: headers are matched
// loosely ("Full name", "Email address", "Stage"), a First/Last name pair builds the name, and an
// address that is not one is refused here, with the row number, before anything is sent.
//
// Server contract (fl-api):
//   POST /api/v1/leads         { name, bloqId, email?, company?, status?, price_bid? }  — upserts by email
//   POST /api/v1/leads/import  { bloq_id, dry_run, leads: [...] } (max 1000 rows)
//     -> { dry_run, created, merged, failed: [{ index, error }], ids }
// ============================================================================

/** The server's per-request cap. */
export const IMPORT_MAX_ROWS = 1000
/** A file bigger than this is refused before it is parsed. */
export const IMPORT_MAX_BYTES = 5_000_000
/** How many rows the preview shows. */
export const PREVIEW_ROWS = 8

export const IMPORT_FIELDS = ["name", "email", "phone", "company", "source", "status", "notes", "title", "external_id", "segment"] as const
export type ImportField = (typeof IMPORT_FIELDS)[number]
export type ImportLead = Partial<Record<Exclude<ImportField, "name">, string>> & { name: string }

/** The CRM's statuses, exactly as fl-api checks them (SOMLeads::STATUSES). */
export const LEAD_STATUSES = [
  "New",
  "Prospected",
  "Contacted",
  "Qualified",
  "Proposal",
  "In Negotiation",
  "Follow-Up",
  "On Hold",
  "Active",
  "Partner",
  "Won",
  "Lost",
  "Archived",
] as const
export type LeadStatus = (typeof LEAD_STATUSES)[number]

const statusKey = (v: string) => v.toLowerCase().replace(/[\s_-]+/g, "")
/** Spellings people put in a spreadsheet that mean one of the statuses above. */
const STATUS_ALIASES: Record<string, LeadStatus> = {
  negotiation: "In Negotiation",
  negotiating: "In Negotiation",
  followup: "Follow-Up",
  prospect: "Prospected",
  closedwon: "Won",
  closedlost: "Lost",
  onhold: "On Hold",
}

/** A status as the CRM spells it, or null when it is not one. */
export function normalizeStatus(raw: unknown): LeadStatus | null {
  const key = statusKey(String(raw ?? ""))
  if (!key) return null
  return LEAD_STATUSES.find((st) => statusKey(st) === key) ?? STATUS_ALIASES[key] ?? null
}

/** RFC 4180 CSV: quoted cells may hold commas, doubled quotes and newlines; CRLF or LF. */
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

const headerKey = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, "")
/** Header spellings, after lower-casing and dropping everything but letters and digits. */
const HEADER_ALIASES: Record<string, ImportField> = {
  name: "name",
  fullname: "name",
  contactname: "name",
  leadname: "name",
  contact: "name",
  email: "email",
  emailaddress: "email",
  workemail: "email",
  mail: "email",
  phone: "phone",
  phonenumber: "phone",
  mobile: "phone",
  telephone: "phone",
  tel: "phone",
  company: "company",
  companyname: "company",
  organization: "company",
  organisation: "company",
  business: "company",
  status: "status",
  stage: "status",
  leadstatus: "status",
  dealstage: "status",
  source: "source",
  leadsource: "source",
  notes: "notes",
  note: "notes",
  comments: "notes",
  title: "title",
  jobtitle: "title",
  position: "title",
  externalid: "external_id",
  apolloid: "external_id",
  segment: "segment",
}
const FIRST = new Set(["firstname", "first", "givenname"])
const LAST = new Set(["lastname", "last", "surname", "familyname", "lastnamehint"])

export type ImportPlan = {
  /** source column -> lead field, in file order */
  columns: Record<string, ImportField>
  /** A First / Last pair builds the name when no column is the name. */
  nameFrom?: { first: string; last?: string }
  /** Columns nothing reads, so a dropped column is never silent. */
  unused: string[]
}

/** Which column feeds which field. The first column that means a field wins it. */
export function planImport(header: string[]): ImportPlan {
  const columns: Record<string, ImportField> = {}
  const taken = new Set<ImportField>()
  for (const h of header) {
    const field = HEADER_ALIASES[headerKey(h)]
    if (field && !taken.has(field)) {
      columns[h] = field
      taken.add(field)
    }
  }
  let nameFrom: ImportPlan["nameFrom"]
  if (!taken.has("name")) {
    const first = header.find((h) => FIRST.has(headerKey(h)))
    const last = header.find((h) => LAST.has(headerKey(h)))
    if (first) nameFrom = { first, last }
  }
  const used = new Set([...Object.keys(columns), ...(nameFrom ? [nameFrom.first, nameFrom.last ?? ""] : [])])
  return { columns, nameFrom, unused: header.filter((h) => h && !used.has(h)) }
}

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

export type BuiltRow = { row: number; line: number; lead?: ImportLead; warning?: string; error?: string }

/** One row of the file -> the lead to send, a warning it carries, or why it is skipped. */
export function buildRow(src: { line: number; cells: Record<string, string> }, row: number, plan: ImportPlan): BuiltRow {
  const v: Partial<Record<ImportField, string>> = {}
  for (const [col, field] of Object.entries(plan.columns)) {
    const cell = (src.cells[col] ?? "").trim()
    if (cell) v[field] = cell
  }
  if (!v.name && plan.nameFrom) {
    const built = [src.cells[plan.nameFrom.first], plan.nameFrom.last ? src.cells[plan.nameFrom.last] : ""].map((s) => (s ?? "").trim()).filter(Boolean).join(" ")
    if (built) v.name = built
  }
  const base = { row, line: src.line }
  const lead: ImportLead = { name: v.name ?? "" }
  for (const f of ["email", "phone", "company", "source", "notes", "title", "external_id", "segment"] as const) if (v[f]) lead[f] = v[f]
  // A skipped row keeps what it said, so the preview can show which row it is; it is never sent.
  if (!v.name) return { ...base, lead, error: "No name" }
  if (v.email && !EMAIL.test(v.email)) return { ...base, lead, error: `"${v.email}" is not an email address` }
  if (v.status) {
    const st = normalizeStatus(v.status)
    if (st) lead.status = st
    else return { ...base, lead, warning: `Stage "${v.status}" is not one the CRM has, so it comes in as Prospected` }
  }
  return { ...base, lead }
}

export type ImportPreview = {
  /** Every column of the file, and the field it feeds (null: not imported). */
  columns: { column: string; field: ImportField | "name (with last name)" | null }[]
  /** The first rows as they will be imported. */
  rows: BuiltRow[]
  total: number
  /** Rows that will be sent. */
  ready: number
  /** Rows refused here, every one, with the reason. */
  skipped: { row: number; reason: string }[]
  /** Rows that go in, but not exactly as written. */
  warnings: { row: number; reason: string }[]
}

export function readImport(csv: string): { ok: true; plan: ImportPlan; built: BuiltRow[]; header: string[] } | { ok: false; reason: string } {
  if (typeof csv !== "string" || !csv.trim()) return { ok: false, reason: "The file is empty." }
  if (csv.length > IMPORT_MAX_BYTES) return { ok: false, reason: "The file is larger than 5 MB. Split it and import the parts." }
  const { header, rows } = parseCsv(csv)
  if (header.length === 0) return { ok: false, reason: "The file is empty." }
  if (rows.length === 0) return { ok: false, reason: "The file has a header row but no leads under it." }
  const plan = planImport(header)
  if (!Object.values(plan.columns).includes("name") && !plan.nameFrom)
    return { ok: false, reason: `No column holds a name. Name one column "Name" (or "First name" and "Last name") and pick the file again.` }
  const built = rows.map((r, i) => buildRow(r, i + 1, plan))
  return { ok: true, plan, built, header }
}

export function previewImport(csv: string): { ok: true; preview: ImportPreview } | { ok: false; reason: string } {
  const read = readImport(csv)
  if (!read.ok) return read
  const { plan, built, header } = read
  return {
    ok: true,
    preview: {
      columns: header.map((column) => ({
        column,
        field: plan.columns[column] ?? (plan.nameFrom?.first === column ? "name" : plan.nameFrom?.last === column ? "name (with last name)" : null),
      })),
      rows: built.slice(0, PREVIEW_ROWS),
      total: built.length,
      ready: built.filter((b) => b.lead && !b.error).length,
      skipped: built.flatMap((b) => (b.error ? [{ row: b.row, reason: b.error }] : [])),
      warnings: built.flatMap((b) => (b.warning ? [{ row: b.row, reason: b.warning }] : [])),
    },
  }
}

export type ImportResult = {
  /** New leads on the board. */
  created: number
  /** Rows that matched a lead already there and updated it. */
  merged: number
  skipped: { row: number; reason: string }[]
  warnings: { row: number; reason: string }[]
  /** Set when a later chunk was not sent. */
  stopped?: string
}

/** The server may wrap the result in {data: ...} like most fl-api routes; accept both. */
export function unwrapImportResponse(body: any): { created?: number; merged?: number; failed?: { index: number; error: unknown }[] } {
  const d = body?.data && typeof body.data === "object" && !Array.isArray(body.data) && ("created" in body.data || "merged" in body.data || "failed" in body.data) ? body.data : body
  return d ?? {}
}

const reasonOf = (e: unknown): string => {
  if (typeof e === "string") return e
  if (Array.isArray(e)) return e.map(reasonOf).join("; ")
  if (e && typeof e === "object") return Object.values(e as Record<string, unknown>).map(reasonOf).join("; ")
  return String(e ?? "Refused")
}

/**
 * Send every row that is ready, 1000 at a time. `post` is the platform call; it answers the
 * server's JSON, or throws/returns `{ error }`. A chunk that fails stops the rest, and the result
 * says so: nothing is retried behind the person's back.
 */
export async function importLeads(csv: string, post: (leads: ImportLead[]) => Promise<{ ok: boolean; body: any; reason?: string }>): Promise<{ ok: true; result: ImportResult } | { ok: false; reason: string }> {
  const read = readImport(csv)
  if (!read.ok) return read
  const ready = read.built.filter((b) => b.lead && !b.error)
  const result: ImportResult = {
    created: 0,
    merged: 0,
    skipped: read.built.flatMap((b) => (b.error ? [{ row: b.row, reason: b.error }] : [])),
    warnings: read.built.flatMap((b) => (b.warning ? [{ row: b.row, reason: b.warning }] : [])),
  }
  if (ready.length === 0) return { ok: true, result }
  for (let i = 0; i < ready.length; i += IMPORT_MAX_ROWS) {
    const slice = ready.slice(i, i + IMPORT_MAX_ROWS)
    const r = await post(slice.map((b) => b.lead!))
    if (!r.ok) {
      if (i === 0) return { ok: false, reason: r.reason ?? "The import was refused." }
      result.stopped = `Stopped after ${i} rows: ${r.reason ?? "the platform refused the next part"}. The rest were not sent.`
      break
    }
    const d = unwrapImportResponse(r.body)
    result.created += Number(d.created ?? 0)
    result.merged += Number(d.merged ?? 0)
    for (const f of d.failed ?? []) {
      const b = slice[Number(f.index)]
      if (b) result.skipped.push({ row: b.row, reason: reasonOf(f.error) })
    }
  }
  result.skipped.sort((a, b) => a.row - b.row)
  return { ok: true, result }
}

// ── New lead ────────────────────────────────────────────────────────────────

export type NewLead = { name?: string; email?: string; company?: string; value?: string | number; status?: string; bloqId?: number }

/** The body for POST /api/v1/leads, or why it can't be sent. Name or email is required. */
export function newLeadPayload(a: NewLead): { ok: true; body: Record<string, unknown> } | { ok: false; reason: string } {
  const name = String(a.name ?? "").trim()
  const email = String(a.email ?? "").trim()
  if (!a.bloqId) return { ok: false, reason: "Pick a board first: a lead belongs to one." }
  if (!name && !email) return { ok: false, reason: "Give the lead a name or an email address." }
  if (email && !EMAIL.test(email)) return { ok: false, reason: `"${email}" is not an email address.` }
  const body: Record<string, unknown> = { name: name || email, bloqId: a.bloqId }
  if (email) body.email = email
  const company = String(a.company ?? "").trim()
  if (company) body.company = company
  const value = String(a.value ?? "").replace(/[$,\s]/g, "")
  if (value) {
    const n = Number(value)
    if (!Number.isFinite(n) || n < 0) return { ok: false, reason: "The value has to be a number, like 4500." }
    body.price_bid = n
  }
  if (a.status) {
    const st = normalizeStatus(a.status)
    if (!st) return { ok: false, reason: `"${a.status}" is not a stage the CRM has.` }
    body.status = st
  }
  return { ok: true, body }
}

/**
 * fl-api UPSERTS by email (#137529): an address it already has answers with that lead, unchanged.
 * Saying "added" then would be false, so a returned name that is not the one sent means it matched.
 */
export function matchedExisting(sent: Record<string, unknown>, got: any): boolean {
  if (!sent.email) return false
  return String(got?.name ?? "").trim().toLowerCase() !== String(sent.name ?? "").trim().toLowerCase()
}
