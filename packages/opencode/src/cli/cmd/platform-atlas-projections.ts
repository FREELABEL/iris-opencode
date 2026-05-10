import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, dim, bold } from "./iris-api"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { resolve } from "path"

const ATLAS_DIR = resolve(process.cwd(), "atlas")

function projectionsPath(bloqId: string): string {
  return resolve(ATLAS_DIR, `${bloqId}-projections.json`)
}

function printDivider() { console.log(dim("  " + "-".repeat(72))) }
function printKV(label: string, value: string | number | null | undefined) {
  console.log(`  ${dim(label + ":")} ${value ?? dim("--")}`)
}

function fmtDollars(n?: number | null): string {
  if (n == null) return dim("--")
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

// ── Pull ────────────────────────────────────────────────────────────────────

const ProjPullCommand = cmd({
  command: "pull <bloq-id>",
  describe: "download projections to local ./atlas/<bloq-id>-projections.json",
  builder: (yargs) =>
    yargs
      .positional("bloq-id", { describe: "bloq ID", type: "number", demandOption: true })
      .option("output", { alias: "o", describe: "custom output path", type: "string" }),
  async handler(args) {
    UI.empty()
    const bloqId = args["bloq-id"] as number
    prompts.intro(`Atlas Projections -- Pull (bloq ${bloqId})`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Fetching...")
    try {
      const res = await irisFetch(`/api/v1/atlas/${bloqId}/projections`)
      const ok = await handleApiError(res, "Get projections"); if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }
      const body = (await res.json()) as any
      const doc = body?.data ?? body

      if (!doc || Object.keys(doc).length === 0) {
        spinner.stop("Not found", 1)
        prompts.log.error("No projections exist. Run: iris atlas:projections generate <bloq-id>")
        prompts.outro("Done"); return
      }

      if (!existsSync(ATLAS_DIR)) mkdirSync(ATLAS_DIR, { recursive: true })
      const filepath = args.output ?? projectionsPath(String(bloqId))
      writeFileSync(filepath, JSON.stringify(doc, null, 2) + "\n")
      spinner.stop("Pulled")

      printDivider()
      printKV("Company", doc.company?.name)
      printKV("Revenue (annual)", fmtDollars(doc.revenue?.projected_annual))
      printKV("Confidence", doc.revenue?.confidence)
      printKV("Saved to", filepath)
      printDivider()
      prompts.outro(`${dim(`iris atlas:projections push ${bloqId}`)}  |  ${dim(`iris atlas:projections diff ${bloqId}`)}`)
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

// ── Push ────────────────────────────────────────────────────────────────────

const ProjPushCommand = cmd({
  command: "push <bloq-id>",
  describe: "upload local ./atlas/<bloq-id>-projections.json to API",
  builder: (yargs) =>
    yargs
      .positional("bloq-id", { describe: "bloq ID", type: "number", demandOption: true })
      .option("file", { alias: "f", describe: "local JSON file", type: "string" }),
  async handler(args) {
    UI.empty()
    const bloqId = args["bloq-id"] as number
    prompts.intro(`Atlas Projections -- Push (bloq ${bloqId})`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }

    const filepath = args.file ?? projectionsPath(String(bloqId))
    if (!existsSync(filepath)) {
      prompts.log.error(`Local file not found: ${filepath}`)
      prompts.log.info(`Run first: ${dim(`iris atlas:projections pull ${bloqId}`)}`)
      prompts.outro("Done"); return
    }

    let doc: Record<string, unknown>
    try {
      doc = JSON.parse(readFileSync(filepath, "utf-8"))
    } catch (e) {
      prompts.log.error(`Failed to parse ${filepath}: ${e instanceof Error ? e.message : String(e)}`)
      prompts.outro("Done"); return
    }

    const spinner = prompts.spinner()
    spinner.start("Pushing...")
    try {
      const res = await irisFetch(`/api/v1/atlas/${bloqId}/projections`, {
        method: "PUT",
        body: JSON.stringify(doc),
      })
      const ok = await handleApiError(res, "Push projections"); if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }
      spinner.stop("Pushed")
      prompts.log.success(`Uploaded projections from ${filepath}`)
      prompts.outro(`${dim(`iris atlas:projections estimate ${bloqId}`)}`)
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

// ── Diff ────────────────────────────────────────────────────────────────────

const ProjDiffCommand = cmd({
  command: "diff <bloq-id>",
  describe: "compare local projections with remote API",
  builder: (yargs) =>
    yargs.positional("bloq-id", { describe: "bloq ID", type: "number", demandOption: true }),
  async handler(args) {
    UI.empty()
    const bloqId = args["bloq-id"] as number
    prompts.intro(`Atlas Projections -- Diff (bloq ${bloqId})`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }

    const filepath = projectionsPath(String(bloqId))
    if (!existsSync(filepath)) {
      prompts.log.error(`Local file not found: ${filepath}`)
      prompts.log.info(`Run first: ${dim(`iris atlas:projections pull ${bloqId}`)}`)
      prompts.outro("Done"); return
    }

    const spinner = prompts.spinner()
    spinner.start("Fetching remote...")
    try {
      const res = await irisFetch(`/api/v1/atlas/${bloqId}/projections`)
      const ok = await handleApiError(res, "Get projections"); if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }
      const body = (await res.json()) as any
      const remote = body?.data ?? body

      const local = JSON.parse(readFileSync(filepath, "utf-8"))
      spinner.stop("Fetched")

      const localStr = JSON.stringify(local, null, 2)
      const remoteStr = JSON.stringify(remote, null, 2)

      if (localStr === remoteStr) {
        prompts.log.success("In sync -- no differences")
        prompts.outro("Done"); return
      }

      const localKeys = new Set(Object.keys(local))
      const remoteKeys = new Set(Object.keys(remote))
      const added: string[] = []
      const removed: string[] = []
      const changed: string[] = []

      for (const k of localKeys) {
        if (!remoteKeys.has(k)) added.push(k)
        else if (JSON.stringify(local[k]) !== JSON.stringify(remote[k])) changed.push(k)
      }
      for (const k of remoteKeys) {
        if (!localKeys.has(k)) removed.push(k)
      }

      printDivider()
      if (added.length > 0) console.log(`  ${bold("+ local only:")} ${added.join(", ")}`)
      if (removed.length > 0) console.log(`  ${bold("- remote only:")} ${removed.join(", ")}`)
      if (changed.length > 0) console.log(`  ${bold("~ changed:")} ${changed.join(", ")}`)
      printDivider()
      prompts.outro(`${dim(`iris atlas:projections push ${bloqId}`)}  to apply local  |  ${dim(`iris atlas:projections pull ${bloqId}`)}  to overwrite local`)
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

// ── Generate ────────────────────────────────────────────────────────────────

const ProjGenerateCommand = cmd({
  command: "generate <bloq-id>",
  describe: "scaffold initial projections from lead data + GoodDeals",
  builder: (yargs) =>
    yargs
      .positional("bloq-id", { describe: "bloq ID", type: "number", demandOption: true })
      .option("lead-id", { alias: "l", describe: "lead ID to source data from", type: "number", demandOption: true }),
  async handler(args) {
    UI.empty()
    const bloqId = args["bloq-id"] as number
    const leadId = args["lead-id"] as number
    prompts.intro(`Atlas Projections -- Generate (bloq ${bloqId}, lead ${leadId})`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Generating...")
    try {
      const res = await irisFetch(`/api/v1/atlas/${bloqId}/projections/generate?lead_id=${leadId}`, { method: "POST" })
      const ok = await handleApiError(res, "Generate projections"); if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }
      const body = (await res.json()) as any
      const doc = body?.data ?? body
      spinner.stop("Generated")

      printDivider()
      printKV("Company", doc.company?.name)
      printKV("Revenue streams", (doc.revenue?.streams ?? []).length)
      printKV("Annual revenue (mid)", fmtDollars(doc.forecasts?.annual_revenue?.mid))
      printKV("Confidence", doc.revenue?.confidence)
      printKV("Sources", Object.entries(doc.sources ?? {}).filter(([, v]) => v).map(([k]) => k).join(", "))
      printDivider()
      prompts.outro(`${dim(`iris atlas:projections pull ${bloqId}`)}  |  ${dim(`iris atlas:projections estimate ${bloqId}`)}`)
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

// ── Estimate ────────────────────────────────────────────────────────────────

const ProjEstimateCommand = cmd({
  command: "estimate <bloq-id>",
  describe: "compute pricing recommendation from projections",
  builder: (yargs) =>
    yargs
      .positional("bloq-id", { describe: "bloq ID", type: "number", demandOption: true })
      .option("apply", { describe: "also apply to a custom request (proposal)", type: "number" }),
  async handler(args) {
    UI.empty()
    const bloqId = args["bloq-id"] as number
    prompts.intro(`Atlas Projections -- Estimate (bloq ${bloqId})`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Computing pricing...")
    try {
      const res = await irisFetch(`/api/v1/atlas/${bloqId}/projections/estimate`)
      const ok = await handleApiError(res, "Estimate pricing"); if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }
      const body = (await res.json()) as any
      const rec = body?.data ?? body
      spinner.stop("Estimated")

      printDivider()
      printKV("Tier", rec.tier)
      printKV("Monthly fee", fmtDollars(rec.monthly_fee))
      printKV("Revenue share", rec.revenue_share_pct != null ? `${rec.revenue_share_pct}%` : dim("--"))
      printKV("Readiness modifier", rec.readiness_modifier)
      printKV("Rationale", rec.rationale)
      printDivider()

      if (args.apply != null) {
        spinner.start("Applying to proposal...")
        const applyRes = await irisFetch(`/api/v1/atlas/${bloqId}/projections/apply/${args.apply}`, { method: "POST" })
        const applyOk = await handleApiError(applyRes, "Apply to proposal"); if (!applyOk) { spinner.stop("Failed", 1); prompts.outro("Done"); return }
        spinner.stop("Applied")
        prompts.log.success(`Pricing applied to custom request #${args.apply}`)
      }

      prompts.outro("Done")
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

// ── Export ───────────────────────────────────────────────────────────────────

const ProjExportCommand = cmd({
  command: "export <bloq-id>",
  describe: "export projections as markdown or CSV report",
  builder: (yargs) =>
    yargs
      .positional("bloq-id", { describe: "bloq ID", type: "number", demandOption: true })
      .option("format", { alias: "F", describe: "md or csv", type: "string", default: "md" })
      .option("output", { alias: "o", describe: "output file path", type: "string" }),
  async handler(args) {
    UI.empty()
    const bloqId = args["bloq-id"] as number
    const fmt = args.format as string
    prompts.intro(`Atlas Projections -- Export (bloq ${bloqId}, ${fmt})`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Fetching...")
    try {
      const res = await irisFetch(`/api/v1/atlas/${bloqId}/projections`)
      const ok = await handleApiError(res, "Get projections"); if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }
      const body = (await res.json()) as any
      const doc = body?.data ?? body
      spinner.stop("Fetched")

      let output: string
      if (fmt === "csv") {
        const lines = ["metric,low,mid,high"]
        const rev = doc.forecasts?.annual_revenue ?? {}
        const prof = doc.forecasts?.annual_profit ?? {}
        lines.push(`annual_revenue,${rev.low ?? ""},${rev.mid ?? ""},${rev.high ?? ""}`)
        lines.push(`annual_profit,${prof.low ?? ""},${prof.mid ?? ""},${prof.high ?? ""}`)
        lines.push(`break_even_months,${doc.forecasts?.break_even_months ?? ""},,`)
        const rec = doc.pricing_recommendation ?? {}
        lines.push(`tier,${rec.tier ?? ""},,`)
        lines.push(`monthly_fee,${rec.monthly_fee ?? ""},,`)
        lines.push(`revenue_share_pct,${rec.revenue_share_pct ?? ""},,`)
        output = lines.join("\n") + "\n"
      } else {
        const lines: string[] = []
        lines.push(`# Projections: ${doc.company?.name ?? "Unknown"}`)
        lines.push("")
        lines.push(`**Industry:** ${doc.company?.industry ?? "--"}  `)
        lines.push(`**Confidence:** ${doc.revenue?.confidence ?? "--"}  `)
        lines.push(`**Updated:** ${doc.updated_at ?? "--"}`)
        lines.push("")
        lines.push("## Revenue Streams")
        for (const s of doc.revenue?.streams ?? []) {
          lines.push(`- ${s.name}: ${fmtDollars(s.monthly)}/mo (${((s.growth_rate ?? 0) * 100).toFixed(0)}% growth)`)
        }
        lines.push("")
        lines.push("## Forecasts")
        const rev = doc.forecasts?.annual_revenue ?? {}
        lines.push(`| Metric | Low | Mid | High |`)
        lines.push(`|--------|-----|-----|------|`)
        lines.push(`| Annual Revenue | ${fmtDollars(rev.low)} | ${fmtDollars(rev.mid)} | ${fmtDollars(rev.high)} |`)
        const prof = doc.forecasts?.annual_profit ?? {}
        lines.push(`| Annual Profit | ${fmtDollars(prof.low)} | ${fmtDollars(prof.mid)} | ${fmtDollars(prof.high)} |`)
        lines.push(`| Break-even | ${doc.forecasts?.break_even_months ?? "--"} months | | |`)
        lines.push("")
        const rec = doc.pricing_recommendation
        if (rec) {
          lines.push("## Pricing Recommendation")
          lines.push(`- **Tier:** ${rec.tier}`)
          lines.push(`- **Monthly fee:** ${fmtDollars(rec.monthly_fee)}`)
          lines.push(`- **Revenue share:** ${rec.revenue_share_pct}%`)
          lines.push(`- **Rationale:** ${rec.rationale}`)
        }
        output = lines.join("\n") + "\n"
      }

      if (args.output) {
        writeFileSync(args.output, output)
        prompts.log.success(`Exported to ${args.output}`)
      } else {
        console.log(output)
      }
      prompts.outro("Done")
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

// ── Command Group ───────────────────────────────────────────────────────────

export const PlatformAtlasProjectionsCommand = cmd({
  command: "atlas:projections",
  aliases: ["atlas:proj"],
  describe: "atlas financial projections — push/pull documents + pricing engine",
  builder: (yargs) =>
    yargs
      .command(ProjPullCommand)
      .command(ProjPushCommand)
      .command(ProjDiffCommand)
      .command(ProjGenerateCommand)
      .command(ProjEstimateCommand)
      .command(ProjExportCommand)
      .demandCommand(),
  async handler() {},
})
