import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { printDivider, bold, highlight, dim } from "./iris-api"
import { spawnSync } from "child_process"
import { existsSync, writeFileSync, statSync } from "fs"
import { join } from "path"

function which(bin: string): string | null {
  const r = spawnSync("which", [bin], { encoding: "utf8" })
  const p = r.stdout.trim()
  return p && r.status === 0 ? p : null
}

function ensureYtDlp(): string | null {
  let ytdlp = which("yt-dlp")
  if (ytdlp) return ytdlp
  prompts.log.info("Installing yt-dlp...")
  spawnSync("brew", ["install", "yt-dlp"], { stdio: "pipe", timeout: 120_000 })
  ytdlp = which("yt-dlp")
  if (ytdlp) return ytdlp
  spawnSync("pip3", ["install", "--user", "yt-dlp"], { stdio: "pipe", timeout: 60_000 })
  ytdlp = which("yt-dlp")
  if (!ytdlp) prompts.log.error("yt-dlp not found. Install: brew install yt-dlp")
  return ytdlp
}

function slugFromUrl(url: string): string {
  try {
    const u = new URL(url)
    const v = u.searchParams.get("v")
    if (v) return v
    const path = u.pathname.replace(/^\/+|\/+$/g, "").replace(/\//g, "-")
    if (path) return path
  } catch {}
  return `download-${Date.now()}`
}

interface DownloadResult {
  path: string
  format: string
}

async function downloadFile(
  ytdlp: string,
  url: string,
  outPath: string,
  formatSpec: string,
  mergeFormat?: string,
  opts?: { quality?: number; section?: string },
): Promise<{ ok: boolean; error?: string; timedOut?: boolean }> {
  // Cap resolution when --quality is set: rewrite the height-agnostic default into a
  // height-bounded selector so a 6h source isn't pulled at 1080p when 720p will do (#137385).
  const spec = opts?.quality
    ? `bestvideo[height<=${opts.quality}]+bestaudio/best[height<=${opts.quality}]/best`
    : formatSpec
  const baseArgs = [
    "-f", spec,
    "--no-playlist",
    "-o", outPath,
    "--no-warnings",
    // Only pull the requested minutes instead of the whole multi-hour file.
    ...(opts?.section ? ["--download-sections", opts.section] : []),
    ...(mergeFormat ? ["--merge-output-format", mergeFormat] : []),
  ]

  // Stream yt-dlp's own progress/errors when the user asked for logs — otherwise a
  // multi-GB / multi-hour pull looks identical to a hang, and the real error is lost
  // behind a guess (#137384). yt-dlp emits full %/ETA + clear errors; surface them.
  const argv = process.argv
  const verbose =
    argv.includes("--print-logs") ||
    argv.includes("--log-level=DEBUG") ||
    (argv.includes("--log-level") && (argv[argv.indexOf("--log-level") + 1] || "").toUpperCase() === "DEBUG")
  const stdio: any = verbose ? ["ignore", "inherit", "inherit"] : "pipe"

  const attempts = [
    ...["chrome", "firefox", "safari"].map((b) => [...baseArgs, "--cookies-from-browser", b, url]),
    [...baseArgs, url],
  ]

  let last: ReturnType<typeof spawnSync> | null = null
  for (const a of attempts) {
    const dl = spawnSync(ytdlp, a, { stdio, timeout: 300_000, encoding: "utf8" })
    last = dl
    if (dl.status === 0 && existsSync(outPath)) return { ok: true }
  }

  // Failed — report the REAL cause. On timeout spawnSync sets .error(ETIMEDOUT)/SIGTERM;
  // otherwise yt-dlp's stderr holds the true error (e.g. "No video could be found in
  // this tweet"). A partial .part/.ytdl may remain — flag it so a downstream step never
  // mistakes a partial for a finished file.
  const timedOut = (last?.error as any)?.code === "ETIMEDOUT" || last?.signal === "SIGTERM"
  const stderr = typeof last?.stderr === "string" ? last.stderr.trim() : ""
  const partial = existsSync(outPath + ".part") ? outPath + ".part" : null
  let error: string
  if (timedOut) {
    error = `yt-dlp timed out after 300s${partial ? ` (incomplete ${partial} left in place)` : ""}`
  } else if (stderr) {
    error = stderr.split("\n").filter(Boolean).pop() || stderr
  } else if (verbose) {
    error = "yt-dlp failed (see output above)"
  } else {
    error = last?.error?.message || "yt-dlp failed — re-run with --print-logs to see why"
  }
  return { ok: false, error, timedOut }
}

/**
 * Extract metadata from URL via yt-dlp --dump-json.
 * Works for tweets, YouTube, Instagram, TikTok, etc.
 */
function extractMetadata(ytdlp: string, url: string): any | null {
  // Try with browser cookies
  for (const browser of ["chrome", "firefox", "safari"]) {
    const res = spawnSync(ytdlp, [
      "--dump-json", "--no-playlist", "--no-warnings",
      "--cookies-from-browser", browser, url,
    ], { encoding: "utf8", timeout: 60_000 })
    if (res.status === 0 && res.stdout.trim()) {
      try { return JSON.parse(res.stdout.trim()) } catch {}
    }
  }

  // Fallback: no cookies
  const res = spawnSync(ytdlp, [
    "--dump-json", "--no-playlist", "--no-warnings", url,
  ], { encoding: "utf8", timeout: 60_000 })
  if (res.status === 0 && res.stdout.trim()) {
    try { return JSON.parse(res.stdout.trim()) } catch {}
  }

  // yt-dlp can't handle text-only posts — try oEmbed / HTML fallback
  return extractViaOEmbed(url)
}

/**
 * Strip HTML tags from a string.
 */
function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .trim()
}

/**
 * Fallback: use oEmbed APIs for platforms that support it (Twitter/X, etc.).
 */
function extractViaOEmbed(url: string): any | null {
  // Twitter/X oEmbed (no auth needed)
  if (/x\.com|twitter\.com/i.test(url)) {
    const oembedUrl = `https://publish.twitter.com/oembed?url=${encodeURIComponent(url)}`
    const res = spawnSync("curl", ["-s", "-L", "--max-time", "10", oembedUrl], {
      encoding: "utf8",
      timeout: 15_000,
    })
    if (res.status === 0 && res.stdout.trim()) {
      try {
        const data = JSON.parse(res.stdout.trim())
        const text = stripHtml(data.html || "")
        return {
          title: text.split("\n")[0]?.slice(0, 100) || "Tweet",
          description: text,
          uploader: data.author_name || "Unknown",
          extractor_key: "Twitter",
          _oembed: true,
        }
      } catch {}
    }
  }

  // Generic oEmbed discovery (YouTube, Instagram, etc. also support this)
  // Most platforms respond to the standard oEmbed endpoint pattern
  return null
}

/**
 * Convert yt-dlp metadata to a clean markdown document.
 */
function metadataToMarkdown(meta: any, url: string): string {
  const lines: string[] = []

  const title = meta.title || meta.fulltitle || "Untitled"
  const author = meta.uploader || meta.channel || meta.creator || "Unknown"
  const date = meta.upload_date
    ? `${meta.upload_date.slice(0, 4)}-${meta.upload_date.slice(4, 6)}-${meta.upload_date.slice(6, 8)}`
    : meta.timestamp ? new Date(meta.timestamp * 1000).toISOString().slice(0, 10) : ""
  const platform = meta.extractor_key || meta.extractor || "Unknown"
  const description = meta.description || ""

  lines.push(`# ${title}`)
  lines.push("")
  lines.push(`**Author:** ${author}`)
  if (date) lines.push(`**Date:** ${date}`)
  lines.push(`**Platform:** ${platform}`)
  lines.push(`**URL:** ${url}`)

  // Engagement stats
  const stats: string[] = []
  if (meta.like_count != null) stats.push(`${meta.like_count.toLocaleString()} likes`)
  if (meta.repost_count != null) stats.push(`${meta.repost_count.toLocaleString()} reposts`)
  if (meta.comment_count != null) stats.push(`${meta.comment_count.toLocaleString()} comments`)
  if (meta.view_count != null) stats.push(`${meta.view_count.toLocaleString()} views`)
  if (stats.length > 0) {
    lines.push(`**Engagement:** ${stats.join(" | ")}`)
  }

  if (meta.duration_string || meta.duration) {
    const dur = meta.duration_string || `${Math.floor((meta.duration || 0) / 60)}:${String((meta.duration || 0) % 60).padStart(2, "0")}`
    lines.push(`**Duration:** ${dur}`)
  }

  lines.push("")
  lines.push("---")
  lines.push("")

  // Main content (description/tweet text)
  if (description) {
    lines.push(description)
    lines.push("")
  }

  // Tags/hashtags
  if (meta.tags && meta.tags.length > 0) {
    lines.push("---")
    lines.push("")
    lines.push(`**Tags:** ${meta.tags.map((t: string) => `#${t}`).join(" ")}`)
    lines.push("")
  }

  return lines.join("\n")
}

/**
 * `iris download <url>` — download video, audio, and/or text from any URL.
 *
 * Saves files to the current directory. Supports YouTube, Instagram, TikTok,
 * X/Twitter, Threads, Facebook, SoundCloud, and 1000+ sites via yt-dlp.
 */
export const PlatformDownloadCommand = cmd({
  command: "download <url>",
  describe: "download video/audio/text from YouTube, Instagram, TikTok, X, and 1000+ sites",
  builder: (y) =>
    y
      .positional("url", {
        type: "string",
        demandOption: true,
        describe: "URL to download",
      })
      .option("video", {
        type: "boolean",
        default: true,
        describe: "Download video file (mp4)",
      })
      .option("audio", {
        type: "boolean",
        default: true,
        describe: "Download audio file (m4a)",
      })
      .option("text", {
        type: "boolean",
        default: true,
        describe: "Extract post text/metadata as markdown",
      })
      .option("text-only", {
        type: "boolean",
        default: false,
        describe: "Only extract text (skip video/audio download)",
      })
      .option("quality", {
        type: "number",
        describe: "Max video height (e.g. 720, 1080) — caps resolution instead of pulling best. Huge for long sources.",
      })
      .option("section", {
        type: "string",
        describe: "Time range to download instead of the whole file, passed to yt-dlp --download-sections (e.g. '*00:10:00-00:11:00')",
      })
      .option("out", {
        type: "string",
        alias: "o",
        describe: "Output directory (default: current directory)",
      })
      .option("name", {
        type: "string",
        describe: "Custom filename (without extension)",
      }),
  async handler(args) {
    UI.empty()
    prompts.intro("  Download")

    const url = String(args.url)
    const outDir = args.out ? String(args.out) : process.cwd()
    const slug = args.name ? String(args.name) : slugFromUrl(url)
    const textOnly = !!args["text-only"]
    const wantVideo = !textOnly && args.video
    const wantAudio = !textOnly && args.audio
    const wantText = args.text || textOnly

    const ytdlp = ensureYtDlp()
    if (!ytdlp) {
      prompts.outro("Aborted")
      return
    }

    // Ensure ffmpeg for merging (only needed for video)
    if (wantVideo && !which("ffmpeg")) {
      prompts.log.error("ffmpeg not found. Install: brew install ffmpeg")
      prompts.log.info("Skipping video download, continuing with audio/text...")
    }

    const results: DownloadResult[] = []

    // Extract metadata/text first (fast, always useful)
    let meta: any = null
    if (wantText) {
      const sp = prompts.spinner()
      sp.start("Extracting metadata...")
      meta = extractMetadata(ytdlp, url)
      if (meta) {
        const md = metadataToMarkdown(meta, url)
        const mdPath = join(outDir, `${slug}.md`)
        writeFileSync(mdPath, md, "utf8")
        sp.stop("Text extracted")
        results.push({ path: mdPath, format: "text/md" })

        // Print the content inline
        console.log()
        console.log(dim("─".repeat(50)))
        const title = meta.title || meta.fulltitle || ""
        const author = meta.uploader || meta.channel || ""
        if (title) console.log(`  ${bold(title)}`)
        if (author) console.log(`  ${dim(`by ${author}`)}`)
        if (meta.description) {
          console.log()
          // Truncate long descriptions for display
          const desc = meta.description.length > 500
            ? meta.description.slice(0, 500) + "..."
            : meta.description
          console.log(`  ${desc.split("\n").join("\n  ")}`)
        }
        console.log(dim("─".repeat(50)))
        console.log()
      } else {
        sp.stop("No metadata available", 1)
      }
    }

    // Download video
    if (wantVideo && which("ffmpeg")) {
      const videoPath = join(outDir, `${slug}.mp4`)
      const sp = prompts.spinner()
      sp.start("Downloading video...")

      const r = await downloadFile(
        ytdlp, url, videoPath,
        "bestvideo+bestaudio/best",
        "mp4",
        { quality: args.quality as number | undefined, section: args.section as string | undefined },
      )

      if (r.ok && existsSync(videoPath)) {
        const size = (statSync(videoPath).size / 1024 / 1024).toFixed(1)
        sp.stop(`Video downloaded (${size} MB)`)
        results.push({ path: videoPath, format: "video/mp4" })
      } else {
        sp.stop(`Video download failed: ${r.error}`, 1)
      }
    }

    // Download audio
    if (wantAudio) {
      const audioPath = join(outDir, `${slug}-audio.m4a`)
      const sp = prompts.spinner()
      sp.start("Downloading audio...")

      const r = await downloadFile(
        ytdlp, url, audioPath,
        "bestaudio[ext=m4a]/bestaudio/best",
        undefined,
        { section: args.section as string | undefined },
      )

      if (r.ok && existsSync(audioPath)) {
        const size = (statSync(audioPath).size / 1024 / 1024).toFixed(1)
        sp.stop(`Audio downloaded (${size} MB)`)
        results.push({ path: audioPath, format: "audio/m4a" })
      } else {
        sp.stop(`Audio download failed: ${r.error}`, 1)
      }
    }

    // Summary
    if (results.length > 0) {
      printDivider()
      for (const r of results) {
        console.log(`  ${bold(r.format.padEnd(12))} ${highlight(r.path)}`)
      }
      printDivider()
      prompts.outro(`${results.length} file${results.length > 1 ? "s" : ""} saved`)
    } else {
      // Exit non-zero so a downstream pipeline step (transcribe/clip) doesn't treat a
      // failed download as success — the silent-data-loss core of #137384.
      process.exitCode = 1
      prompts.outro("No files downloaded — see the error above (re-run with --print-logs for full yt-dlp output)")
    }
  },
})
