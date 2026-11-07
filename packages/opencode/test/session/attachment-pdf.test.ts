import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import { isPdf, pdfToText } from "../../src/session/attachment-pdf"
import { attachmentToText } from "../../src/session/attachment-text"

// PDFs written by a real PDF writer (Chromium print-to-PDF), not hand-built — #192645.
const fixture = (name: string) => new Uint8Array(fs.readFileSync(path.join(import.meta.dir, "../fixture/attachments", name)))

describe("an attached PDF is read by the engine (#192645)", () => {
  test("a text PDF reads page by page, with the page count up front", async () => {
    const result = await pdfToText(fixture("two-pages.pdf"))
    if (result.kind !== "text") throw new Error(result.reason)
    expect(result.text).toStartWith("# PDF — 2 pages")
    expect(result.text).toContain("## Page 1")
    expect(result.text).toContain("Reduction request")
    expect(result.text).toContain("1,250.00")
    expect(result.text).toContain("## Page 2")
    expect(result.text).toContain("Round 1 offer 700.00")
    expect(result.text.indexOf("Round 1 offer")).toBeGreaterThan(result.text.indexOf("## Page 2"))
  })

  test("a scan with no text layer says so instead of handing over an empty document", async () => {
    const result = await pdfToText(fixture("scanned.pdf"))
    expect(result.kind).toBe("unreadable")
    if (result.kind === "unreadable") {
      expect(result.reason).toContain("no text layer")
      expect(result.fix).toContain("OCR")
    }
  })

  test("a damaged PDF is unreadable with a fix, never a throw", async () => {
    const bad = new TextEncoder().encode("%PDF-1.7\nthis is not really a pdf\n%%EOF")
    const result = await pdfToText(bad)
    expect(result.kind).toBe("unreadable")
  })

  test("a PDF is recognised by mime, by name, or by its bytes", () => {
    expect(isPdf("application/pdf")).toBe(true)
    expect(isPdf("application/octet-stream", "A_R Report.PDF")).toBe(true)
    expect(isPdf("application/octet-stream", "x.bin", fixture("two-pages.pdf"))).toBe(true)
    expect(isPdf("text/plain", "notes.txt", new TextEncoder().encode("hello"))).toBe(false)
  })
})

describe("a workbook leads with its outline (#192645)", () => {
  const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  const read = (name: string) => {
    const r = attachmentToText({ bytes: fixture(name), mime: XLSX, filename: name })
    if (r.kind !== "text") throw new Error(r.reason)
    return r.text
  }

  test("every sheet's size and first row come before any rows", () => {
    const out = read("one-sheet.xlsx")
    expect(out).toStartWith("# Workbook outline — 1 sheet\n")
    // Columns counted from cells, not commas: the "Ann ""AJ"" Lee, MD" cell has a comma in it.
    expect(out).toContain('- "Claims": 4 rows × 4 columns · first row: Patient,CPT,Billed,Paid')
    expect(out.indexOf("# Workbook outline")).toBeLessThan(out.indexOf('## Sheet "Claims"'))
  })

  test("a multi-sheet workbook lists every sheet in the outline", () => {
    const out = read("three-sheets.xlsx")
    const outline = out.slice(0, out.indexOf("\n\n"))
    for (const sheet of ["Orders", "Visits", "Summary"]) expect(outline).toContain(`- "${sheet}"`)
  })
})
