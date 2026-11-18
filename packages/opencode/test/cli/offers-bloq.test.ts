import { describe, expect, test } from "bun:test"
import { fetchBloqOffers, offersAuditJson } from "../../src/cli/cmd/offers"

/**
 * #191705 — `iris reachr offers audit --bloq 80 --json` printed the header and no JSON, and without
 * --json said "List service packages failed: HTTP 404". The CLI asked for
 * `/bloqs/{id}/service-packages`, a route no API serves, so every board 404'd. The board's
 * packages live at `/bloqs/{id}/packages` as `{ data: { packages: [...] } }`.
 */

const realApi = (packages: any[]) => {
  const calls: string[] = []
  const fetch = async (path: string) => {
    calls.push(path)
    // The routes that exist (fl-api lead-management-routes.php); anything else is Laravel's 404.
    if (/^\/api\/v1\/bloqs\/\d+\/packages$/.test(path)) return Response.json({ success: true, data: { packages, total: packages.length } })
    return Response.json({ message: "" }, { status: 404, statusText: "Not Found" })
  }
  return { fetch, calls }
}

describe("fetchBloqOffers", () => {
  test("an empty board is an empty list, not a 404", async () => {
    const api = realApi([])
    expect(await fetchBloqOffers("80", api.fetch)).toEqual([])
    expect(api.calls).toEqual(["/api/v1/bloqs/80/packages"])
  })

  test("reads the packages the endpoint returns, under the audit's `title`", async () => {
    const api = realApi([{ id: 1, name: "Growth Retainer", price: "1500.00", features: ["a", "b"] }])
    const got = await fetchBloqOffers("40", api.fetch)
    expect(got?.length).toBe(1)
    expect(got?.[0]).toMatchObject({ title: "Growth Retainer", price: "1500.00" })
  })
})

describe("offersAuditJson", () => {
  test("an empty catalogue is still one JSON answer", () => {
    expect(offersAuditJson([], "80")).toMatchObject({ success: true, bloq_id: "80", packageCount: 0, empty: true, findings: [] })
  })

  test("a catalogue carries success alongside the audit", () => {
    const j: any = offersAuditJson([{ title: "Growth Retainer", price: 1500, features: ["a", "b", "c"] }], "40")
    expect(j.success).toBe(true)
    expect(j.packageCount).toBe(1)
    expect(Array.isArray(j.findings)).toBe(true)
  })
})
