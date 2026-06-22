import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import {
  irisFetch,
  IRIS_API,
  requireAuth,
  printDivider,
  dim,
  bold,
  success,
  highlight,
} from "./iris-api"
import { spawnSync } from "child_process"
import { existsSync, mkdirSync, statSync, writeFileSync } from "fs"
import { transcribeLocal } from "../lib/transcription"
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
  sourceUrl?: string,
) {
  const abs = resolve(filePath)
  const sp = prompts.spinner()
  sp.start("Transcribing locally (whisper.cpp)…")
  let text: string
  try {
    text = await transcribeLocal(abs, { language })
  } catch (e) {
    sp.stop("Failed", 1)
    prompts.log.error(e instanceof Error ? e.message : String(e))
    return
  }
  sp.stop("Done")

  // Persist next to the source (preserves prior UX).
  const txtPath = join(process.cwd(), `${basename(abs, extname(abs))}-transcript.txt`)
  writeFileSync(txtPath, text)

  // Best-effort server sync so it's searchable in the knowledge base.
  const estimatedDuration = Math.round((text.split(/\s+/).length / 150) * 60)
  const syncUrl = sourceUrl ?? (/^https?:\/\//i.test(filePath) ? filePath : undefined)
  try {
    if (syncUrl && text) {
      await irisFetch("/api/v1/transcripts", {
        method: "POST",
        body: JSON.stringify({
          url: syncUrl,
          text,
          provider: "whisper.cpp (local)",
          duration_seconds: estimatedDuration,
        }),
      })
    }
  } catch {
    // Silent — server sync is best-effort
  }

  if (asJson) {
    console.log(JSON.stringify({ provider: "whisper.cpp (local)", file: abs, transcript_path: txtPath, text }, null, 2))
    return
  }

  printDivider()
  console.log(`  ${bold("Saved:")}  ${highlight(txtPath)}`)
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

  // Format ladder — try most-specific (small m4a audio) first, then progressively
  // looser selectors, ending with NO -f so yt-dlp picks its own default. A single
  // hardcoded selector was the cause of "Requested format is not available"
  // (#147267) when YouTube didn't offer that exact format. Each entry is tried
  // both with browser cookies and without.
  const formatLadder = [
    "bestaudio[ext=m4a]/bestaudio/best",
    "bestaudio/best",
    "worstaudio/worst",
    null, // let yt-dlp choose its default format
  ]
  const commonArgs = ["--no-playlist", "-o", outPath, "--no-warnings", "--quiet"]

  let lastErr = "Download failed"
  for (const fmt of formatLadder) {
    const fmtArgs = fmt ? ["-f", fmt] : []
    // Cookies first (Instagram/age-gated need them), then a cookieless attempt.
    for (const browser of ["chrome", "firefox", "safari", null]) {
      const cookieArgs = browser ? ["--cookies-from-browser", browser] : []
      const dl = spawnSync(ytdlp, [...fmtArgs, ...commonArgs, ...cookieArgs, url], {
        encoding: "utf8",
        timeout: 60_000,
      })
      if (dl.status === 0 && existsSync(outPath)) return outPath
      const out = (dl.stderr || dl.stdout || "").trim()
      if (out) lastErr = out.split("\n").pop() || lastErr
    }
  }

  // Everything failed — surface the last real yt-dlp error + a hint to update.
  prompts.log.error(lastErr)
  if (/format is not available|requested format/i.test(lastErr)) {
    prompts.log.info(`Tip: update yt-dlp — ${highlight("brew upgrade yt-dlp")} (or ${highlight("pip3 install -U yt-dlp")})`)
  }
  return null
}

// Server-side transcription via the SAME path that `iris tools invoke
// transcribevideo` uses and that the bug report (#147267) proved works:
//   POST /api/v1/tools/invoke  on IRIS_API (freelabel.net)  { tool, params }
//
// The old code POSTed to `/api/v1/v6/tools/execute` WITHOUT the IRIS_API host
// arg → irisFetch defaulted to FL_API (raichu.heyiris.io), where that route is
// dead → "Server unavailable" on every YouTube transcribe while the underlying
// tool was fine. Tool name is lowercase `transcribevideo` to match the registry.
async function invokeTranscribeTool(url: string): Promise<{ ok: boolean; data?: any }> {
  try {
    const res = await irisFetch(
      `/api/v1/tools/invoke`,
      { method: "POST", body: JSON.stringify({ tool: "transcribevideo", params: { url } }) },
      IRIS_API,
    )
    if (!res.ok) return { ok: false }
    const result = (await res.json()) as any
    const data = result?.data ?? result
    if (result?.status?.includes?.("error") || data?.error || !data?.text) return { ok: false }
    return { ok: true, data }
  } catch {
    return { ok: false }
  }
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

      await runLocalWhisper(videoPath, args.language as string | undefined, !!args.json, url)

      // Cleanup temp file
      try { spawnSync("rm", ["-f", videoPath]) } catch {}
      prompts.outro("Done")
      return
    }

    // ── YouTube → try server first (Supadata is fast), fall back to local ─
    if (isYouTubeUrl(url)) {
      const token = await requireAuth()
      if (token) {
        const spinner = prompts.spinner()
        spinner.start("Transcribing on server…")
        const tool = await invokeTranscribeTool(url)
        if (tool.ok) {
          const data = tool.data
          spinner.stop("Done")

          if (args.json) {
            console.log(JSON.stringify(data, null, 2))
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
        spinner.stop("Server path unavailable — falling back to local", 1)
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
      await runLocalWhisper(videoPath, args.language as string | undefined, !!args.json, url)
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
      await runLocalWhisper(videoPath, args.language as string | undefined, !!args.json, url)
      try { spawnSync("rm", ["-f", videoPath]) } catch {}
      prompts.outro("Done")
      return
    }

    const spinner = prompts.spinner()
    spinner.start("Transcribing on server…")

    const tool = await invokeTranscribeTool(url)
    if (!tool.ok) {
      spinner.stop("Server path unavailable — trying local", 1)
      const dlSpinner = prompts.spinner()
      dlSpinner.start("Downloading…")
      const videoPath = await downloadVideoLocally(url)
      if (!videoPath) { dlSpinner.stop("Failed", 1); prompts.outro("Done"); return }
      dlSpinner.stop("Downloaded")
      await runLocalWhisper(videoPath, args.language as string | undefined, !!args.json, url)
      try { spawnSync("rm", ["-f", videoPath]) } catch {}
      prompts.outro("Done")
      return
    }

    const data = tool.data
    spinner.stop("Done")

    if (args.json) {
      console.log(JSON.stringify(data, null, 2))
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
  },
})
