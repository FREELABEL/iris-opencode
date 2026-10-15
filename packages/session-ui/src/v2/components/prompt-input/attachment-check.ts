/**
 * Which files the composer can attach, and — when it can't — a message that names the file and says
 * what to do. Shared by both composers (the app's PromptInput and the V2 composer) so the two cannot
 * drift: they had separate copies of this logic, and the V2 one is the Desktop default.
 *
 * Spreadsheets and Word files are accepted here and read into text by the engine
 * (packages/opencode/src/session/attachment-text.ts). A file the model will never see must not look
 * attached — so everything refused here is refused out loud, never silently.
 */

export const ACCEPTED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"]

const IMAGE_MIMES = new Set(ACCEPTED_IMAGE_TYPES)
const IMAGE_EXTS = new Map([
  ["gif", "image/gif"],
  ["jpeg", "image/jpeg"],
  ["jpg", "image/jpeg"],
  ["png", "image/png"],
  ["webp", "image/webp"],
])
const TEXT_MIMES = new Set([
  "application/json",
  "application/ld+json",
  "application/toml",
  "application/x-toml",
  "application/x-yaml",
  "application/xml",
  "application/yaml",
])

const SAMPLE = 4096

function kind(type: string) {
  return type.split(";", 1)[0]?.trim().toLowerCase() ?? ""
}

function ext(name: string) {
  const idx = name.lastIndexOf(".")
  if (idx === -1) return ""
  return name.slice(idx + 1).toLowerCase()
}

function textMime(type: string) {
  if (!type) return false
  if (type.startsWith("text/")) return true
  if (TEXT_MIMES.has(type)) return true
  if (type.endsWith("+json")) return true
  return type.endsWith("+xml")
}

function textBytes(bytes: Uint8Array) {
  if (bytes.length === 0) return true
  let count = 0
  for (const byte of bytes) {
    if (byte === 0) return false
    if (byte < 9 || (byte > 13 && byte < 32)) count += 1
  }
  return count / bytes.length <= 0.3
}

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
// Read by the engine (packages/opencode/src/session/attachment-text.ts), which turns them into text.
const OFFICE_MIMES = new Map([
  ["xlsx", XLSX],
  ["xlsm", XLSX],
  ["docx", DOCX],
])
const OFFICE_TYPES = new Set([XLSX, DOCX, "application/vnd.ms-excel.sheet.macroenabled.12"])

const ZIP = [0x50, 0x4b, 0x03, 0x04]
const CFB = [0xd0, 0xcf, 0x11, 0xe0]

const RESAVE_XLSX = "Open it, choose File › Save As › Excel Workbook (.xlsx) or CSV, and attach that."
// Formats nothing on the path can read. Each says what to do instead — never a bare "unsupported".
const UNREADABLE: Record<string, { reason: string; fix: string }> = {
  xls: { reason: "is an old-format Excel workbook (.xls)", fix: RESAVE_XLSX },
  ods: { reason: "is an OpenDocument spreadsheet (.ods)", fix: RESAVE_XLSX },
  numbers: { reason: "is an Apple Numbers file", fix: "Export it as Excel (.xlsx) or CSV and attach that." },
  doc: {
    reason: "is an old-format Word document (.doc)",
    fix: "Open it, choose File › Save As › Word Document (.docx) or PDF, and attach that.",
  },
  odt: { reason: "is an OpenDocument text file (.odt)", fix: "Save it as Word (.docx) or PDF and attach that." },
  pages: { reason: "is an Apple Pages file", fix: "Export it as Word (.docx) or PDF and attach that." },
  ppt: { reason: "is a PowerPoint file", fix: "Export it as PDF and attach that." },
  pptx: { reason: "is a PowerPoint file", fix: "Export it as PDF and attach that." },
  key: { reason: "is a Keynote file", fix: "Export it as PDF and attach that." },
  heic: { reason: "is a HEIC photo, which can't be read yet", fix: "Export it as JPEG or PNG and attach that." },
  heif: { reason: "is a HEIF photo, which can't be read yet", fix: "Export it as JPEG or PNG and attach that." },
  avif: { reason: "is an AVIF image, which can't be read yet", fix: "Convert it to PNG or JPEG and attach that." },
  bmp: { reason: "is a BMP image, which can't be read yet", fix: "Convert it to PNG or JPEG and attach that." },
  tif: { reason: "is a TIFF image, which can't be read yet", fix: "Convert it to PNG, JPEG or PDF and attach that." },
  tiff: { reason: "is a TIFF image, which can't be read yet", fix: "Convert it to PNG, JPEG or PDF and attach that." },
  zip: { reason: "is a zip archive", fix: "Unzip it and attach the files inside." },
}

export type AttachmentCheck = { ok: true; mime: string } | { ok: false; message: string }

function begins(bytes: Uint8Array, sig: number[]) {
  return bytes.length >= sig.length && sig.every((value, i) => bytes[i] === value)
}

function base(name: string) {
  return name.split(/[\\/]/).pop() || name
}

function refuse(file: File, reason: string, fix: string): AttachmentCheck {
  return { ok: false, message: `"${base(file.name)}" ${reason} — the model can't read it. ${fix}` }
}

/**
 * Decide whether a file can be attached and, when it can't, say why in words that name the file and
 * what to do. A file the model will never see must not look attached.
 */
export async function attachmentCheck(file: File): Promise<AttachmentCheck> {
  const type = kind(file.type)
  if (IMAGE_MIMES.has(type)) return { ok: true, mime: type }
  if (type === "application/pdf") return { ok: true, mime: type }

  const suffix = ext(file.name)
  const head = new Uint8Array(await file.slice(0, 8).arrayBuffer())

  const office = OFFICE_MIMES.get(suffix) ?? (OFFICE_TYPES.has(type) ? (type === DOCX ? DOCX : XLSX) : undefined)
  if (office) {
    if (begins(head, ZIP)) return { ok: true, mime: office }
    if (begins(head, CFB))
      return refuse(
        file,
        "is password-protected",
        "Remove the password (File › Info › Protect Workbook/Document) or save a copy as CSV, and attach that.",
      )
    if (head.length === 0) return refuse(file, "is empty", "Check the file and attach it again.")
    return refuse(file, "is damaged or not really an Office file", RESAVE_XLSX)
  }

  const unreadable = UNREADABLE[suffix]
  if (unreadable) return refuse(file, unreadable.reason, unreadable.fix)

  const fallback = IMAGE_EXTS.get(suffix) ?? (suffix === "pdf" ? "application/pdf" : undefined)
  if ((!type || type === "application/octet-stream") && fallback) return { ok: true, mime: fallback }

  // A workbook renamed to .csv/.txt is still a workbook: send it as one so the engine reads it.
  if (begins(head, ZIP) && (suffix === "csv" || suffix === "txt" || suffix === "tsv")) return { ok: true, mime: XLSX }

  if (textMime(type)) return { ok: true, mime: "text/plain" }
  // UTF-16 text (Excel's "Unicode Text" export) is full of NUL bytes; its BOM says it is text.
  if (begins(head, [0xff, 0xfe]) || begins(head, [0xfe, 0xff])) return { ok: true, mime: "text/plain" }
  const bytes = new Uint8Array(await file.slice(0, SAMPLE).arrayBuffer())
  if (textBytes(bytes)) return { ok: true, mime: "text/plain" }
  return refuse(
    file,
    "is a binary file",
    "Attach text, CSV, Excel (.xlsx), Word (.docx), PDF or a PNG/JPEG/GIF/WebP image instead.",
  )
}

export async function attachmentMime(file: File) {
  const result = await attachmentCheck(file)
  return result.ok ? result.mime : undefined
}

/** Above this, the engine may inline only the beginning of a text attachment, and tells the model so. */
export const LARGE_TEXT_ATTACHMENT_BYTES = 150_000

export function largeAttachmentNotice(file: File, mime: string) {
  if (mime.startsWith("image/") || mime === "application/pdf") return
  if (file.size <= LARGE_TEXT_ATTACHMENT_BYTES) return
  const size =
    file.size >= 1024 * 1024 ? `${(file.size / 1024 / 1024).toFixed(1)} MB` : `${Math.round(file.size / 1024)} KB`
  return `"${base(file.name)}" is ${size}. If that is more than the model can take in one message, it reads the beginning and is told exactly what was left out. For questions about the whole file, ask IRIS to work with the file on disk, or attach just the part you need.`
}
