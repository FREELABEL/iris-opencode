import { describe, expect, test } from "bun:test"
import { boardItemJson } from "./platform-boards"

/** #190328 / #190329 — the only output was the human rendering: no list, ANSI codes. */
describe("boards list --json", () => {
  test("says which list an item belongs to", () => {
    const row = boardItemJson({ id: 42, title: "Journal", status: "todo", bloq_list_id: 2921, list_name: "Journal" })
    expect(row).toMatchObject({ id: 42, list_id: 2921, list_name: "Journal" })
  })

  test("is a fixed shape — every field present, missing ones null", () => {
    const row = boardItemJson({ id: 1 })
    expect(Object.keys(row).sort()).toEqual(
      ["due_date", "id", "list_id", "list_name", "status", "title", "type"].sort(),
    )
    expect(row.title).toBeNull()
    expect(row.list_name).toBeNull()
  })

  test("accepts list_id as well as bloq_list_id", () => {
    expect(boardItemJson({ id: 2, list_id: 99 }).list_id).toBe(99)
  })
})
