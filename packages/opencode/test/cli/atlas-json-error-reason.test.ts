/**
 * #191045 — `iris atlas create-list <bloq> <name> --json` answered a refused write with a bare
 * {"success":false,"error":"HTTP 403"}. The server had said WHY ("Only this board's owner can add
 * lists. You are on this board as editor.", #190334) and the --json branch threw it away before
 * handleApiError could read it. The cloud MCP runs every command with --json, so a board member
 * hitting an owner-only rule saw what looked like a broken route — filed twice (#190325, #191045).
 *
 * The same short-circuit sat on 23 write/read paths in platform-bloqs.ts; the source guard below
 * keeps it from coming back on any of them.
 *
 * Spawns the REAL CLI against a local server, because the defect was in the command's own branch,
 * which an in-process test of handleApiError does not reach.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { join } from "path"
import fs from "fs/promises"
import os from "os"

const PKG = join(import.meta.dir, "../..")
const CLI = join(PKG, "src/index.ts")
const REASON = "Only this board's owner can add lists. You are on this board as editor."

let server: ReturnType<typeof Bun.serve>
let home = ""
const seen: string[] = []

beforeAll(async () => {
  home = await fs.mkdtemp(join(os.tmpdir(), "atlas-json-reason-"))
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      seen.push(`${req.method} ${url.pathname}`)
      if (req.method === "POST" && url.pathname === "/api/v1/user/bloqs/544/lists")
        return Response.json({ success: false, error: REASON }, { status: 403 })
      return Response.json({ success: false, message: "not here" }, { status: 404 })
    },
  })
})

afterAll(async () => {
  server?.stop(true)
  if (home) await fs.rm(home, { recursive: true, force: true })
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

describe("atlas create-list --json on a refused write", () => {
  test("carries the server's reason and status, not a bare HTTP code", async () => {
    const r = await iris(["atlas", "create-list", "544", "Recurring Patterns", "--json"])
    expect(seen).toContain("POST /api/v1/user/bloqs/544/lists") // the refusal really came from the server

    const lines = r.stdout.trim().split("\n")
    expect(lines.length).toBe(1) // exactly one object a script can parse
    const out = JSON.parse(lines[0])
    expect(out.success).toBe(false)
    expect(out.error).toBe(REASON)
    expect(out.status).toBe(403)
    expect(r.exitCode).not.toBe(0)
  }, 60_000)
})

describe("platform-bloqs.ts source guard", () => {
  test("no --json failure path answers with only the status code", async () => {
    const src = await Bun.file(join(PKG, "src/cli/cmd/platform-bloqs.ts")).text()
    expect(src).not.toMatch(/failJson\(\{ success: false, error: `HTTP \$\{res\.status\}` \}\)/)
  })
})
