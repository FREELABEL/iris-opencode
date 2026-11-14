import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn, test } from "bun:test"
import yargs from "yargs"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { PlatformAtlasDatasetsCommand, parseDataArg } from "./platform-atlas-datasets"

/**
 * #193517: `records upsert --data <path>` printed "Invalid JSON" then "Done" and exited 0.
 * Nothing was written. These drive the real yargs tree with fetch stubbed at the boundary.
 */
const realFetch = globalThis.fetch
const realKey = process.env.IRIS_API_KEY
let requests: { url: string; method: string; body: any }[] = []
let ui = ""
let dir = ""
let spies: { mockRestore(): void }[] = []

const parse = (argv: string[]) =>
  yargs(argv)
    .command({ ...(PlatformAtlasDatasetsCommand as any) })
    .demandCommand()
    .exitProcess(false)
    .fail((msg: string, err: Error) => {
      throw err ?? new Error(msg)
    })
    .parseAsync()

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "rec-data-"))
  fs.writeFileSync(path.join(dir, "rec.json"), JSON.stringify({ name: "Ad 51", status: "live" }))
  fs.writeFileSync(path.join(dir, "bad.json"), "{ name: nope")
})
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

beforeEach(() => {
  requests = []
  ui = ""
  process.exitCode = 0
  process.env.IRIS_API_KEY = "test-key"
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    requests.push({ url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined })
    return new Response(JSON.stringify({ message: "Record created", data: { id: 9 } }), { status: 200, headers: { "Content-Type": "application/json" } })
  }) as any
  const grab = (c: any, ...rest: any[]) => {
    ui += String(c)
    rest.find((r) => typeof r === "function")?.()
    return true
  }
  // clack writes plain text to process.stderr when stdout is not a TTY (as under bun test).
  spies = [
    spyOn(process.stderr, "write").mockImplementation(grab as any),
    spyOn(process.stdout, "write").mockImplementation(grab as any),
    spyOn(Bun.stderr, "write").mockImplementation(grab as any),
  ]
})

afterEach(() => {
  for (const s of spies) s.mockRestore()
  globalThis.fetch = realFetch
  if (realKey === undefined) delete process.env.IRIS_API_KEY
  else process.env.IRIS_API_KEY = realKey
  process.exitCode = 0
})

const upsert = (data: string) => ["atlas:datasets", "records", "upsert", "-s", "hive-ad-creatives", "--external-id", "ad-51", "--data", data]

test("upsert --data <path> reads the file", async () => {
  await parse(upsert(path.join(dir, "rec.json")))
  expect(requests).toHaveLength(1)
  expect(requests[0].url).toEndWith("/api/v1/atlas/datasets/hive-ad-creatives/upsert")
  expect(requests[0].body).toEqual({ external_id: "ad-51", data: { name: "Ad 51", status: "live" } })
  expect(process.exitCode).toBe(0)
})

test("upsert --data '<inline json>' still works", async () => {
  await parse(upsert('{"name":"inline"}'))
  expect(requests[0].body.data).toEqual({ name: "inline" })
  expect(process.exitCode).toBe(0)
})

test("upsert with bad JSON exits non-zero, sends nothing, and never says Done", async () => {
  await parse(upsert("{not json"))
  expect(requests).toHaveLength(0)
  expect(process.exitCode).toBe(1)
  expect(ui).toContain("Invalid JSON")
  expect(ui).not.toContain("Done")
})

test("upsert with a file of bad JSON names the file and fails", async () => {
  await parse(upsert(path.join(dir, "bad.json")))
  expect(requests).toHaveLength(0)
  expect(process.exitCode).toBe(1)
  expect(ui).toContain("bad.json")
  expect(ui).not.toContain("Done")
})

test("upsert with a missing file says so and fails", async () => {
  await parse(upsert(path.join(dir, "missing.json")))
  expect(requests).toHaveLength(0)
  expect(process.exitCode).toBe(1)
  expect(ui).toContain("File not found")
})

test("an API error on upsert exits non-zero without Done", async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({ message: "boom" }), { status: 500 })) as any
  await parse(upsert('{"a":1}'))
  expect(process.exitCode).toBe(1)
  expect(ui).not.toContain("Done")
})

test("records add --data <path> reads any existing file and fails on bad JSON", async () => {
  await parse(["atlas:datasets", "records", "add", "-s", "x", "--data", path.join(dir, "rec.json")])
  expect(requests[0].body.data).toEqual({ name: "Ad 51", status: "live" })
  expect(process.exitCode).toBe(0)
  requests = []
  await parse(["atlas:datasets", "records", "add", "-s", "x", "--data", "{bad"])
  expect(requests).toHaveLength(0)
  expect(process.exitCode).toBe(1)
})

test("records update --data <path> reads the file (it never did) and fails on bad JSON", async () => {
  await parse(["atlas:datasets", "records", "update", "5", "-s", "x", "--data", path.join(dir, "rec.json")])
  expect(requests[0].method).toBe("PATCH")
  expect(requests[0].body).toEqual({ data: { name: "Ad 51", status: "live" } })
  expect(process.exitCode).toBe(0)
  requests = []
  await parse(["atlas:datasets", "records", "update", "5", "-s", "x", "--data", "{bad"])
  expect(requests).toHaveLength(0)
  expect(process.exitCode).toBe(1)
  expect(ui).not.toContain("Done")
})

test("parseDataArg: @file, ~/ expansion, arrays rejected", () => {
  expect(parseDataArg("@" + path.join(dir, "rec.json"))).toEqual({ ok: true, value: { name: "Ad 51", status: "live" } })
  const home = path.join(os.homedir(), ".iris-test-" + process.pid + ".json")
  fs.writeFileSync(home, '{"h":1}')
  try {
    expect(parseDataArg("~/" + path.basename(home))).toEqual({ ok: true, value: { h: 1 } })
  } finally {
    fs.rmSync(home, { force: true })
  }
  expect(parseDataArg("[1,2]").ok).toBe(false)
  expect(parseDataArg("").ok).toBe(false)
})
