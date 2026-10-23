import { describe, expect, test } from "bun:test"
import { attachmentCheck, attachmentMime, largeAttachmentNotice, pickAttachmentFiles } from "./files"
import { pasteMode } from "./paste"

describe("attachmentMime", () => {
  test("keeps PDFs when the browser reports the mime", async () => {
    const file = new File(["%PDF-1.7"], "guide.pdf", { type: "application/pdf" })
    expect(await attachmentMime(file)).toBe("application/pdf")
  })

  test("normalizes structured text types to text/plain", async () => {
    const file = new File(['{"ok":true}\n'], "data.json", { type: "application/json" })
    expect(await attachmentMime(file)).toBe("text/plain")
  })

  test("accepts text files even with a misleading browser mime", async () => {
    const file = new File(["export const x = 1\n"], "main.ts", { type: "video/mp2t" })
    expect(await attachmentMime(file)).toBe("text/plain")
  })

  test("rejects binary files", async () => {
    const file = new File([Uint8Array.of(0, 255, 1, 2)], "blob.bin", { type: "application/octet-stream" })
    expect(await attachmentMime(file)).toBeUndefined()
  })
})

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
const ZIP_HEAD = Uint8Array.of(0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00)
const OLE_HEAD = Uint8Array.of(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1)

describe("attachmentCheck — spreadsheets and the files nothing can read", () => {
  test("an .xlsx is accepted and sent as a workbook for the engine to read", async () => {
    const file = new File([ZIP_HEAD], "roster.xlsx", { type: XLSX_MIME })
    expect(await attachmentCheck(file)).toEqual({ ok: true, mime: XLSX_MIME })
  })

  test("an .xlsx with no browser mime is still accepted (drag from Finder/Explorer)", async () => {
    const file = new File([ZIP_HEAD], "roster.xlsx", { type: "" })
    expect(await attachmentCheck(file)).toEqual({ ok: true, mime: XLSX_MIME })
  })

  test("a CSV that Windows labels application/vnd.ms-excel is still text", async () => {
    const file = new File(["name,amount\nAnn,5\n"], "claims.csv", { type: "application/vnd.ms-excel" })
    expect(await attachmentCheck(file)).toEqual({ ok: true, mime: "text/plain" })
  })

  test("a UTF-16 CSV (Excel 'Unicode Text') is text, not binary", async () => {
    const file = new File([Uint8Array.of(0xff, 0xfe, 0x61, 0x00, 0x2c, 0x00, 0x62, 0x00)], "u.csv", { type: "" })
    expect(await attachmentCheck(file)).toEqual({ ok: true, mime: "text/plain" })
  })

  test("a workbook renamed .csv goes to the engine as a workbook", async () => {
    const file = new File([ZIP_HEAD], "report.csv", { type: "text/csv" })
    expect(await attachmentCheck(file)).toEqual({ ok: true, mime: XLSX_MIME })
  })

  test("a password-protected .xlsx is refused by name, with the fix", async () => {
    const result = await attachmentCheck(new File([OLE_HEAD], "locked.xlsx", { type: XLSX_MIME }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toContain('"locked.xlsx"')
    expect(result.message).toContain("password-protected")
    expect(result.message).toContain("CSV")
  })

  for (const [name, words] of [
    ["legacy.xls", "Save As"],
    ["sheet.ods", "Save As"],
    ["photo.heic", "JPEG or PNG"],
    ["memo.doc", ".docx"],
  ] as const) {
    test(`${name} is refused by name with what to do`, async () => {
      const result = await attachmentCheck(new File([OLE_HEAD], name, { type: "" }))
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.message).toContain(`"${name}"`)
      expect(result.message).toContain(words)
    })
  }

  test("a binary file's refusal names it — no generic 'unsupported'", async () => {
    const result = await attachmentCheck(new File([Uint8Array.of(0, 255, 1, 2)], "blob.bin", { type: "" }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('"blob.bin"')
  })

  test("a large text attachment gets a notice; a small one does not", () => {
    const big = new File([new Uint8Array(6 * 1024 * 1024).fill(0x61)], "big.csv", { type: "text/csv" })
    expect(largeAttachmentNotice(big, "text/plain")).toContain('"big.csv" is 6.0 MB')
    expect(largeAttachmentNotice(new File(["a,b"], "s.csv"), "text/plain")).toBeUndefined()
    expect(largeAttachmentNotice(big, "image/png")).toBeUndefined()
  })
})

describe("pickAttachmentFiles", () => {
  test("reads the current project directory for every native picker invocation", async () => {
    const paths: string[] = []
    const files: File[] = []
    const file = new File(["hello"], "hello.txt", { type: "text/plain" })
    let directory = "C:\\Projects\\LoremIpsum"
    const picker = async (options?: { defaultPath?: string }, onFile?: (file: File) => Promise<unknown>) => {
      paths.push(options?.defaultPath ?? "")
      await onFile?.(file)
    }

    pickAttachmentFiles({
      picker,
      directory: () => directory,
      fallback: () => undefined,
      onFile: async (selected) => files.push(selected),
      onError: () => undefined,
    })
    await Promise.resolve()
    directory = "C:\\Projects\\DolorSit"
    pickAttachmentFiles({
      picker,
      directory: () => directory,
      fallback: () => undefined,
      onFile: async (selected) => files.push(selected),
      onError: () => undefined,
    })
    await Promise.resolve()
    expect(files).toEqual([file, file])
    expect(paths).toEqual(["C:\\Projects\\LoremIpsum", "C:\\Projects\\DolorSit"])
  })

  test("uses the browser file input when no native picker exists", async () => {
    let fallback = 0
    pickAttachmentFiles({
      directory: () => "/projects/consectetur-adipiscing",
      fallback: () => {
        fallback += 1
      },
      onFile: async () => undefined,
      onError: () => undefined,
    })
    expect(fallback).toBe(1)
  })

  test("reports native picker failures without rejecting", async () => {
    const error = new Error("picker unavailable")
    const errors: unknown[] = []
    const handled = Promise.withResolvers<void>()
    pickAttachmentFiles({
      picker: async () => Promise.reject(error),
      directory: () => "C:\\Projects\\LoremIpsum",
      fallback: () => undefined,
      onFile: async () => undefined,
      onError: (cause) => {
        errors.push(cause)
        handled.resolve()
      },
    })
    await handled.promise
    expect(errors).toEqual([error])
  })
})

describe("pasteMode", () => {
  test("uses native paste for short single-line text", () => {
    expect(pasteMode("hello world")).toBe("native")
  })

  test("uses manual paste for multiline text", () => {
    expect(
      pasteMode(`{
  "ok": true
}`),
    ).toBe("manual")
    expect(pasteMode("a\r\nb")).toBe("manual")
  })

  test("uses manual paste for large text", () => {
    expect(pasteMode("x".repeat(8000))).toBe("manual")
  })
})
