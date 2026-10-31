import { afterEach, describe, expect, test } from "bun:test"
import { listAllAgents } from "./agent-list-all"
import { fetchIntentAgents } from "./platform-intent-agents"
import { resolveAgentId } from "./platform-agents"

/**
 * #191868: three lookups read one page of per_page=500 and treated it as every agent. fl-api clamps
 * per_page at 500, so the agent at position 501 did not exist as far as they could tell.
 */

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
  process.exitCode = 0
})

/** Serves `total` agents the way fl-api does: page size clamped to 500, has_more in meta. */
function serveAgents(total: number) {
  const pages: number[] = []
  globalThis.fetch = (async (url: string) => {
    const u = new URL(String(url))
    const page = Number(u.searchParams.get("page") ?? 1)
    pages.push(page)
    const perPage = Math.min(Number(u.searchParams.get("per_page") ?? 25), 500)
    const start = (page - 1) * perPage
    const data = Array.from({ length: Math.max(0, Math.min(perPage, total - start)) }, (_, i) => ({
      id: start + i + 1,
      name: `agent-${start + i + 1}`,
    }))
    return new Response(
      JSON.stringify({ data, meta: { total, per_page: perPage, current_page: page, has_more: start + perPage < total } }),
      { status: 200 },
    )
  }) as any
  return pages
}

describe("listAllAgents", () => {
  test("reads until has_more is false, past the 500 a single request can return", async () => {
    const pages = serveAgents(1203)
    const all = await listAllAgents(193)
    expect(all.ok && all.rows.length).toBe(1203)
    expect(pages).toEqual([1, 2, 3])
  })

  test("one request when the first page is everything", async () => {
    const pages = serveAgents(455)
    const all = await listAllAgents(193)
    expect(all.ok && all.rows.length).toBe(455)
    expect(pages).toEqual([1])
  })

  test("a page that fails fails the whole list: a partial list reads as 'no such agent'", async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      return calls === 1
        ? new Response(JSON.stringify({ data: [{ id: 1 }], meta: { has_more: true } }), { status: 200 })
        : new Response("{}", { status: 403 })
    }) as any
    expect(await listAllAgents(193)).toEqual({ ok: false, status: 403, error: "HTTP 403" })
  })

  test("a server that ignores `page` ends in an error, not an endless loop", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: [{ id: 1 }], meta: { has_more: true } }), { status: 200 })) as any
    const all = await listAllAgents(193)
    expect(all.ok).toBe(false)
  })

  test("the shape is honoured when the server gives only a Laravel paginator", async () => {
    globalThis.fetch = (async (url: string) => {
      const page = Number(new URL(String(url)).searchParams.get("page"))
      return new Response(
        JSON.stringify({ success: true, data: { data: [{ id: page }], current_page: page, last_page: 2, per_page: 1, total: 2 } }),
        { status: 200 },
      )
    }) as any
    const all = await listAllAgents(193)
    expect(all.ok && all.rows.map((a: any) => a.id)).toEqual([1, 2])
  })
})

describe("the lookups that read it", () => {
  test("resolveAgentId finds an agent only reachable on the third page", async () => {
    serveAgents(1203)
    expect(await resolveAgentId("agent-1201", 193, true)).toBe(1201)
  })

  test("the intent lookup sees every agent", async () => {
    serveAgents(501)
    const r = await fetchIntentAgents(193, 4000)
    expect(r.ok && r.agents.length).toBe(501)
  })
})
