import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import * as platform from "./platform"

// fetchRecords is the board boundary for datasets: asked for `cases` with no board context it
// once returned 2,157 patient records from a board the caller was not on (2026-09-13). #190231
// phase 0c fetches the schema check and the records together instead of one after the other;
// these pin that the records still never come back unless the check passes.

const SCHEMAS = [
  { id: 1, slug: "cases", name: "Cases", bloq_id: 174, fields: [{ name: "patient_name", type: "string" }] },
  { id: 2, slug: "leads", name: "Leads", bloq_id: 503, fields: [{ name: "email", type: "string" }] },
]

describe("fetchRecords", () => {
  const spies: { mockRestore(): void }[] = []
  let events: string[] = []

  beforeEach(() => {
    events = []
    spies.push(spyOn(platform, "resolveUserId").mockResolvedValue(7))
    spies.push(
      spyOn(platform, "irisFetch").mockImplementation((async (p: string) => {
        const which = p.startsWith("/api/v1/atlas/schemas") ? "schemas" : "records"
        events.push(`start ${which}`)
        await new Promise((r) => setTimeout(r, 30))
        events.push(`end ${which}`)
        if (which === "schemas") return Response.json({ data: SCHEMAS })
        return Response.json({ data: { schema: { id: 1, slug: "cases", name: "Cases" }, records: { data: [{ id: 9, data: { patient_name: "A" } }], total: 1 } } })
      }) as any),
    )
  })
  afterEach(() => {
    while (spies.length) spies.pop()!.mockRestore()
  })

  test("asks for the schema check and the records together, not one after the other", async () => {
    const r = await platform.fetchRecords("cases", { bloqId: 174 })
    expect(r.measured).toBe(true)
    // Both requests were started before either finished.
    expect(events.slice(0, 2).sort()).toEqual(["start records", "start schemas"])
  })

  test("a dataset on the board you are on returns its rows and columns", async () => {
    const r = await platform.fetchRecords("cases", { bloqId: 174 })
    expect(r.data.rows.map((x) => x.id)).toEqual([9])
    expect(r.data.columns.length).toBeGreaterThan(0)
  })

  test("a dataset on ANOTHER board is refused, and no row leaks into the answer", async () => {
    const r = await platform.fetchRecords("cases", { bloqId: 503 })
    expect(r.measured).toBe(false)
    expect(r.reason).toBe('"cases" belongs to another board')
    expect(r.data.rows).toEqual([])
  })

  test("an unknown dataset is refused with no rows", async () => {
    const r = await platform.fetchRecords("nope", { bloqId: 174 })
    expect(r.measured).toBe(false)
    expect(r.data.rows).toEqual([])
  })
})
