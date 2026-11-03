/**
 * #191862 — iris_agent action:"list" (the `iris mcp serve` tool) returned exactly 50 agents and
 * said "50 of 50 agent(s) carry a description and are listed" on an account holding 455. It ran
 * `iris agents list --json --limit 50` and counted the PAGE as if it were the account; it took no
 * page or limit argument, so an LLM consuming it could never see agents 51–455.
 *
 * Drives the REAL CLI against a local server that pages the way fl-api's AgentController does
 * (ListsResources: data + meta{page, per_page, total, last_page, has_more}, per_page clamped at
 * 500), then feeds the CLI's stdout through the MCP tool's own argv builder and renderer.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test"
import { join } from "path"
import fs from "fs/promises"
import os from "os"
import { buildAgentListArgs, renderAgentList, AGENT_LIST_MAX_LIMIT } from "../../src/cli/cmd/mcp-agent-list"

const PKG = join(import.meta.dir, "../..")
const CLI = join(PKG, "src/index.ts")
const TOTAL = 455
// Newest first, like the server's default sort. Every 10th agent has no description.
const ALL = Array.from({ length: TOTAL }, (_, i) => {
  const id = TOTAL - i
  return {
    id,
    name: id % 7 === 0 ? `Finance agent ${id}` : `Agent ${id}`,
    type: "assistant",
    active: true,
    description: id % 10 === 0 ? "" : `Owns area ${id}`,
    bloq_id: 1,
    workspace_id: 1,
  }
})

let server: ReturnType<typeof Bun.serve>
let home = ""
const seen: URL[] = []

beforeAll(async () => {
  home = await fs.mkdtemp(join(os.tmpdir(), "agents-paging-"))
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      seen.push(url)
      if (url.pathname === "/api/v1/users/2945/bloqs/agents") {
        const q = (url.searchParams.get("search") ?? "").toLowerCase()
        const rows = q ? ALL.filter((a) => a.name.toLowerCase().includes(q) || a.description.toLowerCase().includes(q)) : ALL
        const per = Math.min(Number(url.searchParams.get("per_page") ?? 25) || 25, 500)
        const page = Math.max(1, Number(url.searchParams.get("page") ?? 1) || 1)
        const last = Math.max(1, Math.ceil(rows.length / per))
        return Response.json({
          success: true,
          data: rows.slice((page - 1) * per, page * per),
          meta: { page, per_page: per, total: rows.length, last_page: last, has_more: page < last },
        })
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
  seen.length = 0
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
      IRIS_USER_ID: "2945",
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  return { exitCode: await proc.exited, stdout, stderr }
}

const listCalls = () => seen.filter((u) => u.pathname.endsWith("/bloqs/agents"))

/** What the MCP tool does: build argv from the tool args, run the CLI, render its stdout. */
async function mcpList(args: Record<string, unknown>) {
  const req = buildAgentListArgs(args)
  if (!req.ok) throw new Error(req.error)
  const r = await iris(req.argv)
  expect(r.exitCode).toBe(0)
  return renderAgentList(JSON.parse(r.stdout), req)
}

describe("iris_agent list through the real CLI (#191862)", () => {
  test("page 1 reports the account total, not the page size — the '50 of 50' regression", async () => {
    const out = await mcpList({ action: "list" })
    expect(out.text).not.toContain("50 of 50")
    expect(out.text).toContain(`Agents 1–50 of ${TOTAL}`)
    expect(out.text).toContain("page:2")
    expect(out.meta).toMatchObject({
      total: TOTAL,
      per_page: 50,
      current_page: 1,
      last_page: 10,
      from: 1,
      to: 50,
      has_more: true,
      truncated: true,
      page_rows: 50,
      omitted_no_description: 5,
      returned: 45,
    })
    expect(out.meta.hint).toContain('iris_agent {action:"list", page:2}')
    // The page was asked of the server, not cut locally.
    expect(listCalls()[0].searchParams.get("per_page")).toBe("50")
    expect(listCalls()[0].searchParams.get("page")).toBe("1")
  }, 60_000)

  test("a middle page", async () => {
    const out = await mcpList({ action: "list", page: 5 })
    expect(out.meta).toMatchObject({ current_page: 5, from: 201, to: 250, has_more: true, total: TOTAL })
    expect(out.data[0].id).toBe(TOTAL - 200)
  }, 60_000)

  test("the last page is partial and says so", async () => {
    const out = await mcpList({ action: "list", page: 10 })
    expect(out.meta).toMatchObject({ current_page: 10, last_page: 10, from: 451, to: 455, page_rows: 5, has_more: false, truncated: true })
    expect(out.meta.hint).toBeUndefined()
    expect(out.text).toContain("This is the last page")
  }, 60_000)

  test("paging through every page reaches every described agent exactly once", async () => {
    const ids: unknown[] = []
    let page = 1
    for (;;) {
      const out = await mcpList({ action: "list", page, limit: AGENT_LIST_MAX_LIMIT })
      ids.push(...out.data.map((a) => a.id))
      if (!out.meta.has_more) break
      page++
    }
    expect(page).toBe(3)
    const described = ALL.filter((a) => a.description).map((a) => a.id)
    expect(ids).toEqual(described)
  }, 120_000)

  test("exact boundary: a page that ends on the last agent has no more", async () => {
    // 455 agents in 5 pages of 91 — page 5 ends exactly on the total.
    const out = await mcpList({ action: "list", page: 5, limit: 91 })
    expect(out.meta).toMatchObject({ last_page: 5, to: 455, has_more: false })
    const prev = await mcpList({ action: "list", page: 4, limit: 91 })
    expect(prev.meta).toMatchObject({ to: 364, has_more: true })
  }, 60_000)

  test("a page past the last says how many exist and how to start over", async () => {
    const out = await mcpList({ action: "list", page: 11 })
    expect(out.data).toEqual([])
    expect(out.meta).toMatchObject({ total: TOTAL, last_page: 10, has_more: false, from: null })
    expect(out.text).toContain("past the last page (10)")
    expect(out.text).toContain(`${TOTAL} agent(s)`)
  }, 60_000)

  test("a filter is sent to the server and the total is the filtered total", async () => {
    const finance = ALL.filter((a) => a.name.includes("Finance"))
    const out = await mcpList({ action: "list", query: "finance", limit: 20 })
    expect(listCalls()[0].searchParams.get("search")).toBe("finance")
    expect(out.meta).toMatchObject({ total: finance.length, per_page: 20, last_page: Math.ceil(finance.length / 20), has_more: true })
    expect(out.text).toContain(`of ${finance.length} matching "finance"`)
    expect(out.meta.hint).toContain('query:"finance"')
    expect(out.meta.hint).toContain("limit:20")
  }, 60_000)

  test("no match is reported as empty, not as a page problem", async () => {
    const out = await mcpList({ action: "list", query: "zzz-nobody" })
    expect(out.meta).toMatchObject({ total: 0, has_more: false })
    expect(out.text).toContain('No agents matched "zzz-nobody"')
  }, 60_000)
})

describe("iris_agent list argument validation (#191862)", () => {
  for (const bad of [{ limit: 0 }, { limit: -1 }, { limit: AGENT_LIST_MAX_LIMIT + 1 }, { limit: 1.5 }, { limit: "50" }, { page: 0 }, { page: -2 }, { page: 1.5 }]) {
    test(`refuses ${JSON.stringify(bad)}`, () => {
      const r = buildAgentListArgs({ action: "list", ...bad })
      expect(r.ok).toBe(false)
      if (r.ok) return
      // Worded as tool fields, not CLI flags.
      expect(r.error).not.toContain("--")
      expect(r.error).toContain(Object.keys(bad)[0])
    })
  }

  test("defaults are page 1, 50 per page", () => {
    const r = buildAgentListArgs({ action: "list" })
    expect(r.ok && r.argv).toEqual(["agents", "list", "--json", "--limit", "50", "--page", "1"])
  })

  test("shell metacharacters in query are refused", () => {
    expect(buildAgentListArgs({ action: "list", query: "a;rm -rf" }).ok).toBe(false)
  })

  test("an envelope with no total falls back to 'a full page means more', never to 'that is all'", () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({ id: i + 1, name: `A${i}`, description: "d" }))
    const out = renderAgentList({ data: rows }, { query: "", page: 1, perPage: 50 })
    expect(out.meta).toMatchObject({ total: null, has_more: true })
    expect(out.text).toContain("an unknown total of")
    expect(out.text).not.toContain("50 of 50")
  })
})

describe("iris_agent tool wiring (#191862)", () => {
  test("mcp-serve uses the paged builder and declares limit/page", async () => {
    const src = await fs.readFile(join(PKG, "src/cli/cmd/mcp-serve.ts"), "utf8")
    expect(src).not.toContain('["agents", "list", "--json", "--limit", "50"]')
    expect(src).toContain("buildAgentListArgs(")
    expect(src).toContain("renderAgentList(")
    const schema = src.slice(src.indexOf('name: "iris_agent"'), src.indexOf('name: "iris_memory"'))
    expect(schema).toMatch(/\n\s+limit: \{ type: "number", description: "list:/)
    expect(schema).toMatch(/\n\s+page: \{ type: "number", description: "list:/)
    expect(schema).toContain("The list is PAGED")
  })
})

describe("iris agents list --limit/--page validation (#191862)", () => {
  for (const [flags, field] of [
    [["--limit", "0"], "limit"],
    [["--limit", "501"], "limit"],
    [["--page", "0"], "page"],
    [["--page", "-1"], "page"],
  ] as const) {
    test(`${flags.join(" ")} is refused with exit 2 and no request`, async () => {
      const r = await iris(["agents", "list", ...flags, "--json"])
      expect(r.exitCode).toBe(2)
      const out = JSON.parse(r.stdout.trim())
      expect(Object.keys(out.errors)).toEqual([field])
      expect(listCalls().length).toBe(0)
    }, 60_000)
  }

  test("JSON meta reports the page size asked for and the account total", async () => {
    const r = await iris(["agents", "list", "--limit", "50", "--page", "10", "--json"])
    expect(r.exitCode).toBe(0)
    const out = JSON.parse(r.stdout)
    expect(out.data.length).toBe(5)
    expect(out.meta.total).toBe(TOTAL)
    expect(out.meta.limit).toBe(50)
    // Page 10 must say it is page 10, not page 1 (#191863 follow-up).
    expect(out.meta).toMatchObject({ current_page: 10, last_page: 10, from: 451, to: 455, has_more: false })
  }, 60_000)
})
