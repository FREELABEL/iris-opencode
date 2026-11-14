import * as fs from "fs"
import * as path from "path"
import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, printDivider, dim, bold, success } from "./iris-api"
import {
  IMPORT_FIELDS,
  IMPORT_MAX_ROWS,
  buildLeads,
  chunk,
  parseMapArgs,
  parseSetArgs,
  planMapping,
  readLeadFile,
  unwrapImportResponse,
  type RowError,
} from "./leads-import"

// ============================================================================
// iris leads import <file> --board <id> (#193513)
//
// 969 Apollo people meant 969 `leads create` calls with no preview and no undo. This sends a
// CSV or JSON file to POST /api/v1/leads/import in chunks of <=1000, keyed on external_id so a
// re-run merges instead of duplicating (#193511), with a dry run that writes nothing.
// ============================================================================

export type ImportSummary = {
  file: string
  board: number
  dry_run: boolean
  rows: number
  sent: number
  created: number
  merged: number
  failed: { row: number; line?: number; error: string }[]
  ids: unknown[]
  /** Set when a chunk was refused as a whole; rows from that chunk on were not sent. */
  stopped?: string
  columns: Record<string, string>
  unused_columns: string[]
}

function errText(e: unknown): string {
  if (typeof e === "string") return e
  if (Array.isArray(e)) return e.map(errText).join("; ")
  if (e && typeof e === "object") {
    const o = e as Record<string, unknown>
    if (typeof o.message === "string") return o.message
    return Object.entries(o)
      .map(([k, v]) => `${k}: ${errText(v)}`)
      .join("; ")
  }
  return String(e)
}

export const LeadsImportCommand = cmd({
  command: "import <file>",
  describe: "bulk import leads from a CSV or JSON file — re-running merges on external_id instead of duplicating",
  builder: (yargs) =>
    yargs
      .positional("file", { describe: "a .csv (header row) or .json (array of leads) file", type: "string", demandOption: true })
      .option("board", { alias: ["bloq-id", "bloq"], describe: "board (bloq) the leads belong to", type: "number", demandOption: true })
      .option("dry-run", { describe: "send with dry_run=true: the server reports what it WOULD create/merge and writes nothing", type: "boolean", default: false })
      .option("map", {
        describe: `column=field, repeatable (fields: ${IMPORT_FIELDS.join(", ")}). A column named like a field is read without one.`,
        type: "string",
        array: true,
      })
      .option("set", { describe: "field=value for every row that has none, repeatable (e.g. source=apollo)", type: "string", array: true })
      .option("external-id-prefix", { describe: "prefix for ids that have none (an apollo_id column gets apollo: automatically)", type: "string" })
      .option("json", { describe: "JSON output (the totals and every failed row)", type: "boolean", default: false })
      .example(
        "$0 leads import terra-leads.csv --board 746 --map apollo_id=external_id --set source=apollo --set segment=contractors-tx --dry-run",
        "Apollo export: first_name + last_name_hint become the name (marked not verified when the hint has *), apollo_id becomes external_id apollo:<id>, product terra becomes iris-terra",
      )
      .example("$0 leads import people.json --board 746 --map 'Job Title=title' --map 'Full Name=name'", "rename columns"),
  async handler(args) {
    const isJson = args.json === true
    const dryRun = Boolean(args["dry-run"])
    const file = String(args.file)
    const board = Number(args.board)

    const fail = (message: string, extra?: Record<string, unknown>) => {
      if (isJson) process.stdout.write(JSON.stringify({ success: false, error: message, ...(extra ?? {}) }) + "\n")
      else {
        prompts.log.error(message)
        prompts.outro("Failed")
      }
      process.exitCode = 1
    }

    if (!isJson) {
      UI.empty()
      prompts.intro(`◈  Import leads → board ${board}${dryRun ? "  (dry run)" : ""}`)
    }
    if (!Number.isInteger(board) || board <= 0) return fail(`--board must be a board id (got ${JSON.stringify(args.board)})`)
    if (!fs.existsSync(file)) return fail(`File not found: ${file}`)

    const mapArg = parseMapArgs(args.map as unknown[] | undefined)
    if (!mapArg.ok) return fail(mapArg.error)
    const setArg = parseSetArgs(args.set as unknown[] | undefined)
    if (!setArg.ok) return fail(setArg.error)

    const read = readLeadFile(file)
    if (!read.ok) return fail(read.error)
    const missingCols = Object.keys(mapArg.map).filter((c) => !read.columns.includes(c))
    if (missingCols.length) return fail(`--map names column(s) the file does not have: ${missingCols.join(", ")} (columns: ${read.columns.join(", ")})`)

    const plan = planMapping(read.columns, mapArg.map, { externalIdPrefix: args["external-id-prefix"] as string | undefined })
    const built = buildLeads(read.rows, plan, setArg.set)

    const summary: ImportSummary = {
      file: path.basename(file),
      board,
      dry_run: dryRun,
      rows: read.rows.length,
      sent: 0,
      created: 0,
      merged: 0,
      failed: [...built.errors],
      ids: [],
      columns: { ...plan.columns, ...(plan.apolloName ? { "first_name + last_name_hint": "name" } : {}) },
      unused_columns: plan.unused,
    }

    if (!isJson) {
      console.log(`  ${bold("Parsed")}     ${read.rows.length} row(s) from ${path.basename(file)}`)
      for (const [col, field] of Object.entries(summary.columns)) console.log(`  ${dim(`${col} → ${field}`)}`)
      if (plan.externalIdPrefix) console.log(`  ${dim(`external ids without a prefix get "${plan.externalIdPrefix}"`)}`)
      for (const [f, v] of Object.entries(setArg.set)) console.log(`  ${dim(`${f} = ${JSON.stringify(v)} (every row without one)`)}`)
      if (plan.unused.length) console.log(`  ${dim(`not imported: ${plan.unused.join(", ")}`)}`)
      if (!Object.values(plan.columns).includes("external_id")) {
        prompts.log.warn("No external_id column — a re-run of this file will create duplicates. Map one: --map <col>=external_id")
      }
      const unverified = built.leads.filter((l) => l.name_verified === false).length
      if (unverified) console.log(`  ${dim(`${unverified} name(s) are partly hidden and will be saved as NOT verified`)}`)
      if (built.errors.length) console.log(`  ${dim(`${built.errors.length} row(s) refused before sending (listed below)`)}`)
    }

    if (built.leads.length > 0) {
      const token = await requireAuth()
      if (!token) {
        if (!isJson) prompts.outro("Failed")
        process.exitCode = 1
        return
      }

      const chunks = chunk(built.leads, IMPORT_MAX_ROWS)
      const spinner = isJson ? null : prompts.spinner()
      let offset = 0
      for (let c = 0; c < chunks.length; c++) {
        const slice = chunks[c]
        spinner?.start(`${dryRun ? "Checking" : "Importing"} chunk ${c + 1}/${chunks.length} (${slice.length} rows)…`)
        let res: Response
        try {
          res = await irisFetch("/api/v1/leads/import", {
            method: "POST",
            body: JSON.stringify({ bloq_id: board, dry_run: dryRun, leads: slice }),
          })
        } catch (e) {
          spinner?.stop("Error", 1)
          summary.stopped = `chunk ${c + 1}/${chunks.length}: ${e instanceof Error ? e.message : String(e)}`
          break
        }
        if (!res.ok) {
          spinner?.stop("Failed", 1)
          // Stop rather than press on: a total that mixes written and unwritten rows is how a
          // list ends up half-imported and trusted.
          if (res.status === 404) summary.stopped = `chunk ${c + 1}/${chunks.length}: the server has no /api/v1/leads/import (HTTP 404) — it needs the fl-api release that adds it`
          else {
            const body = (await res.clone().json().catch(() => null)) as any
            if (!isJson) await handleApiError(res, `Import chunk ${c + 1}/${chunks.length}`)
            summary.stopped = `chunk ${c + 1}/${chunks.length}: HTTP ${res.status}${body?.message ? ` — ${body.message}` : ""}`
          }
          break
        }
        const r = unwrapImportResponse(await res.json().catch(() => ({})))
        if (r.dry_run !== undefined && Boolean(r.dry_run) !== dryRun) {
          // Never report a dry run that wrote, or a write that did not, as the other.
          spinner?.stop("Failed", 1)
          summary.stopped = `the server answered dry_run=${r.dry_run} to a request with dry_run=${dryRun} — stopping`
          break
        }
        summary.sent += slice.length
        summary.created += Number(r.created ?? 0)
        summary.merged += Number(r.merged ?? 0)
        if (Array.isArray(r.ids)) summary.ids.push(...r.ids)
        for (const f of Array.isArray(r.failed) ? r.failed : []) {
          const i = offset + Number(f?.index)
          summary.failed.push({
            row: Number.isFinite(i) && built.rowOf[i] !== undefined ? built.rowOf[i] : -1,
            line: Number.isFinite(i) ? built.lineOf[i] : undefined,
            error: errText(f?.error),
          })
        }
        const accounted = Number(r.created ?? 0) + Number(r.merged ?? 0) + (Array.isArray(r.failed) ? r.failed.length : 0)
        if (accounted !== slice.length) {
          summary.stopped = `chunk ${c + 1}/${chunks.length}: sent ${slice.length} rows but the server accounted for ${accounted} (created + merged + failed) — read the board back before trusting this`
          spinner?.stop("Mismatch", 1)
          break
        }
        spinner?.stop(`chunk ${c + 1}/${chunks.length}: ${r.created ?? 0} new, ${r.merged ?? 0} merged, ${Array.isArray(r.failed) ? r.failed.length : 0} failed`)
        offset += slice.length
      }
    }

    summary.failed.sort((a, b) => a.row - b.row)
    const notSent = built.leads.length - summary.sent
    const bad = summary.failed.length > 0 || !!summary.stopped || built.leads.length === 0

    if (isJson) {
      process.stdout.write(JSON.stringify({ success: !bad, ...summary, not_sent: notSent }, null, 2) + "\n")
      if (bad) process.exitCode = 1
      return
    }

    printDivider()
    if (dryRun) console.log(`  ${bold("DRY RUN — nothing was written.")} ${dim("These are the server's counts for what a real run would do.")}`)
    console.log(`  ${bold(dryRun ? "Would create" : "Created")}  ${summary.created}`)
    console.log(`  ${bold(dryRun ? "Would merge " : "Merged ")}  ${summary.merged} ${dim("(matched an existing external_id on this board)")}`)
    console.log(`  ${bold("Failed")}       ${summary.failed.length}`)
    for (const f of summary.failed.slice(0, 20)) {
      console.log(`    ${dim(`row ${f.row}${f.line ? ` (line ${f.line})` : ""}: ${f.error}`)}`)
    }
    if (summary.failed.length > 20) console.log(`    ${dim(`… ${summary.failed.length - 20} more (--json lists every one)`)}`)
    if (notSent > 0) console.log(`  ${bold("Not sent")}     ${notSent} ${dim("(after the stop below)")}`)
    printDivider()

    if (summary.stopped) prompts.log.error(`Stopped at ${summary.stopped}`)
    if (built.leads.length === 0) prompts.log.error("No row could be imported.")
    if (bad) {
      prompts.outro("Failed")
      process.exitCode = 1
      return
    }
    prompts.outro(
      dryRun
        ? `${success("✓")} Looks good. Run it for real: drop --dry-run`
        : `${success("✓")} ${dim(`iris leads list --bloq-id ${board} --all`)}`,
    )
  },
})
