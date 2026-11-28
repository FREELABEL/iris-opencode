import { describe, expect, test } from "bun:test"
import { EMPTY_FORM, fileProblem, groupReasons, newLeadBody, newLeadProblem, rowState, valueColumns } from "./iris-leads-add-model"
import { agoLine } from "./iris-leads-model"

describe("New lead form (#194506)", () => {
  test("a name or an email is enough", () => {
    expect(newLeadProblem(EMPTY_FORM)).toBe("iris.leads.new.need")
    expect(newLeadProblem({ ...EMPTY_FORM, name: "Grace" })).toBeUndefined()
    expect(newLeadProblem({ ...EMPTY_FORM, email: "grace@example.test" })).toBeUndefined()
  })
  test("a bad email and a value that is not a number are caught before sending", () => {
    expect(newLeadProblem({ ...EMPTY_FORM, name: "G", email: "grace" })).toBe("iris.leads.new.badEmail")
    expect(newLeadProblem({ ...EMPTY_FORM, name: "G", value: "lots" })).toBe("iris.leads.new.badValue")
    expect(newLeadProblem({ ...EMPTY_FORM, name: "G", value: "$4,500" })).toBeUndefined()
  })
  test("the body carries the board and trims what was typed", () => {
    expect(newLeadBody({ name: " Grace ", company: "", email: "", value: "", stage: "Qualified" }, 952)).toEqual({ name: "Grace", company: "", email: "", value: "", status: "Qualified", bloqId: 952 })
  })
})

describe("Import (#194506)", () => {
  test("a row reads as ready, ready with a note, or skipped with its reason", () => {
    expect(rowState({ row: 1, lead: { name: "A" } }).tone).toBe("success")
    expect(rowState({ row: 2, lead: { name: "B" }, warning: "w" })).toEqual({ tone: "warning", text: "w" })
    expect(rowState({ row: 3, error: "No name" })).toEqual({ tone: "critical", text: "No name" })
  })
  test("repeated reasons are grouped with their rows", () => {
    const g = groupReasons([{ row: 4, reason: "No name" }, { row: 5, reason: "bad" }, { row: 9, reason: "No name" }])
    expect(g).toEqual([{ reason: "No name", rows: [4, 9], more: 0 }, { reason: "bad", rows: [5], more: 0 }])
    expect(groupReasons(Array.from({ length: 10 }, (_, i) => ({ row: i + 1, reason: "x" })), 3)[0]).toEqual({ reason: "x", rows: [1, 2, 3], more: 7 })
  })
  test("only CSV files under 5 MB are read", () => {
    expect(fileProblem({ name: "leads.csv", size: 100 })).toBeUndefined()
    expect(fileProblem({ name: "leads.xlsx", size: 100 })).toBe("iris.leads.import.notCsv")
    expect(fileProblem({ name: "leads.csv", size: 6_000_000 })).toBe("iris.leads.import.tooBig")
  })
})

describe("Import says what it leaves out (#194506)", () => {
  test("a value column that nothing reads is named, so the dialog can say why", () => {
    expect(valueColumns([{ column: "Full name", field: "name" }, { column: "Deal value", field: null }, { column: "Notes2", field: null }])).toEqual(["Deal value"])
  })
  test("a lead added a moment ago reads as just now", () => {
    const now = Date.parse("2026-11-27T12:00:30Z")
    expect(agoLine("2026-11-27T12:00:00Z", now)).toBe("just now")
    expect(agoLine("2026-11-27T11:58:00Z", now)).toBe("2m ago")
  })
})
