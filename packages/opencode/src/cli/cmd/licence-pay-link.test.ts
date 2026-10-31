import { afterEach, beforeEach, expect, test } from "bun:test"
import yargs from "yargs"
import { LicenceCommand } from "./licence"

/** #191969: the client half of the trial-to-paid link. Tests drive the real yargs tree. */
const realFetch = globalThis.fetch
const realWrite = process.stdout.write
const realErr = process.stderr.write
let requests: { url: string; body: any }[] = []
let stdout = ""
let stderr = ""

function respondWith(status: number, body: unknown) {
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    requests.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined })
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
  }) as any
}

const parse = (argv: string[]) =>
  yargs(argv)
    .command({ ...(LicenceCommand as any) })
    .demandCommand()
    .exitProcess(false)
    .fail((msg: string, err: Error) => {
      throw err ?? new Error(msg)
    })
    .parseAsync()

const base = ["licence", "pay-link", "--plan", "team", "--people", "a@x.test", "b@x.test", "--from", "IRIS-AAAA-BBBB-CCCC", "--billing-email", "pay@x.test"]

beforeEach(() => {
  requests = []
  stdout = ""
  stderr = ""
  process.exitCode = 0
  process.stderr.write = ((chunk: any, ...rest: any[]) => {
    stderr += String(chunk)
    rest.find((r) => typeof r === "function")?.()
    return true
  }) as any
  process.stdout.write = ((chunk: any, ...rest: any[]) => {
    stdout += String(chunk)
    rest.find((r) => typeof r === "function")?.()
    return true
  }) as any
})

afterEach(() => {
  globalThis.fetch = realFetch
  process.stdout.write = realWrite
  process.stderr.write = realErr
  process.exitCode = 0
})

test("sends the choice and prints the link", async () => {
  respondWith(201, { data: { id: 7, amount_cents: 79900, seats: 5, people: ["a@x.test", "b@x.test"], link_url: "https://checkout.stripe.test/x" } })
  await parse(base)
  expect(requests[0].url).toEndWith("/licences/conversions")
  expect(requests[0].body).toMatchObject({ plan: "team", method: "checkout", people: ["a@x.test", "b@x.test"], from: ["IRIS-AAAA-BBBB-CCCC"], billing_email: "pay@x.test" })
  expect(requests[0].body).not.toHaveProperty("amount_cents")
  expect(stdout + stderr).toContain("https://checkout.stripe.test/x")
  expect(process.exitCode).toBe(0)
})

test("--invoice asks for an invoice", async () => {
  respondWith(201, { data: { id: 7, link_url: "https://invoice.stripe.test/x" } })
  await parse([...base, "--invoice", "--days-until-due", "14"])
  expect(requests[0].body).toMatchObject({ method: "invoice", days_until_due: 14 })
})

test("an unknown plan is the server's refusal and a failed exit", async () => {
  respondWith(422, { success: false, error: "Unknown plan" })
  await parse([...base, "--json"])
  expect(stdout).toContain("Unknown plan")
  expect(process.exitCode).toBe(1)
})

test("a plan, people and keys are all required", async () => {
  respondWith(201, {})
  await expect((async () => parse(["licence", "pay-link", "--plan", "team"]))()).rejects.toThrow()
  expect(requests).toHaveLength(0)
})

test("pay-status exits non-zero on a refusal", async () => {
  respondWith(200, { data: { status: "pending", plan_key: "team", amount_cents: 79900, refusal: "paid 1 usd, expected 79900 usd" } })
  await parse(["licence", "pay-status", "7"])
  expect(requests[0].url).toEndWith("/licences/conversions/7")
  expect(process.exitCode).toBe(1)
})
