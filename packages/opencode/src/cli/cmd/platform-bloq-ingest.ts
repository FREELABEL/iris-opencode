import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, printDivider, printKV, dim, bold, success } from "./iris-api"

// ============================================================================
// bloq-ingest start <bloqId> <source> <path>
// POST /api/v1/bloqs/{bloqId}/ingest-folder
// ============================================================================

const IngestStartCommand = cmd({
  command: "start <bloqId> <source> <path>",
  describe: "start bulk ingestion from cloud storage (dropbox, google_drive)",
  builder: (yargs) =>
    yargs
      .positional("bloqId", { type: "number", demandOption: true })
      .positional("source", { type: "string", demandOption: true, choices: ["dropbox", "google_drive"] })
      .positional("path", { type: "string", demandOption: true, describe: "folder path or ID" })
      .option("recursive", { alias: "r", type: "boolean", default: false })
      .option("file-types", { alias: "t", type: "string", describe: "comma-separated extensions" })
      .option("list-name", { alias: "l", type: "string", default: "Imported Files" })
      .option("include-images", { alias: "i", type: "boolean", default: false })
      .option("image-detail", { type: "string", default: "high" })
      .option("wait", { alias: "w", type: "boolean", default: false })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Ingest → Bloq #${args.bloqId}`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }

    const payload: Record<string, any> = {
      source: args.source,
      path: args.path,
      recursive: args.recursive,
      list_name: args["list-name"],
    }
    if (args["file-types"]) payload.file_types = args["file-types"].split(",").map((s: string) => s.trim())
    if (args["include-images"]) {
      payload.include_images = true
      payload.image_detail_level = args["image-detail"]
    }

    const spinner = prompts.spinner()
    spinner.start("Starting ingestion…")
    try {
      const res = await irisFetch(`/api/v1/bloqs/${args.bloqId}/ingest-folder`, {
        method: "POST",
        body: JSON.stringify(payload),
      })
      const ok = await handleApiError(res, "Start ingestion")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }
      const data = (await res.json()) as any
      const job = data?.data ?? data
      spinner.stop(`${success("✓")} Job ${job.job_id ?? job.id}`)

      if (args.json) { console.log(JSON.stringify(job, null, 2)); prompts.outro("Done"); return }

      printDivider()
      printKV("Job ID", job.job_id ?? job.id)
      printKV("Status", job.status)
      printKV("Source", args.source)
      printKV("Path", args.path)
      printDivider()

      if (args.wait) {
        const jobId = job.job_id ?? job.id
        const pollSpinner = prompts.spinner()
        pollSpinner.start("Waiting for completion…")
        const start = Date.now()
        while (true) {
          if (Date.now() - start > 30 * 60 * 1000) { pollSpinner.stop("Timed out", 1); break }
          await new Promise((r) => setTimeout(r, 3000))
          const sr = await irisFetch(`/api/v1/ingestion-jobs/${jobId}/status`)
          if (!sr.ok) continue
          const sd = ((await sr.json()) as any)?.data ?? (await sr.json().catch(() => ({})))
          const st = sd.status ?? "?"
          const pct = sd.progress_percent ?? 0
          const proc = sd.processed_files ?? 0
          const tot = sd.total_files ?? 0
          pollSpinner.message(`${st} · ${proc}/${tot} (${pct}%)`)
          if (["completed", "partial", "failed", "cancelled"].includes(st)) {
            pollSpinner.stop(`${st === "completed" ? success("✓") : "⚠"} ${st}: ${sd.successful_files ?? 0} ok, ${sd.failed_files ?? 0} failed`)
            break
          }
        }
      } else {
        prompts.outro(dim(`iris bloq-ingest status ${job.job_id ?? job.id}`))
        return
      }
      prompts.outro("Done")
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

// ============================================================================
// bloq-ingest jobs <bloqId>
// GET /api/v1/bloqs/{bloqId}/ingestion-jobs
// ============================================================================

const IngestJobsCommand = cmd({
  command: "jobs <bloqId>",
  describe: "list ingestion jobs for a bloq",
  builder: (yargs) =>
    yargs
      .positional("bloqId", { type: "number", demandOption: true })
      .option("status", { alias: "s", type: "string" })
      .option("limit", { alias: "l", type: "number", default: 20 })
      .option("page", { alias: "p", type: "number", default: 1 })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Ingestion Jobs — Bloq #${args.bloqId}`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }
    const params = new URLSearchParams({ limit: String(args.limit), page: String(args.page) })
    if (args.status) params.set("status", args.status)
    const res = await irisFetch(`/api/v1/bloqs/${args.bloqId}/ingestion-jobs?${params}`)
    const ok = await handleApiError(res, "List jobs")
    if (!ok) { prompts.outro("Done"); return }
    const data = (await res.json()) as any
    const jobs: any[] = data?.data ?? data?.jobs ?? (Array.isArray(data) ? data : [])
    if (args.json) { console.log(JSON.stringify(jobs, null, 2)); prompts.outro("Done"); return }
    printDivider()
    if (jobs.length === 0) console.log(`  ${dim("(no jobs)")}`)
    else for (const j of jobs) {
      console.log(`  ${bold(String(j.job_id ?? j.id))}  ${dim(j.status ?? "?")}  ${dim(`${j.successful_files ?? 0}/${j.total_files ?? 0}`)}`)
      if (j.created_at) console.log(`    ${dim(String(j.created_at))}`)
    }
    printDivider()
    prompts.outro("Done")
  },
})

// ============================================================================
// bloq-ingest status <jobId>
// GET /api/v1/ingestion-jobs/{jobId}/status
// ============================================================================

const IngestStatusCommand = cmd({
  command: "status <jobId>",
  describe: "show ingestion job status",
  builder: (yargs) =>
    yargs
      .positional("jobId", { type: "string", demandOption: true })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Job ${args.jobId}`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }
    const res = await irisFetch(`/api/v1/ingestion-jobs/${args.jobId}/status`)
    const ok = await handleApiError(res, "Get status")
    if (!ok) { prompts.outro("Done"); return }
    const data = ((await res.json()) as any)?.data ?? (await res.json().catch(() => ({})))
    if (args.json) { console.log(JSON.stringify(data, null, 2)); prompts.outro("Done"); return }
    printDivider()
    printKV("Status", data.status)
    printKV("Progress", data.progress_percent !== undefined ? `${data.progress_percent}%` : undefined)
    printKV("Processed", `${data.processed_files ?? 0} / ${data.total_files ?? 0}`)
    printKV("Successful", data.successful_files)
    printKV("Failed", data.failed_files)
    printKV("Current file", data.current_file)
    printDivider()
    prompts.outro("Done")
  },
})

export const PlatformBloqIngestCommand = cmd({
  command: "bloq-ingest",
  describe: "bulk ingest files from cloud storage into bloqs",
  builder: (yargs) =>
    yargs
      .command(IngestStartCommand)
      .command(IngestJobsCommand)
      .command(IngestStatusCommand)
      .demandCommand(),
  async handler() {},
})
