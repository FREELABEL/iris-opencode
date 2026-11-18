/**
 * #191863 / #191864 — one JSON shape for every list command.
 *
 * Stress testing on 2026-10-30 found five list commands answering in five shapes: agents/pages
 * {data, meta:{returned,truncated,total,limit,hint}}, schedules {schedules, pagination}, users a
 * bare [] (for an account with 3,606 users — the server's {success, data:{data:[...]}} wrapper was
 * not unwrapped), bugs {items, page, total, last_page}. The contract every converted command now
 * emits:
 *
 *   { data: [...],
 *     meta: { total, returned, per_page, current_page, last_page, from, to, has_more, truncated, hint? },
 *     links?: { next, prev } }
 *
 * Part 1 unit-tests the builder against every server shape the API returns. Part 2 spawns the
 * REAL CLI against a local server and checks each converted command emits the contract, for a
 * page with more behind it and for an empty result, and that bad --limit/--page is refused the
 * same way everywhere.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test"
import { join } from "path"
import fs from "fs/promises"
import os from "os"
import {
  listEnvelope,
  listFooter,
  normalizeListResponse,
  commandWith,
  type ListEnvelope,
} from "../../src/cli/cmd/pagination-args"

const META_KEYS = ["total", "returned", "per_page", "current_page", "last_page", "from", "to", "has_more", "truncated"]

/** Every invariant of the contract, checked on any envelope. */
function expectContract(env: any) {
  expect(Array.isArray(env)).toBe(false)
  expect(Array.isArray(env.data)).toBe(true)
  const m = env.meta
  for (const k of META_KEYS) expect(Object.prototype.hasOwnProperty.call(m, k)).toBe(true)
  expect(m.total === null || Number.isInteger(m.total)).toBe(true)
  expect(m.returned).toBe(env.data.length)
  expect(Number.isInteger(m.per_page) && m.per_page >= 1).toBe(true)
  expect(m.current_page === null || (Number.isInteger(m.current_page) && m.current_page >= 1)).toBe(true)
  expect(typeof m.has_more).toBe("boolean")
  expect(typeof m.truncated).toBe("boolean")
  if (m.total !== null) expect(m.truncated).toBe(m.returned < m.total || m.has_more)
  else expect(m.truncated).toBe(m.has_more || m.truncated) // unknown total: truncated may be set for other reasons
  if (m.truncated) expect(typeof m.hint).toBe("string")
  if (m.returned === 0) {
    expect(m.from).toBeNull()
    expect(m.to).toBeNull()
  } else if (m.from !== null) {
    expect(m.to - m.from + 1).toBe(m.returned)
  }
  if (env.links) {
    expect(env.links.next === null || typeof env.links.next === "string").toBe(true)
    expect(env.links.next !== null).toBe(m.has_more)
  }
}

const rows = (n: number, start = 1) => Array.from({ length: n }, (_, i) => ({ id: start + i }))

// ============================================================================
// Part 1 — the builder
// ============================================================================

describe("normalizeListResponse — every server shape", () => {
  test("bare array: rows, no facts", () => {
    const p = normalizeListResponse(rows(3))
    expect(p).toEqual({ rows: rows(3), total: null, page: null, perPage: null, lastPage: null, hasMore: null })
  })

  test("Laravel paginator (top level)", () => {
    const p = normalizeListResponse({ data: rows(2), current_page: 1, per_page: 2, total: 28522, last_page: 14261, next_page_url: "x?page=2" })
    expect(p).toMatchObject({ total: 28522, page: 1, perPage: 2, lastPage: 14261, hasMore: true })
  })

  test("Laravel paginator wrapped as {success, data:{...}} — the users-list shape that printed []", () => {
    const body = { success: true, message: "OK", data: { data: rows(2), current_page: 1, per_page: 2, total: 3606, last_page: 1803 } }
    const p = normalizeListResponse(body)
    expect(p.rows).toEqual(rows(2))
    expect(p).toMatchObject({ total: 3606, page: 1, perPage: 2, lastPage: 1803 })
  })

  test("{data, meta} (resource collection / bloqs index); string numbers are read as numbers", () => {
    const p = normalizeListResponse({ data: rows(2), meta: { page: 2, per_page: "2", total: 196, last_page: 98, has_more: true } })
    expect(p).toMatchObject({ total: 196, page: 2, perPage: 2, lastPage: 98, hasMore: true })
  })

  test("{items, total} and {items, page, total, last_page}", () => {
    expect(normalizeListResponse({ items: rows(1), total: 9 })).toMatchObject({ rows: rows(1), total: 9 })
    expect(normalizeListResponse({ items: rows(1), page: 3, total: 9, last_page: 9 })).toMatchObject({ page: 3, lastPage: 9 })
  })

  test("{<key>: [...], pagination} with a key, and the bloq-items {data:{items, pagination}} shape", () => {
    expect(normalizeListResponse({ schedules: rows(2), pagination: { page: 1, per_page: 2, total: 967, last_page: 484 } }, { key: "schedules" })).toMatchObject({
      rows: rows(2),
      total: 967,
      lastPage: 484,
    })
    expect(normalizeListResponse({ data: { items: rows(2), pagination: { current_page: 1, per_page: 2, total: 5, last_page: 3 } } })).toMatchObject({
      rows: rows(2),
      total: 5,
      page: 1,
    })
  })

  test("garbage is an empty list, not a crash", () => {
    for (const body of [null, undefined, "nope", 42, {}, { data: {} }, { data: "x" }]) {
      expect(normalizeListResponse(body).rows).toEqual([])
    }
  })
})

describe("listEnvelope — the contract", () => {
  test("first page of many: truncated, hint, links.next", () => {
    const env = listEnvelope({ data: rows(50), current_page: 1, per_page: 50, total: 455, last_page: 10 }, { resource: "agents", command: "agents list" })
    expectContract(env)
    expect(env.meta).toMatchObject({ total: 455, returned: 50, per_page: 50, current_page: 1, last_page: 10, from: 1, to: 50, has_more: true, truncated: true })
    expect(env.meta.hint).toContain("Showing 1–50 of 455 agents")
    expect(env.meta.hint).toContain("iris agents list --page 2 --limit 50")
    expect(env.links).toEqual({ next: "iris agents list --page 2 --limit 50", prev: null })
  })

  test("middle page: prev and next", () => {
    const env = listEnvelope({ data: rows(50, 201), current_page: 5, per_page: 50, total: 455, last_page: 10 }, { resource: "agents", command: "agents list" })
    expectContract(env)
    expect(env.meta).toMatchObject({ from: 201, to: 250, has_more: true })
    expect(env.links).toEqual({ next: "iris agents list --page 6 --limit 50", prev: "iris agents list --page 4 --limit 50" })
  })

  test("last page: no more, but still truncated (earlier pages exist) with a hint", () => {
    const env = listEnvelope({ data: rows(5, 451), current_page: 10, per_page: 50, total: 455, last_page: 10 }, { resource: "agents", command: "agents list" })
    expectContract(env)
    expect(env.meta).toMatchObject({ from: 451, to: 455, has_more: false, truncated: true })
    expect(env.links?.next).toBeNull()
  })

  test("exact boundary: total == per_page is one complete page", () => {
    const env = listEnvelope({ data: rows(50), current_page: 1, per_page: 50, total: 50, last_page: 1 }, { resource: "agents", command: "agents list" })
    expectContract(env)
    expect(env.meta).toMatchObject({ total: 50, last_page: 1, has_more: false, truncated: false })
    expect(env.meta.hint).toBeUndefined()
    expect(env.links).toEqual({ next: null, prev: null })
  })

  test("exact boundary: total == per_page + 1 has exactly one more page", () => {
    const env = listEnvelope({ data: rows(50), current_page: 1, per_page: 50, total: 51, last_page: 2 }, { resource: "agents" })
    expect(env.meta).toMatchObject({ last_page: 2, has_more: true, truncated: true })
  })

  test("empty: data [], total 0, has_more false — never a bare []", () => {
    for (const body of [[], { data: [], total: 0 }, { success: true, data: { data: [], total: 0, current_page: 1, per_page: 20, last_page: 1 } }]) {
      const env = listEnvelope(body, { resource: "users", complete: Array.isArray(body) })
      expectContract(env)
      expect(env.data).toEqual([])
      expect(env.meta).toMatchObject({ total: 0, returned: 0, has_more: false, truncated: false, from: null, to: null })
    }
  })

  test("page past the end: empty, total kept, has_more false, hint names the last page", () => {
    const env = listEnvelope({ data: [], current_page: 99999, per_page: 2, total: 3606, last_page: 1803 }, { resource: "users", command: "users list" })
    expectContract(env)
    expect(env.meta).toMatchObject({ total: 3606, returned: 0, current_page: 99999, last_page: 1803, has_more: false, truncated: true })
    expect(env.meta.hint).toContain("past the end")
    expect(env.meta.hint).toContain("--page 1803")
    expect(env.links?.prev).toBe("iris users list --page 1803 --limit 2")
  })

  test("over-limit: the server's clamped per_page wins over what was asked", () => {
    // /api/v1/pages?per_page=500 answers 100 rows, per_page 100.
    const env = listEnvelope({ data: { data: rows(100), current_page: 1, per_page: "100", total: 1016, last_page: 11 } }, { resource: "pages", limit: 500 })
    expect(env.meta).toMatchObject({ per_page: 100, last_page: 11, to: 100, has_more: true })
  })

  test("complete rows (server ignores paging): counted and paged here", () => {
    const env = listEnvelope(rows(83), { resource: "workflows", complete: true, page: 2, limit: 15, command: "workflows list" })
    expectContract(env)
    expect(env.data.map((r) => r.id)).toEqual(rows(15, 16).map((r) => r.id))
    expect(env.meta).toMatchObject({ total: 83, returned: 15, per_page: 15, current_page: 2, last_page: 6, from: 16, to: 30, has_more: true })
  })

  test("unknown total: never guessed; a full page means has_more, a short page means done", () => {
    const full = listEnvelope(rows(15), { resource: "users", limit: 15 })
    expect(full.meta).toMatchObject({ total: null, has_more: true, truncated: true, last_page: null })
    expect(full.meta.hint).toContain("did not report a total")
    const short = listEnvelope(rows(3), { resource: "users", limit: 15 })
    expect(short.meta).toMatchObject({ total: null, has_more: false, truncated: false })
  })

  test("unknown total but the server said has_more / next_page_url: that signal wins", () => {
    expect(listEnvelope({ data: rows(2), next_page_url: null }, { resource: "x", limit: 2 }).meta.has_more).toBe(false)
    expect(listEnvelope({ data: rows(1), meta: { has_more: true } }, { resource: "x", limit: 2 }).meta.has_more).toBe(true)
  })

  test("cursor paging: next cursor decides has_more; a continuation page invents no page number", () => {
    const first = listEnvelope({ rows: rows(20), total: 28522, page: 1, perPage: 20, lastPage: null, hasMore: null }, { resource: "leads", command: "leads list", cursor: { next: "abc", continued: false } })
    expectContract(first)
    expect(first.meta).toMatchObject({ current_page: 1, from: 1, to: 20, has_more: true, next_cursor: "abc" })
    expect(first.links?.next).toBe("iris leads list --cursor abc --limit 20")
    const later = listEnvelope({ rows: rows(20), total: null, page: 1, perPage: 20, lastPage: null, hasMore: null }, { resource: "leads", command: "leads list", cursor: { next: null, continued: true } })
    expectContract(later)
    expect(later.meta).toMatchObject({ current_page: null, from: null, to: null, last_page: null, has_more: false, next_cursor: null })
    expect(later.links?.next).toBeNull()
  })

  test("legacy keys ride alongside data/meta and can never replace them", () => {
    const env = listEnvelope(rows(2), { resource: "bugs", complete: true, legacy: { items: rows(2), page: 1, total: 2, last_page: 1, data: "x", meta: "y" } }) as any
    expect(env.items).toEqual(rows(2))
    expect(env.total).toBe(2)
    expect(env.data).toEqual(rows(2))
    expect(env.meta.total).toBe(2)
  })

  test("invalid paging input is coerced to a sane envelope (validation is the caller's job)", () => {
    const env = listEnvelope(rows(2), { resource: "x", page: 0, limit: 0 })
    expect(env.meta.current_page).toBe(1)
    expect(env.meta.per_page).toBe(1)
  })
})

describe("listFooter — one line for humans", () => {
  const env = (body: unknown, o: any = {}) => listEnvelope(body, { resource: "agents", ...o }).meta
  test("page with more", () => {
    expect(listFooter(env({ data: rows(50), current_page: 1, per_page: 50, total: 455, last_page: 10 }), "agents")).toBe(
      "Showing 1–50 of 455 agents · page 1/10 · --page 2 for more",
    )
  })
  test("everything on one page", () => {
    expect(listFooter(env(rows(12), { complete: true }), "agents")).toBe("Showing 1–12 of 12 agents · page 1/1")
  })
  test("explicit empty state", () => {
    expect(listFooter(env([], { complete: true }), "agents")).toBe("No agents found.")
  })
  test("past the end names the last page", () => {
    expect(listFooter(env({ data: [], current_page: 12, per_page: 50, total: 455, last_page: 10 }), "agents")).toBe(
      "Page 12 is past the end — 455 agents in 10 page(s). Try --page 10.",
    )
  })
  test("unknown total", () => {
    expect(listFooter(env(rows(15), { limit: 15 }), "users", { more: "narrow the query for more" })).toBe("Showing 1–15 users · page 1 · narrow the query for more")
  })
})

describe("commandWith", () => {
  test("keeps the caller's filters, drops unset ones, quotes values with spaces", () => {
    expect(commandWith("schedules list", { active: true, overdue: false, "agent-id": 12, search: undefined })).toBe("schedules list --active --agent-id 12")
    expect(commandWith("bug list", { search: "invoice total" })).toBe('bug list --search "invoice total"')
  })
})

// ============================================================================
// Part 2 — every converted command, through the real CLI
// ============================================================================

const PKG = join(import.meta.dir, "../..")
const CLI = join(PKG, "src/index.ts")
const UID = "2945"

let server: ReturnType<typeof Bun.serve>
let home = ""
/** "many": 7 rows exist; "empty": none exist. */
let mode: "many" | "empty" = "many"
const TOTAL = 7

const all = () => (mode === "empty" ? [] : rows(TOTAL).map((r) => ({ ...r, name: `row ${r.id}`, title: `row ${r.id}`, status: "todo" })))
const pageOf = (url: URL, def = 20) => {
  const per = Number(url.searchParams.get("per_page") ?? def)
  const p = Number(url.searchParams.get("page") ?? 1)
  const data = all().slice((p - 1) * per, p * per)
  return { data, per, p, total: all().length, last: Math.max(1, Math.ceil(all().length / per)) }
}

beforeAll(async () => {
  home = await fs.mkdtemp(join(os.tmpdir(), "list-contract-"))
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      const path = url.pathname
      // users list: the paginator wrapped in {success, data} (production shape)
      if (path === "/api/v1/users") {
        const { data, per, p, total, last } = pageOf(url)
        return Response.json({ success: true, data: { data, current_page: p, per_page: per, total, last_page: last } })
      }
      // users search: a bare array, no total
      if (path === "/api/v1/users/search") return Response.json(all().slice(0, Number(url.searchParams.get("per_page") ?? 15)))
      // schedules: server-paged {data, meta}
      if (path === `/api/v1/users/${UID}/bloqs/scheduled-jobs`) {
        const { data, per, p, total, last } = pageOf(url, 50)
        return Response.json({ data, meta: { page: p, per_page: per, total, last_page: last, has_more: p < last } })
      }
      // bloq items (atlas items + bug list): {data:{items, pagination}}
      if (/^\/api\/v1\/user\/\d+\/bloqs\/\d+\/items$/.test(path)) {
        const { data, per, p, total, last } = pageOf(url, 50)
        return Response.json({ data: { items: data, pagination: { current_page: p, per_page: String(per), total, last_page: last } } })
      }
      // bloqs index: {data, meta}
      if (path === `/api/v1/user/${UID}/bloqs`) {
        const { data, per, p, total, last } = pageOf(url)
        return Response.json({ success: true, data, meta: { page: p, per_page: per, total, last_page: last, has_more: p < last } })
      }
      // leads: top-level Laravel paginator
      if (path === "/api/v1/leads") {
        // Keyset cursor mode (#191736): total on the first page only, next_cursor while more.
        if (url.searchParams.get("pagination") === "cursor" || url.searchParams.get("cursor")) {
          const per = Number(url.searchParams.get("per_page") ?? 20)
          const off = Number((url.searchParams.get("cursor") ?? "o0").slice(1))
          const data = all().slice(off, off + per)
          const more = off + per < all().length
          return Response.json({ data, total: url.searchParams.get("cursor") ? null : all().length, next_cursor: more ? `o${off + per}` : null, has_more: more })
        }
        const { data, per, p, total, last } = pageOf(url)
        return Response.json({ data, current_page: p, per_page: per, total, last_page: last })
      }
      // pages: {data: paginator}, clamped at 100
      if (path === "/api/v1/pages") {
        const { data, per, p, total, last } = pageOf(url, 50)
        return Response.json({ data: { data, current_page: p, per_page: per, total, last_page: last } })
      }
      // workflows: ignores paging, bare array of everything
      if (path === `/api/v1/users/${UID}/bloqs/workflows`) return Response.json(all())
      // integrations (both stores): every row
      if (path === `/api/v1/users/${UID}/integrations`) return Response.json({ connections: all().map((r) => ({ ...r, type: "gmail", status: "active" })) })
      // hive nodes: every node
      if (path === "/api/v6/nodes/") return Response.json({ nodes: all().map((r) => ({ ...r, id: String(r.id), connection_status: "online" })) })
      // agents: Laravel paginator
      if (path === `/api/v1/users/${UID}/bloqs/agents`) {
        const { data, per, p, total, last } = pageOf(url, 30)
        return Response.json({ data, current_page: p, per_page: per, total, last_page: last })
      }
      return Response.json({ success: false, message: "not here" }, { status: 404 })
    },
  })
})

afterAll(async () => {
  server?.stop(true)
  if (home) await fs.rm(home, { recursive: true, force: true })
})

beforeEach(() => {
  mode = "many"
})

async function iris(args: string[]) {
  const base = `http://127.0.0.1:${server.port}`
  const proc = Bun.spawn(["bun", "run", CLI, ...args], {
    cwd: PKG,
    env: {
      ...process.env,
      HOME: home,
      OPENCODE_TEST_HOME: home,
      IRIS_API_URL: base,
      IRIS_FL_API_URL: base,
      IRIS_API_KEY: "test-key",
      IRIS_USER_ID: UID,
      // commitViews (hive nodes) asks GitHub for main; keep it off the network.
      GITHUB_API_URL: base,
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  return { exitCode: await proc.exited, stdout, stderr }
}

/**
 * Every converted list command. `paged` = takes --limit/--page and the fake server holds 7 rows,
 * so `--limit 2` must report a truncated first page with a next link.
 */
const COMMANDS: { name: string; argv: string[]; paged: boolean; legacy?: string[] }[] = [
  { name: "users list", argv: ["users", "list"], paged: true },
  { name: "users search", argv: ["users", "search", "row"], paged: false },
  { name: "schedules list", argv: ["schedules", "list"], paged: true, legacy: ["schedules", "pagination"] },
  { name: "bug list", argv: ["bug", "list"], paged: true, legacy: ["items", "page", "total", "last_page"] },
  { name: "atlas items", argv: ["atlas", "items", "550"], paged: true, legacy: ["items", "pagination"] },
  { name: "atlas list", argv: ["atlas", "list"], paged: true },
  { name: "leads list", argv: ["leads", "list", "--sort", "created"], paged: false },
  { name: "pages list", argv: ["pages", "list"], paged: true },
  { name: "pages search", argv: ["pages", "search", "row"], paged: true },
  { name: "workflows list", argv: ["workflows", "list"], paged: true },
  { name: "integrations list", argv: ["integrations", "list"], paged: false },
  { name: "hive nodes list", argv: ["hive", "nodes", "list"], paged: false },
]

describe("every converted list command emits the contract", () => {
  for (const c of COMMANDS) {
    test(`${c.name} --json: a page of a larger set`, async () => {
      const r = await iris([...c.argv, ...(c.paged || c.name === "leads list" ? ["--limit", "2"] : []), "--json"])
      expect(r.exitCode).toBe(0)
      const out = JSON.parse(r.stdout)
      expectContract(out)
      if (c.paged || c.name === "leads list") {
        expect(out.meta).toMatchObject({ returned: 2, per_page: 2, total: TOTAL, has_more: true, truncated: true })
        expect(out.meta.hint).toContain("NOT the full set")
        expect(out.links.next).toContain("--limit 2")
      } else if (c.name !== "users search") {
        // Unpaged inventories: everything, exactly counted. (integrations reads two stores.)
        expect(out.meta.has_more).toBe(false)
        expect(out.meta.total).toBe(out.data.length)
      }
      for (const k of c.legacy ?? []) expect(out).toHaveProperty(k)
    }, 60_000)

    test(`${c.name} --json: empty is an envelope, not []`, async () => {
      mode = "empty"
      const r = await iris([...c.argv, "--json"])
      expect(r.exitCode).toBe(0)
      const out = JSON.parse(r.stdout)
      expectContract(out)
      expect(out.data).toEqual([])
      expect(out.meta).toMatchObject({ returned: 0, has_more: false, truncated: false })
      expect(out.meta.total === 0 || (c.name === "users search" && out.meta.total === null)).toBe(true)
    }, 60_000)
  }

  test("a middle page reports its offsets and both links (users list --limit 2 --page 2)", async () => {
    const r = await iris(["users", "list", "--limit", "2", "--page", "2", "--json"])
    const out = JSON.parse(r.stdout)
    expectContract(out)
    expect(out.meta).toMatchObject({ current_page: 2, from: 3, to: 4, last_page: 4, has_more: true })
    expect(out.links).toEqual({ next: "iris users list --page 3 --limit 2", prev: "iris users list --page 1 --limit 2" })
  }, 60_000)

  test("leads list --cursor: a continuation page invents no page number, links to the next cursor", async () => {
    const r = await iris(["leads", "list", "--sort", "created", "--limit", "2", "--cursor", "o2", "--json"])
    expect(r.exitCode).toBe(0)
    const out = JSON.parse(r.stdout)
    expectContract(out)
    expect(out.data.map((l: any) => l.id)).toEqual([3, 4])
    expect(out.meta).toMatchObject({ current_page: null, from: null, has_more: true, next_cursor: "o4" })
    expect(out.links.next).toContain("--cursor o4")
  }, 60_000)

  test("workflows list applies --limit (the server returns everything)", async () => {
    const r = await iris(["workflows", "list", "--limit", "3", "--page", "3", "--json"])
    const out = JSON.parse(r.stdout)
    expect(out.data.map((w: any) => w.id)).toEqual([7])
    expect(out.meta).toMatchObject({ total: 7, current_page: 3, last_page: 3, from: 7, to: 7, has_more: false })
  }, 60_000)

  test("bug list past the last page is empty and says so (no silent clamp)", async () => {
    const r = await iris(["bug", "list", "--limit", "5", "--page", "9", "--json"])
    const out = JSON.parse(r.stdout)
    expectContract(out)
    expect(out.meta).toMatchObject({ total: 7, returned: 0, current_page: 9, has_more: false })
    expect(out.meta.hint).toContain("past the end")
  }, 60_000)
})

describe("--limit / --page are validated the same way everywhere", () => {
  const PAGED = COMMANDS.filter((c) => c.paged)
  for (const c of PAGED) {
    for (const [flags, field] of [
      [["--limit", "0"], "limit"],
      [["--limit", "1.5"], "limit"],
      [["--page", "0"], "page"],
    ] as const) {
      test(`${c.name} ${flags.join(" ")} → JSON error on stdout, exit 2`, async () => {
        const r = await iris([...c.argv, ...flags, "--json"])
        expect(r.exitCode).toBe(2)
        const out = JSON.parse(r.stdout.trim())
        expect(out.success).toBe(false)
        expect(Object.keys(out.errors)).toEqual([field])
      }, 60_000)
    }
  }

  test("leads list --limit 0 → JSON error on stdout, exit 2 (was stderr + exit 1)", async () => {
    const r = await iris(["leads", "list", "--limit", "0", "--json"])
    expect(r.exitCode).toBe(2)
    const out = JSON.parse(r.stdout.trim())
    expect(Object.keys(out.errors)).toEqual(["limit"])
  }, 60_000)

  test("users search --limit 16 is refused: the server returns at most 15", async () => {
    const r = await iris(["users", "search", "row", "--limit", "16", "--json"])
    expect(r.exitCode).toBe(2)
  }, 60_000)
})

describe("human output: one footer, explicit empty state", () => {
  test("users list prints the shared footer", async () => {
    const r = await iris(["users", "list", "--limit", "2"])
    expect(r.stdout + r.stderr).toContain("Showing 1–2 of 7 users · page 1/4 · --page 2 for more")
  }, 60_000)

  test("users list on an empty account says so", async () => {
    mode = "empty"
    const r = await iris(["users", "list"])
    expect(r.stdout + r.stderr).toContain("No users found.")
  }, 60_000)
})

// Typed use, so a shape change breaks the build and not just a test.
const _typed: ListEnvelope<{ id: number }> = listEnvelope(rows(1), { resource: "x" })
void _typed
