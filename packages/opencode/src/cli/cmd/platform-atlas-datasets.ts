import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, dim, bold, FL_API, isNonInteractive, writeJson } from "./iris-api"
import * as fs from "fs"
import * as path from "path"

// ============================================================================
// Atlas Datasets CLI — Schema-driven generic data platform
//
// Routes: /api/v1/atlas/schemas + /api/v1/atlas/datasets
// The "last migration" — define schemas via JSON, no new tables needed
// ============================================================================

function fmtCents(c?: number | null): string {
  if (c == null || c === 0) return dim("—")
  return "$" + (c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function printDivider() { console.log(dim("  " + "─".repeat(72))) }

// A schema's `settings` blob is not decoration — an ONBOARDING FLOW lives entirely
// in it (`flow_type: "onboarding"` plus steps/branding/completion). Both the create
// and update endpoints have always accepted it; the CLI just never passed it, which
// is why flows could only be made by hand against the API and why the whole
// Onboarding SDK stayed invisible. See `iris onboarding` for the friendly surface.
function readJsonArg(v: string | undefined, label: string): { ok: boolean; value?: any } {
  if (!v) return { ok: true, value: undefined }
  try {
    if (v.endsWith(".json") && fs.existsSync(v)) return { ok: true, value: JSON.parse(fs.readFileSync(v, "utf8")) }
    return { ok: true, value: JSON.parse(v) }
  } catch {
    prompts.log.error(`Invalid JSON for --${label}`)
    return { ok: false }
  }
}

// ── SCHEMAS ──────────────────────────────────────────────────────────────────

const SchemaListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list all schemas",
  builder: (y) =>
    y.option("bloq", { type: "number", describe: "filter by bloq" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Atlas Schemas")
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Loading…")
    try {
      const p = new URLSearchParams()
      if (args.bloq != null) p.set("bloq_id", String(args.bloq))
      const res = await irisFetch(`/api/v1/atlas/schemas?${p}`)
      const ok = await handleApiError(res, "List schemas"); if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }
      const body = (await res.json()) as any
      const rows: any[] = body?.data ?? []
      spinner.stop(`${rows.length} schema(s)`)

      if (args.json) { await writeJson(rows); prompts.outro("Done"); return }
      if (rows.length === 0) { prompts.log.warn("No schemas defined yet"); prompts.outro("iris atlas:datasets schemas create"); return }

      printDivider()
      for (const s of rows) {
        const fieldCount = s.fields?.fields?.length ?? 0
        console.log(`  ${bold(s.slug)}  ${dim(`v${s.version}`)}  ${s.name}  ${dim(`${fieldCount} fields`)}  ${dim(`bloq:${s.bloq_id ?? "—"}`)}`)
      }
      printDivider()
      prompts.outro("iris atlas:datasets records list --schema=<slug>")
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const SchemaShowCommand = cmd({
  command: "show <slug>",
  describe: "show schema definition",
  builder: (y) => y.positional("slug", { type: "string", demandOption: true }).option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Schema: ${args.slug}`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }

    const res = await irisFetch(`/api/v1/atlas/schemas/${args.slug}`)
    const ok = await handleApiError(res, "Show schema"); if (!ok) { prompts.outro("Done"); return }
    const body = (await res.json()) as any
    const schema = body?.data?.schema ?? body?.data

    if (args.json) { await writeJson(body?.data); prompts.outro("Done"); return }

    console.log(`  ${dim("Name:")}    ${schema?.name}`)
    console.log(`  ${dim("Version:")} ${schema?.version}`)
    console.log(`  ${dim("Bloq:")}    ${schema?.bloq_id ?? "—"}`)
    console.log(`  ${dim("Records:")} ${body?.data?.record_count ?? "?"}`)
    printDivider()
    console.log(`  ${bold("Fields:")}`)
    for (const f of schema?.fields?.fields ?? []) {
      const flags = []
      if (f.required) flags.push("required")
      if (f.indexed) flags.push("indexed")
      console.log(`    ${f.key.padEnd(25)} ${dim(f.type.padEnd(10))} ${f.label ?? ""}  ${flags.length ? dim(flags.join(", ")) : ""}`)
    }
    printDivider()
    prompts.outro("Done")
  },
})

const SchemaCreateCommand = cmd({
  command: "create",
  aliases: ["new"],
  describe: "create a new dataset schema",
  builder: (y) =>
    y
      .option("name", { type: "string", demandOption: true, describe: "schema name" })
      .option("slug", { type: "string", describe: "url-safe slug (auto from name if omitted)" })
      .option("bloq", { type: "number", describe: "bloq ID to scope to" })
      .option("fields", { type: "string", describe: "JSON fields definition or path to .json file" })
      .option("settings", { type: "string", describe: "JSON settings blob or path to .json file — an onboarding flow lives here" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Create Schema")
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }

    let fields: any = null
    if (args.fields) {
      try {
        // Try as file path first
        if (args.fields.endsWith(".json") && fs.existsSync(args.fields)) {
          fields = JSON.parse(fs.readFileSync(args.fields, "utf8"))
        } else {
          fields = JSON.parse(args.fields)
        }
      } catch {
        prompts.log.error("Invalid JSON for --fields")
        prompts.outro("Done")
        return
      }
    } else {
      // Interactive: ask for fields
      const fieldsDef = await prompts.text({
        message: "Define fields as JSON (or press Enter for empty schema):",
        placeholder: '{"fields": [{"key": "name", "label": "Name", "type": "text", "required": true}]}',
      })
      if (prompts.isCancel(fieldsDef)) { prompts.outro("Done"); return }
      if (fieldsDef && String(fieldsDef).trim()) {
        try { fields = JSON.parse(String(fieldsDef)) } catch { prompts.log.error("Invalid JSON"); prompts.outro("Done"); return }
      } else {
        fields = { fields: [] }
      }
    }

    // Normalize: wrap bare arrays so API receives { fields: [...] }
    const normalizedFields = Array.isArray(fields) ? { fields } : fields
    const settingsArg = readJsonArg(args.settings as string | undefined, "settings")
    if (!settingsArg.ok) { prompts.outro("Done"); return }

    const body: Record<string, any> = { name: args.name, fields: normalizedFields }
    if (args.slug) body.slug = args.slug
    if (args.bloq != null) body.bloq_id = args.bloq
    if (settingsArg.value !== undefined) body.settings = settingsArg.value

    const spinner = prompts.spinner()
    spinner.start("Creating…")
    try {
      const res = await irisFetch("/api/v1/atlas/schemas", { method: "POST", body: JSON.stringify(body) })
      const ok = await handleApiError(res, "Create schema"); if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }
      const data = ((await res.json()) as any)?.data
      spinner.stop(`Created: ${bold(data?.slug ?? args.name)}`)
      const madeAFlow = settingsArg.value?.flow_type === "onboarding"
      prompts.outro(madeAFlow
        ? `iris onboarding flows show ${data?.slug ?? args.slug ?? args.name}`
        : `iris atlas:datasets records list --schema=${data?.slug ?? args.name}`)
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

// #162692 — evolve a schema's fields safely. The backend (PATCH schemas/{slug}) creates
// a NEW version and keeps existing records; no destructive delete-and-recreate needed.
const SchemaUpdateCommand = cmd({
  command: "update <slug>",
  aliases: ["edit", "evolve"],
  describe: "evolve a schema's fields — creates a NEW version, keeps existing records",
  builder: (y) =>
    y
      .positional("slug", { type: "string", demandOption: true })
      .option("name", { type: "string", describe: "rename the schema" })
      .option("fields", { type: "string", describe: "JSON fields definition or path to .json file (full new field set)" })
      .option("settings", { type: "string", describe: "JSON settings blob or path to .json file — replaces settings wholesale" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Evolve Schema: ${args.slug}`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }

    let fields: any = null
    if (args.fields) {
      try {
        if (args.fields.endsWith(".json") && fs.existsSync(args.fields)) {
          fields = JSON.parse(fs.readFileSync(args.fields, "utf8"))
        } else {
          fields = JSON.parse(args.fields)
        }
      } catch { prompts.log.error("Invalid JSON for --fields"); prompts.outro("Done"); return }
    }

    const settingsArg = readJsonArg(args.settings as string | undefined, "settings")
    if (!settingsArg.ok) { prompts.outro("Done"); return }

    const body: Record<string, any> = {}
    if (args.name) body.name = args.name
    if (fields) body.fields = Array.isArray(fields) ? { fields } : fields
    if (settingsArg.value !== undefined) body.settings = settingsArg.value
    if (body.name === undefined && body.fields === undefined && body.settings === undefined) {
      prompts.log.warn("Nothing to update. Pass --fields <json|file> (full new field set), --settings <json|file>, and/or --name")
      prompts.outro("Done"); return
    }

    const spinner = prompts.spinner()
    spinner.start("Evolving schema…")
    try {
      const res = await irisFetch(`/api/v1/atlas/schemas/${args.slug}`, { method: "PATCH", body: JSON.stringify(body) })
      const ok = await handleApiError(res, "Update schema"); if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }
      const data = ((await res.json()) as any)?.data
      spinner.stop(`Evolved ${bold(args.slug)} → v${data?.version ?? "?"}  ${dim("(existing records preserved)")}`)
      prompts.outro(`iris atlas:datasets records list --schema=${args.slug}`)
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

// #137845 — the create path existed but there was no delete path, so test schemas
// persisted as orphans. Prompt by default, --force to skip, --cascade to also remove
// records (the server refuses with a clear 409 if records exist and cascade is off).
const SchemaDeleteCommand = cmd({
  command: "delete <slug>",
  aliases: ["rm", "destroy"],
  describe: "delete a dataset schema (all versions)",
  builder: (y) =>
    y
      .positional("slug", { type: "string", demandOption: true })
      .option("force", { alias: "y", describe: "skip confirmation prompt", type: "boolean", default: false })
      .option("cascade", { describe: "also delete the dataset's records", type: "boolean", default: false })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    const isJson = args.json === true
    if (!isJson) {
      UI.empty()
      prompts.intro(`◈  Delete Schema: ${args.slug}`)
    }
    const token = await requireAuth()
    if (!token) { if (!isJson) prompts.outro("Done"); return }

    let confirmed: boolean | symbol = args.force
    if (!confirmed) {
      if (isNonInteractive()) {
        if (isJson) console.log(JSON.stringify({ error: "Refusing to delete schema without --force in non-interactive mode" }))
        else prompts.log.error("Refusing to delete schema without --force in non-interactive mode.")
        process.exitCode = 2
        return
      }
      confirmed = await prompts.confirm({ message: `Delete schema '${args.slug}'${args.cascade ? " AND its records" : ""}? This cannot be undone.` })
    }
    if (!confirmed || prompts.isCancel(confirmed)) { if (!isJson) prompts.outro("Cancelled"); return }

    const query = args.cascade ? "?cascade=true" : ""
    const res = await irisFetch(`/api/v1/atlas/schemas/${args.slug}${query}`, { method: "DELETE" })
    if (!(await handleApiError(res, "Delete schema"))) {
      process.exitCode = 1
      if (!isJson) prompts.outro("Done")
      return
    }
    const data = (((await res.json().catch(() => ({}))) as any)?.data) ?? {}
    if (isJson) { await writeJson(data); return }
    prompts.outro(`Deleted schema '${args.slug}' (${data.deleted_versions ?? 1} version(s)${data.deleted_records ? `, ${data.deleted_records} record(s)` : ""})`)
  },
})

const SchemasGroup = cmd({
  command: "schemas",
  aliases: ["schema"],
  describe: "manage dataset schemas",
  builder: (y) => y.command(SchemaListCommand).command(SchemaShowCommand).command(SchemaCreateCommand).command(SchemaUpdateCommand).command(SchemaDeleteCommand).demandCommand(),
  async handler() {},
})

// ── RECORDS ──────────────────────────────────────────────────────────────────

const RecordsListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list records in a dataset",
  builder: (y) =>
    y
      .option("schema", { type: "string", demandOption: true, alias: "s", describe: "schema slug" })
      .option("filter", { type: "string", alias: "where", describe: "field=value filter (repeatable), e.g. --where status=active", array: true })
      .option("search", { type: "string", alias: "q", describe: "full-text search over record data" })
      .option("sort", { type: "string", default: "created_at" })
      .option("limit", { type: "number", default: 25 })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Dataset: ${args.schema}`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Loading…")
    try {
      const p = new URLSearchParams({ per_page: String(args.limit), sort: args.sort })
      if (args.search) p.set("search", args.search)
      // Parse --filter stage_name=Negotiating into filter[stage_name]=Negotiating
      for (const f of args.filter ?? []) {
        const [key, ...rest] = f.split("=")
        if (key && rest.length) p.set(`filter[${key}]`, rest.join("="))
      }

      const res = await irisFetch(`/api/v1/atlas/datasets/${args.schema}?${p}`)
      const ok = await handleApiError(res, "List records"); if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }
      const body = (await res.json()) as any
      const records: any[] = body?.data?.records?.data ?? body?.data?.records ?? []
      const total = body?.data?.records?.total ?? records.length
      const schema = body?.data?.schema
      spinner.stop(`${records.length} of ${total} record(s)`)

      if (args.json) { await writeJson(records); prompts.outro("Done"); return }
      if (records.length === 0) { prompts.log.warn("No records"); prompts.outro("Done"); return }

      printDivider()
      for (const r of records) {
        const d = r.data ?? {}
        // Build a smart one-liner from the first few fields
        const displayField = schema?.fields?.display_field ?? Object.keys(d)[0]
        const displayVal = d[displayField] ?? r.external_id ?? `#${r.id}`
        const extId = r.external_id ? dim(r.external_id) : ""
        console.log(`  ${dim(`#${r.id}`)}  ${bold(String(displayVal))}  ${extId}`)

        // Show key fields inline
        const preview: string[] = []
        for (const key of Object.keys(d).slice(0, 6)) {
          if (key === displayField) continue
          const val = d[key]
          if (val == null || typeof val === "object") continue
          preview.push(`${key}: ${val}`)
        }
        if (preview.length) console.log(`    ${dim(preview.join("  ·  "))}`)
      }
      printDivider()
      prompts.outro("Done")
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

// #162689 — discoverable search verb over dataset records (sugar for list --search,
// plus --where filters). Backed by the API's JSON search/filter over record data.
const RecordsSearchCommand = cmd({
  command: "search <query>",
  aliases: ["find"],
  describe: "search records by text; combine with --where field=value filters",
  builder: (y) =>
    y
      .positional("query", { type: "string", demandOption: true })
      .option("schema", { type: "string", demandOption: true, alias: "s", describe: "schema slug" })
      .option("where", { type: "string", alias: "filter", describe: "field=value filter (repeatable)", array: true })
      .option("limit", { type: "number", default: 25 })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Search: ${args.schema} · "${args.query}"`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }
    const spinner = prompts.spinner()
    spinner.start("Searching…")
    try {
      const p = new URLSearchParams({ per_page: String(args.limit), search: String(args.query) })
      for (const f of (args.where as string[] | undefined) ?? []) {
        const [key, ...rest] = f.split("=")
        if (key && rest.length) p.set(`filter[${key}]`, rest.join("="))
      }
      const res = await irisFetch(`/api/v1/atlas/datasets/${args.schema}?${p}`)
      const ok = await handleApiError(res, "Search records"); if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }
      const body = (await res.json()) as any
      const records: any[] = body?.data?.records?.data ?? body?.data?.records ?? []
      const total = body?.data?.records?.total ?? records.length
      const schema = body?.data?.schema
      spinner.stop(`${records.length} of ${total} match(es)`)
      if (args.json) { await writeJson(records); prompts.outro("Done"); return }
      if (records.length === 0) { prompts.log.warn("No matches"); prompts.outro("Done"); return }
      printDivider()
      for (const r of records) {
        const d = r.data ?? {}
        const displayField = schema?.fields?.display_field ?? Object.keys(d)[0]
        const displayVal = d[displayField] ?? r.external_id ?? `#${r.id}`
        console.log(`  ${dim(`#${r.id}`)}  ${bold(String(displayVal))}  ${r.external_id ? dim(r.external_id) : ""}`)
      }
      printDivider()
      prompts.outro("Done")
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const RecordsShowCommand = cmd({
  command: "show <id>",
  describe: "show a single record",
  builder: (y) =>
    y.positional("id", { type: "number", demandOption: true })
      .option("schema", { type: "string", demandOption: true, alias: "s" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Record #${args.id}`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }

    const res = await irisFetch(`/api/v1/atlas/datasets/${args.schema}/${args.id}`)
    const ok = await handleApiError(res, "Show record"); if (!ok) { prompts.outro("Done"); return }
    const body = (await res.json()) as any
    const record = body?.data

    if (args.json) { await writeJson(record); prompts.outro("Done"); return }

    const d = record?.data ?? {}
    printDivider()
    for (const [k, v] of Object.entries(d)) {
      if (v == null) continue
      if (Array.isArray(v)) {
        console.log(`  ${dim(k + ":")} [${v.length} items]`)
        for (const item of v.slice(0, 5)) {
          if (typeof item === "object") {
            const line = Object.entries(item).map(([ik, iv]) => `${ik}: ${iv}`).join("  ·  ")
            console.log(`    ${dim("→")} ${line}`)
          } else {
            console.log(`    ${dim("→")} ${item}`)
          }
        }
        if (v.length > 5) console.log(`    ${dim(`... and ${v.length - 5} more`)}`)
      } else {
        console.log(`  ${dim(k + ":")} ${v}`)
      }
    }
    printDivider()
    if (record?.external_id) console.log(`  ${dim("external_id:")} ${record.external_id}`)
    if (record?.updated_at) console.log(`  ${dim("updated:")} ${record.updated_at}`)
    prompts.outro("Done")
  },
})

const RecordsSummaryCommand = cmd({
  command: "summary",
  aliases: ["stats"],
  describe: "aggregate stats for a dataset",
  builder: (y) =>
    y
      .option("schema", { type: "string", demandOption: true, alias: "s" })
      .option("group-by", { type: "string", describe: "field to group by" })
      .option("sum", { type: "string", describe: "money field to sum" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Dataset Summary: ${args.schema}`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }

    const p = new URLSearchParams()
    if (args["group-by"]) p.set("group_by", args["group-by"])
    if (args.sum) p.set("sum", args.sum)

    const res = await irisFetch(`/api/v1/atlas/datasets/${args.schema}/summary?${p}`)
    const ok = await handleApiError(res, "Summary"); if (!ok) { prompts.outro("Done"); return }
    const body = (await res.json()) as any
    const data = body?.data

    if (args.json) { await writeJson(data); prompts.outro("Done"); return }

    printDivider()
    console.log(`  ${bold("Total Records:")} ${data?.total_records ?? 0}`)
    if (data?.sum) {
      console.log(`  ${bold(`Sum (${data.sum.field}):`)} ${fmtCents(data.sum.total)}`)
    }
    if (data?.groups && Object.keys(data.groups).length > 0) {
      console.log(`  ${bold("By " + (args["group-by"] ?? "group") + ":")}`)
      for (const [group, count] of Object.entries(data.groups)) {
        console.log(`    ${(group || "(empty)").padEnd(25)} ${count}`)
      }
    }
    printDivider()
    prompts.outro("Done")
  },
})

// Fetch dataset records, paginating through ALL pages when `all` is set. Returns the
// records plus the dataset's true total so callers can warn loudly when a capped fetch
// is partial — audit and export used to silently process only the first 200 rows and
// present the result as complete, dropping ~91% of a 2143-row dataset (#137273).
async function fetchDatasetRecords(
  schema: string,
  opts: { limit: number; all: boolean },
): Promise<{ records: any[]; total: number; truncated: boolean }> {
  const perPage = opts.all ? 200 : opts.limit
  let page = 1
  let records: any[] = []
  let total = 0
  while (true) {
    const p = new URLSearchParams({ per_page: String(perPage), page: String(page) })
    const res = await irisFetch(`/api/v1/atlas/datasets/${schema}?${p}`)
    const ok = await handleApiError(res, "List records")
    if (!ok) throw new Error("Failed to list records")
    const body = (await res.json()) as any
    const recs = body?.data?.records
    const pageRecords: any[] = recs?.data ?? recs ?? []
    total = recs?.total ?? body?.data?.total ?? total ?? pageRecords.length
    records = records.concat(pageRecords)
    const lastPage = recs?.last_page ?? Math.ceil((total || pageRecords.length) / perPage)
    if (!opts.all || page >= lastPage || pageRecords.length === 0) break
    page++
  }
  return { records, total: total || records.length, truncated: !opts.all && (total || 0) > records.length }
}

// ── EXPORT ───────────────────────────────────────────────────────────────────

const ExportCommand = cmd({
  command: "export",
  describe: "export dataset to CSV",
  builder: (y) =>
    y
      .option("schema", { type: "string", demandOption: true, alias: "s" })
      .option("out", { type: "string", alias: "o", describe: "output file path" })
      .option("format", { type: "string", default: "csv", describe: "csv|json" })
      .option("fields", { type: "string", describe: "comma-separated fields to include" })
      .option("all", { type: "boolean", default: false, describe: "export the ENTIRE dataset (paginate past --limit)" })
      .option("limit", { type: "number", default: 200 }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Export: ${args.schema}`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Fetching records…")

    try {
      // Get schema for field labels
      const schemaRes = await irisFetch(`/api/v1/atlas/schemas/${args.schema}`)
      const schemaOk = await handleApiError(schemaRes, "Get schema"); if (!schemaOk) { spinner.stop("Failed", 1); prompts.outro("Done"); return }
      const schemaBody = (await schemaRes.json()) as any
      const schema = schemaBody?.data?.schema ?? schemaBody?.data

      // Get records (paginate the full dataset with --all; otherwise capped by --limit)
      const { records, total, truncated } = await fetchDatasetRecords(args.schema, { limit: args.limit, all: args.all })
      spinner.stop(truncated ? `${records.length} of ${total} record(s) — PARTIAL` : `${records.length} record(s)`)
      if (truncated) {
        prompts.log.warn(`Exporting only ${records.length} of ${total} records (--limit ${args.limit}). Pass --all to export the entire dataset, or raise --limit.`)
      }

      // Determine fields to export
      const allFields: { key: string; label: string }[] = (schema?.fields?.fields ?? []).map((f: any) => ({
        key: f.key,
        label: f.label ?? f.key,
      }))
      const selectedKeys = args.fields ? args.fields.split(",").map((k: string) => k.trim()) : allFields.map((f: { key: string }) => f.key)
      const selectedFields = allFields.filter((f: { key: string }) => selectedKeys.includes(f.key))

      if (args.format === "json") {
        const output = JSON.stringify(records.map((r: any) => r.data), null, 2)
        if (args.out) {
          fs.writeFileSync(args.out, output)
          prompts.outro(`Written to ${args.out}`)
        } else {
          console.log(output)
          prompts.outro("Done")
        }
        return
      }

      // CSV export
      // Flatten nested objects/arrays for CSV
      const csvRows: string[] = []
      // Header
      csvRows.push(selectedFields.map((f: { label: string }) => `"${f.label}"`).join(","))
      // Rows
      for (const r of records) {
        const d = r.data ?? {}
        const row = selectedFields.map((f: { key: string }) => {
          let val = d[f.key]
          if (val == null) return ""
          if (typeof val === "boolean") return val ? "Yes" : "No"
          if (Array.isArray(val)) {
            // For services array, summarize
            if (val.length > 0 && typeof val[0] === "object") {
              return `"${val.length} items"`
            }
            return `"${val.join("; ")}"`
          }
          if (typeof val === "number" && f.key.includes("total") || f.key.includes("balance") || f.key.includes("limit")) {
            // Money fields — convert from cents
            return (val / 100).toFixed(2)
          }
          return `"${String(val).replace(/"/g, '""')}"`
        })
        csvRows.push(row.join(","))
      }

      const csvOutput = csvRows.join("\n")
      const outPath = args.out ?? `${args.schema}-export-${new Date().toISOString().slice(0, 10)}.csv`
      fs.writeFileSync(outPath, csvOutput)
      prompts.outro(`${records.length} records → ${outPath}`)
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

// ── AUDIT ────────────────────────────────────────────────────────────────────

const AuditCommand = cmd({
  command: "audit",
  describe: "audit dataset for data quality issues",
  builder: (y) =>
    y
      .option("schema", { type: "string", demandOption: true, alias: "s" })
      .option("json", { type: "boolean", default: false })
      .option("all", { type: "boolean", default: false, describe: "audit the ENTIRE dataset (paginate past --limit)" })
      .option("limit", { type: "number", default: 200 }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Audit: ${args.schema}`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Scanning…")

    try {
      // Get schema
      const schemaRes = await irisFetch(`/api/v1/atlas/schemas/${args.schema}`)
      const schemaOk = await handleApiError(schemaRes, "Get schema"); if (!schemaOk) { spinner.stop("Failed", 1); prompts.outro("Done"); return }
      const schemaBody = (await schemaRes.json()) as any
      const schema = schemaBody?.data?.schema ?? schemaBody?.data

      // Get records (paginate the full dataset with --all; otherwise capped by --limit)
      const { records, total, truncated } = await fetchDatasetRecords(args.schema, { limit: args.limit, all: args.all })
      spinner.stop(truncated ? `auditing ${records.length} of ${total} record(s) — PARTIAL` : `${records.length} record(s) to audit`)
      if (truncated) {
        prompts.log.warn(`Auditing only ${records.length} of ${total} records (--limit ${args.limit}). The other ${total - records.length} were NOT examined — pass --all to audit the entire dataset.`)
      }

      const fields: any[] = schema?.fields?.fields ?? []
      const requiredKeys = fields.filter((f: any) => f.required).map((f: any) => f.key)

      interface AuditFlag {
        record_id: number
        external_id: string
        field: string
        issue: string
        severity: string
      }

      const flags: AuditFlag[] = []

      for (const r of records) {
        const d = r.data ?? {}
        const extId = r.external_id ?? `#${r.id}`

        // Check required fields
        for (const key of requiredKeys) {
          if (!d[key] && d[key] !== 0 && d[key] !== false) {
            flags.push({ record_id: r.id, external_id: extId, field: key, issue: "Missing required field", severity: "error" })
          }
        }

        // Check money fields for $0
        for (const f of fields) {
          if (f.type === "money" && d[f.key] === 0 && f.key !== "ar_balance") {
            flags.push({ record_id: r.id, external_id: extId, field: f.key, issue: "$0.00 amount", severity: "warning" })
          }
        }

        // Check services array for $0 billing
        if (Array.isArray(d.services)) {
          for (const svc of d.services) {
            if (svc.amount === 0 && svc.provider && svc.provider !== "N/A") {
              flags.push({ record_id: r.id, external_id: extId, field: `services.${svc.provider}`, issue: "$0.00 billing — missing amount", severity: "warning" })
            }
          }
          if (d.services.length === 0) {
            flags.push({ record_id: r.id, external_id: extId, field: "services", issue: "No services attached", severity: "info" })
          }
        }

        // Check for empty G Drive link
        if (!d.g_drive_link && d.servis_case_id) {
          flags.push({ record_id: r.id, external_id: extId, field: "g_drive_link", issue: "No Google Drive folder linked", severity: "info" })
        }
      }

      if (args.json) { await writeJson({ total_records: records.length, flags_count: flags.length, flags }); prompts.outro("Done"); return }

      printDivider()
      console.log(`  ${bold("Records scanned:")} ${records.length}`)
      console.log(`  ${bold("Issues found:")}    ${flags.length}`)

      const errors = flags.filter(f => f.severity === "error")
      const warnings = flags.filter(f => f.severity === "warning")
      const infos = flags.filter(f => f.severity === "info")

      if (errors.length) {
        console.log(`\n  ${bold("ERRORS")} (${errors.length})`)
        for (const f of errors) {
          console.log(`    ❌  ${f.external_id}  ${f.field}  ${dim(f.issue)}`)
        }
      }
      if (warnings.length) {
        console.log(`\n  ${bold("WARNINGS")} (${warnings.length})`)
        for (const f of warnings) {
          console.log(`    ⚠️   ${f.external_id}  ${f.field}  ${dim(f.issue)}`)
        }
      }
      if (infos.length) {
        console.log(`\n  ${bold("INFO")} (${infos.length})`)
        for (const f of infos) {
          console.log(`    ℹ️   ${f.external_id}  ${dim(f.field)}  ${dim(f.issue)}`)
        }
      }
      if (flags.length === 0) {
        console.log(`\n  ✅  ${bold("All records pass audit")}`)
      }
      printDivider()
      prompts.outro("Done")
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

// ── RECORDS WRITE COMMANDS ───────────────────────────────────────────────────

const RecordsAddCommand = cmd({
  command: "add",
  aliases: ["create"],
  describe: "add a record to a dataset",
  builder: (y) =>
    y
      .option("schema", { type: "string", demandOption: true, alias: "s" })
      .option("data", { type: "string", describe: "JSON data or path to .json file" })
      .option("external-id", { type: "string", describe: "external ID for dedup" })
      .option("bloq", { type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Add Record: ${args.schema}`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }

    let data: any = {}
    if (args.data) {
      try {
        if (args.data.endsWith(".json") && fs.existsSync(args.data)) {
          data = JSON.parse(fs.readFileSync(args.data, "utf8"))
        } else {
          data = JSON.parse(args.data)
        }
      } catch { prompts.log.error("Invalid JSON for --data"); prompts.outro("Done"); return }
    } else {
      const raw = await prompts.text({ message: "Record data (JSON):", placeholder: '{"name": "value"}' })
      if (prompts.isCancel(raw)) { prompts.outro("Done"); return }
      try { data = JSON.parse(String(raw)) } catch { prompts.log.error("Invalid JSON"); prompts.outro("Done"); return }
    }

    const body: Record<string, any> = { data }
    if (args["external-id"]) body.external_id = args["external-id"]
    if (args.bloq != null) body.bloq_id = args.bloq

    const spinner = prompts.spinner()
    spinner.start("Creating…")
    try {
      const res = await irisFetch(`/api/v1/atlas/datasets/${args.schema}`, { method: "POST", body: JSON.stringify(body) })
      const ok = await handleApiError(res, "Create record"); if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }
      const result = ((await res.json()) as any)?.data
      spinner.stop(`Created #${result?.id ?? "?"}`)
      prompts.outro(`iris atlas:datasets records show ${result?.id ?? ""} -s ${args.schema}`)
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const RecordsUpdateCommand = cmd({
  command: "update <id>",
  aliases: ["edit"],
  describe: "update a record",
  builder: (y) =>
    y
      .positional("id", { type: "number", demandOption: true })
      .option("schema", { type: "string", demandOption: true, alias: "s" })
      .option("data", { type: "string", describe: "JSON data to merge" })
      .option("set", { type: "string", describe: "key=value pairs (repeatable)", array: true }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Update Record #${args.id}`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }

    let data: any = {}
    if (args.data) {
      try { data = JSON.parse(args.data) } catch { prompts.log.error("Invalid JSON for --data"); prompts.outro("Done"); return }
    }
    // Parse --set key=value pairs
    for (const s of args.set ?? []) {
      const [key, ...rest] = s.split("=")
      if (key && rest.length) {
        let val: any = rest.join("=")
        try { val = JSON.parse(val) } catch { /* keep as string */ }
        data[key] = val
      }
    }

    if (Object.keys(data).length === 0) {
      prompts.log.error("No data provided. Use --data '{...}' or --set key=value")
      prompts.outro("Done")
      return
    }

    const spinner = prompts.spinner()
    spinner.start("Updating…")
    try {
      const res = await irisFetch(`/api/v1/atlas/datasets/${args.schema}/${args.id}`, {
        method: "PATCH",
        body: JSON.stringify({ data }),
      })
      const ok = await handleApiError(res, "Update record"); if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }
      spinner.stop("Updated")
      prompts.outro(`iris atlas:datasets records show ${args.id} -s ${args.schema}`)
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const RecordsDeleteCommand = cmd({
  command: "delete <id>",
  aliases: ["rm", "remove"],
  describe: "delete a record",
  builder: (y) =>
    y
      .positional("id", { type: "number", demandOption: true })
      .option("schema", { type: "string", demandOption: true, alias: "s" })
      .option("force", { alias: "y", describe: "skip confirmation prompt", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Delete Record #${args.id}`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }

    if (!args.force) {
      const confirm = await prompts.confirm({ message: `Delete record #${args.id}?` })
      if (prompts.isCancel(confirm) || !confirm) { prompts.outro("Cancelled"); return }
    }

    const spinner = prompts.spinner()
    spinner.start("Deleting…")
    try {
      const res = await irisFetch(`/api/v1/atlas/datasets/${args.schema}/${args.id}`, { method: "DELETE" })
      const ok = await handleApiError(res, "Delete record"); if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }
      spinner.stop("Deleted")
      prompts.outro("Done")
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const RecordsUpsertCommand = cmd({
  command: "upsert",
  aliases: ["sync"],
  describe: "create or update a record by external ID",
  builder: (y) =>
    y
      .option("schema", { type: "string", demandOption: true, alias: "s" })
      .option("external-id", { type: "string", demandOption: true, describe: "external ID for dedup" })
      .option("data", { type: "string", demandOption: true, describe: "JSON data" })
      .option("bloq", { type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Upsert: ${args["external-id"]}`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }

    let data: any
    try { data = JSON.parse(args.data) } catch { prompts.log.error("Invalid JSON"); prompts.outro("Done"); return }

    const body: Record<string, any> = { external_id: args["external-id"], data }
    if (args.bloq != null) body.bloq_id = args.bloq

    const spinner = prompts.spinner()
    spinner.start("Upserting…")
    try {
      const res = await irisFetch(`/api/v1/atlas/datasets/${args.schema}/upsert`, { method: "POST", body: JSON.stringify(body) })
      const ok = await handleApiError(res, "Upsert"); if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }
      const result = ((await res.json()) as any)
      spinner.stop(result?.message ?? "Done")
      prompts.outro("Done")
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

// ── COMMAND GROUPS ────────────────────────────────────────────────────────────

const RecordsGroup = cmd({
  command: "records",
  aliases: ["data", "rows"],
  describe: "manage records in a dataset",
  builder: (y) =>
    y.command(RecordsListCommand).command(RecordsSearchCommand).command(RecordsShowCommand).command(RecordsSummaryCommand)
     .command(RecordsAddCommand).command(RecordsUpdateCommand).command(RecordsDeleteCommand)
     .command(RecordsUpsertCommand).demandCommand(),
  async handler() {},
})

// #137843 — datasets ARE served as a real REST API, but it was undiscoverable: no
// command told you the host, path, auth header, or the (wrapped) body shape. This
// surfaces the full contract for a dataset so it can actually be called.
const ApiCommand = cmd({
  command: "api <slug>",
  aliases: ["endpoint", "serve"],
  describe: "show the REST API for a dataset (base URL, auth, request shapes)",
  builder: (y) =>
    y
      .positional("slug", { type: "string", demandOption: true })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    const token = await requireAuth()
    if (!token) return

    const url = `${FL_API}/api/v1/atlas/datasets/${args.slug}`

    // Pull the field keys + record count so the body example is concrete.
    let fields: string[] = []
    let recordCount: number | undefined
    try {
      const res = await irisFetch(`/api/v1/atlas/schemas/${args.slug}`)
      if (res.ok) {
        const b = (await res.json()) as any
        const schema = b?.data?.schema ?? b?.data
        fields = (schema?.fields?.fields ?? []).map((f: any) => f.key).filter(Boolean)
        recordCount = b?.data?.record_count
      }
    } catch { /* non-fatal — still print the contract */ }

    const exampleData = fields.length
      ? `{${fields.slice(0, 2).map((f) => `"${f}":"…"`).join(",")}}`
      : `{…}`
    const curl = `curl -X POST "${url}" -H "Authorization: Bearer $IRIS_API_KEY" -H "Content-Type: application/json" -d '{"data":${exampleData},"external_id":"unique-1"}'`

    if (args.json) {
      await writeJson({
        dataset: args.slug,
        base_url: url,
        auth: { header: "Authorization", value: "Bearer <IRIS_API_KEY>" },
        record_count: recordCount,
        fields,
        endpoints: {
          list: { method: "GET", path: `/api/v1/atlas/datasets/${args.slug}`, query: ["page", "per_page"] },
          create: { method: "POST", path: `/api/v1/atlas/datasets/${args.slug}`, body: { data: "{...fields}", external_id: "optional unique id" } },
          show: { method: "GET", path: `/api/v1/atlas/datasets/${args.slug}/{id}` },
          update: { method: "PATCH", path: `/api/v1/atlas/datasets/${args.slug}/{id}` },
          delete: { method: "DELETE", path: `/api/v1/atlas/datasets/${args.slug}/{id}` },
          upsert: { method: "POST", path: `/api/v1/atlas/datasets/${args.slug}/upsert` },
          summary: { method: "GET", path: `/api/v1/atlas/datasets/${args.slug}/summary` },
        },
        example_curl: curl,
      })
      return
    }

    UI.empty()
    prompts.intro(`◈  Dataset API — ${args.slug}`)
    console.log(`  ${bold("Base URL")}   ${url}`)
    console.log(`  ${bold("Auth")}       Authorization: Bearer <IRIS_API_KEY>`)
    if (recordCount != null) console.log(`  ${bold("Records")}    ${recordCount}`)
    printDivider()
    console.log(`  ${bold("Endpoints")}`)
    console.log(`    GET    ${url}        ${dim("?page=&per_page=")}`)
    console.log(`    POST   ${url}        ${dim('{"data":{…},"external_id":"…"}')}`)
    console.log(`    GET    ${url}/{id}`)
    console.log(`    PATCH  ${url}/{id}`)
    console.log(`    DELETE ${url}/{id}`)
    console.log(`    POST   ${url}/upsert ${dim("(upsert by external_id)")}`)
    console.log(`    GET    ${url}/summary   ${dim("(legacy — COUNT/SUM only)")}`)
    console.log(`    GET    ${url}/aggregate ${dim("?group_by=&metrics=avg:Field,median:Field,rate:F=V&min_sample=")}`)
    console.log(`    POST   ${url}/derive    ${dim('{"fields":["zone_id"],"force":false}')}`)
    console.log(`    POST   ${url}/import    ${dim('{"records":[{"external_id":"…","data":{…}}]} — upsert, idempotent')}`)
    printDivider()
    if (fields.length) console.log(`  ${bold("Fields")}     ${fields.join(", ")}`)
    console.log()
    console.log(`  ${dim("POST body MUST be wrapped as { data, external_id } — a flat body fails:")}`)
    console.log(`  ${dim(curl)}`)
    prompts.outro("Done")
  },
})

// ── FEEDS ────────────────────────────────────────────────────────────────────

const FeedCreateCommand = cmd({
  command: "create",
  aliases: ["mint", "new"],
  describe: "mint a shareable read-only token for a dataset (shown ONCE)",
  builder: (y) =>
    y
      .option("schema", { type: "string", demandOption: true, alias: "s", describe: "dataset slug you own" })
      .option("label", { type: "string", describe: "human label for the feed" })
      .option("filter", { type: "array", default: [] as string[], describe: 'pin the feed to a slice — "Region=north" (callers cannot widen it)' })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Mint feed token: ${args.schema}`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }

    const filters: Record<string, string> = {}
    for (const raw of (args.filter as string[]) ?? []) {
      const eq = String(raw).indexOf("=")
      if (eq < 1) { prompts.log.error(`Filter "${raw}" must be Field=value`); prompts.outro("Done"); return }
      filters[String(raw).slice(0, eq).trim()] = String(raw).slice(eq + 1)
    }

    const res = await irisFetch("/api/v1/atlas/feeds", {
      method: "POST",
      body: JSON.stringify({
        schema_slug: args.schema,
        ...(args.label ? { label: args.label } : {}),
        ...(Object.keys(filters).length ? { filters } : {}),
      }),
    })
    const ok = await handleApiError(res, "Create feed"); if (!ok) { prompts.outro("Done"); return }
    const d = ((await res.json()) as any)?.data

    if (args.json) { await writeJson(d); prompts.outro("Done"); return }

    printDivider()
    console.log(`  ${bold("Feed")}      #${d?.id}  ${d?.label ?? ""}`)
    // Said plainly, because it is true and there is no recovery path — the API returns the
    // full token exactly once and every later read shows only a prefix.
    console.log(`  ${bold("Token")}     ${d?.token}`)
    console.log(`  ${dim("This is the ONLY time the token is shown. Store it now.")}`)
    printDivider()
    console.log(`  ${bold("Aggregate")} ${d?.urls?.aggregate}`)
    console.log(`  ${bold("CSV")}       ${d?.urls?.csv}  ${dim("(Excel Power Query)")}`)
    console.log(`  ${bold("JSON")}      ${d?.urls?.json}`)
    if (Object.keys(filters).length) {
      console.log(`  ${bold("Pinned")}    ${JSON.stringify(filters)}  ${dim("— callers cannot widen this")}`)
    }
    printDivider()
    console.log(`  ${dim("The token IS the auth. Anyone holding it can read this dataset.")}`)
    console.log(`  ${dim(`Revoke with: iris datasets feeds revoke ${d?.id}`)}`)
    prompts.outro("Done")
  },
})

const FeedListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list feed tokens (prefixes only — full tokens are never re-shown)",
  builder: (y) =>
    y.option("schema", { type: "string", alias: "s", describe: "filter by dataset slug" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Feed tokens")
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }

    const p = new URLSearchParams()
    if (args.schema) p.set("schema", String(args.schema))

    const res = await irisFetch(`/api/v1/atlas/feeds?${p}`)
    const ok = await handleApiError(res, "List feeds"); if (!ok) { prompts.outro("Done"); return }
    const feeds: any[] = ((await res.json()) as any)?.data?.feeds ?? []

    if (args.json) { await writeJson(feeds); prompts.outro("Done"); return }
    if (feeds.length === 0) {
      prompts.log.warn("No feeds yet")
      prompts.outro("iris datasets feeds create -s <slug>")
      return
    }

    printDivider()
    for (const f of feeds) {
      const state = f.active ? bold("active") : dim("revoked")
      console.log(
        `  #${String(f.id).padEnd(5)} ${state.padEnd(16)} ${String(f.schema_slug).padEnd(24)} ` +
          `${dim(f.token_prefix + "…")}  ${dim(`${f.access_count} hit(s)`)}  ${f.label ?? ""}`,
      )
      if (f.filters && Object.keys(f.filters).length) console.log(`         ${dim("pinned: " + JSON.stringify(f.filters))}`)
    }
    printDivider()
    prompts.outro("Done")
  },
})

const FeedRevokeCommand = cmd({
  command: "revoke <id>",
  describe: "permanently disable a feed token",
  builder: (y) => y.positional("id", { type: "number", demandOption: true }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Revoke feed #${args.id}`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }

    const res = await irisFetch(`/api/v1/atlas/feeds/${args.id}`, { method: "DELETE" })
    const ok = await handleApiError(res, "Revoke feed"); if (!ok) { prompts.outro("Done"); return }

    console.log(`  ${bold("Revoked")} — the token is permanently dead and cannot be reissued.`)
    prompts.outro("Done")
  },
})

const FeedsGroup = cmd({
  command: "feeds",
  aliases: ["feed"],
  describe: "shareable read-only tokens for a dataset",
  builder: (y) => y.command(FeedCreateCommand).command(FeedListCommand).command(FeedRevokeCommand).demandCommand(),
  async handler() {},
})

// ── IMPORT ───────────────────────────────────────────────────────────────────

/** Server cap per request; the CLI chunks to stay under it. */
const IMPORT_CHUNK = 500

/**
 * Read a JSON array or CSV file into {external_id, data} rows.
 *
 * The external-id column is what makes a re-import merge instead of duplicate, so a file
 * without it is refused rather than loaded — a dataset that silently doubles every month is
 * worse than an import that failed.
 */
function readImportRows(file: string, idField: string): { rows: any[]; error?: string } {
  const raw = fs.readFileSync(file, "utf8")

  if (file.toLowerCase().endsWith(".json")) {
    let parsed: any
    try { parsed = JSON.parse(raw) } catch (e: any) { return { rows: [], error: `Invalid JSON: ${e.message}` } }
    const list = Array.isArray(parsed) ? parsed : parsed?.records ?? parsed?.data
    if (!Array.isArray(list)) return { rows: [], error: "Expected a JSON array, or {records:[…]}" }

    const rows = list.map((r: any) =>
      // Already in wire shape? Pass through. Otherwise treat the object as the data and pull
      // the id out of it.
      r && typeof r === "object" && "external_id" in r && "data" in r
        ? r
        : { external_id: String(r?.[idField] ?? ""), data: r },
    )
    const missing = rows.filter((r) => !r.external_id).length
    if (missing) return { rows: [], error: `${missing} row(s) have no "${idField}" — no dedup key, so a re-import would duplicate` }
    return { rows }
  }

  // Minimal CSV: comma-separated, optional double quotes, no embedded newlines.
  const lines = raw.split(/\r?\n/).filter((l) => l.trim() !== "")
  if (lines.length < 2) return { rows: [], error: "CSV needs a header row and at least one data row" }
  const split = (line: string) =>
    (line.match(/("([^"]|"")*"|[^,]*)(,|$)/g) ?? [])
      .slice(0, -1)
      .map((c) => c.replace(/,$/, "").replace(/^"|"$/g, "").replace(/""/g, '"'))
  const header = split(lines[0])
  if (!header.includes(idField)) return { rows: [], error: `CSV has no "${idField}" column (columns: ${header.join(", ")})` }

  const rows = lines.slice(1).map((line) => {
    const cells = split(line)
    const data: Record<string, any> = {}
    header.forEach((h, i) => {
      const v = cells[i] ?? ""
      // Numeric-looking cells become numbers so money/number fields validate and aggregate.
      data[h] = v !== "" && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v
    })
    return { external_id: String(data[idField] ?? ""), data }
  })
  const missing = rows.filter((r) => !r.external_id).length
  if (missing) return { rows: [], error: `${missing} CSV row(s) have an empty "${idField}"` }
  return { rows }
}

const ImportCommand = cmd({
  command: "import <file>",
  describe: "bulk upsert rows from JSON/CSV — re-running merges instead of duplicating",
  builder: (y) =>
    y
      .positional("file", { type: "string", describe: "path to a .json array or .csv file" })
      .option("schema", { type: "string", demandOption: true, alias: "s", describe: "dataset slug" })
      .option("id-field", { type: "string", default: "external_id", describe: "column holding the stable dedup key" })
      .option("bloq", { type: "number" })
      .option("no-validate", { type: "boolean", default: false, describe: "skip schema validation (trusted load)" })
      .option("dry-run", { type: "boolean", default: false, describe: "parse and report, write nothing" })
      .option("json", { type: "boolean", default: false })
      .example('$0 datasets import ./bids.csv -s cci-bid-history --id-field "Project ID"', "monthly workbook drop"),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Import → ${args.schema}`)

    const file = String(args.file)
    if (!fs.existsSync(file)) { prompts.log.error(`File not found: ${file}`); prompts.outro("Done"); return }

    const { rows, error } = readImportRows(file, String(args["id-field"]))
    if (error) { prompts.log.error(error); prompts.outro("Done"); return }

    console.log(`  ${bold("Parsed")}    ${rows.length} row(s) from ${path.basename(file)}`)
    if (args["dry-run"]) {
      console.log(`  ${dim("Dry run — nothing written. First row:")}`)
      console.log(`  ${dim(JSON.stringify(rows[0]).slice(0, 200))}`)
      prompts.outro("Done"); return
    }

    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }

    let created = 0, updated = 0, failedCount = 0, totalActive = 0
    const failures: any[] = []
    const chunks = Math.ceil(rows.length / IMPORT_CHUNK)

    for (let c = 0; c < chunks; c++) {
      const slice = rows.slice(c * IMPORT_CHUNK, (c + 1) * IMPORT_CHUNK)
      const res = await irisFetch(`/api/v1/atlas/datasets/${args.schema}/import`, {
        method: "POST",
        body: JSON.stringify({
          records: slice,
          validate: !args["no-validate"],
          ...(args.bloq != null ? { bloq_id: args.bloq } : {}),
        }),
      })
      const ok = await handleApiError(res, `Import chunk ${c + 1}/${chunks}`)
      // Stop on a failed chunk rather than pressing on — continuing would report a total that
      // mixes written and unwritten rows.
      if (!ok) { prompts.outro("Done"); return }

      const d = ((await res.json()) as any)?.data
      created += d?.created ?? 0
      updated += d?.updated ?? 0
      failedCount += d?.failed_count ?? 0
      totalActive = d?.total_active ?? totalActive
      if (Array.isArray(d?.failed)) failures.push(...d.failed)
      if (chunks > 1) console.log(`  ${dim(`chunk ${c + 1}/${chunks}: +${d?.created ?? 0} new, ${d?.updated ?? 0} merged`)}`)
    }

    if (args.json) {
      await writeJson({ created, updated, failed_count: failedCount, total_active: totalActive, failed: failures })
      prompts.outro("Done"); return
    }

    printDivider()
    console.log(`  ${bold("Created")}   ${created}`)
    console.log(`  ${bold("Merged")}    ${updated} ${dim("(matched an existing dedup key)")}`)
    console.log(`  ${bold("Total")}     ${totalActive} active record(s) in the dataset`)
    // Never let rejected rows pass quietly — a partial load reported as complete is how a
    // dataset ends up 80% full and trusted.
    if (failedCount > 0) {
      console.log(`  ${bold("Failed")}    ${failedCount} row(s) rejected:`)
      for (const f of failures.slice(0, 10)) {
        console.log(`    ${dim(`row ${f.index}${f.external_id ? ` (${f.external_id})` : ""}: ${JSON.stringify(f.error)}`)}`)
      }
      if (failures.length > 10) console.log(`    ${dim(`… ${failures.length - 10} more`)}`)
    }
    printDivider()
    prompts.outro("Done")
  },
})

// ── AGGREGATE ────────────────────────────────────────────────────────────────

/**
 * Parse a --filter token into the nested query shape the endpoint expects.
 *
 *   "Scope[in]=TXDOT,Lift Station"  ->  filter[Scope][in]=TXDOT,Lift Station
 *   "Outcome=Won"                   ->  filter[Outcome]=Won        (bare = equality)
 *
 * Splits on the FIRST "=" so values containing "=" survive.
 */
function applyFilterToken(p: URLSearchParams, token: string): string | null {
  const eq = token.indexOf("=")
  if (eq < 1) return `Filter "${token}" must be Field=value or Field[op]=value`
  const lhs = token.slice(0, eq).trim()
  const value = token.slice(eq + 1)

  const m = lhs.match(/^(.+?)\[(\w+)\]$/)
  if (m) p.set(`filter[${m[1]}][${m[2]}]`, value)
  else p.set(`filter[${lhs}]`, value)
  return null
}

/** "avg:Estimated Margin" -> "Avg Estimated Margin" for a column header. */
function metricHeader(spec: string): string {
  const i = spec.indexOf(":")
  if (i < 0) return spec.charAt(0).toUpperCase() + spec.slice(1)
  const op = spec.slice(0, i)
  return `${op.charAt(0).toUpperCase() + op.slice(1)} ${spec.slice(i + 1)}`
}

function fmtMetric(spec: string, m: any): string {
  if (!m || m.value === null || m.value === undefined) return dim("—")
  const n = Number(m.value)
  if (Number.isNaN(n)) return String(m.value)
  if (spec.startsWith("rate:")) return (n * 100).toFixed(1) + "%"
  if (spec === "count" || Number.isInteger(n)) return n.toLocaleString()
  return n.toFixed(2)
}

const AggregateCommand = cmd({
  command: "aggregate",
  aliases: ["agg"],
  describe: "grouped metrics over a dataset — avg / median / rate / sum per group",
  builder: (y) =>
    y
      .option("schema", { type: "string", demandOption: true, alias: "s", describe: "dataset slug" })
      .option("group-by", { type: "string", alias: "g", describe: "field (or derived field) to group by; omit for a grand total" })
      .option("metrics", {
        type: "string",
        alias: "m",
        default: "count",
        describe: "comma-separated: count, avg:Field, sum:Field, min:Field, max:Field, median:Field, rate:Field=Value",
      })
      .option("filter", {
        type: "array",
        alias: "f",
        default: [] as string[],
        describe: 'repeatable — "Outcome=Won", "Scope[in]=TXDOT,Lift Station", "Bid Date[gte]=2024-01-01"',
      })
      .option("min-sample", { type: "number", describe: "withhold metrics for groups smaller than this (server-side)" })
      .option("bloq", { type: "number", describe: "scope to a bloq id" })
      .option("json", { type: "boolean", default: false })
      .example('$0 datasets aggregate -s cci-bid-history -g "Zone ID" -m "avg:Estimated Margin,count"', "average margin per zone")
      .example('$0 datasets aggregate -s cci-bid-history -m "rate:Outcome=Won" -f "Outcome[in]=Won,Lost"', "win rate over decided bids")
      .example('$0 datasets aggregate -s cci-bid-history -g size_band -m "avg:Estimated Margin"', "margin by derived size band"),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Aggregate: ${args.schema}`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }

    const p = new URLSearchParams()
    if (args["group-by"]) p.set("group_by", String(args["group-by"]))
    if (args.metrics) p.set("metrics", String(args.metrics))
    if (args["min-sample"] != null) p.set("min_sample", String(args["min-sample"]))
    if (args.bloq != null) p.set("bloq_id", String(args.bloq))

    for (const raw of (args.filter as string[]) ?? []) {
      const err = applyFilterToken(p, String(raw))
      if (err) { console.log(`  ${err}`); prompts.outro("Done"); return }
    }

    const res = await irisFetch(`/api/v1/atlas/datasets/${args.schema}/aggregate?${p}`)
    // The endpoint is fail-loud by design (unknown field, non-numeric metric -> 422).
    // Surface that reason rather than printing an empty table, which reads as "no data".
    const ok = await handleApiError(res, "Aggregate"); if (!ok) { prompts.outro("Done"); return }
    const data = ((await res.json()) as any)?.data

    if (args.json) { await writeJson(data); prompts.outro("Done"); return }

    const groups: any[] = data?.groups ?? []
    const specs: string[] = [...new Set(groups.flatMap((g: any) => Object.keys(g.metrics ?? {})))] as string[]

    printDivider()
    console.log(`  ${bold("Records")}   ${(data?.total_records ?? 0).toLocaleString()}`)
    if (data?.group_by) console.log(`  ${bold("Grouped")}   ${data.group_by}`)
    if (data?.min_sample) console.log(`  ${bold("Min n")}     ${data.min_sample} ${dim("(metrics withheld below this)")}`)
    printDivider()

    if (groups.length === 0) {
      console.log(`  ${dim("No groups matched.")}`)
    } else {
      const keyW = Math.max(12, ...groups.map((g: any) => String(g.key ?? "—").length))
      console.log(
        `  ${bold((data?.group_by ? "Group" : "All").padEnd(keyW))}  ${bold("n".padStart(7))}` +
          specs.map((s) => "  " + bold(metricHeader(s).padStart(16))).join(""),
      )
      for (const g of groups) {
        const label = String(g.key ?? "—")
        const row =
          `  ${label.padEnd(keyW)}  ${String(g.count).padStart(7)}` +
          specs.map((s) => "  " + fmtMetric(s, g.metrics?.[s]).padStart(16)).join("")
        // Suppressed groups keep their count and lose their metrics — show them dimmed
        // rather than hiding them, since a vanished group reads as "no work here".
        console.log(g.suppressed ? dim(row + "  (below sample)") : row)
      }
      // A per-metric n below the group count means the metric covers fewer rows than the
      // group holds — the only signal that a number is thin, so never drop it.
      const thin = groups.flatMap((g: any) =>
        specs
          .filter((s) => g.metrics?.[s]?.n != null && Number(g.metrics[s].n) !== Number(g.count))
          .map((s) => `${g.key ?? "all"}/${s}: n=${g.metrics[s].n} of ${g.count}`),
      )
      if (thin.length) {
        printDivider()
        console.log(`  ${dim("Partial coverage (metric n < group size):")}`)
        for (const t of thin.slice(0, 8)) console.log(`    ${dim(t)}`)
        if (thin.length > 8) console.log(`    ${dim(`… ${thin.length - 8} more`)}`)
      }
    }

    if (data?.groups_truncated) {
      printDivider()
      console.log(`  ${bold("Truncated")} — more than ${data.max_groups} groups; narrow the grouping.`)
    }
    printDivider()
    prompts.outro("Done")
  },
})

// ── DERIVE ───────────────────────────────────────────────────────────────────

const DeriveCommand = cmd({
  command: "derive",
  describe: "materialize a dataset's computed dimensions (zones) so they can be grouped",
  builder: (y) =>
    y
      .option("schema", { type: "string", demandOption: true, alias: "s", describe: "dataset slug" })
      .option("field", { type: "array", default: [] as string[], describe: "limit to specific derived keys" })
      .option("force", { type: "boolean", default: false, describe: "re-resolve rows that already have a value" })
      .option("json", { type: "boolean", default: false })
      .example("$0 datasets derive -s cci-bid-history --field zone_id", "resolve coordinates to boundary zones"),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Derive: ${args.schema}`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }

    const res = await irisFetch(`/api/v1/atlas/datasets/${args.schema}/derive`, {
      method: "POST",
      body: JSON.stringify({ fields: (args.field as string[]) ?? [], force: Boolean(args.force) }),
    })
    const ok = await handleApiError(res, "Derive"); if (!ok) { prompts.outro("Done"); return }
    const data = ((await res.json()) as any)?.data

    if (args.json) { await writeJson(data); prompts.outro("Done"); return }

    printDivider()
    const results: any[] = data?.results ?? []
    if (results.length === 0) {
      console.log(`  ${dim("No derived dimensions on this schema.")}`)
    }
    for (const r of results) {
      if (r.inline) {
        console.log(`  ${bold(r.key)}  ${dim(`(${r.type}) inline — computed at query time, nothing to materialize`)}`)
        continue
      }
      console.log(`  ${bold(r.key)}  ${dim(`(${r.type})`)}  ${r.resolved} resolved, ${r.unmatched} unmatched of ${r.considered}`)
      // Unmatched rows are the interesting number: coordinates outside every polygon mean a
      // wrong boundary set or genuinely out-of-area data, and they group as "no zone".
      if (r.unmatched > 0) {
        const pct = ((r.unmatched / Math.max(1, r.considered)) * 100).toFixed(1)
        console.log(`    ${bold("!")} ${r.unmatched} (${pct}%) matched no zone — check the boundary set covers this data.`)
      }
    }
    printDivider()
    prompts.outro("Done")
  },
})

// ── ECONOMICS ────────────────────────────────────────────────────────────────
//
// How a dataset rolls up money, and what the expandable rows on the CaseEconomics
// dashboard card drill into. The rule is field-agnostic: a dataset says which key
// groups its rows, which holds the value, and an ORDERED list of breakdown
// dimensions. Order matters — it is a fallback chain, and the first dimension that
// actually splits a group wins.

export type EconDimension = { type: "field" | "list" | "age"; field: string; emptyLabel?: string; buckets?: number[] }

/**
 * Parse `--breakdown` into dimensions. Forms, comma-separated:
 *   law_firm                       → field
 *   list:service_providers         → multi-value (a record is split across its values)
 *   age:referral_date:30/90/180    → day buckets
 */
export function parseBreakdown(input?: string): EconDimension[] {
  if (!input) return []
  return input.split(",").map((raw) => {
    const part = raw.trim()
    if (!part) return null
    const [head, ...rest] = part.split(":")
    const kind = head.trim().toLowerCase()
    if (kind === "list") return { type: "list", field: (rest[0] ?? "").trim() } as EconDimension
    if (kind === "age") {
      const buckets = (rest[1] ?? "").split("/").map((n) => parseInt(n.trim(), 10)).filter((n) => Number.isFinite(n) && n > 0)
      const dim: EconDimension = { type: "age", field: (rest[0] ?? "").trim() }
      if (buckets.length) dim.buckets = buckets
      return dim
    }
    // Bare field name (or explicit `field:` prefix).
    return { type: "field", field: (kind === "field" ? (rest[0] ?? "") : part).trim() } as EconDimension
  }).filter((d): d is EconDimension => d !== null && d.field !== "")
}

function printEconomics(spec: any, defaults: any, configured: boolean) {
  const effective = configured ? spec : defaults
  printDivider()
  if (!configured) {
    console.log(`  ${dim("Not configured — showing the built-in default this dataset falls back to.")}`)
  }
  console.log(`  ${dim("Group rows by:")} ${effective?.groupBy ?? dim("—")}`)
  console.log(`  ${dim("Sum value in:")}  ${effective?.valueBy ?? dim("—")}`)
  console.log(`  ${dim("Count noun:")}    ${effective?.countNoun ?? "case"}`)
  if (effective?.title) console.log(`  ${dim("Card title:")}    ${effective.title}`)
  if (effective?.totalLabel) console.log(`  ${dim("Total label:")}   ${effective.totalLabel}`)
  console.log(`  ${bold("Breakdown (tried in order):")}`)
  const dims: EconDimension[] = effective?.breakdown ?? []
  if (!dims.length) console.log(`    ${dim("none — rows will not expand")}`)
  for (const [i, d] of dims.entries()) {
    const extra = d.type === "age" && d.buckets?.length ? dim(` buckets ${d.buckets.join("/")} days`) : ""
    const empty = d.emptyLabel ? dim(` empty→"${d.emptyLabel}"`) : ""
    console.log(`    ${i + 1}. ${bold(d.field)} ${dim(`(${d.type})`)}${extra}${empty}`)
  }
  printDivider()
}

const EconomicsShowCommand = cmd({
  command: "show <slug>",
  describe: "show a dataset's economics roll-up config",
  builder: (y) => y.positional("slug", { type: "string", demandOption: true }).option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Economics: ${args.slug}`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }

    const res = await irisFetch(`/api/v1/atlas/datasets/${args.slug}/economics`)
    const ok = await handleApiError(res, "Show economics"); if (!ok) { prompts.outro("Done"); return }
    const body = (await res.json()) as any

    if (args.json) { await writeJson(body); prompts.outro("Done"); return }
    printEconomics(body?.economics, body?.defaults, Boolean(body?.configured))
    prompts.outro("Done")
  },
})

const EconomicsSetCommand = cmd({
  command: "set <slug>",
  describe: "set how a dataset rolls up and breaks down",
  builder: (y) =>
    y.positional("slug", { type: "string", demandOption: true })
      .option("group-by", { type: "string", describe: "field whose value becomes each row (e.g. stage_name)" })
      .option("value-by", { type: "string", describe: "numeric field to total per row (e.g. invoice_total)" })
      .option("count-noun", { type: "string", describe: 'pluralised in labels — "case" → "12 cases"' })
      .option("title", { type: "string", describe: "card title" })
      .option("total-label", { type: "string", describe: "label on the total row" })
      .option("breakdown", {
        type: "string",
        describe: 'ordered dimensions: "law_firm,list:service_providers,age:referral_date:30/90/180"',
      })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Economics: ${args.slug}`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }

    const economics: Record<string, unknown> = {}
    if (args["group-by"]) economics.groupBy = args["group-by"]
    if (args["value-by"]) economics.valueBy = args["value-by"]
    if (args["count-noun"]) economics.countNoun = args["count-noun"]
    if (args.title) economics.title = args.title
    if (args["total-label"]) economics.totalLabel = args["total-label"]
    const dims = parseBreakdown(args.breakdown as string | undefined)
    if (dims.length) economics.breakdown = dims

    if (Object.keys(economics).length === 0) {
      // Sending {} would clear the config, which `reset` already does explicitly. Saying
      // nothing should never silently wipe a client's setup.
      console.log(`  ${bold("!")} Nothing to set. Pass at least one option, or use ${bold("economics reset")} to clear.`)
      prompts.outro("Done")
      return
    }

    const res = await irisFetch(`/api/v1/atlas/datasets/${args.slug}/economics`, {
      method: "PATCH",
      body: JSON.stringify({ economics }),
    })
    const ok = await handleApiError(res, "Set economics"); if (!ok) { prompts.outro("Done"); return }
    const body = (await res.json()) as any

    if (args.json) { await writeJson(body); prompts.outro("Done"); return }
    console.log(`  ${bold("✓")} Saved.`)
    printEconomics(body?.economics, body?.defaults, Boolean(body?.configured))
    prompts.outro("Done")
  },
})

const EconomicsResetCommand = cmd({
  command: "reset <slug>",
  describe: "clear the config and fall back to the built-in default",
  builder: (y) =>
    y.positional("slug", { type: "string", demandOption: true })
      .option("force", { alias: "y", type: "boolean", default: false, describe: "skip confirmation" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Economics reset: ${args.slug}`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }

    if (!args.force && !isNonInteractive()) {
      const go = await prompts.confirm({ message: `Clear the economics config for "${args.slug}"?` })
      if (!go || prompts.isCancel(go)) { prompts.outro("Cancelled"); return }
    }

    const res = await irisFetch(`/api/v1/atlas/datasets/${args.slug}/economics`, {
      method: "PATCH",
      body: JSON.stringify({ economics: null }),
    })
    const ok = await handleApiError(res, "Reset economics"); if (!ok) { prompts.outro("Done"); return }
    const body = (await res.json()) as any
    console.log(`  ${bold("✓")} Cleared — this dataset now uses the built-in default.`)
    printEconomics(body?.economics, body?.defaults, Boolean(body?.configured))
    prompts.outro("Done")
  },
})

const EconomicsGroup = cmd({
  command: "economics",
  aliases: ["econ"],
  describe: "how a dataset rolls up money and what its rows expand into",
  builder: (y) => y.command(EconomicsShowCommand).command(EconomicsSetCommand).command(EconomicsResetCommand).demandCommand(),
  async handler() {},
})

export const PlatformAtlasDatasetsCommand = cmd({
  command: "atlas:datasets",
  aliases: ["atlas-datasets", "datasets"],
  describe: "Schema-driven datasets — define once, store anything, no migrations",
  builder: (y) =>
    y.command(SchemasGroup).command(RecordsGroup).command(ImportCommand).command(AggregateCommand).command(DeriveCommand)
     .command(FeedsGroup).command(ExportCommand).command(AuditCommand).command(ApiCommand).command(EconomicsGroup).demandCommand(),
  async handler() {},
})
