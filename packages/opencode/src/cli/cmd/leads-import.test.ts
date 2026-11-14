import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test"
import yargs from "yargs"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import {
  buildLead,
  buildLeads,
  leadFieldsFromFlags,
  normalizeProduct,
  parseCsv,
  parseMapArgs,
  planMapping,
  readLeadFile,
  unwrapImportResponse,
} from "./leads-import"
import { buildListRequest, checkFieldFilters } from "./leads-scope"
import { PlatformLeadsCommand } from "./platform-leads"

// #193510 title · #193511 external id · #193512 product/segment · #193513 import · #193514 masked names
//
// TYPED FAKE WARNING (#189389): the server half (fl-api POST /api/v1/leads/import and the new
// lead columns) is being built in parallel. Every HTTP test below answers with a fake written
// from the agreed contract by the same author as the client, so it can only prove the client
// matches the contract AS I READ IT — not that the server does. The round trip is unverified
// until the backend PR is live.

describe("parsing", () => {
  test("CSV with quoted commas, doubled quotes, CRLF and a newline inside a cell", () => {
    const { header, rows } = parseCsv('name,company,notes\r\n"Doe, Jane","Acme ""West""","line one\nline two"\r\nBob,Beta,\r\n\r\n')
    expect(header).toEqual(["name", "company", "notes"])
    expect(rows).toHaveLength(2)
    expect(rows[0].cells).toEqual({ name: "Doe, Jane", company: 'Acme "West"', notes: "line one\nline two" })
    expect(rows[1]).toEqual({ line: 4, cells: { name: "Bob", company: "Beta", notes: "" } })
  })

  test("products: short names become the CRM's long ones; anything else is refused", () => {
    expect(normalizeProduct("terra")).toBe("iris-terra")
    expect(normalizeProduct("IRIS Kinetic")).toBe("iris-kinetic")
    expect(normalizeProduct("iris-orbit")).toBe("iris-orbit")
    expect(normalizeProduct("iris")).toBe("iris")
    expect(normalizeProduct("mars")).toBeNull()
  })

  test("--map validates the field name", () => {
    expect(parseMapArgs(["Job Title=title", "id=external_id"])).toEqual({ ok: true, map: { "Job Title": "title", id: "external_id" } })
    expect(parseMapArgs(["x=favourite_colour"]).ok).toBe(false)
    expect(parseMapArgs(["nope"]).ok).toBe(false)
  })
})

describe("Apollo rows (#193514)", () => {
  const cols = ["product", "search", "apollo_id", "first_name", "last_name_hint", "title", "company", "fit"]
  const plan = planMapping(cols, {})

  test("first_name + masked last_name_hint -> name, not verified; apollo_id -> apollo:<id>; terra -> iris-terra", () => {
    const r = buildLead({ row: 1, cells: { product: "terra", search: "2", apollo_id: "5f3a9c", first_name: "Juan", last_name_hint: "Va***s", title: "Superintendent", company: "Acme Builders", fit: "strong" } }, plan)
    expect(r).toEqual({
      ok: true,
      lead: { name: "Juan Va***s", company: "Acme Builders", title: "Superintendent", external_id: "apollo:5f3a9c", product: "iris-terra", name_verified: false },
    })
    expect(plan.unused).toEqual(["search", "fit"])
  })

  test("an unmasked hint stays at the server default (verified)", () => {
    const r = buildLead({ row: 1, cells: { first_name: "Ann", last_name_hint: "Lee", apollo_id: "1" } }, plan)
    expect(r.ok && r.lead.name).toBe("Ann Lee")
    expect(r.ok && "name_verified" in r.lead).toBe(false)
  })

  test("a column claiming name_verified=true cannot verify a masked name", () => {
    const p = planMapping(["name", "name_verified"], {})
    const r = buildLead({ row: 1, cells: { name: "Juan Va***s", name_verified: "true" } }, p)
    expect(r.ok && r.lead.name_verified).toBe(false)
  })

  test("refused rows keep their row number; duplicate external ids in one file are refused", () => {
    const p = planMapping(["name", "external_id", "product"], {})
    const b = buildLeads(
      [
        { row: 1, cells: { name: "A", external_id: "x:1", product: "terra" } },
        { row: 2, cells: { name: "", external_id: "x:2" } },
        { row: 3, cells: { name: "C", external_id: "x:1" } },
        { row: 4, cells: { name: "D", product: "mars" } },
        { row: 5, cells: { name: "E", external_id: "x:5" } },
      ],
      p,
    )
    expect(b.leads.map((l) => l.name)).toEqual(["A", "E"])
    expect(b.rowOf).toEqual([1, 5])
    expect(b.errors.map((e) => e.row)).toEqual([2, 3, 4])
  })

  test("JSON input: a plain array and an Atlas {external_id, data} export both read", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "leads-json-"))
    try {
      const f = path.join(dir, "x.json")
      fs.writeFileSync(f, JSON.stringify([{ external_id: "apollo:1", data: { name: "A", title: "CTO" } }, { name: "B" }]))
      const r = readLeadFile(f)
      expect(r.ok && r.rows.map((x) => x.cells)).toEqual([{ name: "A", title: "CTO", external_id: "apollo:1" }, { name: "B" }])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("create/update flags and list filters", () => {
  test("only flags that were passed are sent", () => {
    expect(leadFieldsFromFlags({ title: " CTO ", product: "kinetic" })).toEqual({ ok: true, fields: { title: "CTO", product: "iris-kinetic" } })
    expect(leadFieldsFromFlags({ "name-verified": false })).toEqual({ ok: true, fields: { name_verified: false } })
    expect(leadFieldsFromFlags({})).toEqual({ ok: true, fields: {} })
    expect(leadFieldsFromFlags({ product: "mars" }).ok).toBe(false)
  })

  test("list sends the filters and stops hiding Prospected when one is set", () => {
    const r = buildListRequest({ limit: 20, title: "super", product: "iris-terra", segment: "contractors-tx", externalId: "apollo:1", unverifiedNames: true })
    expect(r.params.get("title")).toBe("super")
    expect(r.params.get("product")).toBe("iris-terra")
    expect(r.params.get("segment")).toBe("contractors-tx")
    expect(r.params.get("external_id")).toBe("apollo:1")
    expect(r.params.get("name_verified")).toBe("0")
    expect(r.hidesProspected).toBe(false)
  })

  test("rows a server returned without applying a filter are caught", () => {
    const rows = [{ id: 1, product: "iris-terra" }, { id: 2 }, { id: 3, product: "iris-orbit" }]
    const c = checkFieldFilters(rows, { product: "iris-terra" })
    expect(c.kept.map((r) => r.id)).toEqual([1])
    expect(c.ignored).toEqual(["--product"])
    expect(checkFieldFilters([{ name_verified: false }], { unverifiedNames: true }).ignored).toEqual([])
  })

  test("import response: bare or wrapped in data", () => {
    expect(unwrapImportResponse({ created: 1 })).toEqual({ created: 1 })
    expect(unwrapImportResponse({ data: { created: 2, merged: 0, failed: [] } })).toEqual({ created: 2, merged: 0, failed: [] })
  })
})

// ── the command, with fetch stubbed at the boundary (TYPED fake of the contract) ──────────────

const realFetch = globalThis.fetch
const realKey = process.env.IRIS_API_KEY
let requests: { url: string; method: string; body: any }[] = []
let out = ""
let spies: { mockRestore(): void }[] = []
let dir = ""

/** A fake of POST /api/v1/leads/import as the contract describes it. */
function contractServer(opts: { failIndex?: number[]; existing?: Set<string>; status?: number } = {}) {
  const existing = opts.existing ?? new Set<string>()
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    requests.push({ url: String(url), method: init?.method ?? "GET", body })
    if (opts.status) return new Response(JSON.stringify({ message: "nope" }), { status: opts.status })
    let created = 0, merged = 0
    const failed: { index: number; error: string }[] = []
    const ids: number[] = []
    body.leads.forEach((l: any, i: number) => {
      if (opts.failIndex?.includes(i)) return failed.push({ index: i, error: "The email field must be a valid email address." })
      if (l.external_id && existing.has(l.external_id)) merged++
      else {
        created++
        if (!body.dry_run && l.external_id) existing.add(l.external_id)
      }
      ids.push(1000 + i)
    })
    return new Response(JSON.stringify({ dry_run: body.dry_run, created, merged, failed, ids: body.dry_run ? [] : ids }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  }) as any
}

const parse = (argv: string[]) =>
  yargs(argv)
    .command({ ...(PlatformLeadsCommand as any) })
    .demandCommand()
    .exitProcess(false)
    .fail((msg: string, err: Error) => {
      throw err ?? new Error(msg)
    })
    .parseAsync()

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "leads-import-"))
  // A synthetic Apollo-shaped file (never real prospect data in a test).
  const lines = ["product,search,apollo_id,first_name,last_name_hint,title,company,fit"]
  for (let i = 1; i <= 20; i++) lines.push(`terra,1,a${i},First${i},L***${i},Estimator,"Co ${i}, LLC",strong`)
  fs.writeFileSync(path.join(dir, "apollo.csv"), lines.join("\n") + "\n")
  const big = ["name,external_id"]
  for (let i = 1; i <= 2500; i++) big.push(`P${i},src:${i}`)
  fs.writeFileSync(path.join(dir, "big.csv"), big.join("\n"))
})
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

beforeEach(() => {
  requests = []
  out = ""
  process.exitCode = 0
  process.env.IRIS_API_KEY = "test-key"
  const grab = (c: any, ...rest: any[]) => {
    out += String(c)
    rest.find((r) => typeof r === "function")?.()
    return true
  }
  spies = [
    spyOn(process.stderr, "write").mockImplementation(grab as any),
    spyOn(process.stdout, "write").mockImplementation(grab as any),
    spyOn(console, "log").mockImplementation(((...a: any[]) => { out += a.join(" ") + "\n" }) as any),
  ]
})
afterEach(() => {
  for (const s of spies) s.mockRestore()
  globalThis.fetch = realFetch
  if (realKey === undefined) delete process.env.IRIS_API_KEY
  else process.env.IRIS_API_KEY = realKey
  process.exitCode = 0
})

describe("iris leads import (TYPED fake server)", () => {
  test("dry run sends dry_run=true, says nothing was written, exits 0", async () => {
    contractServer()
    await parse(["leads", "import", path.join(dir, "apollo.csv"), "--board", "746", "--dry-run"])
    expect(requests).toHaveLength(1)
    expect(requests[0].url).toEndWith("/api/v1/leads/import")
    expect(requests[0].body.dry_run).toBe(true)
    expect(requests[0].body.bloq_id).toBe(746)
    expect(requests[0].body.leads[0]).toEqual({ name: "First1 L***1", company: "Co 1, LLC", title: "Estimator", external_id: "apollo:a1", product: "iris-terra", name_verified: false })
    expect(out).toContain("DRY RUN — nothing was written")
    expect(out).toContain("Would create")
    expect(process.exitCode).toBe(0)
  })

  test("importing the same 20 rows twice leaves 20 (second run merges)", async () => {
    const existing = new Set<string>()
    contractServer({ existing })
    await parse(["leads", "import", path.join(dir, "apollo.csv"), "--board", "746", "--json"])
    const first = JSON.parse(out.slice(out.indexOf("{")))
    expect([first.created, first.merged, first.failed.length]).toEqual([20, 0, 0])
    out = ""
    await parse(["leads", "import", path.join(dir, "apollo.csv"), "--board", "746", "--json"])
    const second = JSON.parse(out.slice(out.indexOf("{")))
    expect([second.created, second.merged]).toEqual([0, 20])
    expect(existing.size).toBe(20)
    expect(process.exitCode).toBe(0)
  })

  test("2,500 rows go in chunks of 1000 and failures map back to file rows; any failure exits 1", async () => {
    contractServer({ failIndex: [0] })
    await parse(["leads", "import", path.join(dir, "big.csv"), "--board", "9", "--json"])
    expect(requests.map((r) => r.body.leads.length)).toEqual([1000, 1000, 500])
    const res = JSON.parse(out.slice(out.indexOf("{")))
    expect(res.failed.map((f: any) => f.row)).toEqual([1, 1001, 2001])
    expect(res.created).toBe(2497)
    expect(res.success).toBe(false)
    expect(process.exitCode).toBe(1)
  })

  test("a server without the endpoint (404) stops, says why, exits 1", async () => {
    contractServer({ status: 404 })
    await parse(["leads", "import", path.join(dir, "apollo.csv"), "--board", "746"])
    expect(out).toContain("needs the fl-api release")
    expect(out).not.toContain("Done")
    expect(process.exitCode).toBe(1)
  })

  test("--map to a column the file lacks is refused before any request", async () => {
    contractServer()
    await parse(["leads", "import", path.join(dir, "apollo.csv"), "--board", "746", "--map", "Email Address=email"])
    expect(requests).toHaveLength(0)
    expect(process.exitCode).toBe(1)
  })
})

describe("iris leads create/update/list with the new fields (TYPED fake server)", () => {
  function echoServer(drop: string[] = []) {
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {}
      requests.push({ url: String(url), method: init?.method ?? "GET", body })
      if ((init?.method ?? "GET") === "GET") {
        return new Response(JSON.stringify({ data: [{ id: 1, name: "A", title: "Estimator", product: "iris-terra" }, { id: 2, name: "B" }], total: 2 }), { status: 200 })
      }
      const saved: Record<string, unknown> = { id: 7, status: "New", ...body }
      for (const k of drop) delete saved[k]
      return new Response(JSON.stringify({ data: saved }), { status: 200 })
    }) as any
  }

  test("create sends title/external_id/product/segment/name_verified", async () => {
    echoServer()
    await parse(["leads", "create", "--name", "Jane Doe", "--bloq-id", "746", "--title", "Capture Manager", "--external-id", "apollo:9", "--product", "iris-orbit", "--segment", "space-bd-capture", "--no-name-verified"])
    expect(requests[0].body).toMatchObject({ name: "Jane Doe", title: "Capture Manager", external_id: "apollo:9", product: "iris-orbit", segment: "space-bd-capture", name_verified: false })
    expect(process.exitCode).toBe(0)
  })

  test("create says so and exits 1 when the server drops a field it was sent", async () => {
    echoServer(["title"])
    await parse(["leads", "create", "--name", "Jane Doe", "--bloq-id", "746", "--title", "CTO"])
    expect(out).toContain("did not save: title")
    expect(process.exitCode).toBe(1)
  })

  test("a masked name on create is sent as not verified", async () => {
    echoServer()
    await parse(["leads", "create", "--name", "Juan Va***s", "--bloq-id", "746"])
    expect(requests[0].body.name_verified).toBe(false)
  })

  test("update sends only what was passed", async () => {
    echoServer()
    await parse(["leads", "update", "7", "--title", "Superintendent", "--json"])
    const put = requests.find((r) => r.method === "PUT")!
    expect(put.body).toEqual({ title: "Superintendent" })
    expect(process.exitCode).toBe(0)
  })

  test("list --product sends the filter, and drops rows a server returned without applying it", async () => {
    echoServer()
    await parse(["leads", "list", "--product", "iris-terra", "--json"])
    const u = new URL(requests[0].url)
    expect(u.searchParams.get("product")).toBe("iris-terra")
    expect(out).toContain("did not apply --product")
    const env = JSON.parse(out.slice(out.indexOf("{")))
    expect((env.data ?? env.rows ?? env.items).map((r: any) => r.id)).toEqual([1])
  })
})
