import { test } from "bun:test"
import assert from "node:assert/strict"
import { buildQuery, toRecords, nextCursor, hasMore, schemaFromRows, redact, summarize, assertIdent } from "./atlas-database-pull"

const BASE = "https://abcdefgh.supabase.co"

test("the query asks for one ordered page newer than the cursor", () => {
  const u = new URL(buildQuery({ baseUrl: BASE + "/", table: "orders", cursorField: "updated_at", since: "2026-09-01T00:00:00Z", limit: 500 }))
  assert.equal(u.pathname, "/rest/v1/orders")
  // order is what makes cursor paging correct — without it a page boundary can skip rows
  assert.equal(u.searchParams.get("order"), "updated_at.asc")
  assert.equal(u.searchParams.get("updated_at"), "gt.2026-09-01T00:00:00Z")
  assert.equal(u.searchParams.get("limit"), "500")
})

test("a first run has no cursor filter at all", () => {
  const u = new URL(buildQuery({ baseUrl: BASE, table: "orders", cursorField: "updated_at", since: null }))
  assert.equal(u.searchParams.get("updated_at"), null)
})

test("the limit is bounded above, and 0 falls back rather than fetching nothing", () => {
  const limitOf = (limit: unknown) => new URL(buildQuery({ baseUrl: BASE, table: "t", cursorField: "u", limit: limit as any })).searchParams.get("limit")
  assert.equal(limitOf(10 ** 9), "10000")
  // 0 as a literal limit would fetch nothing, advance no cursor, and still report success — a
  // mirror silently doing nothing reads exactly like one that is up to date
  assert.equal(limitOf(0), "500")
  assert.equal(limitOf(-5), "500")
  assert.equal(limitOf("abc"), "500")
  assert.equal(limitOf(250), "250")
})

test("only plain identifiers are interpolated — a crafted table name is refused", () => {
  assert.throws(() => buildQuery({ baseUrl: BASE, table: "orders;drop", cursorField: "updated_at" }), /unsafe table name/)
  assert.throws(() => buildQuery({ baseUrl: BASE, table: "orders", cursorField: "updated_at&select=*" }), /unsafe cursor field/)
  assert.equal(assertIdent("public_orders", "x"), "public_orders")
})

test("records key on the source row's own id, so a re-run MERGES instead of duplicating", () => {
  const { records } = toRecords([{ id: 7, name: "a" }, { id: 8, name: "b" }], { table: "orders" })
  assert.deepEqual(records.map((r) => r.external_id), ["orders:7", "orders:8"])
  assert.deepEqual(records[0].data, { id: 7, name: "a" })
})

test("A ROW WITH NO ID IS DROPPED, never given an invented key", () => {
  // an invented key would make the same row a NEW record on every run — duplication that reads as growth
  const { records, skipped } = toRecords([{ id: 1 }, { name: "no id" }, { id: null }, { id: "" }], { table: "t" })
  assert.equal(records.length, 1)
  assert.equal(skipped.length, 3)
})

test("the cursor never goes backwards", () => {
  const rows = [{ updated_at: "2026-09-10T00:00:00Z" }, { updated_at: "2026-09-12T00:00:00Z" }]
  assert.equal(nextCursor(rows, "updated_at", "2026-09-01T00:00:00Z"), "2026-09-12T00:00:00Z")
  // a late row older than where we already are must not rewind the mirror
  assert.equal(nextCursor([{ updated_at: "2026-08-01T00:00:00Z" }], "updated_at", "2026-09-12T00:00:00Z"), "2026-09-12T00:00:00Z")
  // unreadable or missing values are ignored, not treated as "start again"
  assert.equal(nextCursor([{ updated_at: "not a date" }, { updated_at: null }, {}], "updated_at", "2026-09-12T00:00:00Z"), "2026-09-12T00:00:00Z")
  assert.equal(nextCursor([], "updated_at", "2026-09-12T00:00:00Z"), "2026-09-12T00:00:00Z")
})

test("a full page means keep going; a short page means stop", () => {
  assert.equal(hasMore(new Array(500).fill({}), 500), true)
  assert.equal(hasMore(new Array(499).fill({}), 500), false)
  assert.equal(hasMore([], 500), false)
})

test("schema inference reads types from real values, and widens rather than rejecting", () => {
  const f = schemaFromRows([
    { id: 1, total: 10.5, paid: true, created_at: "2026-09-01T10:00:00Z", note: "hi", mixed: 1 },
    { id: 2, total: 3, paid: false, created_at: "2026-09-02T10:00:00Z", note: null, mixed: "two" },
  ])
  const by = Object.fromEntries(f.map((x) => [x.key, x.type]))
  assert.equal(by.total, "number")
  assert.equal(by.paid, "boolean")
  assert.equal(by.created_at, "date")
  assert.equal(by.note, "text")
  // a column seen as both a number and text becomes text — widening keeps real rows importable
  assert.equal(by.mixed, "text")
})

test("a column that was null in every sampled row SAYS it is a guess", () => {
  const f = schemaFromRows([{ id: 1, maybe: null }, { id: 2, maybe: null }])
  const maybe = f.find((x) => x.key === "maybe")!
  assert.equal(maybe.type, "text")
  assert.equal(maybe.inferred_from_nulls_only, true)
  assert.equal(f.find((x) => x.key === "id")!.inferred_from_nulls_only, false)
})

test("keys never reach the log", () => {
  const key = "sbp_0123456789abcdef0123456789abcdef"
  const line = redact(`GET ${BASE} apikey=${key} failed`, [key])
  assert.ok(!line.includes(key))
  assert.ok(line.includes("sbp_…redacted"))
  // something too short to be a key is left alone rather than mangling the message
  assert.equal(redact("x=abc", ["abc"]), "x=abc")
})

test("the summary says how much moved and whether the cursor advanced", () => {
  const s = summarize({ table: "orders", fetched: 500, records: 498, skipped: 2, from: "2026-09-01T00:00:00Z", to: "2026-09-12T00:00:00Z" })
  assert.equal(s.advanced, true)
  assert.equal(s.imported, 498)
  assert.equal(s.skipped_no_id, 2)
  // a run that fetched nothing must not claim to have advanced
  assert.equal(summarize({ table: "orders", fetched: 0, records: 0, skipped: 0, from: "2026-09-12T00:00:00Z", to: null }).advanced, false)
})
