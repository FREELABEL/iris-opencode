import { afterEach, describe, expect, test } from "bun:test"
import { importLeads, newLeadPayload, normalizeStatus, parseCsv, planImport, previewImport } from "../../src/iris/leads-import"
import { runLeadsOp } from "../../src/iris/platform"

// #194506 — New lead and Import from the Leads tab. The platform is stubbed: nothing here
// reaches fl-api, and no lead is created anywhere.

const CSV = [
  "Full name,Email,Company,Stage,Value",
  "Ana Lopez,ana@example.test,Lopez Bakery,qualified,1200",
  "Ben Okafor,ben@example.test,Okafor Freight,In negotiation,8000",
  "Chen Wei,chen@example.test,Wei Optics,warm,",
  ",nobody@example.test,No Name Co,new,",
  "Eve Martin,not-an-email,Martin Media,contacted,",
].join("\n")

describe("the import mapping", () => {
  test("headers are matched loosely; a column nothing reads is reported, not dropped silently", () => {
    const { header } = parseCsv(CSV)
    const plan = planImport(header)
    expect(plan.columns).toEqual({ "Full name": "name", Email: "email", Company: "company", Stage: "status" })
    expect(plan.unused).toEqual(["Value"])
  })

  test("First name + Last name build the name when no column is the name", () => {
    const p = previewImport("First name,Last name,email\nGrace,Hopper,grace@example.test\n")
    expect(p.ok).toBe(true)
    if (!p.ok) return
    expect(p.preview.rows[0].lead).toEqual({ name: "Grace Hopper", email: "grace@example.test" })
  })

  test("statuses map the CLI's way: case, spaces, - and _ ignored, aliases known", () => {
    expect(normalizeStatus("qualified")).toBe("Qualified")
    expect(normalizeStatus("in_negotiation")).toBe("In Negotiation")
    expect(normalizeStatus("negotiation")).toBe("In Negotiation")
    expect(normalizeStatus("follow up")).toBe("Follow-Up")
    expect(normalizeStatus("warm")).toBeNull()
  })

  test("the preview says which rows go in, which carry a warning, and why each skip is skipped", () => {
    const p = previewImport(CSV)
    expect(p.ok).toBe(true)
    if (!p.ok) return
    expect(p.preview.total).toBe(5)
    expect(p.preview.ready).toBe(3)
    expect(p.preview.rows[0].lead).toEqual({ name: "Ana Lopez", email: "ana@example.test", company: "Lopez Bakery", status: "Qualified" })
    expect(p.preview.rows[1].lead?.status).toBe("In Negotiation")
    // An unknown stage is dropped WITH a warning, and the row still goes in (#194368).
    expect(p.preview.rows[2].lead?.status).toBeUndefined()
    expect(p.preview.warnings).toEqual([{ row: 3, reason: expect.stringContaining('"warm"') }])
    expect(p.preview.skipped).toEqual([
      { row: 4, reason: "No name" },
      { row: 5, reason: '"not-an-email" is not an email address' },
    ])
  })

  test("a file with no name column is refused with what to do", () => {
    const p = previewImport("Email,Company\na@example.test,A\n")
    expect(p.ok).toBe(false)
    if (!p.ok) expect(p.reason).toContain("No column holds a name")
  })

  test("an empty file, and a header with no rows, are refused", () => {
    expect(previewImport("").ok).toBe(false)
    expect(previewImport("name,email\n").ok).toBe(false)
  })

  test("rows go 1000 a request; the server's refusals come back on the file's row numbers", async () => {
    const rows = Array.from({ length: 1500 }, (_, i) => `Person ${i + 1},p${i + 1}@example.test`)
    const sent: number[] = []
    const r = await importLeads(["name,email", ...rows].join("\n"), async (leads) => {
      sent.push(leads.length)
      return { ok: true, body: { data: { created: leads.length - 1, merged: 0, failed: [{ index: 1, error: { email: ["taken"] } }] } } }
    })
    expect(sent).toEqual([1000, 500])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.result.created).toBe(1498)
    expect(r.result.skipped).toEqual([
      { row: 2, reason: "taken" },
      { row: 1002, reason: "taken" },
    ])
  })

  test("a later part refused stops the rest and says so", async () => {
    let n = 0
    const rows = Array.from({ length: 1200 }, (_, i) => `P${i},p${i}@example.test`)
    const r = await importLeads(["name,email", ...rows].join("\n"), async (leads) => (n++ === 0 ? { ok: true, body: { created: leads.length } } : { ok: false, body: null, reason: "fl-api 500" }))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.result.stopped).toContain("Stopped after 1000 rows")
  })
})

describe("a new lead", () => {
  test("needs a name or an email, and a board", () => {
    expect(newLeadPayload({ bloqId: 952 })).toEqual({ ok: false, reason: expect.stringContaining("name or an email") })
    expect(newLeadPayload({ name: "Ana" })).toEqual({ ok: false, reason: expect.stringContaining("board") })
  })
  test("an email alone names the lead; the value is a number; the stage is the CRM's spelling", () => {
    const r = newLeadPayload({ email: "ana@example.test", value: "$4,500", status: "qualified", bloqId: 952 })
    expect(r).toEqual({ ok: true, body: { name: "ana@example.test", email: "ana@example.test", price_bid: 4500, status: "Qualified", bloqId: 952 } })
  })
  test("a bad email, a bad value and an unknown stage are refused before anything is sent", () => {
    expect(newLeadPayload({ name: "A", email: "nope", bloqId: 1 }).ok).toBe(false)
    expect(newLeadPayload({ name: "A", value: "lots", bloqId: 1 }).ok).toBe(false)
    expect(newLeadPayload({ name: "A", status: "warm", bloqId: 1 }).ok).toBe(false)
  })
})

describe("the leads route's new ops, against a stubbed platform", () => {
  const real = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = real
  })
  const stub = (answer: (url: string, body: any) => unknown) => {
    const calls: { url: string; method?: string; body: any }[] = []
    globalThis.fetch = (async (url: any, init?: any) => {
      const body = init?.body ? JSON.parse(init.body) : undefined
      calls.push({ url: String(url), method: init?.method, body })
      return new Response(JSON.stringify(answer(String(url), body)), { status: 200 })
    }) as unknown as typeof fetch
    return calls
  }

  test("create posts the lead to the board and returns it", async () => {
    const calls = stub((_u, b) => ({ data: { id: 7, name: b.name, email: b.email } }))
    const r = await runLeadsOp({ op: "create", body: { name: "Grace Hopper", email: "grace@example.test", value: "12000", status: "Qualified", bloqId: 952 } })
    expect(r.measured).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toEndWith("/api/v1/leads")
    expect(calls[0].method).toBe("POST")
    expect(calls[0].body).toEqual({ name: "Grace Hopper", email: "grace@example.test", price_bid: 12000, status: "Qualified", bloqId: 952 })
    expect((r.data as any).matchedExisting).toBe(false)
  })

  test("an email the CRM already has is reported as matched, not as added", async () => {
    stub(() => ({ data: { id: 32345, name: "Dana Whitfield", email: "dana@example.test" } }))
    const r = await runLeadsOp({ op: "create", body: { name: "Someone Else", email: "dana@example.test", bloqId: 952 } })
    expect((r.data as any).matchedExisting).toBe(true)
  })

  test("create refuses without calling the platform when the form is not valid", async () => {
    const calls = stub(() => ({}))
    const r = await runLeadsOp({ op: "create", body: { company: "No one", bloqId: 952 } })
    expect(r.measured).toBe(false)
    expect(calls).toHaveLength(0)
  })

  test("importPreview never calls the platform", async () => {
    const calls = stub(() => ({}))
    const r = await runLeadsOp({ op: "importPreview", body: { csv: CSV } })
    expect(r.measured).toBe(true)
    expect(calls).toHaveLength(0)
  })

  test("import sends the mapped rows to the board and counts what came back", async () => {
    const calls = stub((_u, b) => ({ data: { dry_run: false, created: b.leads.length, merged: 0, failed: [] } }))
    const r = await runLeadsOp({ op: "import", body: { csv: CSV, bloqId: 952 } })
    expect(r.measured).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toEndWith("/api/v1/leads/import")
    expect(calls[0].body.bloq_id).toBe(952)
    expect(calls[0].body.dry_run).toBe(false)
    expect(calls[0].body.leads.map((l: any) => l.status)).toEqual(["Qualified", "In Negotiation", undefined])
    expect(r.data).toMatchObject({ created: 3, merged: 0, skipped: [{ row: 4 }, { row: 5 }], warnings: [{ row: 3 }] })
  })

  test("import without a board is refused before anything is sent", async () => {
    const calls = stub(() => ({}))
    const r = await runLeadsOp({ op: "import", body: { csv: CSV } })
    expect(r.measured).toBe(false)
    expect(calls).toHaveLength(0)
  })
})
