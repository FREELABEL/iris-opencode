/**
 * ATLAS → A CLIENT'S DATABASE, the pure half of `iris atlas:database publish` (#186474).
 *
 * The mirror in the other direction. `iris atlas:storage feed` already streams changed records with
 * tombstones; what was missing is the landing side: a table in THEIR database that contains their
 * data and nothing of ours.
 *
 * WHAT THE FEED ACTUALLY CARRIES, read from a live dataset rather than assumed:
 *
 *   record = { id, bloq_id, schema_id, schema_version, user_id, status, external_id,
 *              created_at, updated_at, deleted, deleted_at, data: { …the client's fields… } }
 *
 * Five of those describe how IRIS is built — boards, schemas, schema versions, accounts, and our
 * own row id. Publishing them would hand a client (or whoever reads their warehouse) the shape of
 * our model for free, and would tie their tables to our internals: rename a concept here and their
 * reports break.
 *
 * SO THE RULE IS AN ALLOWLIST BY SOURCE, NOT A DENYLIST BY NAME. Columns come only from `data` —
 * the fields the client's own schema defines — plus three sync columns we add deliberately. A new
 * internal field added to the envelope next year cannot leak, because nothing outside `data` is
 * ever read. A denylist would have to be updated to stay correct; this cannot go stale.
 */

import { createHmac } from "node:crypto"

export const IDENT = /^[a-z_][a-z0-9_]*$/i

/**
 * The key a row is published under.
 *
 * MEASURED 2026-09-21 on the live `agreements` dataset: 17 records, ONE with an external_id. The
 * first version skipped the other 16 without a word and reported "1 upserted, applied" — 94% of the
 * dataset never reached the client and the run looked like a success.
 *
 * The fallback cannot be our internal record id: that is exactly what this command exists not to
 * publish. A plain hash of it is no better, because our ids are sequential integers and
 * sha256("agreements:90210") falls to a loop in seconds. So the fallback is an HMAC of the internal
 * id under a salt the publisher holds: stable across runs (the same record always lands on the same
 * row, so re-runs merge), and meaningless to anyone reading the client's table.
 *
 * Returns null only when there is nothing stable to key on at all — and the caller must COUNT that,
 * never drop it quietly.
 */
export function publishedKey(record: FeedRecord, { dataset, salt }: { dataset: string; salt: string }): string | null {
  const own = record?.external_id
  if (own !== undefined && own !== null && String(own) !== "") return String(own)
  const internal = (record as any)?.id
  if (internal === undefined || internal === null || String(internal) === "") return null
  if (!salt || salt.length < 16) throw new Error("publishedKey needs a salt of at least 16 characters")
  return "k_" + createHmac("sha256", salt).update(`${dataset}:${internal}`).digest("hex").slice(0, 32)
}

export interface Field { key: string; type?: string; label?: string }
export type Row = Record<string, unknown>
/** One record as the change feed returns it: an IRIS envelope around the client's `data`. */
export interface FeedRecord {
  external_id?: string | number | null
  updated_at?: string | null
  deleted?: boolean | null
  deleted_at?: string | null
  data?: Record<string, unknown> | null
  [envelope: string]: unknown
}

/**
 * The dataset schema's fields, from wherever the API put them.
 *
 * MEASURED: the schema endpoint nests them as `schema.fields.fields`. The prototype read
 * `schema.fields`, found nothing, and fell back to inferring every column as `text` — a DDL that
 * looked plausible and typed every number and date wrong. Read both shapes, and say when neither
 * was found instead of guessing quietly.
 */
export function fieldsFromSchema(schema: any): Field[] {
  const raw = schema?.fields?.fields ?? (Array.isArray(schema?.fields) ? schema.fields : null) ?? []
  return (Array.isArray(raw) ? raw : [])
    .map((f: any) => ({ key: String(f?.key ?? f?.name ?? ""), type: String(f?.type ?? "text"), label: f?.label }))
    .filter((f: Field) => IDENT.test(f.key))
}

/** The only columns we add beyond the client's own fields. Prefixed so they cannot collide. */
export const SYNC_COLUMNS = ["external_id", "iris_updated_at", "iris_deleted"]

/** Names that would reveal the model. Used ONLY as a second, independent check — see assertClean. */
export const INTERNAL_KEYS = ["bloq_id", "schema_id", "schema_version", "user_id", "bloq_list_id", "iris_item_id", "access_level", "public_uuid"]


export function quoteIdent(name: unknown, what = "identifier"): string {
  const s = String(name ?? "")
  if (!IDENT.test(s)) throw new Error(`unsafe ${what}: ${JSON.stringify(name)}`)
  return `"${s}"`
}

/**
 * One feed record → one row for the client's table.
 *
 * `data` is the only source of business columns. The record's own `status` is OURS and is dropped;
 * a `status` inside `data` is THEIRS and is kept — a naive flatten would let one silently overwrite
 * the other, and which one won would depend on key order.
 */
export function projectRecord(record: FeedRecord, { fields = null, key }: { fields?: string[] | null; key?: string | null } = {}): Row {
  const data = record?.data && typeof record.data === "object" ? record.data : {}
  const row: Row = {}
  for (const [key, value] of Object.entries(data)) {
    if (!IDENT.test(key)) continue
    if (fields && !fields.includes(key)) continue
    row[key] = value
  }
  row.external_id = String(key ?? record?.external_id ?? "")
  row.iris_updated_at = record?.updated_at ?? null
  row.iris_deleted = Boolean(record?.deleted)
  return row
}

/**
 * An independent check that nothing of ours is in the row.
 *
 * The allowlist above already makes this unreachable — which is exactly why it is here. Two
 * different mechanisms have to fail for an internal column to reach a client's database, and this
 * one fails loudly instead of publishing.
 */
export function assertClean(row: Row): Row {
  const leaked = Object.keys(row ?? {}).filter((k) => INTERNAL_KEYS.includes(k))
  if (leaked.length) throw new Error(`refusing to publish IRIS internals: ${leaked.join(", ")}`)
  return row
}

const TYPES: Record<string, string> = { text: "text", number: "numeric", boolean: "boolean", date: "timestamptz" }

/**
 * The table, in their database, described by THEIR schema.
 *
 * Types come from the dataset's own field definitions — the ones the client (or we, on their
 * behalf) declared — so the DDL describes their business, not our storage. Unknown types become
 * `text` rather than failing: a column that arrives is better than a migration that refuses.
 */
export function ddlFor({ table, schemaName = "public", fields, ifNotExists = true }: { table: string; schemaName?: string; fields: Field[]; ifNotExists?: boolean }): string {
  const t = `${quoteIdent(schemaName, "schema name")}.${quoteIdent(table, "table name")}`
  const cols = (fields ?? [])
    .filter((f) => IDENT.test(String(f?.key ?? "")) && !SYNC_COLUMNS.includes(f.key))
    .map((f) => `  ${quoteIdent(f.key, "column name")} ${TYPES[String(f.type)] ?? "text"}`)
  const lines = [
    `CREATE TABLE ${ifNotExists ? "IF NOT EXISTS " : ""}${t} (`,
    ['  "external_id" text PRIMARY KEY', ...cols, '  "iris_updated_at" timestamptz', '  "iris_deleted" boolean DEFAULT false'].join(",\n"),
    `);`,
    // The feed is ordered by updated_at and replicas are read by it; without this every incremental
    // read is a sequential scan of the client's table.
    `CREATE INDEX IF NOT EXISTS ${quoteIdent(`${table}_iris_updated_at_idx`, "index name")} ON ${t} ("iris_updated_at");`,
  ]
  return lines.join("\n")
}

const literal = (v: unknown): string => {
  if (v === null || v === undefined) return "NULL"
  if (typeof v === "number" && Number.isFinite(v)) return String(v)
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE"
  // Everything else goes out as a quoted string with quotes doubled — objects and arrays as JSON,
  // so a nested field lands as readable text rather than "[object Object]".
  const s = typeof v === "object" ? JSON.stringify(v) : String(v)
  return `'${s.replace(/'/g, "''")}'`
}

/**
 * Upsert one row, keyed on the client's own external_id.
 *
 * ON CONFLICT DO UPDATE, so re-publishing a window merges. A plain INSERT would fail on the second
 * run and an INSERT ... DO NOTHING would silently stop applying updates — both look like "it ran".
 */
export function upsertSql({ table, schemaName = "public", row }: { table: string; schemaName?: string; row: Row }): string {
  const t = `${quoteIdent(schemaName, "schema name")}.${quoteIdent(table, "table name")}`
  const keys = Object.keys(row).filter((k) => IDENT.test(k))
  const cols = keys.map((k) => quoteIdent(k, "column name")).join(", ")
  const vals = keys.map((k) => literal(row[k])).join(", ")
  const sets = keys.filter((k) => k !== "external_id").map((k) => `${quoteIdent(k)} = EXCLUDED.${quoteIdent(k)}`).join(", ")
  return `INSERT INTO ${t} (${cols}) VALUES (${vals})\n  ON CONFLICT ("external_id") DO UPDATE SET ${sets};`
}

/**
 * A deleted record.
 *
 * Soft by default: the row stays with `iris_deleted = true`, because a client's report that
 * suddenly loses rows is indistinguishable from a broken sync. `--hard-delete` is available for
 * anyone whose policy is the opposite.
 */
export function deleteSql({ table, schemaName = "public", externalId, hard = false }: { table: string; schemaName?: string; externalId: string; hard?: boolean }): string {
  const t = `${quoteIdent(schemaName, "schema name")}.${quoteIdent(table, "table name")}`
  const id = literal(String(externalId))
  return hard
    ? `DELETE FROM ${t} WHERE "external_id" = ${id};`
    : `UPDATE ${t} SET "iris_deleted" = TRUE WHERE "external_id" = ${id};`
}

/** The whole publish, as SQL a person can read before anyone runs it. */
export function buildScript({ table, schemaName = "public", fields, records, hard = false, includeDdl = true, only = null, keyFor }: { table: string; schemaName?: string; fields: Field[]; records: FeedRecord[]; hard?: boolean; includeDdl?: boolean; only?: string[] | null; keyFor?: (r: FeedRecord) => string | null }): { sql: string; upserts: number; deletes: number; unkeyed: number; derivedKeys: number } {
  const out: string[] = []
  if (includeDdl) out.push(ddlFor({ table, schemaName, fields }), "")
  let upserts = 0
  let deletes = 0
  let unkeyed = 0
  let derivedKeys = 0
  for (const rec of records ?? []) {
    const key = keyFor ? keyFor(rec) : rec?.external_id ? String(rec.external_id) : null
    // A row with no key cannot be upserted or found again — so it is COUNTED, never quietly lost.
    if (!key) { unkeyed++; continue }
    if (!rec?.external_id) derivedKeys++
    const row = assertClean(projectRecord(rec, { fields: only, key }))
    if (row.iris_deleted) {
      out.push(deleteSql({ table, schemaName, externalId: String(row.external_id), hard }))
      deletes++
    } else {
      out.push(upsertSql({ table, schemaName, row }))
      upserts++
    }
  }
  return { sql: out.join("\n"), upserts, deletes, unkeyed, derivedKeys }
}

/**
 * Client fields whose NAMES suggest a secret.
 *
 * These are the client's own columns, so this never refuses — publishing their token to their own
 * database may be exactly right. But copying a signing token or a password hash into a warehouse
 * that more people can read is a decision, not a default, and a decision has to be visible to be
 * made. `--fields` is how you narrow it.
 */
export const SENSITIVE = /(token|secret|password|passwd|api_?key|private_?key|credential|signature)/i

export function sensitiveFields(fields: Array<Field | string>): string[] {
  return (fields ?? []).map((f) => String(typeof f === "string" ? f : f?.key)).filter((k) => SENSITIVE.test(k))
}

/** What the client's table will contain, so it can be said before it is done. */
export function describePublish({ dataset, table, fields, upserts, deletes, since }: { dataset: string; table: string; fields: Field[]; upserts: number; deletes: number; since?: string | null }) {
  return {
    dataset,
    target_table: table,
    columns: [...(fields ?? []).map((f) => f.key).filter((k) => !SYNC_COLUMNS.includes(k)), ...SYNC_COLUMNS],
    upserts,
    deletes,
    since: since ?? "(everything)",
    internals_published: 0,
  }
}
