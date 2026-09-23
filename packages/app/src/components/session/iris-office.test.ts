import { describe, expect, test } from "bun:test"
import { readFileSync } from "fs"
import path from "path"
import { columnIndex, docxHtml, readDocx, readXlsx } from "./iris-office"

const fixture = (name: string) => new Uint8Array(readFileSync(path.join(import.meta.dir, "__fixtures__", name)))

describe("readXlsx — a workbook written by openpyxl, as the agent makes them", () => {
  test("every sheet, by name, with shared strings, numbers, booleans and a formula", async () => {
    const r = await readXlsx(fixture("sample.xlsx"))
    if ("error" in r) throw new Error(r.error)
    expect(r.sheets.map((s) => s.name)).toEqual(["Equipment", "Open questions"])
    const eq = r.sheets[0].rows
    expect(eq[0]).toEqual(["Item", "Qty", "Required?", "Priority", "", "Total"])
    expect(eq[1]).toEqual(["Mixer with interface", "1", "TRUE", "Critical", "", "=SUM(B2:B3)"])
    expect(eq[2].slice(0, 2)).toEqual(["XLR cable 25ft", "8"])
  })
  test("gaps keep their place — a cell at C3 lands in row 3, column 3", async () => {
    const r = await readXlsx(fixture("sample.xlsx"))
    if ("error" in r) throw new Error(r.error)
    const q = r.sheets[1].rows
    expect(q[0][0]).toBe("How many performers?")
    expect(q[1]).toEqual(["", "", ""])
    expect(q[2]).toEqual(["", "", "skip"])
  })
  test("garbage is an error, never a throw", async () => {
    expect(await readXlsx(new TextEncoder().encode("not a zip"))).toHaveProperty("error")
    expect(await readXlsx(fixture("sample.docx"))).toEqual({ error: "not a spreadsheet (no xl/workbook.xml)" })
  })
})

test("columnIndex", () => {
  expect(columnIndex("A1")).toBe(0)
  expect(columnIndex("Z9")).toBe(25)
  expect(columnIndex("AA10")).toBe(26)
})

describe("readDocx", () => {
  test("headings, runs joined, tables", async () => {
    const r = await readDocx(fixture("sample.docx"))
    if ("error" in r) throw new Error(r.error)
    expect(r.blocks[0]).toEqual({ type: "p", text: "Open mic plan", heading: 1 })
    expect(r.blocks[1]).toEqual({ type: "p", text: "Bring the <mixer>", heading: undefined })
    expect(r.blocks[2]).toEqual({
      type: "table",
      rows: [
        ["Item", "Qty"],
        ["Mic", "4"],
      ],
    })
  })
  test("the document's text is escaped — it is data, never markup", async () => {
    const r = await readDocx(fixture("sample.docx"))
    if ("error" in r) throw new Error(r.error)
    const html = docxHtml(r.blocks)
    expect(html).toContain("Bring the &#60;mixer&#62;")
    expect(html).not.toContain("<mixer>")
  })
  test("a spreadsheet is not a Word document", async () => {
    expect(await readDocx(fixture("sample.xlsx"))).toEqual({ error: "not a Word document (no word/document.xml)" })
  })
})

import { headerRowIndex } from "./iris-office"
describe("headerRowIndex", () => {
  test("skips a title and notes to the first row that fills the columns", () => {
    const rows = [
      ["Equipment Sheet", "", "", ""],
      ["Source: a conversation", "", "", ""],
      ["", "", "", ""],
      ["#", "Category", "Item", "Qty"],
      ["1", "Mixer", "Mixer + interface", "1"],
    ]
    expect(headerRowIndex(rows)).toBe(3)
  })
  test("a plain table's header is row 0", () => {
    expect(
      headerRowIndex([
        ["a", "b"],
        ["1", "2"],
      ]),
    ).toBe(0)
  })
  test("one column, or nothing wide enough: no header", () => {
    expect(headerRowIndex([["only"], ["one"]])).toBe(-1)
    expect(headerRowIndex([])).toBe(-1)
  })
  test("a workbook whose first row is its header", async () => {
    const r = await readXlsx(fixture("sample.xlsx"))
    if ("error" in r) throw new Error(r.error)
    expect(headerRowIndex(r.sheets[0].rows)).toBe(0)
  })
})
