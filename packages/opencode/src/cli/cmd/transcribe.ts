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
import { spawnSync } from "child_process"
import { existsSync, mkdirSync, statSync } from "fs"
import { homedir, tmpdir } from "os"
import { join, basename, extname, resolve } from "path"

const WHISPER_MODEL_URL =
  "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin"

function which(bin: string): string | null {
  const r = spawnSync("which", [bin], { encoding: "utf8" })
  const p = r.stdout.trim()
  return p && r.status === 0 ? p : null
}

async function runLocalWhisper(
  filePath: string,
  language: string | undefined,
  asJson: boolean,
) {
  const abs = resolve(filePath)
  if (!existsSync(abs)) {
    prompts.log.error(`File not found: ${abs}`)
    return
  }

  // 1. Check deps
  const ffmpeg = which("ffmpeg")
  const whisper = which("whisper-cli") || which("whisper-cpp")
  if (!ffmpeg) {
    prompts.log.error("ffmpeg not found. Install: brew install ffmpeg")
    return
  }
  if (!whisper) {
    prompts.log.error("whisper-cli not found. Install: brew install whisper-cpp")
    return
  }

  // 2. Ensure model
  const modelDir = join(homedir(), ".whisper")
  const modelPath = join(modelDir, "ggml-base.en.bin")
  if (!existsSync(modelPath)) {
    mkdirSync(modelDir, { recursive: true })
    const sp = prompts.spinner()
    sp.start("Downloading whisper model (~141 MB)…")
    const dl = spawnSync("curl", ["-L", "-o", modelPath, WHISPER_MODEL_URL], {
      stdio: "ignore",
    })
    if (dl.status !== 0) {
      sp.stop("Failed", 1)
      prompts.log.error("Model download failed")
      return
    }
    sp.stop("Model ready")
  }

  // 3. Convert → 16kHz mono WAV in tmp
  const wavPath = join(
    tmpdir(),
    `iris-transcribe-${Date.now()}-${basename(abs, extname(abs))}.wav`,
  )
  const sp = prompts.spinner()
  sp.start("Converting audio…")
  const conv = spawnSync(
    ffmpeg,
    ["-y", "-i", abs, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wavPath],
    { stdio: "ignore" },
  )
  if (conv.status !== 0 || !existsSync(wavPath)) {
    sp.stop("Failed", 1)
    prompts.log.error("ffmpeg conversion failed")
    return
  }
  const wavSize = (statSync(wavPath).size / 1024 / 1024).toFixed(1)
  sp.stop(`Converted (${wavSize} MB)`)

  // 4. Run whisper-cli
  const outBase = join(
    process.cwd(),
    `${basename(abs, extname(abs))}-transcript`,
  )
  const args = ["-m", modelPath, "-otxt", "-of", outBase]
  if (language) args.push("-l", language)
  args.push(wavPath)

  const sp2 = prompts.spinner()
  sp2.start("Transcribing locally (whisper.cpp)…")
  const res = spawnSync(whisper, args, { encoding: "utf8" })
  // cleanup wav regardless
  spawnSync("rm", ["-f", wavPath])

  if (res.status !== 0) {
    sp2.stop("Failed", 1)
    prompts.log.error(res.stderr?.slice(-500) || "whisper-cli failed")
    return
  }
  sp2.stop("Done")

  const txtPath = `${outBase}.txt`
  const text = existsSync(txtPath)
    ? require("fs").readFileSync(txtPath, "utf8")
    : ""

  // Post to canonical /api/v1/transcribe so the local result lands in the
  // same cache + usage log as Supadata/Whisper. Non-fatal — print local
  // text either way. This is what makes --local visible to billing/history.
  const estimatedDuration = Math.round((text.split(/\s+/).length / 150) * 60)
  try {
    const sync = await irisFetch("/api/v1/transcribe", {
      method: "POST",
      body: JSON.stringify({
        pre_transcribed: {
          text,
          provider: "local",
          duration_seconds: estimatedDuration,
        },
      }),
    })
    if (!sync.ok) {
      const body = await sync.text().catch(() => "")
      console.log(dim(`  (canonical sync failed: HTTP ${sync.status} ${body.slice(0, 120)})`))
    }
  } catch (e) {
    console.log(dim(`  (canonical sync skipped: ${e instanceof Error ? e.message : String(e)})`))
  }

  if (asJson) {
    console.log(
      JSON.stringify(
        { provider: "whisper.cpp (local)", file: abs, transcript_path: txtPath, text },
        null,
        2,
      ),
    )
    return
  }

  printDivider()
  console.log(`  ${bold("Provider:")}  ${highlight("whisper.cpp (local)")} ${success("(offline)")}`)
  console.log(`  ${bold("Source:")}    ${dim(abs)}`)
  console.log(`  ${bold("Saved:")}     ${highlight(txtPath)}`)
  printDivider()
  console.log()
  console.log(text)
  console.log()
}

// ============================================================================
// Smart URL detection
// ============================================================================

function isSocialMediaUrl(url: string): boolean {
  return /instagram\.com|tiktok\.com|twitter\.com|x\.com|threads\.net|facebook\.com/i.test(url)
}

function isYouTubeUrl(url: string): boolean {
  return /youtube\.com|youtu\.be/i.test(url)
}

function ensureDep(name: string, installCmd: string): string | null {
  const bin = which(name)
  if (bin) return bin
  // Try to auto-install
  const sp2 = spawnSync("brew", ["install", name], { stdio: "pipe", timeout: 120_000 })
  if (sp2.status === 0) return which(name)
  return null
}

// ============================================================================
// Local video download via yt-dlp (runs on user's machine, uses their cookies)
// ============================================================================

async function downloadVideoLocally(url: string): Promise<string | null> {
  let ytdlp = which("yt-dlp")
  if (!ytdlp) {
    prompts.log.info("Installing yt-dlp…")
    const install = spawnSync("brew", ["install", "yt-dlp"], { stdio: "pipe", timeout: 120_000 })
    if (install.status !== 0) {
      // Try pip fallback
      spawnSync("pip3", ["install", "--user", "yt-dlp"], { stdio: "pipe", timeout: 60_000 })
    }
    ytdlp = which("yt-dlp")
    if (!ytdlp) {
      prompts.log.error("yt-dlp not found. Install: brew install yt-dlp")
      return null
    }
  }

  const outPath = join(tmpdir(), `iris-dl-${Date.now()}.mp4`)

  // Build yt-dlp args — try with browser cookies first (Instagram needs them)
  const baseArgs = [
    "-f", "bestaudio[ext=m4a]/bestaudio/best",
    "--no-playlist",
    "-o", outPath,
    "--no-warnings",
    "--quiet",
  ]

  // Try with browser cookies (Chrome, Firefox, Safari — whatever works)
  for (const browser of ["chrome", "firefox", "safari"]) {
    const args = [...baseArgs, "--cookies-from-browser", browser, url]
    const dl = spawnSync(ytdlp, args, { stdio: "pipe", timeout: 60_000 })
    if (dl.status === 0 && existsSync(outPath)) return outPath
  }

  // Fallback: try without cookies (works for public YouTube, TikTok, etc.)
  const dl = spawnSync(ytdlp, [...baseArgs, url], { stdio: "pipe", timeout: 60_000 })
  if (dl.status === 0 && existsSync(outPath)) return outPath

  // If all failed, show the actual error
  const errDl = spawnSync(ytdlp, ["-f", "bestaudio/best", "--no-playlist", "-o", outPath, url], {
    encoding: "utf8",
    timeout: 60_000,
  })
  const errMsg = (errDl.stderr || errDl.stdout || "").trim().split("\n").pop() || "Download failed"
  prompts.log.error(errMsg)
  return null
}

/**
 * `iris transcribe <url>` — smart transcription.
 *
 * Routing:
 * - Local file → whisper.cpp (offline)
 * - Instagram/TikTok/X/Threads → download locally with yt-dlp (uses browser cookies) → whisper.cpp
 * - YouTube → server-side Supadata (fast, cached) with local fallback
 * - --local flag → always local pipeline
 */
export const PlatformTranscribeCommand = cmd({
  command: "transcribe <url>",
  describe: "transcribe a video/audio from a URL or local file",
  builder: (y) =>
    y
      .positional("url", {
        type: "string",
        demandOption: true,
        describe: "Video/audio URL or local file path",
      })
      .option("language", {
        type: "string",
        describe: "ISO 639-1 language hint for Whisper (e.g. 'en')",
      })
      .option("local", {
        type: "boolean",
        default: false,
        describe: "Force local offline transcription via whisper.cpp",
      })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Transcribe")

    const url = String(args.url)
    const looksLikeFile =
      args.local || (!/^https?:\/\//i.test(url) && existsSync(resolve(url)))

    // ── Local file ──────────────────────────────────────────────
    if (looksLikeFile) {
      await runLocalWhisper(url, args.language as string | undefined, !!args.json)
      prompts.outro("Done")
      return
    }

    // ── Social media (Instagram, TikTok, X, Threads, Facebook) ─
    // Download locally with yt-dlp (uses browser cookies), then whisper locally.
    // No server auth needed. No round trips. Just works.
    if (isSocialMediaUrl(url) || args.local) {
      const dlSpinner = prompts.spinner()
      dlSpinner.start("Downloading video…")

      const videoPath = await downloadVideoLocally(url)
      if (!videoPath) {
        dlSpinner.stop("Download failed", 1)
        prompts.outro("Done")
        return
      }
      dlSpinner.stop("Downloaded")

      await runLocalWhisper(videoPath, args.language as string | undefined, !!args.json)

      // Cleanup temp file
      try { spawnSync("rm", ["-f", videoPath]) } catch {}
      prompts.outro("Done")
      return
    }

    // ── YouTube → try server first (Supadata is fast), fall back to local ─
    if (isYouTubeUrl(url)) {
      const token = await requireAuth()
      if (token) {
        const userId = await requireUserId()
        if (userId) {
          const spinner = prompts.spinner()
          spinner.start("Transcribing via Supadata…")

          try {
            const res = await irisFetch(`/api/v1/v6/tools/execute`, {
              method: "POST",
              body: JSON.stringify({ tool: "transcribeVideo", params: { url }, user_id: userId }),
            })

            if (res.ok) {
              const result = (await res.json()) as any
              const data = result?.data ?? result

              if (!result?.status?.includes?.("error") && !data?.error) {
                spinner.stop("Done")

                if (args.json) {
                  console.log(JSON.stringify(result, null, 2))
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
                return
              }
            }
            spinner.stop("Server unavailable — falling back to local", 1)
          } catch {
            spinner.stop("Server unavailable — falling back to local", 1)
          }
        }
      }

      // YouTube server failed → download locally + whisper
      prompts.log.info("Downloading YouTube audio locally…")
      const dlSpinner = prompts.spinner()
      dlSpinner.start("Downloading…")
      const videoPath = await downloadVideoLocally(url)
      if (!videoPath) {
        dlSpinner.stop("Download failed", 1)
        prompts.outro("Done")
        return
      }
      dlSpinner.stop("Downloaded")
      await runLocalWhisper(videoPath, args.language as string | undefined, !!args.json)
      try { spawnSync("rm", ["-f", videoPath]) } catch {}
      prompts.outro("Done")
      return
    }

    // ── Other URLs → try server, fall back to local download ───
    const token = await requireAuth()
    if (!token) {
      // No auth — try local anyway
      const dlSpinner = prompts.spinner()
      dlSpinner.start("Downloading…")
      const videoPath = await downloadVideoLocally(url)
      if (!videoPath) { dlSpinner.stop("Failed", 1); prompts.outro("Done"); return }
      dlSpinner.stop("Downloaded")
      await runLocalWhisper(videoPath, args.language as string | undefined, !!args.json)
      try { spawnSync("rm", ["-f", videoPath]) } catch {}
      prompts.outro("Done")
      return
    }

    const userId = await requireUserId()
    const spinner = prompts.spinner()
    spinner.start("Transcribing…")

    try {
      const res = await irisFetch(`/api/v1/v6/tools/execute`, {
        method: "POST",
        body: JSON.stringify({ tool: "transcribeVideo", params: { url }, user_id: userId }),
      })

      if (!res.ok) {
        spinner.stop("Server failed — trying local", 1)
        const dlSpinner = prompts.spinner()
        dlSpinner.start("Downloading…")
        const videoPath = await downloadVideoLocally(url)
        if (!videoPath) { dlSpinner.stop("Failed", 1); prompts.outro("Done"); return }
        dlSpinner.stop("Downloaded")
        await runLocalWhisper(videoPath, args.language as string | undefined, !!args.json)
        try { spawnSync("rm", ["-f", videoPath]) } catch {}
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

      const text = data?.text ?? ""
      const provider = data?.provider ?? "?"
      const wordCount = data?.word_count ?? 0
      const duration = data?.duration_seconds ?? 0
      printDivider()
      console.log(`  ${bold("Provider:")}  ${highlight(provider)}`)
      console.log(`  ${bold("Words:")}     ${wordCount}`)
      console.log(`  ${bold("Duration:")}  ~${duration}s`)
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
