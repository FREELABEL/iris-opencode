import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import yargs from "yargs"
import { AllowCmd, ClaimCmd, IssueCmd, LicenceCommand, LinkCmd, ReleaseCmd, RenewCmd, RevokeCmd } from "./licence"

/**
 * #191947: --days 0 was dropped as falsy, so the server applied its default and handed back a
 * year. #191949: a refused claim, or a failed revoke or link, printed a warning and exited 0, so a
 * script could not tell it had not worked. #191940: the client half of named seats and release.
 */

const realFetch = globalThis.fetch
const realWrite = process.stdout.write
let requests: { url: string; body: any }[] = []
let stdout = ""

function respondWith(status: number, body: unknown) {
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    requests.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined })
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
  }) as any
}

const run = (command: any, args: Record<string, unknown>) => command.handler(args)

beforeEach(() => {
  requests = []
  stdout = ""
  process.exitCode = 0
  process.stdout.write = ((chunk: any, ...rest: any[]) => {
    stdout += String(chunk)
    rest.find((r) => typeof r === "function")?.()
    return true
  }) as any
})

afterEach(() => {
  globalThis.fetch = realFetch
  process.stdout.write = realWrite
  process.exitCode = 0
})

describe("licence issue", () => {
  test("--days 0 reaches the server instead of silently becoming a year", async () => {
    respondWith(422, { message: "The days must be at least 1." })
    await run(IssueCmd, { days: 0, tier: "starter", seats: 1, allowance: 0 })
    expect(requests[0].body.days).toBe(0)
    expect(process.exitCode).toBe(1)
  })

  test("no --days leaves the server's default alone", async () => {
    respondWith(201, { data: { key: "IRIS-AAAA-BBBB-CCCC" } })
    await run(IssueCmd, { tier: "starter", seats: 1, allowance: 0 })
    expect("days" in requests[0].body).toBe(false)
  })

  test("--allow sends the named people, split and trimmed", async () => {
    respondWith(201, { data: { key: "IRIS-AAAA-BBBB-CCCC" } })
    await run(IssueCmd, { tier: "starter", seats: 2, allowance: 0, allow: "a@x.test, b@x.test" })
    expect(requests[0].body.allowed_emails).toEqual(["a@x.test", "b@x.test"])
  })

  test("no --allow stays an open licence", async () => {
    respondWith(201, { data: { key: "IRIS-AAAA-BBBB-CCCC" } })
    await run(IssueCmd, { tier: "starter", seats: 1, allowance: 0 })
    expect("allowed_emails" in requests[0].body).toBe(false)
  })
})

describe("licence exit codes", () => {
  test("a refused claim exits non-zero", async () => {
    respondWith(422, { success: false, error: "This licence has no seats left" })
    await run(ClaimCmd, { key: "IRIS-AAAA-BBBB-CCCC" })
    expect(process.exitCode).toBe(1)
  })

  test("a refused claim exits non-zero under --json and still answers on stdout", async () => {
    respondWith(422, { success: false, error: "This licence has no seats left" })
    await run(ClaimCmd, { key: "IRIS-AAAA-BBBB-CCCC", json: true })
    expect(process.exitCode).toBe(1)
    expect(stdout).toContain("no seats left")
  })

  test("a good claim exits zero", async () => {
    respondWith(200, { success: true, license: { tier: "pro" } })
    await run(ClaimCmd, { key: "IRIS-AAAA-BBBB-CCCC" })
    expect(process.exitCode).toBe(0)
  })

  test("revoking a key that is not there exits non-zero", async () => {
    respondWith(404, { success: false, error: "not_found" })
    await run(RevokeCmd, { key: "IRIS-AAAA-BBBB-CCCC" })
    expect(process.exitCode).toBe(1)
  })

  test("linking a key that is not there exits non-zero", async () => {
    respondWith(404, { success: false, error: "not_found" })
    await run(LinkCmd, { key: "IRIS-AAAA-BBBB-CCCC", lead: 1 })
    expect(process.exitCode).toBe(1)
  })

  test("revoking an already revoked key succeeds", async () => {
    respondWith(200, { success: true, already_revoked: true })
    await run(RevokeCmd, { key: "IRIS-AAAA-BBBB-CCCC" })
    expect(process.exitCode).toBe(0)
  })
})

describe("licence release and allow", () => {
  test("release posts the email and exits zero", async () => {
    respondWith(200, { success: true, released: true, unlisted: false, key_still_open: true })
    await run(ReleaseCmd, { key: "IRIS-AAAA-BBBB-CCCC", email: "a@x.test" })
    expect(requests[0].url).toEndWith("/api/v1/licences/IRIS-AAAA-BBBB-CCCC/seats/release")
    expect(requests[0].body).toEqual({ email: "a@x.test" })
    expect(process.exitCode).toBe(0)
  })

  test("releasing someone with no seat exits non-zero", async () => {
    respondWith(422, { success: false, error: "That person does not hold a seat on this licence." })
    await run(ReleaseCmd, { key: "IRIS-AAAA-BBBB-CCCC", email: "a@x.test" })
    expect(process.exitCode).toBe(1)
  })

  test("allow posts the list", async () => {
    respondWith(200, { success: true, data: { allowed_emails: ["a@x.test", "b@x.test"] } })
    await run(AllowCmd, { key: "IRIS-AAAA-BBBB-CCCC", emails: ["a@x.test", "b@x.test"] })
    expect(requests[0].url).toEndWith("/api/v1/licences/IRIS-AAAA-BBBB-CCCC/allow")
    expect(requests[0].body).toEqual({ emails: ["a@x.test", "b@x.test"] })
  })
})

describe("licence extend (#191970)", () => {
  const parse = (argv: string[]) =>
    yargs(argv)
      .command({ ...(LicenceCommand as any) })
      .demandCommand()
      .exitProcess(false)
      .fail((msg: string, err: Error) => {
        throw err ?? new Error(msg)
      })
      .parseAsync()

  test("reaches the renew route with the days, through the real command tree", async () => {
    respondWith(200, { data: { key: "IRIS-AAAA-BBBB-CCCC", expires_at: "2027-01-01T00:00:00Z" } })
    await parse(["licence", "extend", "IRIS-AAAA-BBBB-CCCC", "--days", "30"])
    expect(requests).toHaveLength(1)
    expect(requests[0].url).toEndWith("/IRIS-AAAA-BBBB-CCCC/renew")
    expect(requests[0].body).toEqual({ days: 30 })
  })

  test("a server refusal is still a failure, as it is for renew", async () => {
    respondWith(422, { error: "This licence follows its Stripe subscription, which sets when it ends." })
    await parse(["licence", "extend", "IRIS-AAAA-BBBB-CCCC", "--days", "30"])
    expect(process.exitCode).toBe(1)
  })

  test("--days is required", async () => {
    respondWith(200, {})
    await expect((async () => parse(["licence", "extend", "IRIS-AAAA-BBBB-CCCC"]))()).rejects.toThrow(/days/)
    expect(requests).toHaveLength(0)
  })

  test("is declared on the shared command, so `iris reachr licence extend` gets it too", () => {
    expect((RenewCmd as any).aliases).toContain("extend")
  })
})
