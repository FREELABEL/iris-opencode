/**
 * Read .xlsx and .docx in the webview, with no dependency (#186585).
 *
 * Both are zip archives of XML. The platform already has everything needed to open them —
 * DecompressionStream("deflate-raw") for the zip entries and DOMParser for the XML — so this
 * is a reader of ~200 lines instead of a library. That matters more than size: the npm build of
 * SheetJS is years stale with open CVEs (prototype pollution, ReDoS), and a spreadsheet parser
 * runs in the app's own origin.
 *
 * VALUES, NOT FORMULAS. A cell shows its cached value; a formula cell that has none (openpyxl
 * writes formulas without computing them) shows the formula text, e.g. "=SUM(B2:B9)". This is a
 * viewer; "Open in Excel" is the fallback for anything it does not show.
 *
 * Never throws on bad input — callers get `{ error }` and show the Open-in-app fallback.
 */

export interface Sheet {
  name: string
  rows: string[][]
}
export type DocxBlock = { type: "p"; text: string; heading?: number } | { type: "table"; rows: string[][] }

const MAX_ROWS = 5000
const MAX_COLS = 200

/* ---------- zip ---------- */

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as Uint8Array<ArrayBuffer>])
    .stream()
    .pipeThrough(new DecompressionStream("deflate-raw"))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** Every entry of a zip, by name, read lazily. Uses the central directory, so data descriptors work. */
export function zipEntries(buf: Uint8Array): Map<string, () => Promise<Uint8Array>> {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  // End of central directory: signature 0x06054b50, searched from the end (comment ≤ 64 KB).
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error("not a zip file")
  const count = view.getUint16(eocd + 10, true)
  let p = view.getUint32(eocd + 16, true)
  const out = new Map<string, () => Promise<Uint8Array>>()
  const dec = new TextDecoder()
  for (let n = 0; n < count; n++) {
    if (view.getUint32(p, true) !== 0x02014b50) throw new Error("corrupt zip directory")
    const method = view.getUint16(p + 10, true)
    const csize = view.getUint32(p + 20, true)
    const nameLen = view.getUint16(p + 28, true)
    const extraLen = view.getUint16(p + 30, true)
    const commentLen = view.getUint16(p + 32, true)
    const local = view.getUint32(p + 42, true)
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nameLen))
    p += 46 + nameLen + extraLen + commentLen
    out.set(name, async () => {
      if (view.getUint32(local, true) !== 0x04034b50) throw new Error(`corrupt entry ${name}`)
      const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true)
      const raw = buf.subarray(start, start + csize)
      if (method === 0) return raw
      if (method === 8) return inflateRaw(raw)
      throw new Error(`unsupported compression ${method}`)
    })
  }
  return out
}

async function xml(entries: Map<string, () => Promise<Uint8Array>>, name: string): Promise<Document | undefined> {
  const get = entries.get(name)
  if (!get) return undefined
  const text = new TextDecoder().decode(await get())
  const doc = new DOMParser().parseFromString(text, "application/xml")
  if (doc.getElementsByTagName("parsererror").length) throw new Error(`bad XML in ${name}`)
  return doc
}

/**
 * Namespace-agnostic lookup — OOXML prefixes vary (x:, w:, none). The prefix is stripped by hand
 * because not every DOM does it: browsers report `localName` "t" for <w:t>, happy-dom reports "w:t".
 */
const localOf = (n: { localName: string | null; name?: string }) => {
  const l = n.localName ?? n.name ?? ""
  const i = l.indexOf(":")
  return i < 0 ? l : l.slice(i + 1)
}
const byLocal = (root: Element | Document, local: string) =>
  Array.from(root.getElementsByTagName("*")).filter((e) => localOf(e) === local)
const childrenByLocal = (el: Element, local: string) => Array.from(el.children).filter((e) => localOf(e) === local)
const attrLocal = (el: Element, local: string) => Array.from(el.attributes).find((a) => localOf(a) === local)?.value

/* ---------- xlsx ---------- */

/** "C12" -> 2 (zero-based column). */
export function columnIndex(ref: string): number {
  const letters = /^[A-Z]+/i.exec(ref)?.[0].toUpperCase() ?? "A"
  let n = 0
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

export async function readXlsx(bytes: Uint8Array): Promise<{ sheets: Sheet[] } | { error: string }> {
  try {
    const entries = zipEntries(bytes)
    const book = await xml(entries, "xl/workbook.xml")
    if (!book) return { error: "not a spreadsheet (no xl/workbook.xml)" }
    const rels = await xml(entries, "xl/_rels/workbook.xml.rels")
    const target = new Map<string, string>()
    for (const r of rels ? byLocal(rels, "Relationship") : []) {
      const t = r.getAttribute("Target") ?? ""
      target.set(r.getAttribute("Id") ?? "", t.startsWith("/") ? t.slice(1) : `xl/${t.replace(/^\.\//, "")}`)
    }
    const shared: string[] = []
    const sst = await xml(entries, "xl/sharedStrings.xml")
    for (const si of sst ? byLocal(sst, "si") : [])
      shared.push(
        byLocal(si, "t")
          .map((t) => t.textContent ?? "")
          .join(""),
      )

    const sheets: Sheet[] = []
    for (const s of byLocal(book, "sheet")) {
      const rid = s.getAttribute("r:id") ?? attrLocal(s, "id") ?? ""
      const path = target.get(rid) ?? `xl/worksheets/sheet${sheets.length + 1}.xml`
      const ws = await xml(entries, path)
      const rows: string[][] = []
      for (const row of ws ? byLocal(ws, "row").slice(0, MAX_ROWS) : []) {
        const r = Number(row.getAttribute("r") ?? rows.length + 1) - 1
        const cells: string[] = []
        for (const c of childrenByLocal(row, "c")) {
          const col = c.getAttribute("r") ? columnIndex(c.getAttribute("r")!) : cells.length
          if (col >= MAX_COLS) continue
          const type = c.getAttribute("t")
          const v = childrenByLocal(c, "v")[0]?.textContent ?? ""
          const f = childrenByLocal(c, "f")[0]?.textContent
          let text: string
          if (type === "s") text = shared[Number(v)] ?? ""
          else if (type === "inlineStr")
            text = byLocal(c, "t")
              .map((t) => t.textContent ?? "")
              .join("")
          else if (type === "b") text = v === "1" ? "TRUE" : v === "0" ? "FALSE" : v
          else text = v !== "" ? v : f ? `=${f}` : ""
          while (cells.length < col) cells.push("")
          cells[col] = text
        }
        while (rows.length < r) rows.push([])
        rows[r] = cells
      }
      const width = Math.max(0, ...rows.map((r) => r.length))
      sheets.push({
        name: s.getAttribute("name") ?? `Sheet ${sheets.length + 1}`,
        rows: rows.map((r) => pad(r, width)),
      })
    }
    return { sheets }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
}

const pad = (r: string[], w: number) => (r.length >= w ? r : [...r, ...Array(w - r.length).fill("")])

/* ---------- docx ---------- */

const paraText = (p: Element) =>
  Array.from(p.getElementsByTagName("*"))
    .map((e) => {
      const l = localOf(e)
      return l === "t" ? (e.textContent ?? "") : l === "tab" ? "\t" : l === "br" ? "\n" : ""
    })
    .join("")

export async function readDocx(bytes: Uint8Array): Promise<{ blocks: DocxBlock[] } | { error: string }> {
  try {
    const entries = zipEntries(bytes)
    const doc = await xml(entries, "word/document.xml")
    if (!doc) return { error: "not a Word document (no word/document.xml)" }
    const body = byLocal(doc, "body")[0]
    const blocks: DocxBlock[] = []
    for (const el of body ? Array.from(body.children) : []) {
      const tag = localOf(el)
      if (tag === "p") {
        const style = byLocal(el, "pStyle")[0]
        const val = style ? (attrLocal(style, "val") ?? "") : ""
        const h = /^(?:Heading|Title)(\d)?$/i.exec(val)
        blocks.push({ type: "p", text: paraText(el), heading: h ? Number(h[1] ?? 1) : undefined })
      } else if (tag === "tbl") {
        const rows = childrenByLocal(el, "tr").map((tr) =>
          childrenByLocal(tr, "tc").map((tc) => childrenByLocal(tc, "p").map(paraText).join("\n")),
        )
        blocks.push({ type: "table", rows })
      }
    }
    return { blocks }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
}

/* ---------- rendering docx into the artifact sandbox ---------- */

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

/**
 * The docx as an HTML body. Every string is escaped — the document's text is data, never markup —
 * and it still goes into the same sandboxed srcdoc as any artifact (ADR-01).
 */
export function docxHtml(blocks: DocxBlock[]): string {
  const parts = blocks.map((b) => {
    if (b.type === "table")
      return `<table>${b.rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c).replace(/\n/g, "<br>")}</td>`).join("")}</tr>`).join("")}</table>`
    if (!b.text.trim()) return ""
    const tag = b.heading ? `h${Math.min(b.heading + 1, 4)}` : "p"
    return `<${tag}>${esc(b.text).replace(/\n/g, "<br>")}</${tag}>`
  })
  // Same frame as a markdown artifact: a white page with dark text. NOT `color-scheme: light
  // dark` — the frame paints white, so a dark-mode viewer got white text on white (measured).
  // A real <head>, so sandboxedDocument puts its CSP meta first.
  return (
    `<!doctype html><html><head><meta charset="utf-8"><style>` +
    `body{font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;color:#1d1d1f;background:#fff;max-width:760px;margin:0 auto;padding:24px 20px}` +
    `table{border-collapse:collapse;margin:12px 0}td{border:1px solid #ddd;padding:4px 8px;vertical-align:top}` +
    `h2,h3,h4{line-height:1.25}</style></head><body>${parts.join("\n")}</body></html>`
  )
}

/**
 * Where a sheet's COLUMN HEADER is. Row 1 is often a title and a note or two — the agent's
 * equipment sheet opens "Open Mic / Live Recording — Equipment Sheet", with its real header four
 * rows down. Pinning row 1 put the title in the sticky header (measured, 2026-09-23).
 *
 * The header is the first row, within the first 15, that fills most of the columns in use
 * (at least 2 cells and 60% of the width). Rows above it are a preamble, shown as plain text.
 * No such row -> -1: no header, every row is data.
 */
export function headerRowIndex(rows: string[][]): number {
  const filled = (r: string[]) => r.filter((c) => c.trim() !== "").length
  const width = Math.max(0, ...rows.map(filled))
  if (width < 2) return -1
  const need = Math.max(2, Math.ceil(width * 0.6))
  const limit = Math.min(rows.length, 15)
  for (let i = 0; i < limit; i++) if (filled(rows[i]) >= need) return i
  return -1
}
