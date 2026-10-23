import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import {
  attachmentToText,
  dataUrlBytes,
  decodeText,
  inlineBudget,
  limitInlineText,
  needsTextResolution,
  unreadableNote,
} from "../../src/session/attachment-text"

// Workbooks written by a real spreadsheet library (SheetJS 0.20.3, shared strings, serial dates),
// not hand-built XML — so these exercise the shapes Excel files actually have.
const fixture = (name: string) => new Uint8Array(fs.readFileSync(path.join(import.meta.dir, "../fixture/attachments", name)))

const text = (input: Parameters<typeof attachmentToText>[0]) => {
  const result = attachmentToText(input)
  if (result.kind !== "text") throw new Error(`expected text, got: ${result.reason}`)
  return result.text
}

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

describe("spreadsheets become text the model can read", () => {
  test("a one-sheet workbook reads as CSV, with quoting and non-ASCII names intact", () => {
    const out = text({ bytes: fixture("one-sheet.xlsx"), mime: XLSX, filename: "claims.xlsx" })
    expect(out).toContain('## Sheet "Claims" — 4 rows')
    expect(out).toContain("Patient,CPT,Billed,Paid")
    expect(out).toContain("José Núñez,99213,125.5,80")
    expect(out).toContain('"Ann ""AJ"" Lee, MD",99214,210,150.25')
  })

  test("every sheet is read, formulas give their values, dates read as dates", () => {
    const out = text({ bytes: fixture("three-sheets.xlsx"), mime: XLSX, filename: "book.xlsx" })
    expect(out).toContain('## Sheet "Orders"')
    expect(out).toContain('## Sheet "Visits"')
    expect(out).toContain('## Sheet "Summary"')
    expect(out).toContain("Widget,2,10.5,21")
    expect(out).toContain("Grand total,,,33")
    expect(out).toContain("V-1,2026-03-14")
    expect(out).toContain("V-2,2025-12-31")
    // merged header keeps its value in the first cell
    expect(out).toContain("Quarterly report")
    expect(out).toContain("100,200,300")
  })

  test("an empty workbook says it is empty instead of sending nothing", () => {
    const out = text({ bytes: fixture("empty.xlsx"), mime: XLSX, filename: "empty.xlsx" })
    expect(out).toContain("(empty sheet)")
  })

  test("a workbook saved under a .csv name is read as a workbook, not inlined as binary", () => {
    const out = text({ bytes: fixture("one-sheet.xlsx"), mime: "text/plain", filename: "report.csv" })
    expect(out).toContain("José Núñez,99213,125.5,80")
    expect(out).not.toContain("PK\u0003\u0004")
  })
})

describe("files nothing can read are refused out loud", () => {
  test("legacy .xls names the format and the fix", () => {
    const result = attachmentToText({ bytes: fixture("legacy.xls"), mime: "application/vnd.ms-excel", filename: "a.xls" })
    expect(result.kind).toBe("unreadable")
    if (result.kind !== "unreadable") return
    expect(result.reason).toContain(".xls")
    expect(result.fix).toContain("Save As")
  })

  test("a password-protected .xlsx (an encrypted OLE container) says so", () => {
    const result = attachmentToText({ bytes: fixture("legacy.xls"), mime: XLSX, filename: "locked.xlsx" })
    expect(result.kind).toBe("unreadable")
    if (result.kind === "unreadable") expect(result.reason).toContain("password-protected")
  })

  test(".ods is refused with a re-save instruction", () => {
    const result = attachmentToText({
      bytes: fixture("sheet.ods"),
      mime: "application/vnd.oasis.opendocument.spreadsheet",
      filename: "sheet.ods",
    })
    expect(result.kind).toBe("unreadable")
    if (result.kind === "unreadable") expect(result.reason).toContain(".ods")
  })

  test("a binary file is refused, and the model is told it did not see it", () => {
    const result = attachmentToText({ bytes: Uint8Array.of(0, 1, 2, 3, 0, 255), mime: "application/octet-stream", filename: "x.bin" })
    expect(result.kind).toBe("unreadable")
    if (result.kind !== "unreadable") return
    const note = unreadableNote("x.bin", result)
    expect(note).toContain("was NOT included")
    expect(note).toContain("do not guess")
  })
})

describe("CSV text decodes the way Excel writes it", () => {
  test("UTF-8 with a BOM: the BOM never reaches the model", () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("name,amount\nZoë,5\n")])
    expect(decodeText(bytes)).toBe("name,amount\nZoë,5\n")
  })

  test("Windows-1252 (Excel on Windows 'CSV'): accents, smart quotes, euro", () => {
    // "Café",“quoted”,€5 — 0xE9 é, 0x93/0x94 curly quotes, 0x80 euro
    const bytes = Uint8Array.from([0x43, 0x61, 0x66, 0xe9, 0x2c, 0x93, 0x71, 0x94, 0x2c, 0x80, 0x35, 0x0a])
    expect(decodeText(bytes)).toBe("Café,“q”,€5\n")
  })

  test("UTF-16LE with BOM (Excel 'Unicode Text')", () => {
    const body = "a\tb\nñ\t2\n"
    const bytes = new Uint8Array(2 + body.length * 2)
    bytes[0] = 0xff
    bytes[1] = 0xfe
    for (let i = 0; i < body.length; i++) {
      bytes[2 + i * 2] = body.charCodeAt(i) & 0xff
      bytes[3 + i * 2] = body.charCodeAt(i) >> 8
    }
    expect(text({ bytes, mime: "text/plain", filename: "u.txt" })).toBe(body)
  })

  test("semicolon-delimited and quoted multi-line fields pass through untouched", () => {
    const csv = 'id;note\n1;"line one\nline two; still note"\n'
    expect(text({ bytes: new TextEncoder().encode(csv), mime: "text/plain", filename: "eu.csv" })).toBe(csv)
  })

  test("data: URLs decode to bytes", () => {
    expect(new TextDecoder().decode(dataUrlBytes("data:text/plain;base64,aGk="))).toBe("hi")
  })
})

describe("big attachments are capped, and the model is told what it did not see", () => {
  const csv = ["id,amount", ...Array.from({ length: 200_000 }, (_, i) => `${i},${i % 997}`)].join("\n")

  test("over budget: whole lines kept, the rest named as NOT sent", () => {
    const out = limitInlineText({ text: csv, filename: "big.csv", budget: 50_000 })
    expect(out.truncated).toBe(true)
    expect(out.text.length).toBeLessThan(52_000)
    expect(out.text).toContain("id,amount\n0,0\n1,1")
    expect(out.text).toContain("were NOT sent to you")
    expect(out.text).toContain("Do not state totals")
  })

  test("an on-disk path points the model at the full file", () => {
    const out = limitInlineText({ text: csv, filename: "/Users/me/Downloads/big.csv", budget: 50_000 })
    expect(out.text).toContain("The full file is on disk at /Users/me/Downloads/big.csv")
  })

  test("under budget: untouched", () => {
    expect(limitInlineText({ text: "a,b\n1,2\n", budget: 50_000 })).toEqual({ text: "a,b\n1,2\n", truncated: false })
  })

  test("the budget follows the model's context window, within bounds", () => {
    expect(inlineBudget(undefined)).toBe(150_000)
    expect(inlineBudget(8_000)).toBe(32_000)
    expect(inlineBudget(128_000)).toBe(192_000)
    expect(inlineBudget(1_000_000)).toBe(600_000)
  })
})

describe("which parts the engine reads itself", () => {
  test("images, PDFs and media go to the provider; everything else is read here", () => {
    expect(needsTextResolution("image/png")).toBe(false)
    expect(needsTextResolution("application/pdf")).toBe(false)
    expect(needsTextResolution("audio/wav")).toBe(false)
    expect(needsTextResolution("text/plain")).toBe(true)
    expect(needsTextResolution("text/csv")).toBe(true)
    expect(needsTextResolution(XLSX)).toBe(true)
    expect(needsTextResolution("application/octet-stream")).toBe(true)
  })
})
