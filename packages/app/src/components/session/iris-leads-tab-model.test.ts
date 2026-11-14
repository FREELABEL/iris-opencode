import { describe, expect, test } from "bun:test"
import { resolveSurfaceAlias } from "./iris-panel-nav"
import {
  activeFilterCount,
  bandOf,
  bandQuery,
  healthScore,
  healthWord,
  listQuery,
  mergePages,
  NO_FILTERS,
  showingLine,
  sqlTime,
  stagesOf,
  toneOf,
} from "./iris-leads-tab-model"

const NOW = Date.parse("2026-11-04T18:00:00Z")
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString()

describe("the Leads tab's stats column (#192544)", () => {
  test("urgency bands are ELON's: <24h fresh, 24–48 follow up, 48–72 urgent, older critical", () => {
    expect(bandOf(hoursAgo(1), NOW)).toBe("fresh")
    expect(bandOf(hoursAgo(30), NOW)).toBe("follow")
    expect(bandOf(hoursAgo(60), NOW)).toBe("urgent")
    expect(bandOf(hoursAgo(200), NOW)).toBe("critical")
    expect(bandOf(null, NOW)).toBeUndefined()
  })
  test("each band is counted on the server with the list's own updated_after/before, in MySQL's UTC form", () => {
    expect(sqlTime(NOW)).toBe("2026-11-04 18:00:00")
    expect(bandQuery("fresh", NOW)).toEqual({ updated_after: "2026-11-03 18:00:00" })
    expect(bandQuery("follow", NOW)).toEqual({ updated_before: "2026-11-03 18:00:00", updated_after: "2026-11-02 18:00:00" })
    expect(bandQuery("critical", NOW)).toEqual({ updated_before: "2026-11-01 18:00:00" })
  })
  test("health is the share still fresh or follow-up; unknown until both bands and the total are read", () => {
    expect(healthScore({ fresh: 30, follow: 10, urgent: 5, critical: 55 }, 100)).toBe(40)
    expect(healthWord(40)).toBe("Fair")
    expect(healthWord(80)).toBe("Healthy")
    expect(healthScore({ fresh: 3 }, 100)).toBeUndefined()
    expect(healthScore({ fresh: 3, follow: 1 }, 0)).toBeUndefined()
  })
})

// Recorded from the leads-api `meta` op (fl-api leads/filter-metadata?bloq_id=80), 2026-11-04.
const META80 = { success: true, data: { statuses: { Responded: 22, Qualified: 2, Prospected: 7638, "Follow Up": 10, "Follow-Up": 8, Interested: 6, Contacted: 7 } } }

describe("stages, however they were spelled (#192544)", () => {
  test("Follow Up and Follow-Up are one stage; counts summed, named by the commoner spelling, both kept", () => {
    expect(stagesOf(META80)).toEqual([
      { status: "Prospected", count: 7638, statuses: ["Prospected"] },
      { status: "Contacted", count: 7, statuses: ["Contacted"] },
      { status: "Follow Up", count: 18, statuses: ["Follow Up", "Follow-Up"] },
      { status: "Responded", count: 22, statuses: ["Responded"] },
      { status: "Interested", count: 6, statuses: ["Interested"] },
      { status: "Qualified", count: 2, statuses: ["Qualified"] },
    ])
  })
  test("no metadata is no stages, not an empty list; empty stages are left off", () => {
    expect(stagesOf(undefined)).toBeUndefined()
    expect(stagesOf({ data: {} })).toBeUndefined()
    expect(stagesOf({ data: { statuses: { Lost: 0, Won: 1 } } })).toEqual([{ status: "Won", count: 1, statuses: ["Won"] }])
  })
  test("a merged stage is asked for one spelling at a time, and the pages merge in the list's order", () => {
    const f = { ...NO_FILTERS, stage: { status: "Follow Up", statuses: ["Follow Up", "Follow-Up"] } }
    expect(listQuery({ ...f, page: 1, status: "Follow-Up", now: NOW }).status).toBe("Follow-Up")
    expect(listQuery({ ...f, page: 1, now: NOW }).status).toBe("Follow Up")
    const m = mergePages([
      { rows: [{ id: 1, updated_at: "2026-11-01" }], total: 10, lastPage: 1 },
      { rows: [{ id: 2, updated_at: "2026-11-03" }], total: 8, lastPage: 2 },
    ])
    expect(m.rows.map((r) => r.id)).toEqual([2, 1])
    expect(m).toMatchObject({ total: 18, lastPage: 2 })
    expect(mergePages([{ rows: [{ id: 1, nickname: "b" }, { id: 2, nickname: "a" }], total: 2, lastPage: 1 }], "nickname", "asc").rows.map((r) => r.id)).toEqual([2, 1])
  })
})

describe("the leads list's query (#192544)", () => {
  test("Elon's defaults; empty filters left out, not sent blank", () => {
    expect(listQuery({ ...NO_FILTERS, bloqId: 80, page: 1, now: NOW })).toEqual({ page: "1", per_page: "50", sort: "updated_at", order: "desc", bloq_id: "80" })
  })
  test("search, replied and a band narrow it on the server; the Filters button counts what narrows", () => {
    const f = { ...NO_FILTERS, search: " ava ", replied: true, band: "urgent" as const }
    expect(listQuery({ ...f, page: 2, now: NOW })).toMatchObject({ search: "ava", has_replied: "1", page: "2", updated_after: "2026-11-01 18:00:00", updated_before: "2026-11-02 18:00:00" })
    expect(activeFilterCount(f)).toBe(2)
    expect(activeFilterCount(NO_FILTERS)).toBe(0)
  })
  test("Elon's footer line", () => {
    expect(showingLine(50, 7693)).toBe("Showing 50 of 7,693 leads")
    expect(showingLine(14, 14)).toBe("All 14 leads loaded")
    expect(showingLine(0, undefined)).toBe("")
  })
  test("a status reads in its stage's tone", () => {
    expect(toneOf("Prospected")).toBe("new")
    expect(toneOf("Follow-Up")).toBe("warm")
    expect(toneOf("Converted")).toBe("good")
    expect(toneOf("Lost")).toBe("bad")
    expect(toneOf(null)).toBe("idle")
  })
})

describe("old Outreach queue links land on Needs approval (#192544, #193487)", () => {
  test("outreach/review is Leads › review; outreach alone is the Outreach product again", () => {
    expect(resolveSurfaceAlias("outreach")).toEqual({ surface: "outreach", sub: undefined })
    expect(resolveSurfaceAlias("outreach", "review")).toEqual({ surface: "leads", sub: "review" })
    expect(resolveSurfaceAlias("atlas")).toEqual({ surface: "atlas", sub: undefined })
  })
})
