import { afterEach, beforeEach, expect, test } from "bun:test"
import { IssueCmd, RevokeCmd } from "../../src/cli/cmd/licence"

/** #191949: a failure under --json must answer on stdout. #191947: a bad --days must not become the default. */

let written: string[] = []
let calls = 0
let reply = new Response("{}")
const saved = { fetch: globalThis.fetch, stdout: process.stdout.write, argv: process.argv, key: process.env.IRIS_API_KEY }

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const defaults = { tier: "starter", seats: 1, allowance: 0 }

beforeEach(() => {
  written = []
  calls = 0
  process.exitCode = 0
  process.env.IRIS_API_KEY = "test-token"
  process.argv = ["bun", "iris", "--json"]
  process.stdout.write = ((chunk: any, cb?: any) => {
    written.push(String(chunk))
    if (typeof cb === "function") cb()
    return true
  }) as typeof process.stdout.write
  globalThis.fetch = (async () => {
    calls++
    return reply
  }) as unknown as typeof fetch
})

afterEach(() => {
  globalThis.fetch = saved.fetch
  process.stdout.write = saved.stdout
  process.argv = saved.argv
  process.exitCode = 0
  if (saved.key === undefined) delete process.env.IRIS_API_KEY
  else process.env.IRIS_API_KEY = saved.key
})

test("revoke of an unknown key under --json exits non-zero with JSON on stdout", async () => {
  reply = json({ success: false, error: "not_found" }, 404)
  await (RevokeCmd as any).handler({ key: "IRIS-AAAA-BBBB-CCCC", json: true })
  expect(process.exitCode).toBe(1)
  expect(JSON.parse(written.join("")).status).toBe(404)
})

test("a second revoke under --json reports already_revoked and exits 0", async () => {
  reply = json({ success: true, already_revoked: true, data: { status: "revoked" } })
  await (RevokeCmd as any).handler({ key: "IRIS-AAAA-BBBB-CCCC", json: true })
  expect(process.exitCode).toBe(0)
  expect(JSON.parse(written.join("")).already_revoked).toBe(true)
})

test("issue refused as non-operator under --json exits non-zero with JSON on stdout", async () => {
  reply = json({ success: false, error: "not_found" }, 404)
  await (IssueCmd as any).handler({ ...defaults, json: true })
  expect(process.exitCode).toBe(1)
  expect(JSON.parse(written.join("")).success).toBe(false)
})

test("--days that is not a number never reaches the server", async () => {
  await (IssueCmd as any).handler({ ...defaults, days: Number.NaN, json: true })
  expect(calls).toBe(0)
  expect(process.exitCode).toBe(1)
})
