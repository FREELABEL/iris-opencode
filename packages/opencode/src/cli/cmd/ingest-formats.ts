// ============================================================================
// What a file BECOMES when you ingest it.
//
// `iris atlas ingest` used to know exactly one format: CSV became a dataset, and
// everything else became a blob attachment. A .md file, a .docx, a spreadsheet and an
// HTML artifact all landed as opaque uploads — present in the bloq, invisible to search,
// unreadable by an agent, and not an Atlas record in any sense that matters.
//
// This module answers one question — what KIND of record is this file? — and provides the
// readers for each. Breadth over depth deliberately: a .docx that arrives as plain
// paragraphs is worth far more than a .docx that arrives as a blob, and a spreadsheet
// whose first sheet becomes a real dataset is worth more than one that becomes nothing.
//
// NOTHING HERE ADDS A DEPENDENCY. .xlsx and .docx are both ZIP containers of XML, and the
// repo already ships @zip.js/zip.js and turndown.
// ============================================================================

import path from "path"
import { readFileSync } from "fs"

export type IngestKind = "table" | "document" | "artifact" | "attachment"

/** Column types we are willing to claim from a sample. Deliberately few. */
export type ColumnType = "integer" | "decimal" | "boolean" | "date" | "text" | "empty"

export interface ColumnSchema {
  name: string
  type: ColumnType
  /** How many of the sampled rows had no value. Surfaced because a mostly-empty column
   *  is usually an import mistake, and it is invisible in a 3-row preview. */
  blank: number
  /** Distinct values, capped — a low count on a big table means a category, not free text. */
  distinct: number
  sample: string
}

export interface TableData {
  headers: string[]
  rows: Record<string, string>[]
  /** Present for workbooks: every sheet found, and which one we actually read. */
  sheets?: string[]
  sheetUsed?: string
}

export interface DocumentData {
  /** Markdown, ready to store as an item body. */
  markdown: string
  title: string | null
}

// ── what is this file? ──────────────────────────────────────────────────────

const TABLE_EXT = new Set([".csv", ".tsv", ".xlsx", ".xlsm", ".xls"])
const DOC_EXT = new Set([".md", ".markdown", ".txt", ".text", ".docx"])
const ART_EXT = new Set([".html", ".htm"])

export function detectKind(file: string): IngestKind {
  const ext = path.extname(file).toLowerCase()
  if (TABLE_EXT.has(ext)) return "table"
  if (DOC_EXT.has(ext)) return "document"
  if (ART_EXT.has(ext)) return "artifact"
  return "attachment"
}

export function extOf(file: string): string {
  return path.extname(file).toLowerCase()
}

// ── delimited text ──────────────────────────────────────────────────────────

/**
 * RFC4180-ish: quoted fields, escaped quotes, and newlines INSIDE quotes.
 *
 * A split(",") parser looks correct until the first address column or the first quoted
 * note containing a comma, at which point every subsequent column silently shifts by one —
 * the failure produces a full-looking table with the wrong data in it, which is worse than
 * an error.
 */
export function parseDelimited(text: string, delimiter = ","): TableData {
  const rows: string[][] = []
  let row: string[] = []
  let field = ""
  let quoted = false

  const src = text.replace(/^﻿/, "") // strip BOM; Excel writes one and it poisons header 1
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++ }
        else quoted = false
      } else field += ch
    } else if (ch === '"') {
      quoted = true
    } else if (ch === delimiter) {
      row.push(field); field = ""
    } else if (ch === "\n") {
      row.push(field); field = ""
      rows.push(row); row = []
    } else if (ch !== "\r") {
      field += ch
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row) }

  const clean = rows.filter((r) => r.some((c) => c.trim() !== ""))
  if (!clean.length) return { headers: [], rows: [] }

  const headers = dedupeHeaders(clean[0].map((h) => h.trim()))
  const out = clean.slice(1).map((r) => {
    const o: Record<string, string> = {}
    headers.forEach((h, i) => { o[h] = (r[i] ?? "").trim() })
    return o
  })
  return { headers, rows: out }
}

/** Two columns named the same would silently overwrite each other in a row object. */
function dedupeHeaders(headers: string[]): string[] {
  const seen = new Map<string, number>()
  return headers.map((h, i) => {
    const base = h || `column_${i + 1}`
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    return n === 0 ? base : `${base}_${n + 1}`
  })
}

// ── xlsx ────────────────────────────────────────────────────────────────────

async function unzip(file: string): Promise<Map<string, string>> {
  const { ZipReader, Uint8ArrayReader, TextWriter } = await import("@zip.js/zip.js")
  const reader = new ZipReader(new Uint8ArrayReader(new Uint8Array(readFileSync(file))))
  const out = new Map<string, string>()
  try {
    for (const entry of await reader.getEntries()) {
      if (entry.directory || !entry.getData) continue
      // Only the XML parts matter; a workbook can carry megabytes of embedded images.
      if (!/\.(xml|rels)$/i.test(entry.filename)) continue
      out.set(entry.filename, await entry.getData(new TextWriter()))
    }
  } finally {
    await reader.close()
  }
  return out
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&") // last, or the others double-decode
}

/**
 * Excel stores a date as a NUMBER — days since 1899-12-30 — and records "this is a date"
 * only in the cell's format. Read the value alone and a renewal date arrives as 45930.
 * That is not a parse failure; it is a plausible-looking integer, which lands in the
 * dataset, types as numeric, and is never questioned again.
 *
 * So the formats have to be read: styles.xml maps each cell style to a numFmtId, the
 * built-in ids below are dates, and any custom format whose code contains y/m/d outside
 * quotes is one too.
 */
const BUILTIN_DATE_FMTS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 57])

function dateStyleIndexes(stylesXml: string | undefined): Set<number> {
  const out = new Set<number>()
  if (!stylesXml) return out

  const custom = new Map<number, string>()
  for (const m of stylesXml.matchAll(/<numFmt[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/g)) {
    custom.set(Number(m[1]), decodeXmlEntities(m[2]))
  }

  const cellXfs = stylesXml.match(/<cellXfs[\s\S]*?<\/cellXfs>/)?.[0] ?? ""
  const xfs = [...cellXfs.matchAll(/<xf\b[^>]*>/g)].map((m) => m[0])
  xfs.forEach((xf, i) => {
    const id = Number(xf.match(/numFmtId="(\d+)"/)?.[1] ?? "0")
    if (BUILTIN_DATE_FMTS.has(id)) { out.add(i); return }
    const code = custom.get(id)
    // Strip quoted literals first: a currency format like "\"yen\"#,##0" is not a date.
    if (code && /[ymd]/i.test(code.replace(/"[^"]*"/g, "").replace(/\\./g, ""))) out.add(i)
  })
  return out
}

/** Excel serial -> ISO. Anchored at 1899-12-30, which absorbs the 1900 leap-year bug. */
function serialToIso(n: number): string {
  const ms = Math.round((n - 25569) * 86400 * 1000)
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return String(n)
  const iso = d.toISOString()
  // A whole number is a date; a fraction carries a time of day worth keeping.
  return Number.isInteger(n) ? iso.slice(0, 10) : iso.slice(0, 19).replace("T", " ")
}

/** "BC" -> 54. Excel addresses columns in base-26 letters, not indices. */
function colToIndex(ref: string): number {
  const letters = ref.replace(/[0-9]/g, "")
  let n = 0
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

/**
 * Read one sheet of a workbook into rows.
 *
 * Only the FIRST sheet by default (or `sheetName`). Multi-sheet workbooks are named in
 * `sheets` so the caller can say so out loud rather than silently dropping data — the
 * abstraction for treating several sheets as related datasets is a real design question,
 * and quietly importing sheet 1 while pretending the file is done is the wrong answer to it.
 */
export async function parseXlsx(file: string, sheetName?: string): Promise<TableData> {
  const files = await unzip(file)

  const shared: string[] = []
  const sharedXml = files.get("xl/sharedStrings.xml")
  if (sharedXml) {
    for (const si of sharedXml.match(/<si>[\s\S]*?<\/si>/g) ?? []) {
      // A styled cell splits its text across several <t> runs; concatenating is what
      // makes "Total Revenue" arrive whole instead of as "Total" and " Revenue".
      const parts = [...si.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1])
      shared.push(decodeXmlEntities(parts.join("")))
    }
  }

  const wb = files.get("xl/workbook.xml") ?? ""
  const sheets = [...wb.matchAll(/<sheet[^>]*name="([^"]*)"[^>]*\/?>/g)].map((m) => decodeXmlEntities(m[1]))

  let target = "xl/worksheets/sheet1.xml"
  let used = sheets[0] ?? "Sheet1"
  if (sheetName) {
    const idx = sheets.findIndex((s) => s.toLowerCase() === sheetName.toLowerCase())
    if (idx === -1) throw new Error(`No sheet named "${sheetName}". Found: ${sheets.join(", ") || "(none)"}`)
    target = `xl/worksheets/sheet${idx + 1}.xml`
    used = sheets[idx]
  }
  const sheetXml = files.get(target) ?? files.get("xl/worksheets/sheet1.xml")
  if (!sheetXml) throw new Error("No worksheet found inside the workbook.")

  const dateStyles = dateStyleIndexes(files.get("xl/styles.xml"))

  const grid: string[][] = []
  for (const rowXml of sheetXml.match(/<row[\s\S]*?(?:\/>|<\/row>)/g) ?? []) {
    const cells: string[] = []
    for (const m of rowXml.matchAll(/<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = m[1] ?? ""
      const inner = m[2] ?? ""
      const ref = attrs.match(/r="([A-Z]+)\d+"/)?.[1]
      const type = attrs.match(/t="([^"]+)"/)?.[1]
      let value = ""
      if (type === "s") {
        const i = Number(inner.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? "-1")
        value = shared[i] ?? ""
      } else if (type === "inlineStr") {
        value = decodeXmlEntities([...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join(""))
      } else {
        value = decodeXmlEntities(inner.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? "")
        const styleIdx = Number(attrs.match(/s="(\d+)"/)?.[1] ?? "-1")
        if (value !== "" && dateStyles.has(styleIdx) && !Number.isNaN(Number(value))) {
          value = serialToIso(Number(value))
        }
      }
      const at = ref ? colToIndex(ref) : cells.length
      while (cells.length < at) cells.push("") // a skipped cell is an empty column, not a shift
      cells[at] = value
    }
    grid.push(cells)
  }

  const nonEmpty = grid.filter((r) => r.some((c) => (c ?? "").trim() !== ""))
  if (!nonEmpty.length) return { headers: [], rows: [], sheets, sheetUsed: used }

  const width = Math.max(...nonEmpty.map((r) => r.length))
  const headers = dedupeHeaders(
    Array.from({ length: width }, (_, i) => (nonEmpty[0][i] ?? "").trim()),
  )
  const rows = nonEmpty.slice(1).map((r) => {
    const o: Record<string, string> = {}
    headers.forEach((h, i) => { o[h] = (r[i] ?? "").trim() })
    return o
  })
  return { headers, rows, sheets, sheetUsed: used }
}

// ── documents ───────────────────────────────────────────────────────────────

/** docx paragraphs -> markdown. Headings and list items survive; nothing else is claimed. */
export async function parseDocx(file: string): Promise<DocumentData> {
  const files = await unzip(file)
  const xml = files.get("word/document.xml")
  if (!xml) throw new Error("Not a readable .docx (no word/document.xml inside).")

  const lines: string[] = []
  for (const p of xml.match(/<w:p[\s>][\s\S]*?<\/w:p>|<w:p\/>/g) ?? []) {
    const text = decodeXmlEntities(
      [...p.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map((m) => m[1]).join(""),
    ).trim()
    if (!text) { lines.push(""); continue }

    const style = p.match(/<w:pStyle\s+w:val="([^"]+)"/)?.[1] ?? ""
    const heading = style.match(/^Heading(\d)$/i)?.[1]
    if (heading) lines.push(`${"#".repeat(Math.min(Number(heading), 6))} ${text}`)
    else if (/<w:numPr>/.test(p)) lines.push(`- ${text}`)
    else lines.push(text)
  }

  const markdown = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()
  const title = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? null
  return { markdown, title }
}

/** Plain text / markdown. A .txt is already valid markdown; we do not reformat it. */
export function parsePlain(file: string): DocumentData {
  const markdown = readFileSync(file, "utf8").replace(/^﻿/, "").trim()
  const title = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? null
  return { markdown, title }
}

/** HTML -> markdown, for when the caller wants prose rather than an artifact. */
export async function htmlToMarkdown(html: string): Promise<string> {
  const TurndownService = (await import("turndown")).default as any
  const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" })
  return String(td.turndown(html)).trim()
}

export function titleFromHtml(html: string, file: string): string {
  const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim()
  if (t) return decodeXmlEntities(t)
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1]
  if (h1) {
    const text = h1.replace(/<[^>]+>/g, "").trim()
    if (text) return decodeXmlEntities(text)
  }
  return path.basename(file, path.extname(file))
}

// ── schema ──────────────────────────────────────────────────────────────────

const BOOLS = new Set(["true", "false", "yes", "no", "y", "n", "0", "1"])

function classify(v: string): ColumnType {
  const s = v.trim()
  if (s === "") return "empty"
  if (/^-?\d{1,3}(,\d{3})+$/.test(s)) return "integer" // 1,234,567
  if (/^-?\d+$/.test(s)) return "integer"
  // Currency and percentages are decimals wearing a costume; treating them as text means
  // the column cannot be summed, which is the whole reason it was imported.
  if (/^-?[$£€]?\s?-?\d*\.?\d+\s?%?$/.test(s) && /\d/.test(s)) return "decimal"
  if (/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?/.test(s)) return "date"
  if (/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(s)) return "date"
  if (BOOLS.has(s.toLowerCase())) return "boolean"
  return "text"
}

/**
 * Infer one type per column from the values actually present.
 *
 * Blanks never decide a type — a column of numbers with three gaps is still numeric — and
 * a single stray value demotes to text rather than being dropped, because guessing
 * "integer" for a column containing "N/A" turns that row into a silent null downstream.
 */
export function inferSchema(headers: string[], rows: Record<string, string>[], sampleSize = 500): ColumnSchema[] {
  const sample = rows.slice(0, sampleSize)
  return headers.map((h) => {
    const values = sample.map((r) => (r[h] ?? "").trim())
    const present = values.filter((v) => v !== "")
    const blank = values.length - present.length
    const types = new Set(present.map(classify))

    let type: ColumnType = "text"
    if (!present.length) type = "empty"
    else if (types.size === 1) type = [...types][0]
    else if (types.size === 2 && types.has("integer") && types.has("decimal")) type = "decimal"
    else if (types.size === 2 && types.has("date") && types.has("integer")) type = "date"

    // "0"/"1" columns classify as boolean AND integer-looking; if every value is 0/1 but the
    // header does not read like a flag, integer is the less surprising claim.
    if (type === "boolean" && present.every((v) => v === "0" || v === "1") && !/^(is|has|can|should)_|_flag$|^active$|^enabled$/i.test(h)) {
      type = "integer"
    }

    return {
      name: h,
      type,
      blank,
      distinct: new Set(present).size,
      sample: present[0] ?? "",
    }
  })
}
