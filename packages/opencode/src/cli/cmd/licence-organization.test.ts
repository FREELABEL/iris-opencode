import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import yargs from "yargs"
import { UI } from "../ui"
import { LicenceCommand } from "./licence"

/** #191972: a licence says which company it belongs to. Tests drive the real yargs tree. */
const realFetch = globalThis.fetch
let requests: { url: string; method?: string; body: any }[] = []
let replies: Record<string, unknown> = {}
let printed: string[] = []
let printSpy: any

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
  replies = {}
  printed = []
  process.exitCode = 0
  printSpy = spyOn(UI, "println").mockImplementation((...m: any[]) => void printed.push(m.join(" ")))
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    requests.push({ url: String(url), method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    const path = new URL(String(url)).pathname
    return new Response(JSON.stringify({ success: true, data: replies[path] ?? {} }), { status: 200, headers: { "Content-Type": "application/json" } })
  }) as any
})

afterEach(() => {
  globalThis.fetch = realFetch
  printSpy.mockRestore()
  process.exitCode = 0
})

test("organization sets the company", async () => {
  await parse(["licence", "organization", "IRIS-AAAA-BBBB-CCCC", "Acme Co"])
  expect(requests[0].url).toEndWith("/api/v1/licences/IRIS-AAAA-BBBB-CCCC/organization")
  expect(requests[0].body).toEqual({ organization: "Acme Co" })
})

test("--clear sends null, and neither name nor --clear sends nothing", async () => {
  await parse(["licence", "org", "IRIS-AAAA-BBBB-CCCC", "--clear"])
  expect(requests[0].body).toEqual({ organization: null })
  requests = []
  await parse(["licence", "org", "IRIS-AAAA-BBBB-CCCC"])
  expect(requests).toEqual([])
  expect(process.exitCode).toBe(1)
})

test("issue sends the company", async () => {
  await parse(["licence", "issue", "--email", "a@x.test", "--organization", "Acme Co", "--json"])
  expect(requests[0].body.organization).toBe("Acme Co")
})

test("list filters by company and shows it", async () => {
  replies["/api/v1/licences"] = { data: [{ key: "K1", tier: "pro", status: "issued", issued_to_email: "a@x.test", organization: "Acme Co" }] }
  await parse(["licence", "list", "--organization", "Acme Co"])
  expect(new URL(requests[0].url).searchParams.get("organization")).toBe("Acme Co")
  expect(printed.join("\n")).toContain("Acme Co")
})

test("show says the company, and how to set it when there is none", async () => {
  const logged: string[] = []
  const log = spyOn(console, "log").mockImplementation((...m: any[]) => void logged.push(m.join(" ")))
  replies["/api/v1/licences/K1"] = { key: "K1", organization: "Acme Co" }
  await parse(["licence", "show", "K1"])
  expect(logged.join("\n")).toContain("Acme Co")
  expect(logged.join("\n")).not.toContain("licence organization K1")
  logged.length = 0
  replies["/api/v1/licences/K1"] = { key: "K1", organization: null }
  await parse(["licence", "show", "K1"])
  log.mockRestore()
  expect(logged.join("\n")).toContain("iris licence organization K1 <name>")
})

test("seats shows the company above the holders", async () => {
  replies["/api/v1/licences/K1/seats"] = { organization: "Acme Co", holders: [] }
  await parse(["licence", "seats", "K1"])
  expect(printed.join("\n")).toContain("company    Acme Co")
})
