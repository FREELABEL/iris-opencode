import { describe, expect, test } from "bun:test"
import { recapOf } from "./home-recap-model"
import type { RecentItem } from "./home-dashboard-data"

const DAY = Date.parse("2026-11-26T06:00:00Z")
const item = (id: number, bloqName: string, listName: string, updatedAt: string, title = `item ${id}`): RecentItem => ({
  id,
  title,
  bloqId: id,
  bloqName,
  listName,
  createdAt: updatedAt,
  updatedAt,
})

describe("recapOf", () => {
  test("nothing changed today says so, instead of a sentence of zeros", () => {
    expect(recapOf([item(1, "A", "Todo", "2026-11-25T20:00:00Z")], DAY)).toEqual({ empty: true })
    expect(recapOf([], DAY)).toEqual({ empty: true })
  })

  test("separates your work from what agents wrote, by list name", () => {
    const r = recapOf(
      [
        item(1, "IRIS Feature Requests", "✅ Accepted — building", "2026-11-26T14:47:00Z", "EPIC · Shared workspaces"),
        item(2, "IRIS Feature Requests", "✅ Accepted — building", "2026-11-26T14:46:00Z", "PLAYBOOK (draft)"),
        item(3, "IRIS CLI Bug Reports", "Bug Reports", "2026-11-26T14:45:00Z"),
        item(4, "Client A", "Daily Diary", "2026-11-26T13:00:00Z"),
        item(5, "Client A", "Agent Work", "2026-11-26T13:01:00Z"),
        item(6, "Client B", "Agent Deliverables", "2026-11-26T12:00:00Z"),
        item(7, "Life Atlas", "Daily Meal Plans (auto)", "2026-11-26T11:00:00Z"),
        item(8, "Old", "Todo", "2026-11-25T23:59:00Z"),
      ],
      DAY,
    )
    expect(r).toEqual({
      empty: false,
      mine: 3,
      mineProjects: 2,
      top: { name: "IRIS Feature Requests", count: 2, titles: ["EPIC · Shared workspaces", "PLAYBOOK (draft)"] },
      agents: 4,
      agentProjects: 3,
    })
  })

  test("a day of only agent writing has no top project", () => {
    const r = recapOf([item(1, "Client A", "Daily Diary", "2026-11-26T09:00:00Z")], DAY)
    expect(r).toEqual({ empty: false, mine: 0, mineProjects: 0, top: null, agents: 1, agentProjects: 1 })
  })

  test("long titles are shortened, not cut mid-word with trailing space", () => {
    const long = "PLAYBOOK (draft) · shared-workspaces — share live AI chats with your team (#194307) and more words"
    const r = recapOf([item(1, "P", "L", "2026-11-26T10:00:00Z", long)], DAY)
    if (r.empty || !r.top) throw new Error("expected a top project")
    expect(r.top.titles[0].length).toBeLessThanOrEqual(64)
    expect(r.top.titles[0].endsWith("…")).toBe(true)
  })

  test("an item with no date is not counted as today", () => {
    expect(recapOf([{ id: 1, title: "x", bloqId: 1 }], DAY)).toEqual({ empty: true })
  })
})
