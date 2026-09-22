/**
 * `iris atlas:database` — put an Atlas dataset into a client's OWN database (#186474).
 *
 *   iris atlas:database ddl <dataset>                         the CREATE TABLE, nothing else
 *   iris atlas:database publish <dataset>                     SQL to stdout — nothing is sent
 *   iris atlas:database publish <dataset> --out sync.sql      the same, to a file to read first
 *   SUPABASE_KEY=… iris atlas:database publish <dataset> --target https://<ref>.supabase.co --apply
 *
 * Built for X-ART, whose warehouse is Supabase and whose intelligence layer is IRIS (#185408).
 *
 * WHAT THE CLIENT'S DATABASE NEVER RECEIVES is the reason this is a command and not an export:
 * the change feed wraps every record in an IRIS envelope (our row id, board id, schema id, schema
 * version, account id). Columns come ONLY from the record's own `data`. The rules, and why they are
 * an allowlist by source rather than a denylist by name, live in atlas-database-core.ts.
 *
 * The key is read from an environment variable and never from a flag, so it does not land in shell
 * history, `ps`, or a pasted command.
 */

import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { randomBytes } from "node:crypto"
import { join } from "node:path"
import { irisFetch, requireAuth, handleApiError, dim, bold, success, writeJson } from "./iris-api"
import {
  buildScript, ddlFor, describePublish, fieldsFromSchema, projectRecord, assertClean, sensitiveFields, publishedKey,
  INTERNAL_KEYS, IDENT, type FeedRecord, type Field,
} from "./atlas-database-core"
import { buildQuery, toRecords, nextCursor, hasMore, schemaFromRows, redact, summarize as summarizePull, assertIdent } from "./atlas-database-pull"

const stateDir = () => join(homedir(), ".iris", "atlas-database")
const statePath = (dataset: string, table: string) => join(stateDir(), `${dataset}__${table}.cursor.json`)

function readCursor(dataset: string, table: string): string | null {
  try {
    const p = statePath(dataset, table)
    return existsSync(p) ? (JSON.parse(readFileSync(p, "utf-8"))?.cursor ?? null) : null
  } catch {
    return null
  }
}

/**
 * The salt behind the opaque key for records that have no external_id of their own.
 *
 * It must be THE SAME for everyone who publishes to a given table, or one record lands under two
 * keys and the table grows a duplicate per publisher. So: $ATLAS_DB_KEY_SALT when set (share that
 * across machines), otherwise one generated on first use and kept at ~/.iris/atlas-database/salt.
 */
function keySalt(): { salt: string; source: string; created: boolean } {
  const env = process.env.ATLAS_DB_KEY_SALT
  if (env && env.length >= 16) return { salt: env, source: "$ATLAS_DB_KEY_SALT", created: false }
  const p = join(stateDir(), "salt")
  try {
    if (existsSync(p)) {
      const v = readFileSync(p, "utf-8").trim()
      if (v.length >= 16) return { salt: v, source: p, created: false }
    }
  } catch { /* fall through and create */ }
  mkdirSync(stateDir(), { recursive: true })
  const v = randomBytes(32).toString("hex")
  writeFileSync(p, v + "\n", { mode: 0o600 })
  return { salt: v, source: p, created: true }
}

async function readSchemaFields(dataset: string): Promise<{ fields: Field[]; found: boolean }> {
  const res = await irisFetch(`/api/v1/atlas/schemas/${encodeURIComponent(dataset)}`)
  if (!res.ok) return { fields: [], found: false }
  const body = (await res.json().catch(() => null)) as any
  const fields = fieldsFromSchema(body?.data?.schema ?? body?.data)
  return { fields, found: fields.length > 0 }
}

/**
 * Every changed record since the cursor, tombstones included.
 *
 * Same endpoint and cursor rules as `atlas:storage feed` (strictly-greater-than cursor, an empty
 * page ends it, an epoch cursor rather than none so the first run has something to resume from).
 * Tombstones are always requested here: a replica built without them keeps every row it has ever
 * seen and diverges while both sides report success.
 */
async function readFeed(dataset: string, since: string | null): Promise<{ records: FeedRecord[]; cursor: string | null } | null> {
  let cursor = since || "1970-01-01T00:00:00Z"
  let resume: string | null = since
  const records: FeedRecord[] = []
  for (let page = 0; page < 500; page++) {
    const qs = new URLSearchParams({ updated_since: cursor, per_page: "200", include_deleted: "1" })
    const res = await irisFetch(`/api/v1/atlas/datasets/${encodeURIComponent(dataset)}?${qs.toString()}`)
    if (!(await handleApiError(res, "Change feed"))) return null
    const body = (await res.json().catch(() => null)) as any
    const payload = body?.data ?? body
    const raw = payload?.records?.data ?? payload?.records ?? []
    const rows: FeedRecord[] = Array.isArray(raw) ? raw : []
    // The feed marks a tombstone with deleted_at; the projection reads `deleted`. Normalise here so
    // a delete is never published as an upsert of an empty row.
    for (const r of rows) records.push({ ...r, deleted: Boolean(r?.deleted || r?.deleted_at) })
    const next = payload?.cdc?.next_cursor ?? payload?.records?.next_cursor ?? body?.meta?.next_cursor ?? null
    if (next) resume = next
    if (rows.length === 0 || !next || next === cursor) break
    cursor = next
  }
  return { records, cursor: resume }
}

const DdlCommand = cmd({
  command: "ddl <dataset>",
  describe: "print the CREATE TABLE a client's database needs for this dataset — nothing is sent",
  builder: (y: any) =>
    y
      .positional("dataset", { type: "string", demandOption: true, describe: "dataset slug" })
      .option("table", { type: "string", describe: "target table name (default: the dataset slug, snake_cased)" })
      .option("pg-schema", { type: "string", default: "public", describe: "Postgres schema to create it in" }),
  async handler(args: any) {
    const token = await requireAuth(); if (!token) return
    const table = targetTable(args)
    const { fields, found } = await readSchemaFields(String(args.dataset))
    if (!found) { console.error(`No field definitions found for dataset "${args.dataset}".`); process.exitCode = 1; return }
    process.stdout.write(ddlFor({ table, schemaName: String(args["pg-schema"]), fields }) + "\n")
  },
})

/** Dataset slugs use hyphens; Postgres identifiers should not. */
function targetTable(args: any): string {
  const t = String(args.table || String(args.dataset).replace(/-/g, "_"))
  if (!IDENT.test(t)) throw new Error(`"${t}" is not a usable table name — pass --table`)
  return t
}

const PublishCommand = cmd({
  command: "publish <dataset>",
  describe: "publish a dataset into a client's own Postgres/Supabase — their fields only, never IRIS internals",
  builder: (y: any) =>
    y
      .positional("dataset", { type: "string", demandOption: true, describe: "dataset slug" })
      .option("table", { type: "string", describe: "target table name (default: the dataset slug, snake_cased)" })
      .option("pg-schema", { type: "string", default: "public", describe: "Postgres schema the table lives in" })
      .option("fields", { type: "string", describe: "comma-separated subset of fields to publish" })
      .option("out", { type: "string", describe: "write the SQL to this file instead of stdout" })
      .option("target", { type: "string", describe: "Supabase project URL for --apply (or SUPABASE_URL)" })
      .option("key-env", { type: "string", default: "SUPABASE_KEY", describe: "env var holding the target key — never pass a key as a flag" })
      .option("apply", { type: "boolean", default: false, describe: "actually upsert into the target. Without it nothing is sent anywhere" })
      .option("hard-delete", { type: "boolean", default: false, describe: "DELETE tombstoned rows instead of marking iris_deleted = true" })
      .option("reset", { type: "boolean", default: false, describe: "ignore the saved cursor and publish everything" })
      .option("json", { type: "boolean", default: false }),
  async handler(args: any) {
    const token = await requireAuth(); if (!token) return
    const dataset = String(args.dataset)
    let table: string
    try { table = targetTable(args) } catch (e: any) { console.error(e.message); process.exitCode = 1; return }
    const pgSchema = String(args["pg-schema"])
    if (!IDENT.test(pgSchema)) { console.error(`"${pgSchema}" is not a usable schema name`); process.exitCode = 1; return }
    const named = args.fields ? String(args.fields).split(",").map((s) => s.trim()).filter(Boolean) : null
    const since = args.reset ? null : readCursor(dataset, table)

    const { fields: schemaFields, found } = await readSchemaFields(dataset)
    const feed = await readFeed(dataset, since)
    if (!feed) { process.exitCode = 1; return }
    let fields = schemaFields
    if (!found) {
      // No schema to read types from. Infer the column NAMES from the rows, type them all text, and
      // say so — a DDL of plausible-looking text columns must not be mistaken for a typed one.
      const keys = new Set<string>()
      for (const r of feed.records) for (const k of Object.keys(r?.data ?? {})) if (IDENT.test(k)) keys.add(k)
      fields = [...keys].map((key) => ({ key, type: "text" }))
    }
    if (named) fields = fields.filter((f) => named.includes(f.key))

    // THE TABLE AND THE ROWS MUST AGREE. Records can carry keys the schema never declared; left in,
    // they would name columns the CREATE TABLE does not have and the upsert would fail part-way
    // through a run. So when the schema is known, exactly its fields go out, and anything else in
    // the data is reported as dropped rather than silently sent or silently lost.
    const only = named ?? (found ? fields.map((f) => f.key) : null)
    const undeclared = new Set<string>()
    if (found) for (const r of feed.records) for (const k of Object.keys(r?.data ?? {})) if (!schemaFields.some((f) => f.key === k)) undeclared.add(k)

    const needsDerived = feed.records.some((r) => !r?.external_id)
    const saltInfo = needsDerived ? keySalt() : null
    const keyFor = (r: FeedRecord) => publishedKey(r, { dataset, salt: saltInfo?.salt ?? "" })
    const { sql, upserts, deletes, unkeyed, derivedKeys } = buildScript({ table, schemaName: pgSchema, fields, records: feed.records, hard: Boolean(args["hard-delete"]), only, keyFor })

    // A last, independent read of the finished text: two mechanisms have to fail before an internal
    // name reaches a client, and this is the one that reads what is actually about to leave.
    const leaked = INTERNAL_KEYS.filter((k) => sql.includes(`"${k}"`))
    if (leaked.length) { console.error(`REFUSING: the generated SQL names IRIS internals: ${leaked.join(", ")}`); process.exitCode = 1; return }

    const summary = describePublish({ dataset, table, fields, upserts, deletes, since })
    const risky = sensitiveFields(only ?? fields)

    if (args.json && !args.apply) {
      await writeJson({ ...summary, pg_schema: pgSchema, typed_from_schema: found, sensitive_columns: risky, undeclared_dropped: [...undeclared], derived_keys: derivedKeys, unkeyed_skipped: unkeyed, sql: args.out ? undefined : sql })
      if (args.out) writeFileSync(String(args.out), sql + "\n")
      return
    }

    // The report goes to stderr so `publish > sync.sql` produces a file that is only SQL.
    const say = (s = "") => console.error(s)
    say(`  ${bold(dataset)} → ${pgSchema}.${table}`)
    say(`  ${feed.records.length} record(s) read · ${upserts} upsert(s) · ${deletes} delete(s) · since ${summary.since}`)
    if (derivedKeys) {
      say(`  ${derivedKeys} record(s) have no external_id — published under an opaque key (stable across runs; reveals nothing about IRIS ids)`)
      say(dim(`    salt: ${saltInfo?.source}${saltInfo?.created ? " (created now)" : ""} — anyone else publishing to this table must use the same one: export ATLAS_DB_KEY_SALT=<it>`))
    }
    if (unkeyed) say(`  ! ${unkeyed} record(s) have nothing stable to key on and were NOT published`)
    say(`  columns: ${summary.columns.join(", ")}`)
    if (undeclared.size) say(`  ${undeclared.size} key(s) in the data are not in the dataset schema and were NOT published: ${[...undeclared].slice(0, 12).join(", ")}${undeclared.size > 12 ? " …" : ""}`)
    if (!found) say(`  ! no field definitions found — every column typed as text. Check: iris atlas:datasets schemas show ${dataset}`)
    say(`  ${success("IRIS internals in this output: 0")}`)
    if (risky.length) say(`  ! these columns look like secrets and WILL be published: ${risky.join(", ")}  ${dim("(narrow with --fields)")}`)

    if (args.out) { writeFileSync(String(args.out), sql + "\n"); say(`  written to ${args.out} — read it before you run it`) }

    if (!args.apply) {
      if (!args.out) process.stdout.write(sql + "\n")
      say(dim("  nothing was sent anywhere — add --apply with --target to upsert into Supabase"))
      return
    }

    const target = String(args.target || process.env.SUPABASE_URL || "").replace(/\/+$/, "")
    const key = process.env[String(args["key-env"])]
    if (!target || !key) { say(`  --apply needs --target (or SUPABASE_URL) and the key in $${args["key-env"]}`); process.exitCode = 1; return }
    if (pgSchema !== "public") { say("  --apply goes through PostgREST, which serves the public schema — use --out and run the SQL for another schema"); process.exitCode = 1; return }

    const headers = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" }
    // The SAME key function as the SQL above, so --out and --apply cannot disagree about which row is which.
    const rows = feed.records.filter((r) => !r.deleted).map((r) => ({ r, key: keyFor(r) })).filter((x) => x.key).map((x) => assertClean(projectRecord(x.r, { fields: only, key: x.key })))
    const gone = feed.records.filter((r) => r.deleted).map((r) => keyFor(r)).filter((k): k is string => Boolean(k))

    for (let i = 0; i < rows.length; i += 500) {
      const res = await fetch(`${target}/rest/v1/${table}`, {
        method: "POST",
        headers: { ...headers, Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify(rows.slice(i, i + 500)),
      })
      if (!res.ok) {
        const body = (await res.text().catch(() => "")).slice(0, 300)
        // Nothing past this point runs, including the cursor save: the next run re-sends this window,
        // which the upsert absorbs. A skipped window is the failure nobody finds.
        say(`  upsert failed (${res.status}): ${body}`)
        if (res.status === 404) say(`  the table does not exist yet — create it first:  iris atlas:database ddl ${dataset}${args.table ? ` --table ${table}` : ""}`)
        say(`  cursor left at ${since ?? "(beginning)"} — nothing was skipped`)
        process.exitCode = 1
        return
      }
    }

    let tombstoneFailures = 0
    for (const id of gone) {
      const res = await fetch(`${target}/rest/v1/${table}?external_id=eq.${encodeURIComponent(id)}`, {
        method: args["hard-delete"] ? "DELETE" : "PATCH",
        headers: { ...headers, Prefer: "return=minimal" },
        ...(args["hard-delete"] ? {} : { body: JSON.stringify({ iris_deleted: true }) }),
      })
      if (!res.ok) tombstoneFailures++
    }
    if (tombstoneFailures) {
      say(`  ${tombstoneFailures} deletion(s) failed — cursor NOT saved, so the next run retries them`)
      process.exitCode = 1
      return
    }

    mkdirSync(stateDir(), { recursive: true })
    writeFileSync(statePath(dataset, table), JSON.stringify({ cursor: feed.cursor, dataset, table, target, updated_at: new Date().toISOString() }, null, 2) + "\n", { mode: 0o600 })
    say(`  ${success(`applied: ${rows.length} upserted, ${gone.length} ${args["hard-delete"] ? "deleted" : "tombstoned"}`)}`)
    say(dim(`  cursor saved — the next run publishes only what changed after ${feed.cursor}`))
    if (args.json) await writeJson({ ...summary, applied: true, upserted: rows.length, removed: gone.length, cursor: feed.cursor })
  },
})


/**
 * `iris atlas:database pull <table> --dataset <slug>` — the other direction (#186475).
 *
 * Reads a Supabase table over PostgREST and upserts it into an Atlas dataset, incrementally. No
 * Postgres driver and no inbound access to their database: only a key that can SELECT. The rules
 * (ordered paging, a cursor that never goes backwards, rows without an id dropped rather than given
 * an invented key) live in atlas-database-pull.ts.
 *
 * DRY BY DEFAULT. The first thing anyone runs against a client's warehouse cannot change anything.
 */
const PullCommand = cmd({
  command: "pull <table>",
  describe: "mirror a Supabase/Postgres table into an Atlas dataset, incrementally — dry unless --apply",
  builder: (y: any) =>
    y
      .positional("table", { type: "string", demandOption: true, describe: "source table (plain identifier)" })
      .option("dataset", { type: "string", demandOption: true, describe: "Atlas dataset slug to upsert into" })
      .option("source", { type: "string", describe: "Supabase project URL (or SUPABASE_URL)" })
      .option("key-env", { type: "string", default: "SUPABASE_KEY", describe: "env var holding a key that can SELECT — never pass a key as a flag" })
      .option("cursor-field", { type: "string", default: "updated_at", describe: "column that decides what is new" })
      .option("id-field", { type: "string", default: "id", describe: "column that becomes external_id as <table>:<id>" })
      .option("limit", { type: "number", default: 500, describe: "rows per page" })
      .option("max-pages", { type: "number", default: 50, describe: "ceiling on pages per run" })
      .option("bloq", { type: "number", describe: "board the dataset lives on" })
      .option("apply", { type: "boolean", default: false, describe: "actually write to Atlas. Without it nothing is written" })
      .option("reset", { type: "boolean", default: false, describe: "forget the cursor and read the table from the beginning" })
      .option("json", { type: "boolean", default: false }),
  async handler(args: any) {
    const table = String(args.table)
    const dataset = String(args.dataset)
    const cursorField = String(args["cursor-field"])
    const idField = String(args["id-field"])
    try { assertIdent(table, "table name"); assertIdent(cursorField, "cursor field"); assertIdent(idField, "id field") }
    catch (e: any) { console.error(e.message); process.exitCode = 1; return }

    const source = String(args.source || process.env.SUPABASE_URL || "").replace(/\/+$/, "")
    const key = process.env[String(args["key-env"])]
    if (!source || !key) { console.error(`pull needs --source (or SUPABASE_URL) and a key in $${args["key-env"]}`); process.exitCode = 1; return }
    const say = (s = "") => console.error(redact(s, [key]))

    const statePath = join(stateDir(), `pull__${dataset}__${table}.cursor.json`)
    let since: string | null = null
    if (!args.reset) { try { since = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf-8"))?.cursor ?? null : null } catch { since = null } }

    const limit = Math.max(1, Math.min(10000, Number(args.limit) || 500))
    const all: Record<string, unknown>[] = []
    let cursor = since
    let stalled = false
    for (let page = 0; page < Number(args["max-pages"] || 50); page++) {
      const url = buildQuery({ baseUrl: source, table, cursorField, since: cursor, limit })
      const res = await fetch(url, { headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: "application/json" } })
      if (!res.ok) {
        const body = (await res.text().catch(() => "")).slice(0, 300)
        // Day one is usually this: the invite is accepted but the key cannot read the table. The
        // fix is a grant, not a retry — so name the table.
        say(`  source said ${res.status} reading "${table}": ${body}`)
        process.exitCode = 1
        return
      }
      const rows = (await res.json().catch(() => [])) as Record<string, unknown>[]
      if (!Array.isArray(rows) || rows.length === 0) break
      all.push(...rows)
      const advanced = nextCursor(rows, cursorField, cursor)
      // A page that does not move the cursor would be fetched for ever. Stop and name the suspect.
      if (advanced === cursor) { stalled = true; break }
      cursor = advanced
      if (!hasMore(rows, limit)) break
    }

    const { records, skipped } = toRecords(all, { idField, table })
    const result = summarizePull({ table, fetched: all.length, records: records.length, skipped: skipped.length, from: since, to: cursor })

    say(`  ${bold(table)} → ${dataset}`)
    say(`  fetched ${result.fetched} · to import ${result.imported} · skipped (no ${idField}) ${result.skipped_no_id}`)
    say(`  cursor ${result.cursor_from} → ${result.cursor_to}`)
    if (stalled) say(`  ! a page came back but "${cursorField}" did not advance — stopped. Is --cursor-field right?`)
    if (skipped.length) say(`  ! ${skipped.length} row(s) have no "${idField}" and were NOT imported — an invented key would duplicate them on every run`)

    if (records.length === 0) { say(args.apply ? "  nothing new" : "  nothing new (dry run)"); if (args.json) await writeJson({ ...result, applied: false }); return }

    const token = await requireAuth(); if (!token) return
    const schemaRes = await irisFetch(`/api/v1/atlas/schemas/${encodeURIComponent(dataset)}`)
    const datasetExists = schemaRes.ok

    if (!args.apply) {
      const schema = schemaFromRows(all)
      const guessed = schema.filter((f) => f.inferred_from_nulls_only).map((f) => f.key)
      say("")
      say(`  DRY RUN — nothing was written to Atlas. ${schema.length} column(s) seen.`)
      if (guessed.length) say(`  typed as text because every sampled row was null: ${guessed.join(", ")}`)
      if (!datasetExists) {
        say(`  the dataset "${dataset}" does not exist yet — create it, then re-run with --apply:`)
        say(`    iris atlas:datasets schemas create --name "${table}" --slug ${dataset}${args.bloq ? ` --bloq ${args.bloq}` : ""} \\`)
        say(`      --fields '${JSON.stringify({ fields: schema.map(({ key, label, type }) => ({ key, label, type })) })}'`)
      } else say(`  dataset "${dataset}" exists — re-run with --apply to import`)
      if (args.json) await writeJson({ ...result, applied: false, dataset_exists: datasetExists, inferred_schema: schema })
      return
    }

    if (!datasetExists) { say(`  the dataset "${dataset}" does not exist — run without --apply to get the create command`); process.exitCode = 1; return }

    let created = 0, updated = 0, failed = 0
    for (let i = 0; i < records.length; i += 500) {
      const res = await irisFetch(`/api/v1/atlas/datasets/${encodeURIComponent(dataset)}/import`, {
        method: "POST",
        body: JSON.stringify({ records: records.slice(i, i + 500), validate: true, ...(args.bloq != null ? { bloq_id: args.bloq } : {}) }),
      })
      if (!(await handleApiError(res, "Import"))) {
        // The cursor is NOT advanced: re-reading this window is absorbed by the upsert; skipping it is not.
        say(`  cursor left at ${since ?? "(beginning)"} — nothing was skipped`)
        process.exitCode = 1
        return
      }
      const d = ((await res.json().catch(() => null)) as any)?.data
      created += d?.created ?? 0
      updated += d?.updated ?? 0
      failed += d?.failed_count ?? 0
    }

    // Rows the server refused are rows the next run must see again. Advancing past them would lose
    // them for good, and "failed_count: 3" is the only place that loss would ever have been written.
    if (failed > 0) {
      say(`  ${created} new · ${updated} merged · ${bold(`${failed} REFUSED by the dataset`)} — cursor NOT advanced, so the next run retries them`)
      process.exitCode = 1
      return
    }

    mkdirSync(stateDir(), { recursive: true })
    writeFileSync(statePath, JSON.stringify({ cursor, table, dataset, source, updated_at: new Date().toISOString() }, null, 2) + "\n", { mode: 0o600 })
    say(`  ${success(`imported: ${created} new · ${updated} merged`)}`)
    say(dim(`  cursor saved — the next run reads only rows after ${cursor}`))
    if (args.json) await writeJson({ ...result, applied: true, created, updated })
  },
})

export const PlatformAtlasDatabaseCommand = cmd({
  command: "atlas:database",
  aliases: ["atlas-database", "atlas:db"],
  describe: "Atlas ↔ a client's own database — publish their fields out (never IRIS internals), pull their tables in",
  builder: (y: any) => y.command(PublishCommand).command(PullCommand).command(DdlCommand).demandCommand(),
  async handler() {},
})
