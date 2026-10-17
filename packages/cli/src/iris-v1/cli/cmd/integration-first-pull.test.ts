import { describe, expect, test } from "bun:test"
import { FIRST_PULL, describeRow, firstPullCommand, rowsOf } from "./integration-first-pull"

// T3 #188213 — after a connect, the person's own data. Functions are the ones fl-iris-api's
// services actually expose (read_emails, list_files, list_events, list_channels).

describe("firstPullCommand", () => {
  test("gives the exact command for each covered type", () => {
    expect(firstPullCommand("gmail")).toBe('iris integrations exec gmail read_emails --max-results 5 --query "in:inbox"')
    expect(firstPullCommand("google-drive")).toBe("iris integrations exec google-drive list_files --page-size 5")
  })
  test("has nothing to suggest for a type it does not know", () => {
    expect(firstPullCommand("quickbooks")).toBeNull()
  })
  test("only ever offers read functions", () => {
    for (const p of Object.values(FIRST_PULL)) expect(p.action).toMatch(/^(read|list|get|search)_/)
  })
})

describe("rowsOf", () => {
  test("finds the list wherever the service put it", () => {
    expect(rowsOf({ success: true, emails: [{ id: 1 }] })).toHaveLength(1)
    expect(rowsOf({ success: true, data: { files: [{ id: 1 }, { id: 2 }] } })).toHaveLength(2)
    expect(rowsOf({ success: true, data: [{ id: 1 }] })).toHaveLength(1)
  })
  test("an empty or shapeless result is zero rows, not a crash", () => {
    expect(rowsOf({ success: true, emails: [] })).toEqual([])
    expect(rowsOf(null)).toEqual([])
    expect(rowsOf({ success: true, message: "ok" })).toEqual([])
  })
})

describe("describeRow", () => {
  test("shows the human field and strips the address from a sender", () => {
    const s = describeRow({ subject: "Invoice 42", from: "Jane Doe <jane@x.test>" })
    expect(s).toContain("Invoice 42")
    expect(s).toContain("Jane Doe")
    expect(s).not.toContain("jane@x.test")
  })
  test("never prints a line longer than the terminal can take", () => {
    expect(describeRow({ name: "x".repeat(300) }).length).toBeLessThanOrEqual(110)
  })
})
