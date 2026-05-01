import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, requireUserId, printDivider, printKV, dim, bold, success, highlight } from "./iris-api"

const IRIS_API = process.env.IRIS_API_URL ?? "https://heyiris.io"

async function hiveFetch(path: string, options: RequestInit = {}) {
  return irisFetch(path, options, IRIS_API)
}

// ============================================================================
// Subcommands
// ============================================================================

const ClipsCutCommand = cmd({
  command: "cut [url]",
  describe: "cut a clip from a YouTube video and publish to Instagram",
  builder: (yargs) =>
    yargs
      .positional("url", { describe: "YouTube URL (omit to auto-pick from latest uploads)", type: "string" })
      .option("brand", { describe: "brand identity for caption/branding", type: "string", default: "discover" })
      .option("dry-run", { describe: "show what would happen without dispatching", type: "boolean", default: false })
      .option("skip-scoring", { describe: "skip AI virality scoring", type: "boolean", default: false })
      .option("threshold", { describe: "minimum virality score (0-100)", type: "number", default: 70 })
      .option("hive", { describe: "dispatch as Hive task instead of direct artisan", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Clip Cutter")

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"] as number | undefined)
    if (!userId) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()

    if (args.hive) {
      // Dispatch as Hive task
      spinner.start("Dispatching Hive clip_cutter task…")

      const prompt = [
        `brand=${args.brand}`,
        args.url ? `url=${args.url}` : "",
        args["dry-run"] ? "dry=1" : "",
        args["skip-scoring"] ? "skip-scoring=1" : "",
        `threshold=${args.threshold}`,
      ].filter(Boolean).join(" ")

      try {
        const res = await hiveFetch("/api/v6/workspace/tools/execute", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            tool_name: "hiveClipCutter",
            function_name: "cut",
            args: {
              task_type: "clip_cutter",
              prompt,
              _title: "Clip Cutter",
            },
            user_id: userId,
          }),
        })

        const ok = await handleApiError(res, "Dispatch clip task")
        if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

        const json = await res.json() as Record<string, unknown>
        spinner.stop(success("Clip task dispatched to Hive"))
        if (json.task_id) printKV("Task ID", json.task_id)
        if (json.message) printKV("Message", json.message)
      } catch (err) {
        spinner.stop("Error", 1)
        prompts.log.error(err instanceof Error ? err.message : String(err))
      }
    } else {
      // Direct artisan call via fl-api
      spinner.start("Running clip cutter…")

      const params = new URLSearchParams()
      params.set("brand", args.brand as string)
      if (args.url) params.set("url", args.url as string)
      if (args["dry-run"]) params.set("dry_run", "1")
      if (args["skip-scoring"]) params.set("skip_scoring", "1")
      params.set("threshold", String(args.threshold))

      try {
        const res = await irisFetch(`/api/v1/clips/cut-scheduled?${params}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        })

        const ok = await handleApiError(res, "Cut clip")
        if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

        const json = await res.json() as Record<string, unknown>
        spinner.stop(success("Clip cutter completed"))

        if (json.job_id) printKV("Job ID", json.job_id)
        if (json.video_title) printKV("Video", json.video_title)
        if (json.youtube_url) printKV("URL", json.youtube_url)
        if (json.start) printKV("Start", json.start)
        if (json.duration) printKV("Duration", json.duration)
        if (json.virality_score) printKV("Score", `${json.virality_score}%`)
        if (json.message) printKV("Status", json.message)

        // Show scores if available
        const scores = json.scores as Array<{ title: string; score: number }> | undefined
        if (scores && scores.length > 0) {
          console.log()
          printDivider()
          console.log(bold("  Virality Scores"))
          printDivider()
          const threshold = args.threshold as number
          for (const s of scores) {
            const icon = s.score >= threshold ? "✅" : "❌"
            console.log(`  ${icon} ${highlight(String(s.score) + "%")} — ${s.title}`)
          }
        }
      } catch (err) {
        spinner.stop("Error", 1)
        prompts.log.error(err instanceof Error ? err.message : String(err))
      }
    }

    prompts.outro("Done")
  },
})

const ClipsStatusCommand = cmd({
  command: "status <job-id>",
  describe: "check the status of a clip processing job",
  builder: (yargs) =>
    yargs.positional("job-id", { describe: "video processing job ID", type: "number", demandOption: true }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Clip Status")

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Checking…")

    try {
      const res = await irisFetch(`/api/v1/clips/status/${args["job-id"]}`)
      const ok = await handleApiError(res, "Clip status")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const json = await res.json() as Record<string, unknown>
      spinner.stop(success("Status retrieved"))

      printKV("Job ID", json.id)
      printKV("Status", json.status)
      printKV("Progress", `${json.progress_percentage}%`)
      if (json.video_url) printKV("Video URL", json.video_url)
      if (json.error_message) printKV("Error", json.error_message)
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
    }

    prompts.outro("Done")
  },
})

// ============================================================================
// Root command
// ============================================================================

export const PlatformClipsCommand = cmd({
  command: "clips",
  describe: "cut and publish video clips to Instagram",
  builder: (yargs) =>
    yargs
      .command(ClipsCutCommand)
      .command(ClipsStatusCommand)
      .demandCommand(1, "specify a subcommand: cut, status"),
  async handler() {},
})
