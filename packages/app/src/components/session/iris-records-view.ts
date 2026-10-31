/**
 * Atlas › Schemas › Records — sort, filter and CSV (#189769). Pure, so the rules are tested
 * without a DOM.
 *
 * Sort and filter work on the page on screen; the table says so. Export reads every page, so a
 * file someone sends on is the dataset, not the 25 rows that happened to be loaded.
 */

export interface RecordColumn {
  key: string
  label: string
  type: string
}
export interface RecordRow {
  id: number
  data: Record<string, unknown>
}
export type SortDir = "asc" | "desc"

const NUMERIC = new Set(["number", "integer", "float", "decimal", "currency"])

/** What a cell reads as — the same text the table draws and the filter matches. */
export function cellString(v: unknown): string {
  if (v == null) return ""
  if (typeof v === "string") return v
  if (typeof v === "number" || typeof v === "boolean") return String(v)
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

/** Empty cells sort last in both directions — a blank is not the smallest value. */
export function sortRecords<R extends RecordRow>(rows: R[], col: RecordColumn | "id", dir: SortDir): R[] {
  const key = col === "id" ? undefined : col.key
  const numeric = col === "id" || NUMERIC.has(col.type)
  const val = (r: R) => (key === undefined ? r.id : r.data[key])
  const sign = dir === "asc" ? 1 : -1
  return [...rows].sort((a, b) => {
    const x = val(a)
    const y = val(b)
    const ex = x == null || x === ""
    const ey = y == null || y === ""
    if (ex && ey) return 0
    if (ex) return 1
    if (ey) return -1
    if (numeric) {
      const nx = Number(x)
      const ny = Number(y)
      if (!Number.isNaN(nx) && !Number.isNaN(ny)) return (nx - ny) * sign
    }
    return cellString(x).localeCompare(cellString(y), undefined, { numeric: true, sensitivity: "base" }) * sign
  })
}

/** Every word must appear somewhere in the row (any column, or the id). */
export function filterRecords<R extends RecordRow>(rows: R[], columns: RecordColumn[], q: string): R[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return rows
  return rows.filter((r) => {
    const hay = [String(r.id), ...columns.map((c) => cellString(r.data[c.key]))].join("\n").toLowerCase()
    return words.every((w) => hay.includes(w))
  })
}

/**
 * RFC 4180: quote a field that holds a comma, quote or line break, and double its quotes.
 * A field that a spreadsheet would run as a formula (=, +, -, @) is prefixed with ' so opening
 * the export cannot execute a cell someone typed.
 */
export function toCsv(columns: RecordColumn[], rows: RecordRow[]): string {
  const field = (raw: string) => {
    const s = /^[=+\-@\t\r]/.test(raw) && !/^[-+]?\d+(\.\d+)?$/.test(raw) ? `'${raw}` : raw
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const head = ["id", ...columns.map((c) => c.key)].map(field).join(",")
  const body = rows.map((r) => [String(r.id), ...columns.map((c) => cellString(r.data[c.key]))].map(field).join(","))
  return [head, ...body].join("\r\n") + "\r\n"
}
