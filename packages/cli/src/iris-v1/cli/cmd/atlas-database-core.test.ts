import { test } from "bun:test"
import assert from "node:assert/strict"
import { projectRecord, assertClean, ddlFor, upsertSql, deleteSql, buildScript, describePublish, sensitiveFields, INTERNAL_KEYS, quoteIdent } from "./atlas-database-core"

// The envelope exactly as `iris atlas:storage feed` returns it, read from a live dataset.
const record = {
  id: 90210,
  bloq_id: 503,
  schema_id: 41,
  schema_version: 1,
  user_id: 193,
  status: "active", // OURS
  external_id: "agr_7",
  created_at: "2026-08-01T10:00:00Z",
  updated_at: "2026-08-12T03:31:47Z",
  deleted: false,
  deleted_at: null,
  data: {
    agreement_type: "nda",
    counterparty_name: "Experience Art",
    status: "executed", // THEIRS — same name, different meaning
    notes: null,
    amount: 2500,
  },
}

const fields = [
  { key: "agreement_type", type: "text" },
  { key: "counterparty_name", type: "text" },
  { key: "status", type: "text" },
  { key: "notes", type: "text" },
  { key: "amount", type: "number" },
]

test("NOTHING FROM THE ENVELOPE IS PUBLISHED — columns come only from the client's own fields", () => {
  const row = projectRecord(record)
  for (const internal of ["bloq_id", "schema_id", "schema_version", "user_id", "id", "created_at", "deleted_at"]) {
    assert.equal(internal in row, false, `${internal} must not reach a client's database`)
  }
  assert.deepEqual(
    Object.keys(row).sort(),
    ["agreement_type", "amount", "counterparty_name", "external_id", "iris_deleted", "iris_updated_at", "notes", "status"].sort(),
  )
})

test("THE CLIENT'S `status` WINS, and ours never appears", () => {
  // both exist with the same name; a naive flatten would let key order decide which survives
  assert.equal(projectRecord(record).status, "executed")
})

test("a field invented in the envelope next year still cannot leak", () => {
  // this is the point of allowlisting by SOURCE: no code change is needed to stay correct
  const withNewInternal = { ...record, tenant_shard: "eu-3", billing_plan: "enterprise" }
  const row = projectRecord(withNewInternal)
  assert.equal("tenant_shard" in row, false)
  assert.equal("billing_plan" in row, false)
})

test("the second, independent check refuses rather than publishes", () => {
  // unreachable through projectRecord by construction — which is why it is here
  assert.throws(() => assertClean({ external_id: "x", bloq_id: 503 }), /refusing to publish IRIS internals/)
  assert.throws(() => assertClean({ external_id: "x", schema_version: 2 }), /schema_version/)
  assert.deepEqual(INTERNAL_KEYS.includes("bloq_id"), true)
  assert.doesNotThrow(() => assertClean({ external_id: "x", amount: 1 }))
})

test("only the requested fields go out when a subset is named", () => {
  const row = projectRecord(record, { fields: ["agreement_type", "amount"] })
  assert.deepEqual(Object.keys(row).sort(), ["agreement_type", "amount", "external_id", "iris_deleted", "iris_updated_at"])
})

test("the DDL describes THEIR schema, keyed on their id", () => {
  const sql = ddlFor({ table: "agreements", fields })
  assert.match(sql, /CREATE TABLE IF NOT EXISTS "public"\."agreements"/)
  assert.match(sql, /"external_id" text PRIMARY KEY/)
  assert.match(sql, /"amount" numeric/)
  assert.match(sql, /"iris_updated_at" timestamptz/)
  // the incremental read is by updated_at; without the index every sync scans their table
  assert.match(sql, /CREATE INDEX IF NOT EXISTS "agreements_iris_updated_at_idx"/)
  for (const internal of INTERNAL_KEYS) assert.equal(sql.includes(`"${internal}"`), false)
})

test("an unknown field type becomes text rather than failing the migration", () => {
  assert.match(ddlFor({ table: "t", fields: [{ key: "weird", type: "geography" }] }), /"weird" text/)
})

test("identifiers are validated, so a dataset name cannot become SQL", () => {
  assert.throws(() => ddlFor({ table: "agreements; drop table users", fields }), /unsafe table name/)
  assert.throws(() => quoteIdent("a b"), /unsafe identifier/)
  assert.equal(quoteIdent("public_agreements"), '"public_agreements"')
})

test("re-publishing MERGES — ON CONFLICT DO UPDATE, not INSERT and not DO NOTHING", () => {
  const sql = upsertSql({ table: "agreements", row: projectRecord(record) })
  assert.match(sql, /ON CONFLICT \("external_id"\) DO UPDATE SET/)
  assert.match(sql, /"status" = EXCLUDED\."status"/)
  // the key itself is not re-assigned
  assert.equal(/SET[^;]*"external_id" = EXCLUDED/.test(sql), false)
})

test("values are escaped, and a quote in client data cannot end the statement", () => {
  const row = projectRecord({ ...record, data: { ...record.data, counterparty_name: "O'Brien; DROP TABLE x;--" } })
  const sql = upsertSql({ table: "agreements", row })
  // the payload sits WHOLLY inside one quoted literal, with its quote doubled — semicolons inside
  // a literal are just characters, so counting them was testing the wrong thing
  assert.match(sql, /'O''Brien; DROP TABLE x;--'/)
  // quotes balance: an unescaped quote would leave an odd number and end the literal early
  assert.equal((sql.match(/'/g) || []).length % 2, 0)
  // and the statement still ends where it should
  assert.equal(sql.trim().endsWith(";"), true)
})

test("nested values land as readable JSON, not [object Object]", () => {
  const row = projectRecord({ ...record, data: { ...record.data, meta: { tier: 2 } } })
  assert.match(upsertSql({ table: "t", row }), /'\{"tier":2\}'/)
})

test("a deletion is SOFT by default — rows that vanish look like a broken sync", () => {
  assert.match(deleteSql({ table: "agreements", externalId: "agr_7" }), /UPDATE .* SET "iris_deleted" = TRUE WHERE "external_id" = 'agr_7'/)
  assert.match(deleteSql({ table: "agreements", externalId: "agr_7", hard: true }), /^DELETE FROM/)
})

test("the script counts what it will do, and tombstones become deletes", () => {
  const deleted = { ...record, external_id: "agr_8", deleted: true }
  const { sql, upserts, deletes } = buildScript({ table: "agreements", fields, records: [record, deleted] })
  assert.equal(upserts, 1)
  assert.equal(deletes, 1)
  assert.match(sql, /CREATE TABLE IF NOT EXISTS/)
  for (const internal of INTERNAL_KEYS) assert.equal(sql.includes(`"${internal}"`), false)
})

test("a record with no key at all is COUNTED, never silently dropped", () => {
  const { upserts, unkeyed } = buildScript({ table: "t", fields, records: [{ ...record, external_id: "", id: undefined }] })
  assert.equal(upserts, 0)
  assert.equal(unkeyed, 1)
})

test("columns that look like secrets are NAMED, not silently copied", () => {
  const flagged = sensitiveFields([{ key: "signing_token" }, { key: "document_hash" }, { key: "api_key" }, { key: "counterparty_name" }, { key: "notes" }])
  assert.deepEqual(flagged.sort(), ["api_key", "signing_token"])
  // it warns, it does not refuse: they are the client's own fields and may belong in their database
  assert.deepEqual(sensitiveFields([]), [])
})

test("the description states the columns a client will see, and that none are ours", () => {
  const d = describePublish({ dataset: "agreements", table: "agreements", fields, upserts: 2, deletes: 0 })
  assert.deepEqual(d.columns, ["agreement_type", "counterparty_name", "status", "notes", "amount", "external_id", "iris_updated_at", "iris_deleted"])
  assert.equal(d.internals_published, 0)
})

import { fieldsFromSchema, publishedKey } from "./atlas-database-core"

test("fields are read from where the schema endpoint ACTUALLY puts them (schema.fields.fields)", () => {
  // the prototype read schema.fields, found nothing, and typed every column as text
  const nested = { fields: { fields: [{ key: "amount", type: "number" }, { key: "executed_at", type: "date" }] } }
  assert.deepEqual(fieldsFromSchema(nested).map((f) => [f.key, f.type]), [["amount", "number"], ["executed_at", "date"]])
  // a flat array still works, and a key that is not a plain identifier is dropped, not quoted in
  assert.deepEqual(fieldsFromSchema({ fields: [{ key: "a" }, { key: "bad key" }] }).map((f) => f.key), ["a"])
  assert.deepEqual(fieldsFromSchema(null), [])
})

test("a named subset is honoured in the generated SQL, not just in one code path", () => {
  const rec = { external_id: "x", updated_at: "2026-09-01T00:00:00Z", data: { keep: 1, secret_token: "t0k" } }
  const { sql } = buildScript({ table: "t", fields: [{ key: "keep" }], records: [rec], only: ["keep"] })
  assert.equal(sql.includes("secret_token"), false)
  assert.equal(sql.includes("t0k"), false)
})

const SALT = "a-publisher-held-salt-0123456789"

test("16 OF 17 RECORDS WERE DROPPED — a record without external_id is published under an opaque key", () => {
  // measured on the live agreements dataset: the first version reported "1 upserted" and lost 16
  const noOwnKey = { ...record, external_id: null, id: 90210 }
  const k = publishedKey(noOwnKey, { dataset: "agreements", salt: SALT })
  assert.match(String(k), /^k_[0-9a-f]{32}$/)
  const { upserts, derivedKeys } = buildScript({ table: "t", fields, records: [noOwnKey], keyFor: (r) => publishedKey(r, { dataset: "agreements", salt: SALT }) })
  assert.equal(upserts, 1)
  assert.equal(derivedKeys, 1)
})

test("the opaque key is STABLE, so re-publishing merges instead of duplicating", () => {
  const r = { ...record, external_id: null, id: 90210 }
  assert.equal(publishedKey(r, { dataset: "agreements", salt: SALT }), publishedKey(r, { dataset: "agreements", salt: SALT }))
  // and distinct per record and per dataset
  assert.notEqual(publishedKey(r, { dataset: "agreements", salt: SALT }), publishedKey({ ...r, id: 90211 }, { dataset: "agreements", salt: SALT }))
  assert.notEqual(publishedKey(r, { dataset: "agreements", salt: SALT }), publishedKey(r, { dataset: "other", salt: SALT }))
})

test("the opaque key does not reveal our id — and a plain hash of it would", () => {
  const r = { ...record, external_id: null, id: 90210 }
  const k = String(publishedKey(r, { dataset: "agreements", salt: SALT }))
  assert.equal(k.includes("90210"), false)
  // without the salt the key cannot be recomputed from a guessed id: a different salt, a different key
  assert.notEqual(k, publishedKey(r, { dataset: "agreements", salt: "another-publisher-salt-xyz-000" }))
  assert.throws(() => publishedKey(r, { dataset: "agreements", salt: "short" }), /salt of at least 16/)
})

test("the client's own external_id always wins over a derived key", () => {
  assert.equal(publishedKey({ ...record, external_id: "agr_7", id: 90210 }, { dataset: "agreements", salt: SALT }), "agr_7")
})
