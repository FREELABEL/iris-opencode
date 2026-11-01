import { describe, expect, test } from "bun:test"
import { displayName, initials, isDone, listQuery, moneyLine, peopleNotes, readList, statusColor, urgencyOf } from "./iris-leads-model"

describe("leads model", () => {
  test("urgency follows ELON's bands, and no date is no claim", () => {
    const at = (h: number) => new Date(1_000_000_000_000 - h * 3_600_000).toISOString()
    const now = 1_000_000_000_000
    expect(urgencyOf(at(1), now)?.label).toBe("Fresh")
    expect(urgencyOf(at(30), now)?.label).toBe("Follow Up")
    expect(urgencyOf(at(60), now)?.label).toBe("Urgent")
    expect(urgencyOf(at(90), now)?.label).toBe("Critical")
    expect(urgencyOf(null, now)).toBeNull()
  })

  test("the total comes from the server, in either answer shape, not from the rows on hand", () => {
    expect(readList({ data: [{ id: 1 }], meta: { total: 102, last_page: 3 } })).toEqual({ rows: [{ id: 1 }], total: 102, lastPage: 3 })
    expect(readList({ data: { data: [{ id: 1 }], total: 102, last_page: 3 } })).toEqual({ rows: [{ id: 1 }], total: 102, lastPage: 3 })
    // Recorded from GET users/{id}/leads, 2026-11-01: this is the shape production answers with.
    expect(readList({ current_page: 1, data: [{ id: 1 }], last_page: 3, total: 102 })).toEqual({ rows: [{ id: 1 }], total: 102, lastPage: 3 })
    expect(readList(null)).toEqual({ rows: [], total: 0, lastPage: 1 })
  })

  test("search and status go to the server; empty ones are left out", () => {
    expect(listQuery({ bloqId: 836, search: " abgb ", status: "", sort: "updated_at", order: "desc", page: 2 })).toEqual({ page: "2", per_page: "50", sort: "updated_at", order: "desc", bloq_id: "836", search: "abgb" })
  })

  test("names and initials never come out empty", () => {
    expect(displayName({ id: 7 })).toBe("Lead #7")
    expect(initials({ id: 1, name: "Fast Friends Beer Co." })).toBe("FF")
    expect(initials({ id: 1, name: "---" })).toBe("?")
  })

  test("zero value is not a value, an unknown status stays grey, and system notes aren't follow-ups", () => {
    expect(moneyLine(0)).toBe("")
    expect(moneyLine("1500")).toBe("$1,500")
    expect(statusColor("Something Else")).toBe("#95A5A6")
    expect(statusColor("Contacted")).toBe("#F1C40F")
    expect(peopleNotes([{ id: 1, content: "a", created_at: "", is_system_generated: true }, { id: 2, content: "b", created_at: "" }]).map((n) => n.id)).toEqual([2])
    expect(isDone({ id: 1, status: "completed" })).toBe(true)
  })
})
