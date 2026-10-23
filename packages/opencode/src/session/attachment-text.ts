import { inflateRawSync } from "node:zlib"

/**
 * Turns an attached file into text the model can actually read — or into a plain statement that it
 * could not, so neither the person nor the model is left believing a file was read when it was not.
 *
 * Why this exists. A prompt attachment that is not an image or a PDF reaches the engine as a data:
 * URL and used to take one of two paths:
 *   - mime text/plain: decoded as UTF-8 and inlined WHOLE. A 6 MB CSV became a ~2M-token prompt and
 *     the upstream answered HTTP 400 — and because the attachment stays in the session history, every
 *     later message in that session failed the same way.
 *   - any other mime (a spreadsheet, say): forwarded as a file part, which the OpenAI-compatible SDK
 *     cannot encode, so the turn threw.
 * Both read as an unexplained error. This module reads spreadsheets and Word documents into text,
 * decodes the encodings Excel actually writes, and caps what is inlined with a note that says,
 * to the model, exactly what was left out.
 */

const ZIP = [0x50, 0x4b, 0x03, 0x04]
const CFB = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]

export const SPREADSHEET_MIMES = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel.sheet.macroenabled.12",
  "application/vnd.ms-excel",
  "application/vnd.oasis.opendocument.spreadsheet",
])

export const DOCUMENT_MIMES = new Set([
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/msword",
  "application/vnd.oasis.opendocument.text",
])

const OFFICE_EXTENSIONS = new Set(["xlsx", "xlsm", "xls", "ods", "docx", "doc", "odt"])

/** Characters inlined per attachment when the model's context window is unknown. */
export const DEFAULT_INLINE_CHARS = 150_000
const MIN_INLINE_CHARS = 32_000
const MAX_INLINE_CHARS = 600_000
/** Hard ceiling on what one zip entry may inflate to — a zip bomb must not take the engine down. */
const MAX_ENTRY_BYTES = 200 * 1024 * 1024

export type AttachmentText = { kind: "text"; text: string; format?: "spreadsheet" | "document" }
export type AttachmentUnreadable = { kind: "unreadable"; reason: string; fix: string }
export type AttachmentResult = AttachmentText | AttachmentUnreadable

function extension(name: string | undefined) {
  if (!name) return ""
  const base = name.split(/[\\/]/).pop() ?? ""
  const idx = base.lastIndexOf(".")
  return idx === -1 ? "" : base.slice(idx + 1).toLowerCase()
}

function startsWith(bytes: Uint8Array, sig: number[]) {
  if (bytes.length < sig.length) return false
  return sig.every((value, i) => bytes[i] === value)
}

/** Is this attachment one the engine should read itself, rather than hand to the provider as-is? */
export function needsTextResolution(mime: string) {
  const type = mime.split(";", 1)[0]!.trim().toLowerCase()
  if (type.startsWith("image/") || type === "application/pdf") return false
  if (type.startsWith("audio/") || type.startsWith("video/")) return false
  if (type === "application/x-directory") return false
  return true
}

export function isOfficeFile(mime: string, filename?: string) {
  const type = mime.split(";", 1)[0]!.trim().toLowerCase()
  return SPREADSHEET_MIMES.has(type) || DOCUMENT_MIMES.has(type) || OFFICE_EXTENSIONS.has(extension(filename))
}

export function dataUrlBytes(url: string) {
  const idx = url.indexOf(",")
  if (idx === -1) return new Uint8Array()
  const head = url.slice(0, idx)
  const body = url.slice(idx + 1)
  if (head.includes(";base64")) return new Uint8Array(Buffer.from(body, "base64"))
  return new TextEncoder().encode(decodeURIComponent(body))
}

// Windows-1252 differs from Latin-1 only in 0x80–0x9F, which is where Excel puts smart quotes,
// the euro sign and the dashes. Undefined slots map to U+FFFD.
const CP1252 = [
  0x20ac, 0xfffd, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0xfffd,
  0x017d, 0xfffd, 0xfffd, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a,
  0x0153, 0xfffd, 0x017e, 0x0178,
]

function decodeUtf16(bytes: Uint8Array, littleEndian: boolean) {
  const out: string[] = []
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const units: number[] = []
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    units.push(view.getUint16(i, littleEndian))
    if (units.length === 8192) {
      out.push(String.fromCharCode(...units))
      units.length = 0
    }
  }
  out.push(String.fromCharCode(...units))
  return out.join("")
}

/**
 * Decode text the way the files people attach are actually encoded: UTF-8 (with or without the BOM
 * Excel writes), UTF-16 with a BOM (Excel's "Unicode Text"), and otherwise Windows-1252 — what
 * Excel on Windows writes for "CSV". Never throws; never shows a BOM to the model.
 */
export function decodeText(bytes: Uint8Array) {
  if (startsWith(bytes, [0xef, 0xbb, 0xbf])) return new TextDecoder("utf-8").decode(bytes.subarray(3))
  if (startsWith(bytes, [0xff, 0xfe])) return decodeUtf16(bytes.subarray(2), true)
  if (startsWith(bytes, [0xfe, 0xff])) return decodeUtf16(bytes.subarray(2), false)
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    let out = ""
    for (const byte of bytes) out += String.fromCharCode(byte >= 0x80 && byte <= 0x9f ? CP1252[byte - 0x80]! : byte)
    return out
  }
}

function isBinary(bytes: Uint8Array) {
  const sample = bytes.subarray(0, 4096)
  if (sample.length === 0) return false
  let odd = 0
  for (const byte of sample) {
    if (byte === 0) return true
    if (byte < 9 || (byte > 13 && byte < 32)) odd += 1
  }
  return odd / sample.length > 0.3
}

// ── zip ────────────────────────────────────────────────────────────────────────────────────────

type ZipEntry = { name: string; method: number; compressed: number; offset: number }

function readZip(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let eocd = -1
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd === -1) throw new Error("not a readable zip archive")
  const count = view.getUint16(eocd + 10, true)
  let cursor = view.getUint32(eocd + 16, true)
  const entries = new Map<string, ZipEntry>()
  const decoder = new TextDecoder()
  for (let n = 0; n < count; n++) {
    if (cursor + 46 > bytes.length || view.getUint32(cursor, true) !== 0x02014b50) break
    const method = view.getUint16(cursor + 10, true)
    const compressed = view.getUint32(cursor + 20, true)
    const nameLength = view.getUint16(cursor + 28, true)
    const extraLength = view.getUint16(cursor + 30, true)
    const commentLength = view.getUint16(cursor + 32, true)
    const offset = view.getUint32(cursor + 42, true)
    const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength))
    entries.set(name, { name, method, compressed, offset })
    cursor += 46 + nameLength + extraLength + commentLength
  }
  const read = (name: string) => {
    const entry = entries.get(name)
    if (!entry) return undefined
    const local = entry.offset
    if (view.getUint32(local, true) !== 0x04034b50) throw new Error(`corrupt zip entry ${name}`)
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true)
    const raw = bytes.subarray(start, start + entry.compressed)
    const data =
      entry.method === 0
        ? raw
        : entry.method === 8
          ? new Uint8Array(inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES }))
          : undefined
    if (!data) throw new Error(`unsupported zip compression in ${name}`)
    return new TextDecoder("utf-8").decode(data)
  }
  return { names: () => [...entries.keys()], has: (name: string) => entries.has(name), read }
}

// ── xml helpers ────────────────────────────────────────────────────────────────────────────────

function unescapeXml(value: string) {
  return value.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|lt|gt|amp|quot|apos);/g, (_, code: string) => {
    if (code === "lt") return "<"
    if (code === "gt") return ">"
    if (code === "amp") return "&"
    if (code === "quot") return '"'
    if (code === "apos") return "'"
    const n = code.startsWith("#x") ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10)
    return Number.isFinite(n) ? String.fromCodePoint(n) : ""
  })
}

function attr(tag: string, name: string) {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(tag)
  if (!match) return undefined
  return unescapeXml(match[1] ?? match[2] ?? "")
}

/** Concatenate every <t> run inside a fragment, skipping phonetic guides (<rPh>). */
function runs(fragment: string) {
  const body = fragment.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "")
  let out = ""
  for (const match of body.matchAll(/<(?:\w+:)?t\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?t>)/g)) {
    out += unescapeXml(match[1] ?? "")
  }
  return out
}

function csvCell(value: string) {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

function columnIndex(ref: string | undefined) {
  if (!ref) return undefined
  const letters = /^[A-Z]+/.exec(ref)?.[0]
  if (!letters) return undefined
  let n = 0
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

// ── xlsx ───────────────────────────────────────────────────────────────────────────────────────

const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 57])

function isDateFormat(code: string) {
  const bare = code.replace(/"[^"]*"|\[[^\]]*\]|\\./g, "")
  return /[dmyhs]/i.test(bare) && !/^[#0.,%\s]*$/.test(bare)
}

function dateStyles(styles: string | undefined) {
  const dates = new Set<number>()
  if (!styles) return dates
  const custom = new Map<number, string>()
  for (const match of styles.matchAll(/<numFmt\b([^>]*)\/?>/g)) {
    const id = Number(attr(match[1]!, "numFmtId"))
    const code = attr(match[1]!, "formatCode")
    if (Number.isFinite(id) && code) custom.set(id, code)
  }
  const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles)?.[1] ?? ""
  let index = 0
  for (const match of xfs.matchAll(/<xf\b([^>]*?)(?:\/>|>[\s\S]*?<\/xf>)/g)) {
    const id = Number(attr(match[1]!, "numFmtId") ?? 0)
    const code = custom.get(id)
    if (BUILTIN_DATE_FORMATS.has(id) || (code && isDateFormat(code))) dates.add(index)
    index++
  }
  return dates
}

function serialToDate(serial: number, date1904: boolean) {
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30)
  const ms = Math.round(serial * 86_400_000)
  const iso = new Date(epoch + ms).toISOString()
  const day = iso.slice(0, 10)
  const time = iso.slice(11, 16)
  if (serial < 1) return iso.slice(11, 19)
  return time === "00:00" ? day : `${day} ${time}`
}

function xlsxToText(zip: ReturnType<typeof readZip>) {
  const workbook = zip.read("xl/workbook.xml") ?? ""
  const date1904 = /<workbookPr\b[^>]*date1904\s*=\s*"(?:1|true)"/.test(workbook)
  const rels = new Map<string, string>()
  for (const match of (zip.read("xl/_rels/workbook.xml.rels") ?? "").matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const id = attr(match[1]!, "Id")
    const target = attr(match[1]!, "Target")
    if (id && target) rels.set(id, target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`)
  }
  const shared: string[] = []
  for (const match of (zip.read("xl/sharedStrings.xml") ?? "").matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g)) {
    shared.push(runs(match[1] ?? ""))
  }
  const dates = dateStyles(zip.read("xl/styles.xml"))

  const sheets: string[] = []
  for (const match of workbook.matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const name = attr(match[1]!, "name") ?? `Sheet${sheets.length + 1}`
    const rid = attr(match[1]!, "r:id") ?? attr(match[1]!, "id")
    const state = attr(match[1]!, "state")
    const path = (rid && rels.get(rid)) ?? `xl/worksheets/sheet${sheets.length + 1}.xml`
    const xml = zip.has(path) ? (zip.read(path) ?? "") : ""
    const lines: string[] = []
    for (const row of xml.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const cells: string[] = []
      let next = 0
      for (const cell of (row[1] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const tag = cell[1] ?? ""
        const body = cell[2] ?? ""
        const col = columnIndex(attr(tag, "r")) ?? next
        const type = attr(tag, "t")
        const style = Number(attr(tag, "s") ?? -1)
        const raw = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body)?.[1]
        let value = ""
        if (type === "s") value = shared[Number(raw)] ?? ""
        else if (type === "inlineStr") value = runs(/<is\b[^>]*>([\s\S]*?)<\/is>/.exec(body)?.[1] ?? "")
        else if (type === "b") value = raw === "1" ? "TRUE" : raw === "0" ? "FALSE" : ""
        else if (type === "d" && raw !== undefined) value = unescapeXml(raw).replace(/T00:00:00(?:\.000)?Z?$/, "")
        else if (raw !== undefined) value = unescapeXml(raw)
        else {
          // A formula with no cached result (files written by scripts, never opened in Excel):
          // show the formula rather than an empty cell that reads as "no value".
          const formula = /<f\b[^>]*>([\s\S]*?)<\/f>/.exec(body)?.[1]
          if (formula) value = `=${unescapeXml(formula)}`
        }
        if (value !== "" && (type === undefined || type === "n") && dates.has(style) && Number.isFinite(Number(value))) {
          value = serialToDate(Number(value), date1904)
        }
        while (cells.length < col) cells.push("")
        cells[col] = csvCell(value)
        next = col + 1
      }
      while (cells.length && cells[cells.length - 1] === "") cells.pop()
      lines.push(cells.join(","))
    }
    while (lines.length && lines[lines.length - 1] === "") lines.pop()
    const label = `## Sheet "${name}"${state && state !== "visible" ? ` (${state})` : ""} — ${lines.length} row${lines.length === 1 ? "" : "s"}`
    sheets.push(lines.length ? `${label}\n${lines.join("\n")}` : `${label}\n(empty sheet)`)
  }
  if (sheets.length === 0) return "(this workbook has no sheets)"
  return sheets.join("\n\n")
}

// ── docx ───────────────────────────────────────────────────────────────────────────────────────

function docxToText(zip: ReturnType<typeof readZip>) {
  const xml = zip.read("word/document.xml") ?? ""
  const paragraphs: string[] = []
  for (const match of xml.matchAll(/<w:p\b[^>]*?(?:\/>|>([\s\S]*?)<\/w:p>)/g)) {
    const body = (match[1] ?? "").replace(/<w:tab\b[^>]*\/>/g, "<w:t>\t</w:t>").replace(/<w:br\b[^>]*\/>/g, "<w:t>\n</w:t>")
    paragraphs.push(runs(body))
  }
  return paragraphs.join("\n").replace(/\n{3,}/g, "\n\n").trim()
}

// ── entry point ────────────────────────────────────────────────────────────────────────────────

const RESAVE = "Open it, then File › Save As › Excel Workbook (.xlsx) or CSV, and attach that."

/**
 * Read an attachment into text, or say why it cannot be read. Decides by the file's BYTES first,
 * so a workbook saved as "report.csv" is read as a workbook, not inlined as binary garbage.
 */
export function attachmentToText(input: { bytes: Uint8Array; mime: string; filename?: string }): AttachmentResult {
  const { bytes } = input
  const ext = extension(input.filename)

  if (startsWith(bytes, ZIP)) {
    let zip: ReturnType<typeof readZip>
    try {
      zip = readZip(bytes)
    } catch (error) {
      return {
        kind: "unreadable",
        reason: `it looks like an Office file but is damaged (${error instanceof Error ? error.message : String(error)})`,
        fix: RESAVE,
      }
    }
    try {
      if (zip.has("xl/workbook.xml")) return { kind: "text", text: xlsxToText(zip), format: "spreadsheet" }
      if (zip.has("word/document.xml")) return { kind: "text", text: docxToText(zip), format: "document" }
    } catch (error) {
      return {
        kind: "unreadable",
        reason: `it could not be unpacked (${error instanceof Error ? error.message : String(error)})`,
        fix: RESAVE,
      }
    }
    const mimetype = zip.has("mimetype") ? (zip.read("mimetype") ?? "").trim() : ""
    if (mimetype.includes("opendocument.spreadsheet") || ext === "ods")
      return {
        kind: "unreadable",
        reason: "OpenDocument spreadsheets (.ods) can't be read yet",
        fix: "Save it as Excel Workbook (.xlsx) or CSV and attach that.",
      }
    if (mimetype.includes("opendocument") || ext === "odt")
      return {
        kind: "unreadable",
        reason: "OpenDocument files can't be read yet",
        fix: "Save it as Word (.docx), PDF or plain text and attach that.",
      }
    if (zip.names().some((name) => name.startsWith("ppt/")))
      return {
        kind: "unreadable",
        reason: "PowerPoint files can't be read yet",
        fix: "Export it as PDF and attach that.",
      }
    return {
      kind: "unreadable",
      reason: "it is a zip archive",
      fix: "Unzip it and attach the files inside.",
    }
  }

  if (startsWith(bytes, CFB)) {
    if (ext === "xlsx" || ext === "xlsm" || ext === "docx")
      return {
        kind: "unreadable",
        reason: "it is password-protected (encrypted)",
        fix: "Remove the password (File › Info › Protect), or save a copy as CSV, and attach that.",
      }
    if (ext === "doc")
      return {
        kind: "unreadable",
        reason: "it is an old-format Word document (.doc)",
        fix: "Open it, then File › Save As › Word Document (.docx) or PDF, and attach that.",
      }
    return {
      kind: "unreadable",
      reason: "it is an old-format Excel workbook (.xls) or an encrypted Office file",
      fix: RESAVE,
    }
  }

  if (isBinary(bytes) && !startsWith(bytes, [0xff, 0xfe]) && !startsWith(bytes, [0xfe, 0xff]))
    return {
      kind: "unreadable",
      reason: "it is a binary file, not text",
      fix: "Attach it as text, CSV, Excel (.xlsx), Word (.docx), PDF or an image.",
    }

  return { kind: "text", text: decodeText(bytes) }
}

/** How many characters of one attachment to inline, given the model's context window in tokens. */
export function inlineBudget(contextTokens?: number) {
  if (!contextTokens || !Number.isFinite(contextTokens) || contextTokens <= 0) return DEFAULT_INLINE_CHARS
  // ~3 characters per token for tabular text; one attachment may use about half the window.
  return Math.max(MIN_INLINE_CHARS, Math.min(MAX_INLINE_CHARS, Math.floor(contextTokens * 1.5)))
}

function size(chars: number) {
  if (chars >= 1024 * 1024) return `${(chars / 1024 / 1024).toFixed(1)} MB`
  return `${Math.max(1, Math.round(chars / 1024))} KB`
}

/**
 * Cap inlined text. Over budget, keep whole lines from the top and SAY what was dropped — to the
 * model, in the prompt — so it cannot report a total over rows it never saw.
 */
export function limitInlineText(input: { text: string; filename?: string; budget: number }) {
  const { text, budget } = input
  if (text.length <= budget) return { text, truncated: false as const }
  const cut = text.lastIndexOf("\n", budget)
  const kept = text.slice(0, cut > 0 ? cut : budget)
  const total = text.split("\n").length
  const shown = kept.split("\n").length
  const name = input.filename ?? "the attachment"
  const onDisk = input.filename && /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(input.filename)
  const note =
    `[IRIS: "${name}" is ${size(text.length)} — too large to send whole. Only the first ${shown.toLocaleString("en-US")} of ` +
    `${total.toLocaleString("en-US")} lines (${size(kept.length)}) are included above; the other ` +
    `${(total - shown).toLocaleString("en-US")} lines were NOT sent to you. Do not state totals, counts or values ` +
    `for rows you have not seen. ` +
    (onDisk
      ? `The full file is on disk at ${input.filename} — use your file tools (Read with an offset, Grep, or a shell command) to work with all of it, or tell the user you only read the beginning.]`
      : `Tell the user you only read the beginning, and ask them to split the file or attach only the part they need.]`)
  return { text: `${kept}\n${note}`, truncated: true as const, shownLines: shown, totalLines: total }
}

/** The note the model receives in place of a file it could not be given. */
export function unreadableNote(filename: string | undefined, result: AttachmentUnreadable) {
  return (
    `[IRIS: the attachment "${filename ?? "file"}" was NOT included — ${result.reason}. You have not seen its contents; ` +
    `do not guess or describe them. Tell the user: ${result.fix}]`
  )
}

/** The message the person sees when a file could not be given to the model. */
export function unreadableMessage(filename: string | undefined, result: AttachmentUnreadable) {
  const base = (filename ?? "file").split(/[\\/]/).pop()
  return `"${base}" wasn't sent to the model: ${result.reason}. ${result.fix}`
}
