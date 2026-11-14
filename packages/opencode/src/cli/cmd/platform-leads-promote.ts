// ============================================================================
// iris leads promote — staged Apollo prospects → CRM leads (#193515)
// ============================================================================
//
//   iris leads promote --from product-leads --bloq 746 \
//     --where 'product=iris-terra,fit=strong' --per-company 3 --limit 150 --dry-run
//
// Reads the dataset, picks up to N people per company (best companies first),
// and prints exactly who would be promoted and how many Apollo credits that
// would spend. The decisions live in leads-promote-core.ts (pure, tested).
//
// WHAT RUNS TODAY: --dry-run only. A real run needs two things that are being
// built in parallel and are not merged yet:
//   - lead fields `external_id`, `title`, `product`, `segment`, `name_verified`
//     and POST /api/v1/leads/import (backend)
//   - the import client used by `iris leads import` (this repo)
// Until then `importer` is UnavailableImporter and a non-dry run refuses before
// it reads anything or spends anything. No code path here calls enrich_person.

import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { requireAuth, dim, bold, writeJson } from "./iris-api"
import { fetchDatasetRecords } from "./platform-atlas-datasets"
import { formatPlan, parseWhere, planJson, planPromotion, rowMatches, type DatasetRow, type PlanOptions } from "./leads-promote-core"

// ── seams (filled in when the import PR lands) ───────────────────────────────

export interface ImportLead {
  external_id: string
  name: string
  email: string | null
  company: string | null
  title: string | null
  product: string | null
  segment: string | null
  name_verified: boolean
}

export interface LeadImporter {
  /** external_id → lead id for the ids that already have a lead. null = cannot check yet. */
  existingExternalIds(ids: string[]): Promise<Map<string, number> | null>
  /** Upsert by external_id. Returns external_id → lead id. */
  importLeads(leads: ImportLead[]): Promise<Map<string, number>>
}

export interface PersonEnricher {
  /** ONE paid Apollo call (enrich_person id=<apolloId>). Never called in a dry run. */
  enrich(apolloId: string): Promise<{ first_name?: string; last_name?: string; email?: string | null; raw?: unknown }>
}

export const IMPORT_PENDING =
  "waiting on POST /api/v1/leads/import (+ lead external_id) — the backend and `iris leads import` PRs for #193515's parent work are not merged yet"

/** Stand-in until the import endpoint ships. Lookups report "not checked"; imports refuse. */
export class UnavailableImporter implements LeadImporter {
  async existingExternalIds(): Promise<null> {
    return null
  }
  async importLeads(): Promise<Map<string, number>> {
    throw new Error(`leads import is not available: ${IMPORT_PENDING}`)
  }
}

// ── command ──────────────────────────────────────────────────────────────────

export const LeadsPromoteCommand = cmd({
  command: "promote",
  describe: "promote staged Apollo prospects from an Atlas dataset into CRM leads — per company, credit-capped (dry run today)",
  builder: (y) =>
    y
      .option("from", { type: "string", default: "product-leads", describe: "dataset slug holding the staged prospects" })
      .option("bloq", { type: "number", describe: "board the dataset lives on (product-leads: 746)" })
      .option("where", { type: "string", describe: "row filter: key=value, commas AND, | OR, != negates (e.g. 'product=iris-terra,fit=strong')" })
      .option("per-company", { type: "number", default: 3, describe: "max people per company (#193518: go deep, 3+)" })
      .option("limit", { type: "number", default: 150, describe: "max companies (best first)" })
      .option("enrich", { type: "boolean", default: false, describe: "allowed to spend Apollo credits (enrich_person) to reveal email + full name" })
      .option("max-credits", { type: "number", describe: "hard cap on Apollo credits this run may spend (required with --enrich)" })
      .option("include-no-email", { type: "boolean", default: false, describe: "also enrich people Apollo marks has_email=false (usually a credit for nothing)" })
      .option("dry-run", { type: "boolean", default: false, describe: "print the plan and the exact credit count; change nothing" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    const perCompany = Number(args["per-company"])
    const limit = Number(args.limit)
    const maxCredits = args["max-credits"] === undefined ? undefined : Number(args["max-credits"])
    const fail = (msg: string) => {
      if (args.json) void writeJson({ ok: false, error: msg })
      else prompts.log.error(msg)
      process.exitCode = 1
    }

    if (!Number.isInteger(perCompany) || perCompany < 1) return fail("--per-company must be a whole number ≥ 1")
    if (!Number.isInteger(limit) || limit < 1) return fail("--limit must be a whole number ≥ 1")
    if (maxCredits !== undefined && (!Number.isInteger(maxCredits) || maxCredits < 0)) return fail("--max-credits must be a whole number ≥ 0")
    // The cost gate: a run that can spend must say how much it may spend.
    if (args.enrich && maxCredits === undefined && !args["dry-run"]) {
      return fail("--enrich spends Apollo credits: pass --max-credits N (see the count with --dry-run first)")
    }
    if (!args["dry-run"]) {
      return fail(`only --dry-run works today: ${IMPORT_PENDING}`)
    }

    let where
    try {
      where = parseWhere(args.where)
    } catch (e) {
      return fail((e as Error).message)
    }

    if (!args.json) {
      UI.empty()
      prompts.intro(`◈  ${bold("leads promote")} ${dim(`(dry run) ${args.from}${args.bloq ? ` · bloq ${args.bloq}` : ""}`)}`)
    }
    const token = await requireAuth()
    if (!token) return

    const spinner = args.json ? null : prompts.spinner()
    spinner?.start(`Reading ${args.from}…`)
    let rows: DatasetRow[]
    try {
      const { records } = await fetchDatasetRecords(String(args.from), { limit: 200, all: true, bloq: args.bloq })
      rows = records.map((r: any) => ({ id: Number(r.id), external_id: r.external_id ?? null, data: r.data ?? {} }))
    } catch (e) {
      spinner?.stop("Failed", 1)
      return fail((e as Error).message)
    }
    const matched = rows.filter((r) => rowMatches(r, where))
    spinner?.stop(`${rows.length} rows · ${matched.length} match`)

    const importer: LeadImporter = new UnavailableImporter()
    const existing = await importer.existingExternalIds(matched.map((r) => String(r.external_id ?? "")))
    const opts: PlanOptions = {
      perCompany,
      limit,
      enrich: !!args.enrich,
      maxCredits,
      includeNoEmail: !!args["include-no-email"],
    }
    const plan = planPromotion(matched, opts, new Set(existing ? existing.keys() : []))

    if (args.json) {
      await writeJson({ ok: true, dry_run: true, crm_duplicate_check: existing ? "checked" : "pending_import_endpoint", ...planJson(plan, opts) })
      return
    }
    for (const line of formatPlan(plan, opts)) console.log(line)
    console.log()
    if (!existing) prompts.log.warn(`CRM duplicate check by external_id not run: ${IMPORT_PENDING}. Rows with crm_lead_id were still skipped.`)
    prompts.outro("Dry run — nothing was enriched, imported or written.")
  },
})
