import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, requireAuth, requireUserId, handleApiError, dim, bold, success } from "./iris-api"
import { resolveOpenAIKey, aiGenerateCarouselProps, fetchBrandTokens, resolveRemotionDir } from "./platform-remotion"
import { spawnSync } from "child_process"
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "fs"
import { join } from "path"
import { homedir } from "os"

// ============================================================================
// Readiness checklist — mode-driven templates
// ============================================================================

type ReleaseMode = "feature" | "artist" | "custom"

interface CheckItem {
  label: string
  ok: boolean
  detail: string
  autoFixable: boolean
}

interface ChecklistOpts {
  title: string
  description: string | null
  brand: string
  mode: ReleaseMode
  hasOpenAI: boolean
  discordWebhook: string | null
  authToken: string | null
  caption: string | null
  carouselDir: string | null
  graphicPath: string | null
  videoPath: string | null
  walkthroughPath: string | null
  skipCarousel: boolean
  skipVideo: boolean
  skipWalkthrough: boolean
  skipDiscord: boolean
  skipSocial: boolean
  skipEmail: boolean
  skipPage: boolean
  pageSlug: string | null
  customItems: string[]
  // Artist-mode state
  interviewScheduled: boolean
  deliverables: number
  deliverableTarget: number
  outreachDraft: boolean
}

function buildChecklist(opts: ChecklistOpts): CheckItem[] {
  // Common items shared by all modes
  const common: CheckItem[] = [
    {
      label: opts.mode === "artist" ? "Artist / creator name" : "Release title",
      ok: !!opts.title,
      detail: opts.title ? `"${opts.title}"` : "missing (required arg)",
      autoFixable: false,
    },
    {
      label: "Description",
      ok: !!opts.description,
      detail: opts.description ? `provided (${opts.description.length} chars)` : "will prompt interactively",
      autoFixable: true,
    },
    {
      label: "Brand config",
      ok: true,
      detail: opts.brand,
      autoFixable: false,
    },
    {
      label: "IRIS auth",
      ok: !!opts.authToken,
      detail: opts.authToken ? "authenticated" : "run: iris auth login",
      autoFixable: false,
    },
  ]

  if (opts.mode === "artist") {
    return [
      ...common,
      {
        label: "Interview scheduled",
        ok: opts.interviewScheduled,
        detail: opts.interviewScheduled ? "confirmed" : "not yet — schedule via iris leads:meeting",
        autoFixable: false,
      },
      {
        label: "Promo graphic",
        ok: !!opts.graphicPath,
        detail: opts.graphicPath ? "rendered" : "will render",
        autoFixable: true,
      },
      {
        label: "Carousel slides (9)",
        ok: opts.skipCarousel || !!opts.carouselDir,
        detail: opts.skipCarousel ? "skipped" : opts.carouselDir ? "rendered" : "will generate (9 slides)",
        autoFixable: true,
      },
      {
        label: `Deliverables (${opts.deliverableTarget})`,
        ok: opts.deliverables >= opts.deliverableTarget,
        detail: `${opts.deliverables}/${opts.deliverableTarget} complete`,
        autoFixable: false,
      },
      {
        label: "Social caption",
        ok: opts.skipSocial || !!opts.caption,
        detail: opts.skipSocial ? "skipped" : opts.caption ? `ready (${opts.caption.length} chars)` : "will AI-generate",
        autoFixable: true,
      },
      {
        label: "Outreach email draft",
        ok: opts.skipEmail || opts.outreachDraft,
        detail: opts.skipEmail ? "skipped" : opts.outreachDraft ? "ready" : "will AI-generate",
        autoFixable: true,
      },
      {
        label: "Social publish",
        ok: opts.skipSocial || !!opts.caption,
        detail: opts.skipSocial ? "skipped" : "ready",
        autoFixable: true,
      },
    ]
  }

  if (opts.mode === "custom") {
    const customChecks: CheckItem[] = opts.customItems.map((item) => ({
      label: item,
      ok: false,
      detail: "manual — mark complete in manifest",
      autoFixable: false,
    }))
    return [...common, ...customChecks]
  }

  // Default: feature mode
  return [
    ...common,
    {
      label: "OpenAI API key",
      ok: opts.hasOpenAI,
      detail: opts.hasOpenAI ? "found" : "not configured",
      autoFixable: false,
    },
    {
      label: "Discord webhook",
      ok: opts.skipDiscord || !!opts.discordWebhook,
      detail: opts.skipDiscord ? "skipped" : opts.discordWebhook ? "configured" : "not configured",
      autoFixable: false,
    },
    {
      label: "Social caption",
      ok: opts.skipSocial || !!opts.caption,
      detail: opts.skipSocial ? "skipped" : opts.caption ? `ready (${opts.caption.length} chars)` : "will AI-generate",
      autoFixable: true,
    },
    {
      label: "Carousel slides (9)",
      ok: opts.skipCarousel || !!opts.carouselDir,
      detail: opts.skipCarousel ? "skipped" : opts.carouselDir ? "rendered" : "will generate (9 slides)",
      autoFixable: true,
    },
    {
      label: "Announcement graphic",
      ok: opts.skipCarousel || !!opts.graphicPath,
      detail: opts.skipCarousel ? "skipped" : opts.graphicPath ? "rendered" : "will render",
      autoFixable: true,
    },
    {
      label: "Video assets",
      ok: opts.skipVideo || !!opts.videoPath,
      detail: opts.skipVideo ? "skipped" : opts.videoPath ? "rendered" : "will render",
      autoFixable: true,
    },
    {
      label: "Walkthrough video",
      ok: opts.skipWalkthrough || !!opts.walkthroughPath,
      detail: opts.skipWalkthrough ? "skipped" : opts.walkthroughPath ? "recorded" : "will record via Playwright",
      autoFixable: true,
    },
    {
      label: "Email blast",
      ok: opts.skipEmail,
      detail: opts.skipEmail ? "skipped" : "will send via outreach",
      autoFixable: true,
    },
    {
      label: "Genesis page",
      ok: opts.skipPage || !!opts.pageSlug,
      detail: opts.skipPage ? "skipped" : opts.pageSlug ? `published: /p/${opts.pageSlug}` : "will generate + push",
      autoFixable: true,
    },
  ]
}

function printChecklist(items: CheckItem[]): void {
  const done = items.filter((i) => i.ok).length
  const total = items.length
  const autoFix = items.filter((i) => !i.ok && i.autoFixable).length

  console.log()
  console.log(`  Readiness: ${done}/${total}`)
  console.log()

  for (const item of items) {
    const check = item.ok ? "[x]" : "[ ]"
    const dots = ".".repeat(Math.max(2, 28 - item.label.length))
    console.log(`  ${check} ${item.label} ${dim(dots)} ${item.detail}`)
  }

  if (autoFix > 0) {
    console.log()
    console.log(`  ${autoFix} item${autoFix > 1 ? "s" : ""} will be auto-generated`)
  }
  console.log()
}

// ============================================================================
// Discord webhook resolution
// ============================================================================

export async function resolveDiscordWebhook(): Promise<string | null> {
  for (const key of ["DISCORD_RELEASE_WEBHOOK_URL", "PLATFORM_UPDATES_DISCORD_CHANNEL_WEBHOOK_URL"]) {
    if (process.env[key]) return process.env[key]!
  }
  // Fall back to the local .env files the user already configures. The Discord
  // webhook commonly lives in the Hive bridge env (PLATFORM_UPDATES_…), so check
  // both the SDK and bridge env files.
  for (const envPath of [
    join(homedir(), ".iris", "sdk", ".env"),
    join(homedir(), ".iris", "bridge", ".env"),
  ]) {
    try {
      if (!existsSync(envPath)) continue
      const raw = readFileSync(envPath, "utf-8")
      const text = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw
      for (const line of text.split("\n")) {
        for (const key of ["DISCORD_RELEASE_WEBHOOK_URL", "PLATFORM_UPDATES_DISCORD_CHANNEL_WEBHOOK_URL"]) {
          const m = line.match(new RegExp(`^${key}\\s*=\\s*(.+)`))
          if (m?.[1]) return m[1].trim()
        }
      }
    } catch {}
  }
  return null
}

// ============================================================================
// Source material resolution (reused from platform-remotion.ts pattern)
// ============================================================================

async function resolveSourceMaterial(from: string): Promise<{ context: string; label: string } | null> {
  const diaryMatch = from.match(/^diary:(.+)$/i)
  if (diaryMatch) {
    const slug = diaryMatch[1]
    let diaryDir = join(process.cwd(), "daily-diary")
    if (!existsSync(diaryDir)) {
      let d = process.cwd()
      for (let i = 0; i < 10; i++) {
        if (existsSync(join(d, "daily-diary"))) { diaryDir = join(d, "daily-diary"); break }
        const parent = join(d, "..")
        if (parent === d) break
        d = parent
      }
    }
    if (existsSync(diaryDir)) {
      const files = readdirSync(diaryDir) as string[]
      const exact = files.find((f: string) => f === `${slug}.md`)
      const prefix = files.filter((f: string) => f.startsWith(slug) && f.endsWith(".md")).sort().reverse()
      const diaryFile = exact ? join(diaryDir, exact) : prefix.length > 0 ? join(diaryDir, prefix[0]) : null
      if (diaryFile && existsSync(diaryFile)) {
        return { context: readFileSync(diaryFile, "utf-8"), label: `Diary: ${require("path").basename(diaryFile, ".md")}` }
      }
    }
    return null
  }

  const oppMatch = from.match(/^opportunity:(\d+)$/i)
  if (oppMatch) {
    const res = await irisFetch(`/api/v1/marketplace/opportunities/${oppMatch[1]}`)
    const ok = await handleApiError(res, `Fetch opportunity #${oppMatch[1]}`)
    if (!ok) return null
    const json = (await res.json()) as any
    const opp = json.data ?? json
    return { context: JSON.stringify(opp, null, 2), label: `Opportunity #${opp.id}: ${opp.title}` }
  }

  // Freeform text
  return { context: from, label: from.slice(0, 60) }
}

// ============================================================================
// Asset generation helpers
// ============================================================================

function renderCarouselSlides(
  props: Record<string, unknown>,
  outDir: string,
  rDir: string,
  variant: string,
): boolean {
  const carouselDir = join(outDir, "carousel")
  mkdirSync(carouselDir, { recursive: true })

  for (let i = 0; i < 9; i++) {
    const outFile = join(carouselDir, `slide-${i}.png`)
    const slideProps = { ...props, slideIndex: i }
    const propsFile = join(outDir, `_props-${i}.json`)
    writeFileSync(propsFile, JSON.stringify(slideProps))

    const compositionId = variant === "editorial" ? `EditorialSlide${i}` : `CarouselSlide${i}`
    const result = spawnSync(
      "npx",
      ["remotion", "still", compositionId, outFile, `--props=${propsFile}`],
      { stdio: "pipe", env: process.env, cwd: rDir },
    )
    // Cleanup temp props
    try { require("fs").unlinkSync(propsFile) } catch {}

    if (result.status !== 0) {
      const stderr = result.stderr?.toString() ?? ""
      prompts.log.error(`Slide ${i}: ${stderr.slice(0, 200)}`)
      return false
    }
  }
  return true
}

function renderGraphic(
  props: Record<string, unknown>,
  outDir: string,
  rDir: string,
): boolean {
  const outFile = join(outDir, "announcement.png")
  const graphicProps = {
    brand: props.brand,
    headline: props.headline,
    roles: props.checklistItems,
    handle: props.ctaSubtext ?? `@${props.brand}`,
    subtitle: props.subtitle,
  }
  const propsFile = join(outDir, "_graphic-props.json")
  writeFileSync(propsFile, JSON.stringify(graphicProps))

  const result = spawnSync(
    "npx",
    ["remotion", "still", "SocialPostStill", outFile, `--props=${propsFile}`],
    { stdio: "pipe", env: process.env, cwd: rDir },
  )
  try { require("fs").unlinkSync(propsFile) } catch {}
  return result.status === 0
}

function renderVideo(outDir: string, rDir: string): boolean {
  const introPath = join(outDir, "brand-intro.mp4")
  const outroPath = join(outDir, "brand-outro.mp4")
  const outputPath = join(outDir, "release-video.mp4")

  // Check ffmpeg availability
  const ffmpegCheck = spawnSync("which", ["ffmpeg"], { stdio: "pipe" })
  if (ffmpegCheck.status !== 0) return false

  // Render BrandIntro (2.5s = 75 frames at 30fps)
  const introResult = spawnSync(
    "npx",
    ["remotion", "render", "BrandIntro", introPath],
    { stdio: "pipe", env: process.env, cwd: rDir },
  )
  if (introResult.status !== 0) return false

  // Render BrandOutro (4s = 120 frames at 30fps)
  const outroResult = spawnSync(
    "npx",
    ["remotion", "render", "BrandOutro", outroPath],
    { stdio: "pipe", env: process.env, cwd: rDir },
  )
  if (outroResult.status !== 0) return false

  // Concat with ffmpeg
  const concatResult = spawnSync(
    "ffmpeg",
    ["-y", "-i", introPath, "-i", outroPath, "-filter_complex", "concat=n=2:v=1:a=0", outputPath],
    { stdio: "pipe" },
  )
  return concatResult.status === 0
}

// ============================================================================
// Walkthrough video recording (Playwright)
// ============================================================================

function recordWalkthrough(outDir: string, specPath?: string): string | null {
  // Check if npx playwright is available
  const check = spawnSync("npx", ["playwright", "--version"], { stdio: "pipe" })
  if (check.status !== 0) return null

  const outputVideo = join(outDir, "walkthrough.webm")

  // If a spec file was provided, run it directly
  if (specPath && existsSync(specPath)) {
    const result = spawnSync(
      "npx",
      ["playwright", "test", specPath, "--reporter=list"],
      { stdio: "pipe", env: { ...process.env, PWVIDEO_DIR: outDir }, cwd: process.cwd(), timeout: 120000 },
    )
    // Playwright saves video in test-results/ — find and copy it
    const testResultsDir = join(process.cwd(), "test-results")
    if (existsSync(testResultsDir)) {
      const dirs = readdirSync(testResultsDir).filter((d) => existsSync(join(testResultsDir, d, "video.webm")))
      if (dirs.length > 0) {
        // Copy the most recent video
        const latestDir = dirs.sort().reverse()[0]
        const src = join(testResultsDir, latestDir, "video.webm")
        require("fs").copyFileSync(src, outputVideo)
        return outputVideo
      }
    }
    return result.status === 0 ? outputVideo : null
  }

  // No spec file — check for an existing walkthrough video in test-results/
  const testResultsDir = join(process.cwd(), "test-results")
  if (existsSync(testResultsDir)) {
    const dirs = readdirSync(testResultsDir)
      .filter((d) => existsSync(join(testResultsDir, d, "video.webm")))
      .sort()
      .reverse()
    if (dirs.length > 0) {
      const src = join(testResultsDir, dirs[0], "video.webm")
      require("fs").copyFileSync(src, outputVideo)
      return outputVideo
    }
  }

  return null
}

// ============================================================================
// Genesis page builder — creates a release showcase page from the manifest
// ============================================================================

function buildReleasePageJson(opts: {
  title: string
  description: string
  brand: string
  slug: string
  carouselProps: Record<string, unknown> | null
  walkthroughUrl: string | null
  releaseVideoUrl: string | null
  graphicUrl: string | null
  tag: string | null
}): Record<string, unknown> {
  const components: Record<string, unknown>[] = []

  // 1. Navigation
  components.push({
    type: "IrisNavigation",
    id: "nav",
    props: { themeMode: "dark" },
  })

  // 2. Hero — big announcement header
  components.push({
    type: "Hero",
    id: "hero",
    props: {
      title: opts.title,
      subtitle: opts.description,
      backgroundStyle: "gradient",
      themeMode: "dark",
      alignment: "center",
      badge: opts.tag ?? "New Release",
    },
  })

  // 3. Walkthrough video (if available)
  if (opts.walkthroughUrl) {
    components.push({
      type: "VideoBlock",
      id: "walkthrough",
      props: {
        title: "See It In Action",
        description: "Watch a full walkthrough of the feature.",
        src: opts.walkthroughUrl,
        autoplay: false,
        loop: false,
        muted: true,
        controls: true,
        aspectRatio: "16:9",
        maxWidth: "4xl",
        alignment: "center",
        themeMode: "dark",
      },
    })
  }

  // 4. Feature showcase from carousel tips
  if (opts.carouselProps?.tips) {
    const tips = opts.carouselProps.tips as Array<{ title: string; body: string }>
    components.push({
      type: "FeatureShowcase",
      id: "features",
      props: {
        heading: "What's New",
        subheading: String(opts.carouselProps.subtitle ?? ""),
        layout: "alternating",
        themeMode: "dark",
        accentColor: "#8b5cf6",
        features: tips.map((t) => ({
          heading: t.title,
          title: t.title,
          description: t.body,
          imageUrl: "",
        })),
      },
    })
  }

  // 5. Stats from carousel
  if (opts.carouselProps?.stats) {
    const stats = opts.carouselProps.stats as Array<{ value: string; label: string }>
    components.push({
      type: "StatsCounter",
      id: "stats",
      props: {
        stats: stats.map((s) => ({ value: s.value, label: s.label })),
        themeMode: "dark",
        accentColor: "purple",
      },
    })
  }

  // 6. Code showcase (if codeSnippet present)
  if (opts.carouselProps?.codeSnippet) {
    components.push({
      type: "CodeShowcase",
      id: "code",
      props: {
        title: "Quick Start",
        subtitle: "Get started with one command",
        code: String(opts.carouselProps.codeSnippet),
        langId: "bash",
      },
    })
  }

  // 7. Brand intro video (if available)
  if (opts.releaseVideoUrl) {
    components.push({
      type: "VideoBlock",
      id: "brand-video",
      props: {
        title: "Brand Intro",
        src: opts.releaseVideoUrl,
        autoplay: true,
        loop: true,
        muted: true,
        controls: false,
        aspectRatio: "16:9",
        maxWidth: "2xl",
        alignment: "center",
        themeMode: "dark",
      },
    })
  }

  // 8. Checklist / use cases
  if (opts.carouselProps?.checklistItems) {
    const items = opts.carouselProps.checklistItems as string[]
    components.push({
      type: "FeatureShowcase",
      id: "use-cases",
      props: {
        heading: String(opts.carouselProps.checklistTitle ?? "What This Unlocks"),
        layout: "grid",
        themeMode: "dark",
        accentColor: "#8b5cf6",
        features: items.map((item) => ({
          heading: item,
          title: item,
          description: item,
          imageUrl: "",
        })),
      },
    })
  }

  // 9. CTA
  components.push({
    type: "ButtonCTA",
    id: "cta",
    props: {
      text: opts.carouselProps?.ctaButtonText ?? "Get Started",
      url: "https://heyiris.io",
      style: "primary",
      size: "large",
      alignment: "center",
      themeMode: "dark",
    },
  })

  // 10. Footer
  components.push({
    type: "SiteFooter",
    id: "footer",
    props: { themeMode: "dark" },
  })

  return {
    slug: opts.slug,
    title: `${opts.title} — Release`,
    seo_title: `${opts.title} | IRIS Platform`,
    seo_description: opts.description,
    status: "published",
    owner_type: "user",
    owner_id: 1,
    json_content: {
      version: "1.0",
      type: "landing",
      theme: {
        mode: "dark",
        backgroundColor: "#0a0a0a",
        branding: {
          name: opts.brand.toUpperCase(),
          primaryColor: "#6366f1",
          secondaryColor: "#8b5cf6",
        },
      },
      components,
    },
  }
}

async function pushGenesisPage(pageJson: Record<string, unknown>): Promise<string | null> {
  const slug = pageJson.slug as string
  const res = await irisFetch(`/api/v1/pages/${slug}`, {
    method: "PUT",
    body: JSON.stringify(pageJson),
  })
  if (res.ok) return slug
  // Try create if update fails
  const createRes = await irisFetch("/api/v1/pages", {
    method: "POST",
    body: JSON.stringify(pageJson),
  })
  return createRes.ok ? slug : null
}

// ============================================================================
// Publish helpers
// ============================================================================

async function publishDiscord(
  webhook: string,
  title: string,
  description: string,
  brand: string,
  version?: string,
  assetCount?: number,
): Promise<boolean> {
  const fields: Array<{ name: string; value: string; inline: boolean }> = []
  if (version) fields.push({ name: "Version", value: version, inline: true })
  fields.push({ name: "Brand", value: brand, inline: true })
  if (assetCount) fields.push({ name: "Assets", value: `${assetCount} generated`, inline: true })

  const res = await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      embeds: [{
        title: `Release: ${title}`,
        description,
        color: 0x8b5cf6,
        fields,
        footer: { text: "IRIS Release Pipeline" },
        timestamp: new Date().toISOString(),
      }],
    }),
  })
  return res.ok
}

async function publishSocial(
  userId: number,
  platforms: string[],
  caption: string,
): Promise<boolean> {
  const res = await irisFetch(`/api/v1/users/${userId}/integrations/execute`, {
    method: "POST",
    body: JSON.stringify({
      integration: "copycat-ai",
      action: "publish_to_social_media",
      parameters: { platforms, caption },
    }),
  })
  return res.ok
}

// ============================================================================
// Main command
// ============================================================================

const AnnounceCommand = cmd({
  command: "announce <title>",
  describe: "Run the full release pipeline: checklist, assets, publish",
  builder: (yargs) =>
    yargs
      .positional("title", {
        describe: "Feature release title",
        type: "string",
        demandOption: true,
      })
      .option("brand", {
        type: "string",
        alias: "b",
        describe: "Brand slug (default: freelabel)",
        default: "freelabel",
      })
      .option("description", {
        type: "string",
        alias: "d",
        describe: "Feature description (prompted if missing)",
      })
      .option("tag", {
        type: "string",
        describe: "Optional version tag (e.g., v1.2.0)",
      })
      .option("variant", {
        type: "string",
        describe: "Carousel variant: default or editorial",
        choices: ["default", "editorial"],
        default: "default",
      })
      .option("from", {
        type: "string",
        describe: 'Source material: "diary:2026-05-15", "opportunity:519", or freeform text',
      })
      .option("platforms", {
        type: "string",
        describe: "Social platforms (comma-separated)",
        default: "x",
      })
      .option("mode", {
        type: "string",
        alias: "m",
        describe: "Release mode: feature (dev), artist (creator), custom",
        choices: ["feature", "artist", "custom"],
        default: "feature",
      })
      .option("checklist", {
        type: "string",
        describe: "Custom checklist items (comma-separated, for --mode custom)",
      })
      .option("deliverables", {
        type: "number",
        describe: "Number of deliverables completed (artist mode)",
        default: 0,
      })
      .option("deliverable-target", {
        type: "number",
        describe: "Total deliverables expected (artist mode)",
        default: 6,
      })
      .option("interview", {
        type: "boolean",
        describe: "Interview has been scheduled (artist mode)",
        default: false,
      })
      .option("walkthrough", {
        type: "string",
        describe: "Path to Playwright spec for walkthrough recording, or existing .webm file",
      })
      .option("skip-carousel", { type: "boolean", default: false })
      .option("skip-video", { type: "boolean", default: false })
      .option("skip-walkthrough", { type: "boolean", default: false })
      .option("skip-discord", { type: "boolean", default: false })
      .option("skip-social", { type: "boolean", default: false })
      .option("skip-email", { type: "boolean", default: false })
      .option("skip-page", { type: "boolean", default: false })
      .option("dry-run", { type: "boolean", describe: "Print checklist only, no generation or publishing", default: false })
      .option("output", { type: "string", alias: "o", describe: "Output directory" })
      .option("open", { type: "boolean", describe: "Open output folder when done", default: true })
      .option("user-id", { type: "number", describe: "Override user ID for social publishing" }),
  async handler(args) {
    UI.empty()
    const modeLabel = (args.mode as string) || "feature"
    prompts.intro(`◈  Release Announce (${modeLabel} mode)`)

    const title = args.title as string
    const brand = args.brand as string
    const variant = (args.variant as string) || "default"
    const mode = (args.mode as ReleaseMode) || "feature"
    const skipCarousel = args["skip-carousel"] as boolean
    const skipVideo = args["skip-video"] as boolean
    const skipWalkthrough = args["skip-walkthrough"] as boolean
    const skipDiscord = args["skip-discord"] as boolean
    const skipSocial = args["skip-social"] as boolean
    const skipEmail = args["skip-email"] as boolean
    const skipPage = args["skip-page"] as boolean
    const dryRun = args["dry-run"] as boolean
    const customItems = args.checklist ? String(args.checklist).split(",").map((s) => s.trim()) : []

    // ── Step 1: Resolve prerequisites ──
    const spinner = prompts.spinner()
    spinner.start("Resolving prerequisites...")

    const authToken = await requireAuth()
    const hasOpenAI = !!(await resolveOpenAIKey())
    const discordWebhook = await resolveDiscordWebhook()
    let description = (args.description as string) || null

    spinner.stop(success("Prerequisites checked"))

    // ── Step 2: Prompt for description if missing ──
    if (!description) {
      if (args.from) {
        spinner.start("Gathering source material...")
        const source = await resolveSourceMaterial(args.from as string)
        if (source) {
          // Use source as description context — AI will refine later
          description = source.context.slice(0, 500)
          spinner.stop(success(`Source: ${source.label}`))
        } else {
          spinner.stop("Source not found")
        }
      }
      if (!description) {
        const input = await prompts.text({
          message: "Describe the feature release:",
          placeholder: "What does this release do? Who benefits?",
        })
        if (typeof input === "string" && input.trim()) {
          description = input.trim()
        } else {
          prompts.log.error("Description is required")
          prompts.outro("Done")
          return
        }
      }
    }

    // ── Step 3: Print initial readiness checklist ──
    const checklistBase: ChecklistOpts = {
      title,
      description,
      brand,
      mode,
      hasOpenAI,
      discordWebhook,
      authToken,
      caption: null,
      carouselDir: null,
      graphicPath: null,
      videoPath: null,
      walkthroughPath: null,
      skipCarousel,
      skipVideo,
      skipWalkthrough,
      skipDiscord,
      skipSocial,
      skipEmail,
      skipPage,
      pageSlug: null,
      customItems,
      interviewScheduled: args.interview as boolean,
      deliverables: args.deliverables as number,
      deliverableTarget: args["deliverable-target"] as number,
      outreachDraft: false,
    }
    printChecklist(buildChecklist(checklistBase))

    // Check hard requirements
    if (!title) {
      prompts.log.error("Feature title is required")
      prompts.outro("Done")
      return
    }

    if (dryRun) {
      prompts.outro("Dry run complete")
      return
    }

    // ── Step 4: Setup output directory ──
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
    const outDir = (args.output as string) || join(process.cwd(), `release-${timestamp}`)
    mkdirSync(outDir, { recursive: true })

    // ── Step 5: Resolve source material for AI generation ──
    let sourceContext = description
    if (args.from) {
      const source = await resolveSourceMaterial(args.from as string)
      if (source) sourceContext = source.context
    }

    // ── Step 6: Generate carousel ──
    let carouselDir: string | null = null
    let carouselProps: Record<string, unknown> | null = null

    if (!skipCarousel && hasOpenAI) {
      const carouselMode = mode === "artist" ? "recruit" : "feature"
      spinner.start(`AI generating carousel content (${carouselMode} mode)...`)
      carouselProps = await aiGenerateCarouselProps(sourceContext, brand, carouselMode)
      if (carouselProps) {
        // Resolve brand tokens for custom brands
        const builtIn = ["freelabel", "discover", "heyiris", "beatbox", "emc_radio", "capital_collective"]
        if (!builtIn.includes(brand)) {
          const tokenData = await fetchBrandTokens(brand)
          if (tokenData) {
            const tokens = (tokenData as any).design_tokens ?? {}
            const semantic = tokens.semantic ?? {}
            if (semantic.bg_page) carouselProps.bgOverride = semantic.bg_page
            if (semantic.bg_brand) carouselProps.accentOverride = semantic.bg_brand
            if (semantic.fg_primary) carouselProps.textOverride = semantic.fg_primary
            carouselProps.handleOverride = `@${brand}`
          }
        }
        carouselProps.brand = builtIn.includes(brand) ? brand : "freelabel"

        // Save props
        writeFileSync(join(outDir, "props.json"), JSON.stringify(carouselProps, null, 2))
        spinner.stop(success("Carousel content generated"))

        // Render slides
        spinner.start("Rendering 9 carousel slides...")
        const rDir = resolveRemotionDir()
        const rendered = renderCarouselSlides(carouselProps, outDir, rDir, variant)
        if (rendered) {
          carouselDir = join(outDir, "carousel")
          spinner.stop(success("9 slides rendered"))

          // Render announcement graphic
          spinner.start("Rendering announcement graphic...")
          const graphicOk = renderGraphic(carouselProps, outDir, rDir)
          spinner.stop(graphicOk ? success("Announcement graphic rendered") : "Graphic render failed")
        } else {
          spinner.stop("Carousel render failed")
        }
      } else {
        spinner.stop("AI generation failed")
      }
    }

    // ── Step 7: Generate video ──
    let videoPath: string | null = null
    if (!skipVideo) {
      spinner.start("Rendering video assets (intro + outro)...")
      const rDir = resolveRemotionDir()
      const videoOk = renderVideo(outDir, rDir)
      if (videoOk) {
        videoPath = join(outDir, "release-video.mp4")
        spinner.stop(success("Video rendered (6.5s)"))
      } else {
        spinner.stop(dim("Video skipped (ffmpeg not available or render failed)"))
      }
    }

    // ── Step 7b: Record walkthrough video ──
    let walkthroughPath: string | null = null
    if (!skipWalkthrough) {
      const walkthroughArg = args.walkthrough as string | undefined
      // If a .webm file was provided directly, just copy it
      if (walkthroughArg && walkthroughArg.endsWith(".webm") && existsSync(walkthroughArg)) {
        require("fs").copyFileSync(walkthroughArg, join(outDir, "walkthrough.webm"))
        walkthroughPath = join(outDir, "walkthrough.webm")
        prompts.log.info(success("Walkthrough video copied from provided file"))
      } else {
        spinner.start("Recording walkthrough video...")
        const specFile = walkthroughArg && existsSync(walkthroughArg) ? walkthroughArg : undefined
        walkthroughPath = recordWalkthrough(outDir, specFile)
        if (walkthroughPath) {
          spinner.stop(success("Walkthrough recorded"))
        } else {
          spinner.stop(dim("Walkthrough skipped (no Playwright spec or existing recording found)"))
        }
      }
    }

    // ── Step 8: Generate caption ──
    let caption: string | null = null
    if (carouselProps) {
      const headline = String(carouselProps.headline ?? title)
      const subtitle = String(carouselProps.subtitle ?? description)
      const ctaSubtext = String(carouselProps.ctaSubtext ?? "heyiris.io")
      caption = `${headline}\n\n${subtitle}\n\n${ctaSubtext}`
      writeFileSync(join(outDir, "caption.txt"), caption)
    } else {
      caption = `${title}\n\n${description}\n\nheyiris.io`
      writeFileSync(join(outDir, "caption.txt"), caption)
    }

    // ── Step 8b: Generate Genesis release page ──
    let pageSlug: string | null = null
    const _graphicExists = existsSync(join(outDir, "announcement.png"))
    if (!skipPage && authToken) {
      spinner.start("Generating Genesis release page...")
      const slugBase = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")
      const slug = `release-${slugBase}`
      const pageJson = buildReleasePageJson({
        title,
        description: description!,
        brand,
        slug,
        carouselProps,
        walkthroughUrl: walkthroughPath ? `walkthrough.webm` : null,
        releaseVideoUrl: videoPath ? `release-video.mp4` : null,
        graphicUrl: _graphicExists ? `announcement.png` : null,
        tag: (args.tag as string) ?? null,
      })
      // Save locally
      writeFileSync(join(outDir, "page.json"), JSON.stringify(pageJson, null, 2))
      // Push to API
      const pushed = await pushGenesisPage(pageJson)
      if (pushed) {
        pageSlug = pushed
        spinner.stop(success(`Genesis page published: /p/${pushed}`))
      } else {
        spinner.stop(dim("Page saved locally (API push failed — use: iris pages push page.json)"))
      }
    }

    // ── Step 9: Print updated checklist ──
    const graphicPath = existsSync(join(outDir, "announcement.png")) ? join(outDir, "announcement.png") : null
    const finalChecklist = buildChecklist({
      ...checklistBase,
      caption,
      carouselDir,
      graphicPath,
      videoPath,
      walkthroughPath,
      pageSlug,
    })
    printChecklist(finalChecklist)

    // ── Step 10: Publish Discord ──
    if (!skipDiscord && discordWebhook) {
      spinner.start("Publishing Discord announcement...")
      const assetCount = (carouselDir ? 9 : 0) + (graphicPath ? 1 : 0) + (videoPath ? 1 : 0)
      const ok = await publishDiscord(
        discordWebhook,
        title,
        description,
        brand,
        args.tag as string | undefined,
        assetCount,
      )
      spinner.stop(ok ? success("Discord announcement published") : "Discord publish failed")
    }

    // ── Step 11: Publish social ──
    if (!skipSocial && authToken && caption) {
      const userId = await requireUserId(args["user-id"] as number | undefined)
      if (userId) {
        spinner.start("Publishing to social media...")
        const platforms = String(args.platforms).split(",").map((p) => p.trim())
        const ok = await publishSocial(userId, platforms, caption)
        spinner.stop(ok ? success("Social media published") : "Social publish failed")
      }
    }

    // ── Step 12: Write manifest ──
    const manifest = {
      title,
      description,
      brand,
      version: args.tag ?? null,
      variant,
      timestamp: new Date().toISOString(),
      assets: {
        props: existsSync(join(outDir, "props.json")) ? "props.json" : null,
        carousel: carouselDir ? Array.from({ length: 9 }, (_, i) => `carousel/slide-${i}.png`) : null,
        graphic: graphicPath ? "announcement.png" : null,
        introVideo: existsSync(join(outDir, "brand-intro.mp4")) ? "brand-intro.mp4" : null,
        outroVideo: existsSync(join(outDir, "brand-outro.mp4")) ? "brand-outro.mp4" : null,
        releaseVideo: videoPath ? "release-video.mp4" : null,
        walkthrough: walkthroughPath ? "walkthrough.webm" : null,
        page: existsSync(join(outDir, "page.json")) ? "page.json" : null,
        caption: "caption.txt",
      },
      page: pageSlug ? { slug: pageSlug, url: `https://freelabel.net/p/${pageSlug}` } : null,
      published: {
        discord: !skipDiscord && !!discordWebhook,
        social: !skipSocial && !!authToken,
        platforms: !skipSocial ? String(args.platforms).split(",") : [],
      },
      checklist: finalChecklist.map((c) => ({ label: c.label, ok: c.ok, detail: c.detail })),
    }
    writeFileSync(join(outDir, "release-manifest.json"), JSON.stringify(manifest, null, 2))

    // ── Done ──
    console.log()
    prompts.log.success(bold(`Release ready: ${outDir}`))
    const assetFiles = Object.values(manifest.assets).flat().filter(Boolean)
    console.log(`  ${dim("Assets:")} ${assetFiles.length} files`)
    console.log(`  ${dim("Manifest:")} ${join(outDir, "release-manifest.json")}`)

    if (args.open) {
      spawnSync("open", [outDir], { stdio: "ignore" })
    }

    prompts.outro("Done")
  },
})

// ============================================================================
// Parent command group
// ============================================================================

export const PlatformReleaseCommand = cmd({
  command: "release <subcommand>",
  describe: "Feature release pipeline (announce, checklist, assets, publish)",
  builder: (yargs) =>
    yargs
      .command(AnnounceCommand)
      .demandCommand(1, "Specify a subcommand: announce"),
  async handler() {
    // handled by subcommands
  },
})
