import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { ClaimCmd, IssueCmd, RevokeCmd } from "../../src/cli/cmd/licence"

/**
 * #191947: `issue --days 0` silently became a one-year licence.
 * #191949: `claim` and `revoke` exited 0 when they failed, so scripts read failure as success,
 * and a second revoke said "Revoked".
 */

let written: string[] = []
let errors: string[] = []
let requests: { url: string; body: any }[] = []
let reply: Response = new Response("{}")
const saved = {
  fetch: globalThis.fetch,
  stdout: process.stdout.write,
  stderr: process.stderr.write,
  argv: process.argv,
  exit: process.exitCode,
  key: process.env.IRIS_API_KEY,
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })

const stdout = () => written.join("")
const allOutput = () => stdout() + errors.join("")

const run = async (command: any, args: Record<string, unknown>, jsonMode = false) => {
  process.argv = jsonMode ? ["bun", "iris", "--json"] : ["bun", "iris"]
  await command.handler({ json: jsonMode, ...args })
}

beforeEach(() => {
  written = []
  errors = []
  requests = []
  process.exitCode = 0
  process.env.IRIS_API_KEY = "test-token"
  process.stdout.write = ((chunk: any, cb?: any) => {
    written.push(String(chunk))
    if (typeof cb === "function") cb()
    return true
  }) as typeof process.stdout.write
  process.stderr.write = ((chunk: any, cb?: any) => {
    errors.push(String(chunk))
    if (typeof cb === "function") cb()
    return true
  }) as typeof process.stderr.write
  globalThis.fetch = (async (url: any, init: any) => {
    requests.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : undefined })
    return reply
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = saved.fetch
  process.stdout.write = saved.stdout
  process.stderr.write = saved.stderr
  process.argv = saved.argv
  process.exitCode = 0
  if (saved.key === undefined) delete process.env.IRIS_API_KEY
  else process.env.IRIS_API_KEY = saved.key
})

describe("iris licence issue", () => {
  test("--days 0 reaches the server, and its refusal is a failure", async () => {
    reply = json({ message: "The days must be at least 1.", errors: { days: ["The days must be at least 1."] } }, 422)

    await run(IssueCmd, { days: 0, tier: "starter", seats: 1, allowance: 0 })

    expect(requests[0].body.days).toBe(0)
    expect(process.exitCode).toBe(1)
  })

  test("no --days sends no days", async () => {
    reply = json({ data: { key: "IRIS-AAAA-BBBB-CCCC" } }, 201)

    await run(IssueCmd, { tier: "starter", seats: 1, allowance: 0 }, true)

    expect("days" in requests[0].body).toBe(false)
    expect(process.exitCode).toBe(0)
  })

  test("--days that is not a number never reaches the server as a default term", async () => {
    await run(IssueCmd, { days: Number.NaN, tier: "starter", seats: 1, allowance: 0 })

    expect(requests).toEqual([])
    expect(process.exitCode).toBe(1)
  })

  test("--lead is sent, so the server can refuse one that does not exist", async () => {
    reply = json({ message: "The selected lead id is invalid.", errors: { lead_id: ["invalid"] } }, 422)

    await run(IssueCmd, { lead: 0, tier: "starter", seats: 1, allowance: 0 })

    expect(requests[0].body.lead_id).toBe(0)
    expect(process.exitCode).toBe(1)
  })

  test("a non-operator's 404 exits non-zero with JSON on stdout", async () => {
    reply = json({ success: false, error: "not_found" }, 404)

    await run(IssueCmd, { tier: "starter", seats: 1, allowance: 0 }, true)

    expect(process.exitCode).toBe(1)
    expect(JSON.parse(stdout()).success).toBe(false)
  })
})

describe("iris licence claim", () => {
  const refused = () =>
    json({ success: false, ok: false, license: null, error: "That licence key was not found." }, 422)

  test("a refusal exits non-zero and says why", async () => {
    reply = refused()

    await run(ClaimCmd, { key: "IRIS-AAAA-BBBB-CCCC" })

    expect(process.exitCode).toBe(1)
    expect(allOutput()).toContain("That licence key was not found.")
  })

  test("a refusal under --json exits non-zero with the reason on stdout", async () => {
    reply = refused()

    await run(ClaimCmd, { key: "IRIS-AAAA-BBBB-CCCC" }, true)

    expect(process.exitCode).toBe(1)
    const out = JSON.parse(stdout())
    expect(out.success).toBe(false)
    expect(out.status).toBe(422)
    expect(out.error).toBe("That licence key was not found.")
  })

  test("a claim that works exits 0", async () => {
    reply = json({ success: true, ok: true, license: { tier: "pro" } })

    await run(ClaimCmd, { key: "IRIS-AAAA-BBBB-CCCC" })

    expect(process.exitCode).toBe(0)
  })
})

describe("iris licence revoke", () => {
  test("an unknown key exits non-zero", async () => {
    reply = json({ success: false, error: "not_found" }, 404)

    await run(RevokeCmd, { key: "IRIS-AAAA-BBBB-CCCC" })

    expect(process.exitCode).toBe(1)
    expect(allOutput()).not.toContain("Revoked")
  })

  test("an unknown key under --json exits non-zero with JSON on stdout", async () => {
    reply = json({ success: false, error: "not_found" }, 404)

    await run(RevokeCmd, { key: "IRIS-AAAA-BBBB-CCCC" }, true)

    expect(process.exitCode).toBe(1)
    const out = JSON.parse(stdout())
    expect(out.success).toBe(false)
    expect(out.status).toBe(404)
  })

  test("a first revoke says revoked", async () => {
    reply = json({ success: true, already_revoked: false, data: { status: "revoked" } })

    await run(RevokeCmd, { key: "IRIS-AAAA-BBBB-CCCC" })

    expect(process.exitCode).toBe(0)
    expect(allOutput()).toContain("Revoked IRIS-AAAA-BBBB-CCCC")
  })

  test("a second revoke says already revoked, and is not a failure", async () => {
    reply = json({ success: true, already_revoked: true, data: { status: "revoked" } })

    await run(RevokeCmd, { key: "IRIS-AAAA-BBBB-CCCC" })

    expect(process.exitCode).toBe(0)
    expect(allOutput()).toContain("already revoked")
    expect(allOutput()).not.toContain("Revoked IRIS")
  })
})
