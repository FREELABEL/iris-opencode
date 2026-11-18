import { describe, expect, test } from "bun:test"
import { filterRecords, sortRecords, toCsv, type RecordColumn } from "./iris-records-view"

const cols: RecordColumn[] = [
  { key: "name", label: "Name", type: "string" },
  { key: "amount", label: "Amount", type: "number" },
]
const rows = [
  { id: 3, data: { name: "Charlie", amount: 10 } },
  { id: 1, data: { name: "alice", amount: 2 } },
  { id: 2, data: { name: "Bob", amount: null } },
  { id: 4, data: { name: "", amount: 100 } },
]

describe("records: sort (#189769)", () => {
  test("numbers sort as numbers, not text", () => {
    expect(sortRecords(rows, cols[1], "asc").map((r) => r.id)).toEqual([1, 3, 4, 2])
    expect(sortRecords(rows, cols[1], "desc").map((r) => r.id)).toEqual([4, 3, 1, 2])
  })
  test("text ignores case; blanks go last both ways", () => {
    expect(sortRecords(rows, cols[0], "asc").map((r) => r.id)).toEqual([1, 2, 3, 4])
    expect(sortRecords(rows, cols[0], "desc").map((r) => r.id)).toEqual([3, 2, 1, 4])
  })
  test("by id", () => {
    expect(sortRecords(rows, "id", "asc").map((r) => r.id)).toEqual([1, 2, 3, 4])
  })
})

describe("records: filter (#189769)", () => {
  test("every word must match somewhere in the row", () => {
    expect(filterRecords(rows, cols, "char 10").map((r) => r.id)).toEqual([3])
    expect(filterRecords(rows, cols, "ALICE").map((r) => r.id)).toEqual([1])
    expect(filterRecords(rows, cols, "").length).toBe(4)
  })
})

describe("records: CSV (#189769)", () => {
  test("quotes what needs quoting and doubles quotes", () => {
    const csv = toCsv(cols, [{ id: 1, data: { name: 'He said "hi", then left\nlater', amount: 5 } }])
    expect(csv).toBe('id,name,amount\r\n1,"He said ""hi"", then left\nlater",5\r\n')
  })
  test("a cell a spreadsheet would run as a formula is defused; negative numbers are left alone", () => {
    const csv = toCsv(cols, [{ id: 1, data: { name: "=HYPERLINK(\"x\")", amount: -5 } }])
    expect(csv.split("\r\n")[1]).toBe(`1,"'=HYPERLINK(""x"")",-5`)
  })
})
