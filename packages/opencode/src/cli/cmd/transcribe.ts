import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import {
  irisFetch,
  requireAuth,
  requireUserId,
  printDivider,
  dim,
  bold,
  success,
  highlight,
} from "./iris-api"

/**
 * `iris transcribe <url>` — platform-level video transcription.
 *
 * Routes through the V6 tool registry's `transcribeVideo` system tool,
 * which calls PlatformTranscriptionService (Supadata for YouTube,
 * Whisper for everything else). Cached 7 days per URL.
 */
export const PlatformTranscribeCommand = cmd({
  command: "transcribe <url>",
  describe: "transcribe a video from any URL (YouTube, Instagram, TikTok, X, …)",
  builder: (y) =>
    y
      .positional("url", {
        type: "string",
        demandOption: true,
        describe: "Video URL",
      })
      .option("language", {
        type: "string",
        describe: "ISO 639-1 language hint for Whisper (e.g. 'en')",
      })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Transcribe")
    if (!(await requireAuth())) {
      prompts.outro("Done")
      return
    }

    const url = String(args.url)
    const userId = await requireUserId()

    const params: Record<string, unknown> = { url }
    if (args.language) params.language = String(args.language)

    const spinner = prompts.spinner()
    spinner.start("Transcribing…")

    try {
      const res = await irisFetch(`/api/v1/v6/tools/execute`, {
        method: "POST",
        body: JSON.stringify({
          tool: "transcribeVideo",
          params,
          user_id: userId,
        }),
      })

      if (!res.ok) {
        spinner.stop("Failed", 1)
        const text = await res.text().catch(() => "")
        prompts.log.error(`HTTP ${res.status}: ${text.slice(0, 300)}`)
        prompts.outro("Done")
        return
      }

      const result = (await res.json()) as any
      const data = result?.data ?? result
      spinner.stop("Done")

      if (args.json) {
        console.log(JSON.stringify(result, null, 2))
        prompts.outro("Done")
        return
      }

      if (result?.status === "error" || data?.error) {
        prompts.log.error(data?.error ?? result?.error ?? "Transcription failed")
        prompts.outro("Done")
        return
      }

      const text = data?.text ?? ""
      const provider = data?.provider ?? "?"
      const wordCount = data?.word_count ?? 0
      const duration = data?.duration_seconds ?? 0
      const cached = data?.cached ? success("(cached)") : dim("(fresh)")
      const transcriptUrl = data?.transcript_url

      printDivider()
      console.log(`  ${bold("Provider:")}  ${highlight(provider)} ${cached}`)
      console.log(`  ${bold("Words:")}     ${wordCount}`)
      console.log(`  ${bold("Duration:")}  ~${duration}s`)
      if (transcriptUrl) {
        console.log(`  ${bold("CDN:")}       ${highlight(transcriptUrl)}`)
      }
      printDivider()
      console.log()
      console.log(text)
      console.log()
      prompts.outro("Done")
    } catch (e) {
      spinner.stop("Failed", 1)
      prompts.log.error(e instanceof Error ? e.message : String(e))
      prompts.outro("Done")
    }
  },
})
