import { expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"

const CLI = path.join(import.meta.dir, "../../src/index.ts")

// #192145: bad values are refused before any request, never quietly turned into something else.
async function iris(args: string[]) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "timeout-"))
  const proc = Bun.spawn(["bun", "run", CLI, ...args], {
    cwd: path.join(import.meta.dir, "../.."),
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      HOME: root,
      OPENCODE_TEST_HOME: root,
      XDG_DATA_HOME: path.join(root, "d"),
      XDG_CONFIG_HOME: path.join(root, "c"),
      XDG_CACHE_HOME: path.join(root, "x"),
      XDG_STATE_HOME: path.join(root, "s"),
      IRIS_API_KEY: "test-token",
      IRIS_USER_ID: "1",
      IRIS_FL_API_URL: "http://127.0.0.1:9",
      IRIS_API_URL: "http://127.0.0.1:9",
      IRIS_TELEMETRY: "0",
      DO_NOT_TRACK: "1",
    },
  })
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  const code = await proc.exited
  await fs.rm(root, { recursive: true, force: true })
  return { code, text: out + err, out }
}

const cases: [string, string[], string][] = [
  ["sandbox 0", ["hive", "sandbox", "echo hi", "--timeout", "0"], "from 1 to 120"],
  ["sandbox -5", ["hive", "sandbox", "echo hi", "--timeout=-5"], "from 1 to 120"],
  ["sandbox abc", ["hive", "sandbox", "echo hi", "--timeout", "abc"], "from 1 to 120"],
  ["sandbox over its maximum", ["hive", "sandbox", "echo hi", "--timeout", "500"], "from 1 to 120"],
  ["hive run under its minimum", ["hive", "run", "node-x", "echo hi", "--timeout", "8"], "from 30 to 3600"],
  ["hive run over its maximum", ["hive", "run", "node-x", "echo hi", "--timeout", "4000"], "from 30 to 3600"],
]
for (const [name, args, range] of cases) {
  test(name, async () => {
    const r = await iris(args)
    expect(r.code).toBe(2)
    expect(r.text).toContain(`--timeout must be a whole number ${range}`)
  }, 60_000)
}

test("--json refusal is JSON on stdout", async () => {
  const r = await iris(["hive", "sandbox", "echo hi", "--timeout", "500", "--json"])
  expect(r.code).toBe(2)
  const body = JSON.parse(r.out.trim().split("\n").pop()!)
  expect(body.success).toBe(false)
  expect(body.errors.timeout[0]).toContain("from 1 to 120")
}, 60_000)
