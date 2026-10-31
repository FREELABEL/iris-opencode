import { describe, expect, test } from "bun:test"
import { auditBoard, auditLead, repliedLeads } from "../../src/cli/cmd/platform-reachr-audit"

/**
 * #191704 — `iris reachr audit-replies 80` printed "Reading board 80…" and nothing else.
 *
 * Measured on board 80 (2026-10-29): the audit read 78 pages of 200 leads (the default list and
 * the Prospected list, 39 pages each) to find 36 tagged leads, then read those 36 one at a time —
 * 150 sequential requests, 56s with the spinner frozen on its first line. The fake below is a
 * board shaped like that one: ~7,800 leads, 36 tagged, the default list omitting Prospected.
 */

type Lead = { id: number; name: string; status: string; tags: { id: number; name: string }[] }

function board(total: number, tagged: number) {
  const leads: Lead[] = []
  for (let i = 1; i <= total; i++) {
    leads.push({
      id: i,
      name: `lead${i}`,
      status: i % 2 ? "Prospected" : "Contacted",
      tags: i <= tagged ? [{ id: 9, name: "DM Replied" }, { id: 3, name: "Hot" }] : [{ id: 3, name: "Hot" }],
    })
  }
  return leads
}

function fakeApi(leads: Lead[], o: { delayMs?: number; comms?: (id: number) => any[] } = {}) {
  const calls: string[] = []
  let inFlight = 0
  let maxInFlight = 0
  const fetch = async (path: string): Promise<Response> => {
    calls.push(path)
    inFlight++
    maxInFlight = Math.max(maxInFlight, inFlight)
    try {
      if (o.delayMs) await new Promise((r) => setTimeout(r, o.delayMs))
      const u = new URL(path, "https://x")
      if (u.pathname === "/api/v1/leads") {
        const q = u.searchParams
        const status = q.get("status")
        const tag = q.get("tag")
        const size = Number(q.get("per_page"))
        const page = Number(q.get("page"))
        // The board list without a status omits Prospected — the real list's behaviour (see boardLeads).
        let rows = leads.filter((l) => (status ? l.status === status : l.status !== "Prospected"))
        if (tag) rows = rows.filter((l) => l.tags.some((t) => t.name === tag))
        return Response.json({ data: { data: rows.slice((page - 1) * size, page * size) } })
      }
      const one = u.pathname.match(/^\/api\/v1\/leads\/(\d+)$/)
      if (one) {
        const l = leads.find((x) => x.id === Number(one[1]))!
        return Response.json({ data: { ...l, notes: [], contact_info: { instagram: l.name } } })
      }
      if (u.pathname === "/api/v1/atlas/comms") {
        const id = Number(u.searchParams.get("lead_id"))
        return Response.json({ data: o.comms ? o.comms(id) : [{ id: id * 10, body: "yes interested", metadata: { source: "reachr-inbox" } }] })
      }
      return new Response("not found", { status: 404 })
    } finally {
      inFlight--
    }
  }
  return { fetch, calls, maxInFlight: () => maxInFlight }
}

describe("repliedLeads", () => {
  test("asks the server for the tagged leads instead of reading the whole board", async () => {
    const api = fakeApi(board(7800, 36))
    const got = await repliedLeads(80, api.fetch)
    expect(got.map((l) => l.id).sort((a, b) => a - b)).toEqual(Array.from({ length: 36 }, (_, i) => i + 1))
    // Board 80 took 78 list pages before; the tag filter needs one per list.
    expect(api.calls.length).toBeLessThanOrEqual(4)
    for (const c of api.calls) expect(new URL(c, "https://x").searchParams.get("tag")).toBe("DM Replied")
  })

  test("still finds tagged leads that are Prospected — the list the default view omits", async () => {
    const api = fakeApi(board(10, 4))
    const got = await repliedLeads(80, api.fetch)
    expect(got.map((l) => l.status).sort()).toEqual(["Contacted", "Contacted", "Prospected", "Prospected"])
  })

  test("a board it cannot read is an error, not an empty audit", async () => {
    const fetch = async () => new Response("{}", { status: 403 })
    await expect(repliedLeads(80, fetch)).rejects.toThrow(/could not read board 80 \(HTTP 403\)/)
  })
})

describe("auditBoard", () => {
  test("reads the tagged leads concurrently and reports progress to the end", async () => {
    const api = fakeApi(board(400, 36), { delayMs: 5 })
    const progress: number[] = []
    let announced = -1
    const rows = await auditBoard(80, api.fetch, { onLeads: (n) => (announced = n), onProgress: (d) => progress.push(d) })
    expect(rows.length).toBe(36)
    expect(rows.every((r) => r.verdict === "replied")).toBe(true)
    expect(announced).toBe(36)
    expect(progress.at(-1)).toBe(36)
    // Two reads per lead run together; more than two at once means leads are read in parallel.
    expect(api.maxInFlight()).toBeGreaterThan(2)
  })

  test("one unreadable lead is 'unknown' with the reason — it does not end the audit", async () => {
    // A comms row whose metadata is not JSON threw out of the loop and lost the whole board.
    const api = fakeApi(board(20, 3), {
      comms: (id) => [{ id, body: "hi", metadata: id === 2 ? "{not json" : { source: "reachr-inbox" } }],
    })
    const rows = await auditBoard(80, api.fetch)
    expect(rows.length).toBe(3)
    const bad = rows.find((r) => r.id === 2)
    expect(bad.verdict).toBe("unknown")
    expect(bad.error).toMatch(/could not read the lead/)
    expect(rows.filter((r) => r.verdict === "replied").length).toBe(2)
  })
})

describe("auditLead", () => {
  test("a request that throws (timeout, network) is reported, not thrown", async () => {
    const fetch = async () => {
      throw new Error("The operation timed out.")
    }
    const row = await auditLead({ id: 7, name: "x" }, fetch)
    expect(row).toMatchObject({ id: 7, verdict: "unknown" })
    expect(row.error).toMatch(/timed out/)
  })
})
