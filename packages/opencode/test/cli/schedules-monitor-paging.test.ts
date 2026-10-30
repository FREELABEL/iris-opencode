/**
 * #191851 — `iris schedules list --limit 0|1` and `--page 0|-1` all returned every one of 967
 * schedules (~946 KB of JSON), which a cloud agent without a sandbox cannot consume.
 * #191850 — `iris monitor overview --hours 0|-1|999999` was sent as-is: 0 and -1 came back as an
 * empty window that looked normal, 999999 as 3,839 hourly rows (~475 KB).
 *
 * Spawns the REAL CLI against a local server playing both backends: an fl-api that either
 * ignores `page` (as production did) or honours it (after the fl-api fix), and an fl-iris-api
 * monitor. Asserts on what reached the server, what came out on stdout, and the exit code.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test"
import { join } from "path"
import fs from "fs/promises"
import os from "os"
import { paginationErrors, pageInfo } from "../../src/cli/cmd/pagination-args"
import { windowHoursError, MONITOR_MAX_WINDOW_HOURS } from "../../src/cli/cmd/platform-monitor"
import { pageSchedules, schedulesListParams, SCHEDULES_MAX_PER_PAGE } from "../../src/cli/cmd/platform-schedules"

const PKG = join(import.meta.dir, "../..")
const CLI = join(PKG, "src/index.ts")
const TOTAL = 967
const ALL = Array.from({ length: TOTAL }, (_, i) => ({ id: i + 1, status: "cancelled", frequency: "daily", next_run_at: null }))

let server: ReturnType<typeof Bun.serve>
let home = ""
let serverPages = false
const seen: URL[] = []

beforeAll(async () => {
  home = await fs.mkdtemp(join(os.tmpdir(), "schedules-paging-"))
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      seen.push(url)
      if (url.pathname === "/api/v1/users/2945/bloqs/scheduled-jobs") {
        const page = url.searchParams.get("page")
        if (serverPages && page !== null) {
          const per = Number(url.searchParams.get("per_page") ?? 50)
          const p = Number(page)
          const rows = ALL.slice((p - 1) * per, p * per)
          const last = Math.ceil(TOTAL / per)
          return Response.json({ data: rows, meta: { page: p, per_page: per, total: TOTAL, last_page: last, has_more: p < last }, total: TOTAL })
        }
        // Production before the fl-api fix: page/per_page ignored, everything returned.
        return Response.json({ data: ALL })
      }
      if (url.pathname === "/api/v6/agents/heartbeat-status")
        return Response.json({ success: true, data: { window_hours: Number(url.searchParams.get("hours")), jobs: {} } })
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
  serverPages = false
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

const listCalls = () => seen.filter((u) => u.pathname.endsWith("/bloqs/scheduled-jobs"))

describe("iris schedules list paging (#191851)", () => {
  test("--limit 1 returns one row and the page metadata, even from a server that ignores paging", async () => {
    const r = await iris(["schedules", "list", "--limit", "1", "--json"])
    expect(r.exitCode).toBe(0)
    const out = JSON.parse(r.stdout)
    expect(out.schedules.length).toBe(1)
    expect(out.schedules[0].id).toBe(1)
    expect(out.pagination).toMatchObject({ page: 1, per_page: 1, total: TOTAL, last_page: TOTAL, has_more: true, returned: 1, max_per_page: 200 })
    expect(r.stdout.length).toBeLessThan(2_000)
    // The page was asked for, not just cut locally.
    expect(listCalls()[0].searchParams.get("page")).toBe("1")
    expect(listCalls()[0].searchParams.get("per_page")).toBe("1")
  }, 60_000)

  test("uses the server's page when it pages, and reports the server's total", async () => {
    serverPages = true
    const r = await iris(["schedules", "list", "--limit", "50", "--page", "20", "--json"])
    expect(r.exitCode).toBe(0)
    const out = JSON.parse(r.stdout)
    expect(out.schedules.map((s: any) => s.id)).toEqual(ALL.slice(950, 967).map((s) => s.id))
    expect(out.pagination).toMatchObject({ page: 20, per_page: 50, total: TOTAL, last_page: 20, has_more: false, returned: 17, paged_by: "server" })
  }, 60_000)

  for (const [flags, field] of [
    [["--limit", "0"], "limit"],
    [["--limit", "-1"], "limit"],
    [["--limit", "201"], "limit"],
    [["--limit", "1.5"], "limit"],
    [["--limit", "abc"], "limit"],
    [["--page", "0"], "page"],
    [["--page", "-1"], "page"],
    [["--page", "2.5"], "page"],
  ] as const) {
    test(`${flags.join(" ")} is refused as JSON with a non-zero exit and no request`, async () => {
      const r = await iris(["schedules", "list", ...flags, "--json"])
      expect(r.exitCode).toBe(2)
      const out = JSON.parse(r.stdout.trim())
      expect(out.success).toBe(false)
      expect(Object.keys(out.errors)).toEqual([field])
      expect(listCalls().length).toBe(0)
    }, 60_000)
  }
})

describe("iris monitor overview --hours (#191850)", () => {
  for (const hours of ["0", "-1", "721", "999999", "1.5"]) {
    test(`--hours ${hours} is refused before the request`, async () => {
      const r = await iris(["monitor", "overview", "--hours", hours, "--json"])
      expect(r.exitCode).toBe(2)
      const out = JSON.parse(r.stdout.trim())
      expect(out.errors.hours[0]).toContain("1 to 720")
      expect(seen.some((u) => u.pathname === "/api/v6/agents/heartbeat-status")).toBe(false)
    }, 60_000)
  }

  test("--hours 720 is sent as asked", async () => {
    const r = await iris(["monitor", "overview", "--hours", "720", "--json"])
    expect(r.exitCode).toBe(0)
    expect(seen.find((u) => u.pathname === "/api/v6/agents/heartbeat-status")?.searchParams.get("hours")).toBe("720")
  }, 60_000)
})

describe("helpers", () => {
  test("paginationErrors bounds limit and page", () => {
    expect(paginationErrors({ limit: 50, page: 1 }, { maxLimit: 200 })).toBeNull()
    expect(paginationErrors({ limit: 200, page: 9 }, { maxLimit: 200 })).toBeNull()
    expect(Object.keys(paginationErrors({ limit: 0, page: 0 }, { maxLimit: 200 })!)).toEqual(["limit", "page"])
    expect(paginationErrors({ limit: NaN }, {})!.limit[0]).toContain('"NaN"')
    expect(paginationErrors({}, {})).toBeNull()
  })

  test("windowHoursError caps at 720", () => {
    expect(MONITOR_MAX_WINDOW_HOURS).toBe(720)
    expect(windowHoursError(1)).toBeNull()
    expect(windowHoursError(720)).toBeNull()
    expect(windowHoursError(721)).not.toBeNull()
    expect(windowHoursError(0)).not.toBeNull()
  })

  test("client-side filters fetch the whole list; otherwise the page is asked for", () => {
    expect(SCHEDULES_MAX_PER_PAGE).toBe(200)
    expect(schedulesListParams({ limit: 5, page: 2, clientSideFilter: false }).toString()).toBe("page=2&per_page=5")
    expect(schedulesListParams({ limit: 5, page: 2, clientSideFilter: true, agentId: 9 }).toString()).toBe("agent_id=9")
  })

  test("pageSchedules slices locally when the server did not page", () => {
    const rows = [1, 2, 3, 4, 5]
    expect(pageSchedules(null, rows, 2, 2)).toEqual({ rows: [3, 4], pagination: { ...pageInfo(2, 2, 5, 2), paged_by: "client" } })
    expect(pageSchedules(null, rows, 9, 2).rows).toEqual([])
  })
})
