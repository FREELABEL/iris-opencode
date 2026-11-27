/**
 * New lead and Import (#194506): what the two dialogs decide before the engine is asked. No I/O.
 * The engine checks everything again (`/iris/leads-api` create/import); this only lets the form
 * say what is wrong before a round trip.
 */

/** The stages a new lead can start in, as the CRM spells them. */
export const NEW_LEAD_STAGES = ["New", "Prospected", "Contacted", "Qualified", "Proposal", "In Negotiation", "Follow-Up", "On Hold", "Won", "Lost"] as const

export type NewLeadForm = { name: string; company: string; email: string; value: string; stage: string }
export const EMPTY_FORM: NewLeadForm = { name: "", company: "", email: "", value: "", stage: "New" }

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

/** Why the form can't be sent yet, as an i18n key, or undefined. */
export function newLeadProblem(f: NewLeadForm): "iris.leads.new.need" | "iris.leads.new.badEmail" | "iris.leads.new.badValue" | undefined {
  if (!f.name.trim() && !f.email.trim()) return "iris.leads.new.need"
  if (f.email.trim() && !EMAIL.test(f.email.trim())) return "iris.leads.new.badEmail"
  const v = f.value.replace(/[$,\s]/g, "")
  if (v && !(Number.isFinite(Number(v)) && Number(v) >= 0)) return "iris.leads.new.badValue"
  return undefined
}

/** The engine's `create` body. */
export function newLeadBody(f: NewLeadForm, bloqId: number) {
  return { name: f.name.trim(), email: f.email.trim(), company: f.company.trim(), value: f.value.trim(), status: f.stage, bloqId }
}

/** The import preview and result, as the engine answers them. */
export type ImportRowView = { row: number; lead?: { name: string; email?: string; company?: string; status?: string }; warning?: string; error?: string }
export type ImportPreview = {
  columns: { column: string; field: string | null }[]
  rows: ImportRowView[]
  total: number
  ready: number
  skipped: { row: number; reason: string }[]
  warnings: { row: number; reason: string }[]
}
export type ImportResult = { created: number; merged: number; skipped: { row: number; reason: string }[]; warnings: { row: number; reason: string }[]; stopped?: string }

/** A lead field the way a person reads it (an i18n key). */
export const FIELD_KEY = {
  name: "iris.leads.field.name",
  "name (with last name)": "iris.leads.field.name",
  email: "iris.leads.field.email",
  phone: "iris.leads.field.phone",
  company: "iris.leads.field.company",
  status: "iris.leads.field.stage",
  source: "iris.leads.field.source",
  notes: "iris.leads.field.notes",
  title: "iris.leads.field.title",
  external_id: "iris.leads.field.sourceId",
  segment: "iris.leads.field.segment",
} as const
export type FieldKey = (typeof FIELD_KEY)[keyof typeof FIELD_KEY]
export const fieldKey = (field: string | null): FieldKey | undefined => (field ? (FIELD_KEY as Record<string, FieldKey>)[field] : undefined)

/** How a preview row reads: ready, ready with a note, or skipped and why. */
export function rowState(r: ImportRowView): { tone: "success" | "warning" | "critical"; text?: string } {
  if (r.error) return { tone: "critical", text: r.error }
  if (r.warning) return { tone: "warning", text: r.warning }
  return { tone: "success" }
}

/** Reasons repeat on a big file; group them so the list says "No name: rows 4, 9, 12". */
export function groupReasons(list: { row: number; reason: string }[], max = 6): { reason: string; rows: number[]; more: number }[] {
  const by = new Map<string, number[]>()
  for (const x of list) by.set(x.reason, [...(by.get(x.reason) ?? []), x.row])
  return [...by.entries()].map(([reason, rows]) => ({ reason, rows: rows.slice(0, max), more: Math.max(0, rows.length - max) }))
}

/** Read a picked file as text, refusing anything that is not a CSV or is too big to be one. */
export const IMPORT_MAX_BYTES = 5_000_000
export function fileProblem(f: { name: string; size: number; type?: string }): "iris.leads.import.notCsv" | "iris.leads.import.tooBig" | undefined {
  if (f.size > IMPORT_MAX_BYTES) return "iris.leads.import.tooBig"
  if (!/\.csv$/i.test(f.name) && f.type !== "text/csv") return "iris.leads.import.notCsv"
  return undefined
}
