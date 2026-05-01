import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, dim, bold } from "./iris-api"
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

      if (args.json) { console.log(JSON.stringify(rows, null, 2)); prompts.outro("Done"); return }
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

    if (args.json) { console.log(JSON.stringify(body?.data, null, 2)); prompts.outro("Done"); return }

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
      .option("fields", { type: "string", describe: "JSON fields definition or path to .json file" }),
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

    const body: Record<string, any> = { name: args.name, fields }
    if (args.slug) body.slug = args.slug
    if (args.bloq != null) body.bloq_id = args.bloq

    const spinner = prompts.spinner()
    spinner.start("Creating…")
    try {
      const res = await irisFetch("/api/v1/atlas/schemas", { method: "POST", body: JSON.stringify(body) })
      const ok = await handleApiError(res, "Create schema"); if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }
      const data = ((await res.json()) as any)?.data
      spinner.stop(`Created: ${bold(data?.slug ?? args.name)}`)
      prompts.outro(`iris atlas:datasets records list --schema=${data?.slug ?? args.name}`)
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const SchemasGroup = cmd({
  command: "schemas",
  aliases: ["schema"],
  describe: "manage dataset schemas",
  builder: (y) => y.command(SchemaListCommand).command(SchemaShowCommand).command(SchemaCreateCommand).demandCommand(),
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
      .option("filter", { type: "string", describe: "field=value filter (repeatable)", array: true })
      .option("search", { type: "string", describe: "full-text search" })
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

      if (args.json) { console.log(JSON.stringify(records, null, 2)); prompts.outro("Done"); return }
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

    if (args.json) { console.log(JSON.stringify(record, null, 2)); prompts.outro("Done"); return }

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

    if (args.json) { console.log(JSON.stringify(data, null, 2)); prompts.outro("Done"); return }

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

      // Get all records
      const p = new URLSearchParams({ per_page: String(args.limit) })
      const res = await irisFetch(`/api/v1/atlas/datasets/${args.schema}?${p}`)
      const ok = await handleApiError(res, "List records"); if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }
      const body = (await res.json()) as any
      const records: any[] = body?.data?.records?.data ?? body?.data?.records ?? []
      spinner.stop(`${records.length} record(s)`)

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

      // Get records
      const p = new URLSearchParams({ per_page: String(args.limit) })
      const res = await irisFetch(`/api/v1/atlas/datasets/${args.schema}?${p}`)
      const ok = await handleApiError(res, "List records"); if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }
      const body = (await res.json()) as any
      const records: any[] = body?.data?.records?.data ?? body?.data?.records ?? []
      spinner.stop(`${records.length} record(s) to audit`)

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

      if (args.json) { console.log(JSON.stringify({ total_records: records.length, flags_count: flags.length, flags }, null, 2)); prompts.outro("Done"); return }

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
      .option("schema", { type: "string", demandOption: true, alias: "s" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Delete Record #${args.id}`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }

    const confirm = await prompts.confirm({ message: `Delete record #${args.id}?` })
    if (prompts.isCancel(confirm) || !confirm) { prompts.outro("Cancelled"); return }

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
    y.command(RecordsListCommand).command(RecordsShowCommand).command(RecordsSummaryCommand)
     .command(RecordsAddCommand).command(RecordsUpdateCommand).command(RecordsDeleteCommand)
     .command(RecordsUpsertCommand).demandCommand(),
  async handler() {},
})

export const PlatformAtlasDatasetsCommand = cmd({
  command: "atlas:datasets",
  aliases: ["atlas-datasets", "datasets"],
  describe: "Schema-driven datasets — define once, store anything, no migrations",
  builder: (y) =>
    y.command(SchemasGroup).command(RecordsGroup).command(ExportCommand).command(AuditCommand).demandCommand(),
  async handler() {},
})
