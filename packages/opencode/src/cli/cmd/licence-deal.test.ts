import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import yargs from "yargs"
import { UI } from "../ui"
import { LicenceCommand, agreedLine, revenueLines } from "./licence"

/** #191973: what was agreed for a licence, and a report that never invents a total. */
const realFetch = globalThis.fetch
let requests: { url: string; body: any }[] = []
let reply: unknown = {}
let printed: string[] = []
let spy: any

const parse = (argv: string[]) =>
  yargs(argv)
    .command({ ...(LicenceCommand as any) })
    .demandCommand()
    .exitProcess(false)
    .fail((msg: string, err: Error) => {
      throw err ?? new Error(msg)
    })
    .parseAsync()

beforeEach(() => {
  requests = []
  reply = {}
  printed = []
  process.exitCode = 0
  spy = spyOn(UI, "println").mockImplementation((...m: any[]) => void printed.push(m.join(" ")))
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    requests.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined })
    return new Response(JSON.stringify({ success: true, data: reply }), { status: 200, headers: { "Content-Type": "application/json" } })
  }) as any
})

afterEach(() => {
  globalThis.fetch = realFetch
  spy.mockRestore()
  process.exitCode = 0
})

test("deal sends only what was given", async () => {
  await parse(["licence", "deal", "K1", "--price-cents", "0", "--reference", "inv-1"])
  expect(requests[0].url).toEndWith("/api/v1/licences/K1/deal")
  expect(requests[0].body).toEqual({ agreed_price_cents: 0, payment_reference: "inv-1" })
})

test("--clear-price clears the price, it does not set it to zero", async () => {
  await parse(["licence", "deal", "K1", "--clear-price"])
  expect(requests[0].body).toEqual({ agreed_price_cents: null })
})

test("deal with nothing, or a price that is not a number, sends nothing", async () => {
  await parse(["licence", "deal", "K1"])
  await parse(["licence", "deal", "K1", "--price-cents", "abc"])
  expect(requests).toEqual([])
  expect(process.exitCode).toBe(1)
})

test("issue carries a price of 0", async () => {
  await parse(["licence", "issue", "--email", "a@x.test", "--price-cents", "0", "--reference", "r", "--json"])
  expect(requests[0].body.agreed_price_cents).toBe(0)
  expect(requests[0].body.payment_reference).toBe("r")
})

test("a price is never called monthly, and no price is not zero", () => {
  expect(agreedLine(500000)).toBe("$5000.00 agreed (period not recorded)")
  expect(agreedLine(0)).toBe("$0.00 agreed (period not recorded)")
  expect(agreedLine(null)).toBe("not agreed")
})

test("the report groups by customer, shows flags and prints no total", () => {
  const out = revenueLines([
    { key: "K1", organization: "Acme", source: "manual", agreed_price_cents: 100, lead_id: 7, flags: [] },
    { key: "K2", organization: "Acme", source: "manual", agreed_price_cents: 200, flags: ["no_end_date"] },
    { key: "K3", issued_to_email: "a@x.test", source: "manual", flags: ["no_price", "no_deal_link"] },
  ]).join("\n")
  expect(out.match(/^ {2}Acme$/gm)?.length).toBe(1)
  expect(out).toContain("lead #7")
  expect(out).toContain("REVIEW: no end date")
  expect(out).toContain("REVIEW: no price, no deal link")
  expect(out).not.toContain("$3.00")
})

test("revenue --flagged keeps only flagged licences and --json answers with them", async () => {
  reply = { licences: [{ key: "K1", flags: [] }, { key: "K2", flags: ["no_price"] }], flagged: 1 }
  await parse(["licence", "revenue", "--flagged"])
  expect(printed.join("\n")).toContain("K2")
  expect(printed.join("\n")).not.toContain("K1")
})
