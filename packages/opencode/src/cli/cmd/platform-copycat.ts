import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { irisFetch, requireAuth, requireUserId, handleApiError, dim, bold, highlight, success } from "./iris-api"
import { homedir } from "os"
import { join } from "path"

// ============================================================================
// Copycat CLI — Phase 6
//
// All 20 actions surface as `iris copycat <action>`. Every command dispatches
// through fl-api `/api/v1/users/{userId}/integrations/execute` (which proxies
// to iris-api's canonical CopycatAiIntegrationService).
//
// All commands accept --brand=<slug> which fl-api auto-resolves to the right
// brand_id + social account routing via Phase 3 bridges.
// ============================================================================

interface ExecOptions {
  spinnerLabel?: string
}

async function callCopycat(action: string, params: Record<string, unknown>, userId: number, opts: ExecOptions = {}): Promise<any> {
  // fl-api contract: { integration, action, parameters }
  // fl-api's CopycatAiIntegrationService either handles the action locally
  // (4 known methods: triggerVideoClipper, downloadYoutubeAudio, downloadYoutubeVideo, createArticle)
  // or proxies to iris-api via IrisApiService::callIntegration() (16 other actions).
  const res = await irisFetch(`/api/v1/users/${userId}/integrations/execute`, {
    method: "POST",
    body: JSON.stringify({
      integration: "copycat-ai",
      action,
      parameters: params,
    }),
  })
  const ok = await handleApiError(res, action)
  if (!ok) return null
  return await res.json()
}

// ============================================================================
// Instagram cookie helpers
// ============================================================================

const COOKIES_DIR = join(homedir(), ".iris", "cookies")
const IG_COOKIES_PATH = join(COOKIES_DIR, "instagram.json")

function isInstagramUrl(url: unknown): boolean {
  return typeof url === "string" && /instagram\.com/i.test(url)
}

function isInstagramAuthError(errorText: string): boolean {
  return /instagram|download.*social.*video|login_required|checkpoint_required/i.test(errorText)
    && /fail|error|403|401|cookie/i.test(errorText)
}

async function loadInstagramCookies(): Promise<any[] | null> {
  try {
    const file = Bun.file(IG_COOKIES_PATH)
    if (await file.exists()) {
      const data = JSON.parse(await file.text())
      // Check if cookies are recent (< 7 days old)
      const cookies = data?.cookies ?? data
      if (Array.isArray(cookies) && cookies.length > 0) {
        const savedAt = data?.saved_at ? new Date(data.saved_at).getTime() : 0
        const sevenDays = 7 * 24 * 60 * 60 * 1000
        if (Date.now() - savedAt < sevenDays) return cookies
      }
    }
  } catch {}
  return null
}

async function captureInstagramCookies(): Promise<any[] | null> {
  prompts.log.info("Instagram requires authentication to download videos.")
  prompts.log.info("Opening a browser window — log into Instagram, then come back here.")

  const spinner = prompts.spinner()
  spinner.start("Launching browser…")

  try {
    // Dynamically require Playwright at runtime — use eval to prevent bundler from resolving
    let chromium: any
    try {
      // eslint-disable-next-line no-eval
      chromium = eval('require')("playwright").chromium
    } catch {
      try {
        chromium = eval('require')("playwright-core").chromium
      } catch {
        prompts.log.error("Playwright not installed. Run: npm install -g playwright && npx playwright install chromium")
        return null
      }
    }
    const browser = await chromium.launch({ headless: false })
    const context = await browser.newContext()
    const page = await context.newPage()

    spinner.stop("Browser opened")
    prompts.log.info("Log into Instagram in the browser window. I'll detect when you're done.")

    await page.goto("https://www.instagram.com/accounts/login/")

    // Wait for successful login (URL changes away from /login/)
    try {
      await page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 120_000 })
    } catch {
      await browser.close()
      prompts.log.error("Login timed out after 2 minutes.")
      return null
    }

    // Give Instagram a moment to set all cookies
    await page.waitForTimeout(3000)

    // Capture cookies
    const cookies = await context.cookies()
    await browser.close()

    if (!cookies.length) {
      prompts.log.error("No cookies captured.")
      return null
    }

    // Save for reuse
    const { existsSync, mkdirSync, writeFileSync } = await import("fs")
    mkdirSync(COOKIES_DIR, { recursive: true })
    writeFileSync(IG_COOKIES_PATH, JSON.stringify({
      cookies,
      saved_at: new Date().toISOString(),
      account: "user",
    }, null, 2), { mode: 0o600 })

    prompts.log.success(`Cookies saved (${cookies.length} cookies) — reusable for 7 days.`)
    return cookies
  } catch (e) {
    spinner.stop("Failed", 1)
    const msg = e instanceof Error ? e.message : String(e)
    prompts.log.error(`Browser auth failed: ${msg}`)
    return null
  }
}

// ============================================================================
// Core action runner with Instagram auto-auth retry
// ============================================================================

async function runAction(args: any, action: string, params: Record<string, unknown>, label: string) {
  UI.empty()
  prompts.intro(`◈  copycat ${action}`)
  const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }
  const userId = await requireUserId(args["user-id"]); if (!userId) { prompts.outro("Done"); return }

  // Strip null/undefined params before sending
  const clean: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) clean[k] = v
  }

  // For Instagram URLs, pre-attach cookies if we have them
  const url = clean.video_url ?? clean.instagram_url ?? clean.url
  if (isInstagramUrl(url)) {
    const existing = await loadInstagramCookies()
    if (existing) {
      clean._instagram_cookies = existing
    }
  }

  const spinner = prompts.spinner()
  spinner.start(label)
  try {
    let data = await callCopycat(action, clean, userId)

    // Detect Instagram auth failure and offer to fix it
    if (data == null && isInstagramUrl(url)) {
      spinner.stop("Instagram auth required", 1)
      const cookies = await captureInstagramCookies()
      if (cookies) {
        clean._instagram_cookies = cookies
        const retrySpinner = prompts.spinner()
        retrySpinner.start("Retrying with cookies…")
        data = await callCopycat(action, clean, userId)
        if (data == null) { retrySpinner.stop("Failed", 1); prompts.outro("Done"); return }
        retrySpinner.stop("Done")
      } else {
        prompts.outro("Done")
        return
      }
    } else if (data == null) {
      spinner.stop("Failed", 1)
      prompts.outro("Done")
      return
    } else {
      // Check if the response itself contains an Instagram auth error
      const errorText = JSON.stringify(data)
      if (isInstagramAuthError(errorText) && isInstagramUrl(url)) {
        spinner.stop("Instagram auth required", 1)
        const cookies = await captureInstagramCookies()
        if (cookies) {
          clean._instagram_cookies = cookies
          const retrySpinner = prompts.spinner()
          retrySpinner.start("Retrying with cookies…")
          data = await callCopycat(action, clean, userId)
          if (data == null) { retrySpinner.stop("Failed", 1); prompts.outro("Done"); return }
          retrySpinner.stop("Done")
        } else {
          prompts.outro("Done")
          return
        }
      } else {
        spinner.stop("Done")
      }
    }

    if (args.json) {
      console.log(JSON.stringify(data, null, 2))
    } else {
      const payload = data?.data ?? data
      if (typeof payload === "object" && payload !== null) {
        for (const [k, v] of Object.entries(payload)) {
          if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
            console.log(`  ${dim(k + ":")} ${String(v).slice(0, 200)}`)
          } else if (Array.isArray(v)) {
            console.log(`  ${dim(k + ":")} ${bold(`[${v.length}]`)}`)
          } else if (v && typeof v === "object") {
            console.log(`  ${dim(k + ":")} ${bold("{…}")}`)
          }
        }
      } else {
        console.log(payload)
      }
    }
    prompts.outro("Done")
  } catch (err) {
    spinner.stop("Error", 1)
    prompts.log.error(err instanceof Error ? err.message : String(err))
    prompts.outro("Done")
  }
}

// ----------------------------------------------------------------------------
// Common option builders
// ----------------------------------------------------------------------------
const commonOpts = (yargs: any) =>
  yargs
    .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" })
    .option("json", { describe: "output raw JSON", type: "boolean", default: false })

// ============================================================================
// 20 actions
// ============================================================================

const TranscribeCommand = cmd({
  command: "transcribe <url>",
  describe: "transcribe a video (YouTube/IG/TikTok/etc.)",
  builder: (y) => commonOpts(y)
    .positional("url", { type: "string", demandOption: true })
    .option("language", { type: "string", describe: "ISO 639-1 code (en, es, …)" }),
  async handler(args) {
    // Delegate to `iris transcribe` which handles local download + whisper
    // for social media, and server-side Supadata for YouTube.
    // This avoids the broken 4-hop server proxy chain entirely.
    const { PlatformTranscribeCommand } = await import("./transcribe")
    await PlatformTranscribeCommand.handler({
      ...args,
      url: args.url,
      local: false,
      json: args.json ?? false,
    })
  },
})

const ClipCommand = cmd({
  command: "clip <url>",
  describe: "trigger viral clip generation from a YouTube URL",
  builder: (y) => commonOpts(y)
    .positional("url", { type: "string", demandOption: true })
    .option("brand", { type: "string", describe: "brand slug (e.g. discover, beatbox, esher)" })
    .option("start", { type: "string", describe: "start time, e.g. '0:30'" })
    .option("duration", { type: "string", describe: "clip duration, e.g. '90s' or '90'" })
    .option("title", { type: "string" })
    .option("text", { type: "string", describe: "marketing caption (auto-generated if omitted)" })
    .option("publish", { type: "boolean", default: true, describe: "publish to social after rendering" })
    .option("article", { type: "boolean", default: false, describe: "also generate an article" }),
  async handler(args) {
    await runAction(args, "trigger_video_clipper", {
      youtube_url: args.url,
      brand: args.brand,
      start_time: args.start,
      duration: args.duration,
      title: args.title,
      text: args.text,
      publish_to_social: args.publish,
      generate_article: args.article,
    }, "Queueing clip job…")
  },
})

const AudioCommand = cmd({
  command: "audio <url>",
  describe: "download YouTube audio as MP3",
  builder: (y) => commonOpts(y)
    .positional("url", { type: "string", demandOption: true })
    .option("filename", { type: "string" })
    .option("gcs", { type: "boolean", default: false, describe: "upload to Google Cloud Storage" }),
  async handler(args) {
    await runAction(args, "download_youtube_audio", {
      youtube_url: args.url,
      output_filename: args.filename,
      upload_to_gcs: args.gcs,
    }, "Downloading audio…")
  },
})

const VideoCommand = cmd({
  command: "video <url>",
  describe: "download a video from any social platform",
  builder: (y) => commonOpts(y)
    .positional("url", { type: "string", demandOption: true })
    .option("filename", { type: "string" })
    .option("format", { type: "string", default: "mp4" })
    .option("quality", { type: "string", default: "best" })
    .option("gcs", { type: "boolean", default: false }),
  async handler(args) {
    await runAction(args, "download_social_media_video", {
      video_url: args.url,
      output_filename: args.filename,
      format: args.format,
      quality: args.quality,
      upload_to_gcs: args.gcs,
    }, "Downloading…")
  },
})

const ArticleCommand = cmd({
  command: "article <url>",
  describe: "generate an article from a YouTube video",
  builder: (y) => commonOpts(y)
    .positional("url", { type: "string", demandOption: true })
    .option("brand", { type: "string" })
    .option("length", { type: "string", default: "medium", describe: "short|medium|long" })
    .option("style", { type: "string", default: "informative" })
    .option("publish-fl", { type: "boolean", default: true })
    .option("publish-social", { type: "boolean", default: false })
    .option("social-platforms", { type: "string", describe: "comma-separated, default: x" }),
  async handler(args) {
    await runAction(args, "generate_article_from_video", {
      youtube_url: args.url,
      brand: args.brand,
      article_length: args.length,
      article_style: args.style,
      publish_to_fl: args["publish-fl"],
      publish_to_social: args["publish-social"],
      social_platforms: args["social-platforms"] ? String(args["social-platforms"]).split(",") : undefined,
    }, "Queueing article…")
  },
})

const ViralCommand = cmd({
  command: "viral <url>",
  describe: "extract viral clips from a YouTube video",
  builder: (y) => commonOpts(y)
    .positional("url", { type: "string", demandOption: true })
    .option("max-clips", { type: "number", default: 3 })
    .option("aspect", { type: "string", default: "9:16" }),
  async handler(args) {
    await runAction(args, "generate_viral_clips", {
      youtube_url: args.url,
      max_clips: args["max-clips"],
      aspect_ratio: args.aspect,
    }, "Generating viral clips…")
  },
})

const PublishCommand = cmd({
  command: "publish <url>",
  describe: "publish a video to social media",
  builder: (y) => commonOpts(y)
    .positional("url", { type: "string", demandOption: true })
    .option("platforms", { type: "string", describe: "comma-separated: instagram,tiktok,x,…", default: "x" })
    .option("caption", { type: "string" })
    .option("brand", { type: "string" }),
  async handler(args) {
    await runAction(args, "publish_to_social_media", {
      video_url: args.url,
      platforms: String(args.platforms).split(","),
      caption: args.caption,
      brand: args.brand,
    }, "Publishing…")
  },
})

const EnrichCommand = cmd({
  command: "enrich <mediaId>",
  describe: "enrich a YouTube video's metadata",
  builder: (y) => commonOpts(y).positional("mediaId", { type: "string", demandOption: true }),
  async handler(args) {
    await runAction(args, "enrich_video_data", { media_id: args.mediaId }, "Enriching…")
  },
})

const AnalyzeCommand = cmd({
  command: "analyze <url>",
  describe: "analyze video content (transcript + AI summary + ZIP export)",
  builder: (y) => commonOpts(y)
    .positional("url", { type: "string", demandOption: true })
    .option("summary", { type: "boolean", default: true })
    .option("zip", { type: "boolean", default: true }),
  async handler(args) {
    await runAction(args, "analyze_video_content", {
      youtube_url: args.url,
      include_summary: args.summary,
      export_zip: args.zip,
    }, "Analyzing…")
  },
})

const UpscaleCommand = cmd({
  command: "upscale <url>",
  describe: "upscale a video",
  builder: (y) => commonOpts(y)
    .positional("url", { type: "string", demandOption: true })
    .option("resolution", { type: "string", default: "1080p", describe: "1080p|1440p|4k" })
    .option("gcs", { type: "boolean", default: true }),
  async handler(args) {
    await runAction(args, "upscale_video", {
      video_url: args.url,
      resolution: args.resolution,
      upload_to_gcs: args.gcs,
    }, "Upscaling…")
  },
})

const GifCommand = cmd({
  command: "gif <url>",
  describe: "convert a video clip to GIF",
  builder: (y) => commonOpts(y)
    .positional("url", { type: "string", demandOption: true })
    .option("fps", { type: "number", default: 10 })
    .option("width", { type: "number", default: 640 })
    .option("start", { type: "number", default: 0 })
    .option("duration", { type: "number" })
    .option("quality", { type: "string", default: "high" }),
  async handler(args) {
    await runAction(args, "convert_video_to_gif", {
      video_url: args.url,
      fps: args.fps,
      width: args.width,
      start_time: args.start,
      duration: args.duration,
      quality: args.quality,
    }, "Converting…")
  },
})

const MergeCommand = cmd({
  command: "merge <urls...>",
  describe: "merge multiple videos into one",
  builder: (y) => commonOpts(y)
    .positional("urls", { type: "string", demandOption: true, array: true })
    .option("transition", { type: "string", default: "cut", describe: "cut|fade|dissolve" })
    .option("transition-duration", { type: "number", default: 0.5 }),
  async handler(args) {
    await runAction(args, "merge_videos", {
      video_urls: args.urls,
      transition_type: args.transition,
      transition_duration: args["transition-duration"],
    }, "Merging…")
  },
})

const ScraperScriptCommand = cmd({
  command: "scraper-script",
  describe: "get the YouTube scraper script + brand profiles",
  builder: (y) => commonOpts(y),
  async handler(args) {
    await runAction(args, "get_youtube_scraper_script", {}, "Loading…")
  },
})

const CmsPublishCommand = cmd({
  command: "cms-publish",
  describe: "publish content to FL CMS",
  builder: (y) => commonOpts(y)
    .option("title", { type: "string", demandOption: true })
    .option("media-id", { type: "string", demandOption: true })
    .option("profile-id", { type: "number", demandOption: true })
    .option("description", { type: "string" })
    .option("photo-url", { type: "string" }),
  async handler(args) {
    await runAction(args, "publish_content_to_cms", {
      title: args.title,
      media_id: args["media-id"],
      profile_id: args["profile-id"],
      description: args.description,
      photo_url: args["photo-url"],
    }, "Publishing to CMS…")
  },
})

const BatchUploadCommand = cmd({
  command: "batch-upload",
  describe: "batch upload curated videos to CMS (videos JSON file)",
  builder: (y) => commonOpts(y)
    .option("videos", { type: "string", demandOption: true, describe: "path to videos JSON file" })
    .option("site-analysis", { type: "string" })
    .option("min-quota", { type: "number", default: 5 }),
  async handler(args) {
    const fs = await import("fs/promises")
    const raw = await fs.readFile(String(args.videos), "utf-8")
    const videos = JSON.parse(raw)
    await runAction(args, "batch_upload_videos", {
      videos,
      site_analysis: args["site-analysis"],
      min_quota: args["min-quota"],
    }, "Batch uploading…")
  },
})

const BatchArticleCommand = cmd({
  command: "batch-article",
  describe: "create one article from N videos",
  builder: (y) => commonOpts(y)
    .option("videos", { type: "string", demandOption: true, describe: "path to videos JSON file" })
    .option("focus", { type: "string", default: "trends and patterns" }),
  async handler(args) {
    const fs = await import("fs/promises")
    const raw = await fs.readFile(String(args.videos), "utf-8")
    const videos = JSON.parse(raw)
    await runAction(args, "batch_create_article", {
      videos,
      analysis_focus: args.focus,
    }, "Generating batch article…")
  },
})

const CalendarCommand = cmd({
  command: "calendar",
  describe: "generate a marketing calendar from videos",
  builder: (y) => commonOpts(y)
    .option("videos", { type: "string", demandOption: true })
    .option("posts-per-week", { type: "number", default: 3 })
    .option("target-views", { type: "number", default: 1000 })
    .option("weeks", { type: "number", default: 4 })
    .option("notes", { type: "string" })
    .option("profile-id", { type: "number" }),
  async handler(args) {
    const fs = await import("fs/promises")
    const raw = await fs.readFile(String(args.videos), "utf-8")
    const videos = JSON.parse(raw)
    await runAction(args, "generate_marketing_calendar", {
      videos,
      posts_per_week: args["posts-per-week"],
      target_views: args["target-views"],
      calendar_weeks: args.weeks,
      special_notes: args.notes,
      profile_id: args["profile-id"],
    }, "Building calendar…")
  },
})

const DiscoverProfilesCommand = cmd({
  command: "discover-profiles",
  describe: "discover social profiles for a brand",
  builder: (y) => commonOpts(y)
    .option("profile", { type: "string", demandOption: true, describe: "path to profile JSON file" })
    .option("platforms", { type: "string", describe: "comma-separated platform filter" }),
  async handler(args) {
    const fs = await import("fs/promises")
    const raw = await fs.readFile(String(args.profile), "utf-8")
    const profile = JSON.parse(raw)
    await runAction(args, "discover_social_profiles", {
      profile,
      specific_platforms: args.platforms ? String(args.platforms).split(",") : undefined,
    }, "Discovering…")
  },
})

const InstagramCommand = cmd({
  command: "instagram <url>",
  describe: "download an Instagram video",
  builder: (y) => commonOpts(y)
    .positional("url", { type: "string", demandOption: true })
    .option("filename", { type: "string" })
    .option("gcs", { type: "boolean", default: false }),
  async handler(args) {
    await runAction(args, "download_instagram_video", {
      instagram_url: args.url,
      output_filename: args.filename,
      upload_to_gcs: args.gcs,
    }, "Downloading…")
  },
})

const GenerateArticleCommand = cmd({
  command: "article-from <source>",
  describe: "generate an article from topic, webpage, RSS, or video",
  builder: (y) => commonOpts(y)
    .positional("source", { type: "string", demandOption: true })
    .option("type", { type: "string", default: "topic", describe: "topic|webpage|rss_feed|video" })
    .option("max-sources", { type: "number", default: 5 })
    .option("brand", { type: "string" })
    .option("length", { type: "string", default: "medium" }),
  async handler(args) {
    await runAction(args, "generate_article", {
      source_type: args.type,
      source: args.source,
      max_sources: args["max-sources"],
      brand: args.brand,
      article_length: args.length,
    }, "Queueing article…")
  },
})

// ============================================================================
// Root command
// ============================================================================

export const PlatformCopycatCommand = cmd({
  command: "copycat",
  aliases: ["cc"],
  describe: "Copycat AI — clip, transcribe, publish, generate (20 actions)",
  builder: (yargs) =>
    yargs
      .command(TranscribeCommand)
      .command(ClipCommand)
      .command(AudioCommand)
      .command(VideoCommand)
      .command(InstagramCommand)
      .command(ArticleCommand)
      .command(GenerateArticleCommand)
      .command(ViralCommand)
      .command(PublishCommand)
      .command(EnrichCommand)
      .command(AnalyzeCommand)
      .command(UpscaleCommand)
      .command(GifCommand)
      .command(MergeCommand)
      .command(ScraperScriptCommand)
      .command(CmsPublishCommand)
      .command(BatchUploadCommand)
      .command(BatchArticleCommand)
      .command(CalendarCommand)
      .command(DiscoverProfilesCommand)
      .demandCommand(),
  async handler() {},
})
