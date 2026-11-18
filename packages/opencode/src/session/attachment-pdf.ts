import type { AttachmentResult } from "./attachment-text"

/**
 * The text of an attached PDF, read by the engine (#192645).
 *
 * Before, a PDF was the one attachment the engine never read: it went to the model as a raw file,
 * and a model without PDF input (most OpenAI-compatible models, GPT-6 Luna through the IRIS proxy)
 * received "ERROR: Cannot read <file>" instead — so the agent spent its turns finding a way to
 * extract text itself. This reads the text layer with pdf.js (unpdf, no native code) and returns it
 * page by page, through the same path spreadsheets use (capped, with a note on what was left out).
 *
 * A PDF with no text layer — a scan or a photo — has nothing to read here. That is said plainly,
 * rather than handing the model an empty string it would read as "the document is blank".
 */

/** Pages read from one PDF. Past this the text is cut with a note (the inline budget caps it anyway). */
export const MAX_PDF_PAGES = 400

export function isPdf(mime: string, filename?: string, bytes?: Uint8Array) {
  const type = mime.split(";", 1)[0]!.trim().toLowerCase()
  if (type === "application/pdf") return true
  if (filename && /\.pdf$/i.test(filename)) return true
  return !!bytes && bytes.length > 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 // %PDF
}

export async function pdfToText(bytes: Uint8Array): Promise<AttachmentResult> {
  const { getDocumentProxy, extractText } = await import("unpdf")
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>>
  try {
    // pdf.js takes ownership of (and may detach) the buffer it is given — pass a copy.
    pdf = await getDocumentProxy(new Uint8Array(bytes))
  } catch (error) {
    const name = (error as { name?: string })?.name ?? ""
    if (/password/i.test(name) || /password/i.test(String((error as Error)?.message ?? ""))) {
      return {
        kind: "unreadable",
        reason: "it is password-protected",
        fix: "Open it, remove the password (or print it to a new PDF), and attach that.",
      }
    }
    return {
      kind: "unreadable",
      reason: "it could not be opened as a PDF (it may be damaged)",
      fix: "Open it and save or print it to a new PDF, then attach that.",
    }
  }

  try {
    const total = pdf.numPages
    const { text } = await extractText(pdf, { mergePages: false })
    const pages = (Array.isArray(text) ? text : [text]).slice(0, MAX_PDF_PAGES)
    const withText = pages.filter((page) => page.trim() !== "").length
    if (withText === 0) {
      return {
        kind: "unreadable",
        reason: `it has no text layer (${total} page${total === 1 ? "" : "s"} — a scan or a photo of a document)`,
        fix: "Attach the pages as images, or run it through OCR (e.g. Preview › Export as PDF with text, or Adobe Scan) and attach that.",
      }
    }
    const body = pages
      .map((page, i) => `## Page ${i + 1}\n${page.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim() || "(no text on this page)"}`)
      .join("\n\n")
    const header =
      `# PDF — ${total} page${total === 1 ? "" : "s"}` +
      (withText < pages.length ? ` · ${pages.length - withText} with no text (images or scans)` : "") +
      (total > pages.length ? ` · only the first ${pages.length} pages were read` : "")
    return { kind: "text", text: `${header}\n\n${body}`, format: "document" }
  } finally {
    await pdf.destroy().catch(() => undefined)
  }
}
