import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, requireAuth, requireUserId, handleApiError, dim, bold, success, FL_API } from "./iris-api"
import { spawnSync } from "child_process"
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "fs"
import { join, basename } from "path"
import { homedir } from "os"

// ============================================================================
// Helpers
// ============================================================================

function remotionDir(): string {
  return join(homedir(), ".iris", "remotion")
}

function remotionInstalled(): boolean {
  return existsSync(join(remotionDir(), "package.json"))
}

function runIrisRemotion(args: string[]): void {
  const wrapper = join(homedir(), ".iris", "bin", "iris-remotion")
  if (!existsSync(wrapper)) {
    UI.error(`iris-remotion not found. Run: ${process.platform === "win32" ? "irm https://heyiris.io/install-code.ps1 | iex" : "curl -fsSL https://heyiris.io/install-code | bash"}`)
    process.exit(1)
  }
  const result = spawnSync(wrapper, args, { stdio: "inherit", env: process.env })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

// ============================================================================
// Subcommands
// ============================================================================

const RenderCommand = cmd({
  command: "render <composition>",
  describe: "Render a Remotion composition to video (MP4)",
  builder: (yargs) =>
    yargs
      .positional("composition", {
        describe: "Composition name (e.g., SocialPost, BrandIntro)",
        type: "string",
        demandOption: true,
      })
      .option("output", {
        type: "string",
        alias: "o",
        describe: "Output file path",
      })
      .option("props", {
        type: "string",
        describe: "JSON props for the composition",
      }),
  async handler(args) {
    const comp = args.composition as string
    const output = (args.output as string) || join(process.cwd(), "out", `${comp}.mp4`)
    const cmdArgs = ["render", comp, output]
    if (args.props) cmdArgs.push("--props", args.props as string)
    UI.println(`Output: ${output}`)
    runIrisRemotion(cmdArgs)
  },
})

const StillCommand = cmd({
  command: "still <composition>",
  describe: "Render a Remotion composition to a still image (PNG)",
  builder: (yargs) =>
    yargs
      .positional("composition", {
        describe: "Composition name (e.g., SocialPostStill, HiveAdThumbnail)",
        type: "string",
        demandOption: true,
      })
      .option("output", {
        type: "string",
        alias: "o",
        describe: "Output file path",
      })
      .option("props", {
        type: "string",
        describe: "JSON props for the composition",
      }),
  async handler(args) {
    const comp = args.composition as string
    const output = (args.output as string) || join(process.cwd(), "out", `${comp}.png`)
    const cmdArgs = ["still", comp, output]
    if (args.props) cmdArgs.push("--props", args.props as string)
    UI.println(`Output: ${output}`)
    runIrisRemotion(cmdArgs)
  },
})

const PreviewCommand = cmd({
  command: "preview",
  describe: "Open Remotion Studio in the browser",
  builder: (yargs) => yargs,
  async handler() {
    runIrisRemotion(["preview"])
  },
})

const ListCommand = cmd({
  command: "list",
  describe: "List available Remotion compositions",
  builder: (yargs) => yargs,
  async handler() {
    if (!remotionInstalled()) {
      UI.error(`Remotion not installed. Run: ${process.platform === "win32" ? "irm https://heyiris.io/install-code.ps1 | iex" : "curl -fsSL https://heyiris.io/install-code | bash"}`)
      process.exit(1)
    }
    runIrisRemotion(["list"])
  },
})

const InitCommand = cmd({
  command: "init",
  describe: "(Re)install Remotion dependencies",
  builder: (yargs) => yargs,
  async handler() {
    runIrisRemotion(["init"])
  },
})

const UpdateCommand = cmd({
  command: "update",
  describe: "Update Remotion compositions from upstream",
  builder: (yargs) => yargs,
  async handler() {
    runIrisRemotion(["update"])
  },
})

const CarouselCommand = cmd({
  command: "carousel <props>",
  describe: "Batch-render all 9 carousel slides (CarouselSlide0..8)",
  builder: (yargs) =>
    yargs
      .positional("props", {
        describe: "Path to JSON file with { brand, slides: [...] }",
        type: "string",
        demandOption: true,
      })
      .option("output", {
        type: "string",
        alias: "o",
        describe: "Output directory (default: ./carousel-<timestamp>)",
      }),
  async handler(args) {
    const cmdArgs = ["carousel", args.props as string]
    if (args.output) cmdArgs.push(args.output as string)
    runIrisRemotion(cmdArgs)
  },
})

// ============================================================================
// AI-powered auto-carousel
// ============================================================================

export async function resolveOpenAIKey(): Promise<string | null> {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY
  try {
    const envPath = join(homedir(), ".iris", "sdk", ".env")
    const file = Bun.file(envPath)
    if (await file.exists()) {
      const raw = await file.text()
      const text = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw
      for (const line of text.split("\n")) {
        const m = line.match(/^OPENAI_API_KEY\s*=\s*(.+)/)
        if (m && m[1]) return m[1].trim()
      }
    }
  } catch {}
  try {
    const configPath = join(homedir(), ".iris", "config.json")
    const file = Bun.file(configPath)
    if (await file.exists()) {
      const config = JSON.parse(await file.text())
      if (config?.openai_api_key) return config.openai_api_key
    }
  } catch {}
  // 4. fl-api .env (local dev)
  for (const ep of [
    join(homedir(), "Sites", "freelabel", "fl-docker-dev", "fl-api", ".env"),
    join(homedir(), "Sites", "freelabel", "fl-docker-dev", "fl-iris-api", ".env"),
  ]) {
    try {
      const f = Bun.file(ep)
      if (await f.exists()) {
        for (const line of (await f.text()).split("\n")) {
          const m = line.match(/^OPENAI_API_KEY\s*=\s*(.+)/)
          if (m?.[1]) return m[1].trim()
        }
      }
    } catch {}
  }
  return null
}

type CarouselMode = "recruit" | "feature"

const CAROUSEL_SCHEMA = `{
  "brand": "<brand key>",
  "headline": "<cover slide headline, max 8 words>",
  "subtitle": "<1-2 sentence hook>",
  "category": "<2-3 word uppercase label>",
  "authorName": "<brand or person name>",
  "tips": [
    {"title": "<short punchy title>", "body": "<2-3 sentence explanation>"},
    {"title": "...", "body": "..."},
    {"title": "...", "body": "..."},
    {"title": "...", "body": "..."}
  ],
  "stats": [
    {"value": "<short value>", "label": "<1-2 WORD LABEL>"},
    {"value": "...", "label": "..."},
    {"value": "...", "label": "..."}
  ],
  "statsHeadline": "<ALL CAPS headline for stats slide>",
  "statsSubtitle": "<1 sentence context>",
  "checklistTitle": "<checklist slide heading>",
  "checklistItems": ["item 1", "item 2", "item 3", "item 4", "item 5"],
  "ctaHeadline": "<call to action question>",
  "ctaBody": "<1-2 sentence motivation>",
  "ctaButtonText": "<button label>",
  "ctaSubtext": "<url or contact info>",
  "codeSnippet": "<optional: a CLI command, code example, or terminal output to show on the image slide. Use this instead of imageUrl for dev/feature carousels. 3-6 lines max. Use real commands from the source material.>"
}`

const MODE_RULES: Record<CarouselMode, string> = {
  recruit: `Rules:
- Write for Instagram — punchy, direct, no corporate fluff
- Tips should be actionable and specific to the source material
- Stats should be real data from the source (dates, locations, numbers) or compelling estimates
- Checklist = who should care / what to do / requirements
- CTA drives to application or next step`,

  feature: `Rules:
- This carousel sells the OUTCOME to the person scrolling, not the feature itself
- The reader is a business owner, creator, or professional. They don't care what you built. They care what it means for THEM.
- NEVER write from the builder's perspective ("we built", "we shipped", "introducing"). Write from the USER's perspective ("you can now", "this means", "imagine if").
- Tip 1: The problem — what was painful or impossible before? Be specific and relatable.
- Tip 2: The outcome — what's now possible? Paint the picture. Use a real example from the source material (e.g. "3 healthcare sites launched in one afternoon" not "you can launch sites faster").
- Tip 3: How it works for you — the simplest explanation of what the user does. One command, one click, one conversation. Show the input and output.
- Tip 4: Who this is for — speak directly to the audience. "If you're a [type of person] who needs [outcome], this is built for you."
- Stats: pull REAL numbers from the source. Sites launched, slides generated, time saved, clients onboarded. If the source says "3 sites" use "3". Never make up stats like "100% consistency".
- statsHeadline: frame it as proof, not a label. "WHAT WE SHIPPED THIS WEEK" or "THE NUMBERS" not "FEATURE STATS"
- Checklist = "What You Can Do With This" — 5 specific use cases or scenarios the reader can imagine themselves in
- checklistTitle: "Use Cases" or "What This Unlocks" or "Try This Today" — not "How to Get Started"
- Headline: short, benefit-first. "Your Brand. Nine Slides. One Command." not "Introducing Auto-Carousel CLI!"
- Subtitle: 1 sentence that makes someone think "wait, I need this"
- CTA: drive to a specific action — install link, demo, booking page, marketplace URL
- Category: "NOW AVAILABLE", "USE CASE", "CASE STUDY", "THIS WEEK" — not "NEW FEATURE"
- Tone: confident, direct, zero fluff. Write like you're texting a friend who runs a business, not writing a press release.
- NEVER use exclamation marks. NEVER use "effortlessly", "seamlessly", "elevate", "stunning", "game-changer", or any other AI-sounding filler.
- If the source is a daily diary / changelog, find the most impactful outcome and build the whole carousel around what it means for the end user`,
}

export async function aiGenerateCarouselProps(context: string, brand: string, mode: CarouselMode = "recruit"): Promise<Record<string, unknown> | null> {
  const apiKey = await resolveOpenAIKey()
  if (!apiKey) {
    prompts.log.error("No OpenAI API key. Set OPENAI_API_KEY in env or ~/.iris/sdk/.env")
    return null
  }

  const systemPrompt = `You generate Instagram carousel content from source material.
Return ONLY valid JSON — no markdown fences, no commentary.

The JSON must match this exact schema:
${CAROUSEL_SCHEMA}

${MODE_RULES[mode]}`

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.7,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Brand: ${brand}\n\nSource material:\n${context}` },
      ],
    }),
  })

  if (!res.ok) {
    prompts.log.error(`OpenAI error: ${res.status} ${res.statusText}`)
    return null
  }

  const data = (await res.json()) as any
  const raw = data.choices?.[0]?.message?.content ?? ""
  try {
    const cleaned = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim()
    return JSON.parse(cleaned)
  } catch {
    prompts.log.error("Failed to parse AI response as JSON")
    return null
  }
}

async function fetchOpportunity(id: number): Promise<Record<string, unknown> | null> {
  const token = await requireAuth()
  if (!token) return null
  const res = await irisFetch(`/api/v1/marketplace/opportunities/${id}`)
  const ok = await handleApiError(res, `Fetch opportunity #${id}`)
  if (!ok) return null
  const json = (await res.json()) as any
  return json.data ?? json
}

export async function fetchBrandTokens(slug: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await irisFetch(`/api/v1/public/brands/${slug}/design-tokens`, {}, "https://raichu.heyiris.io")
    if (!res.ok) return null
    return (await res.json()) as Record<string, unknown>
  } catch { return null }
}

export function resolveRemotionDir(): string {
  const repoPaths = [
    join(homedir(), "Sites", "freelabel", "remotion"),
    join(homedir(), ".iris", "remotion"),
  ]
  return repoPaths.find((d) => existsSync(join(d, "node_modules", ".package-lock.json"))) ?? repoPaths[0]
}

const AutoCarouselCommand = cmd({
  command: "auto-carousel",
  aliases: ["auto"],
  describe: "AI-generate a carousel from an opportunity, lead, or prompt",
  builder: (yargs) =>
    yargs
      .option("from", {
        type: "string",
        describe: 'Source: "opportunity:519", "lead:16388", "diary:2026-05-14", or a freeform prompt',
        demandOption: true,
      })
      .option("register", {
        type: "boolean",
        default: false,
        describe: "After rendering, register the carousel into Review Studio (needs --board)",
      })
      .option("board", {
        type: "number",
        describe: "Board ID to register into when --register is set (its Creative tab)",
      })
      .option("brand", {
        type: "string",
        alias: "b",
        describe: "Brand key or slug (default: freelabel)",
        default: "freelabel",
      })
      .option("mode", {
        type: "string",
        alias: "m",
        describe: "Content mode: recruit (default) or feature (announcements/changelog)",
        choices: ["recruit", "feature"],
        default: "recruit",
      })
      .option("output", {
        type: "string",
        alias: "o",
        describe: "Output directory",
      })
      .option("event-promo", {
        type: "boolean",
        describe: "Also render an EventPromoStill slide",
        default: false,
      })
      .option("open", {
        type: "boolean",
        describe: "Open output folder when done",
        default: true,
      })
      .option("draft", {
        type: "boolean",
        describe: "Generate props JSON only — no rendering. Review and edit before running iris remotion carousel.",
        default: false,
      }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Auto Carousel")
    const spinner = prompts.spinner()
    const from = args.from as string
    const brand = args.brand as string

    // ── Step 1: Gather source material ──
    spinner.start("Gathering source material…")
    let context = ""
    let sourceLabel = ""

    const oppMatch = from.match(/^opportunity:(\d+)$/i)
    const leadMatch = from.match(/^lead:(\d+)$/i)
    const diaryMatch = from.match(/^diary:(.+)$/i)

    if (oppMatch) {
      const opp = await fetchOpportunity(parseInt(oppMatch[1]))
      if (!opp) { spinner.stop("Failed to fetch opportunity", 1); prompts.outro("Done"); return }
      context = JSON.stringify(opp, null, 2)
      sourceLabel = `Opportunity #${opp.id}: ${opp.title}`
    } else if (leadMatch) {
      const token = await requireAuth()
      if (!token) { spinner.stop("Auth required", 1); prompts.outro("Done"); return }
      const res = await irisFetch(`/api/v1/bloqs/leads/${leadMatch[1]}`)
      const ok = await handleApiError(res, `Fetch lead #${leadMatch[1]}`)
      if (!ok) { spinner.stop("Failed to fetch lead", 1); prompts.outro("Done"); return }
      const lead = (await res.json()) as any
      context = JSON.stringify(lead.data ?? lead, null, 2)
      sourceLabel = `Lead #${leadMatch[1]}`
    } else if (diaryMatch) {
      // Resolve diary file: "diary:2026-05-14" or "diary:2026-05-14-remotion-brand-token-bridge"
      const slug = diaryMatch[1]
      let diaryDir = join(process.cwd(), "daily-diary")
      // Walk up to find daily-diary
      if (!existsSync(diaryDir)) {
        let d = process.cwd()
        for (let i = 0; i < 10; i++) {
          if (existsSync(join(d, "daily-diary"))) { diaryDir = join(d, "daily-diary"); break }
          const parent = join(d, "..")
          if (parent === d) break
          d = parent
        }
      }
      // Find matching file: exact match or prefix match
      let diaryFile: string | null = null
      if (existsSync(diaryDir)) {
        const files = require("fs").readdirSync(diaryDir) as string[]
        const exact = files.find((f: string) => f === `${slug}.md`)
        const prefix = files.filter((f: string) => f.startsWith(slug) && f.endsWith(".md")).sort().reverse()
        diaryFile = exact ? join(diaryDir, exact) : prefix.length > 0 ? join(diaryDir, prefix[0]) : null
      }
      if (!diaryFile || !existsSync(diaryFile)) {
        spinner.stop(`Diary entry not found: ${slug}`, 1)
        prompts.outro("Done")
        return
      }
      context = require("fs").readFileSync(diaryFile, "utf-8")
      sourceLabel = `Diary: ${require("path").basename(diaryFile, ".md")}`
    } else {
      // Freeform prompt
      context = from
      sourceLabel = from.slice(0, 60)
    }
    spinner.stop(success(`Source: ${sourceLabel}`))

    // ── Step 2: Resolve brand tokens ──
    const builtIn = ["freelabel", "discover", "heyiris", "beatbox", "emc_radio", "capital_collective"]
    let brandOverrides: Record<string, string> = {}

    if (!builtIn.includes(brand)) {
      spinner.start(`Resolving ${brand} design tokens…`)
      const tokenData = await fetchBrandTokens(brand)
      if (tokenData) {
        const tokens = (tokenData as any).design_tokens ?? {}
        const semantic = tokens.semantic ?? {}
        if (semantic.bg_page) brandOverrides.bgOverride = semantic.bg_page
        if (semantic.bg_brand) brandOverrides.accentOverride = semantic.bg_brand
        if (semantic.fg_primary) brandOverrides.textOverride = semantic.fg_primary
        brandOverrides.handleOverride = `@${brand}`
        spinner.stop(success(`Brand tokens loaded: ${Object.keys(brandOverrides).length} overrides`))
      } else {
        spinner.stop(dim("No brand tokens found, using defaults"))
      }
    }

    // ── Step 3: AI generates carousel content ──
    const mode = (args.mode as CarouselMode) ?? "recruit"
    spinner.start(`AI writing carousel content (${mode} mode)…`)
    const props = await aiGenerateCarouselProps(context, brand, mode)
    if (!props) { spinner.stop("AI generation failed", 1); prompts.outro("Done"); return }

    // Merge brand overrides
    props.brand = builtIn.includes(brand) ? brand : "freelabel"
    Object.assign(props, brandOverrides)

    spinner.stop(success("Carousel content generated"))

    // ── Step 4: Write props and render ──
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
    const outDir = (args.output as string) || join(process.cwd(), `carousel-${timestamp}`)
    mkdirSync(outDir, { recursive: true })

    const propsPath = join(outDir, "props.json")
    writeFileSync(propsPath, JSON.stringify(props, null, 2))
    prompts.log.info(`Props saved: ${dim(propsPath)}`)

    // ── Draft mode: stop here, open for editing ──
    if (args.draft) {
      console.log()
      prompts.log.success(bold("Draft ready — review and edit the JSON before rendering:"))
      console.log(`  ${dim("Edit:")} ${propsPath}`)
      console.log(`  ${dim("Then:")} iris remotion carousel ${propsPath} -o ${outDir}`)
      console.log()
      // Try to open in editor
      const editor = process.env.EDITOR || "code"
      spawnSync(editor, [propsPath], { stdio: "ignore" })
      if (args.open) spawnSync("open", [outDir], { stdio: "ignore" })
      prompts.outro("Edit props.json, then run: iris remotion carousel props.json")
      return
    }

    const rDir = resolveRemotionDir()

    spinner.start("Rendering 9 carousel slides…")
    let failed = false
    for (let i = 0; i < 9; i++) {
      const outFile = join(outDir, `slide-${i}.png`)
      const slideProps = { ...props, slideIndex: i }
      const propsFile = join(outDir, `_props-${i}.json`)
      writeFileSync(propsFile, JSON.stringify(slideProps))
      const result = spawnSync(
        "npx",
        ["remotion", "still", `CarouselSlide${i}`, outFile, `--props=${propsFile}`],
        { stdio: "pipe", env: process.env, cwd: rDir },
      )
      if (result.status !== 0) {
        const stderr = result.stderr?.toString() ?? ""
        prompts.log.error(`Slide ${i}: ${stderr.slice(0, 200)}`)
        spinner.stop(`Slide ${i} failed`, 1)
        failed = true
        break
      }
    }
    if (!failed) spinner.stop(success("9 slides rendered"))
    // Cleanup temp props files
    for (let i = 0; i < 9; i++) { try { require("fs").unlinkSync(join(outDir, `_props-${i}.json`)) } catch {} }

    // ── Step 5: Optional event promo ──
    if (args["event-promo"] && !failed) {
      spinner.start("Rendering event promo slide…")
      const eventProps = {
        brand: props.brand,
        eventName: String(props.headline ?? "EVENT").toUpperCase(),
        tagline: String(props.subtitle ?? "").slice(0, 60),
        date: String((props.stats as any[])?.[0]?.value ?? "TBD").toUpperCase(),
        time: "Doors Open",
        venue: String(props.statsSubtitle ?? "").split("—")[0]?.trim() ?? "TBD",
        city: String((props.stats as any[])?.[1]?.value ?? "").toUpperCase() + (String((props.stats as any[])?.[1]?.label ?? "") ? `, ${(props.stats as any[])?.[1]?.label}` : ""),
        price: "FREE ENTRY",
        details: (props.checklistItems as string[])?.slice(0, 4) ?? [],
        ctaText: String(props.ctaSubtext ?? `Apply @ freelabel.net`),
        hostedBy: `Hosted by ${String(props.authorName ?? "FreeLabel")}`,
      }
      const epPropsPath = join(outDir, "_event-promo-props.json")
      writeFileSync(epPropsPath, JSON.stringify(eventProps))
      writeFileSync(join(outDir, "event-promo-props.json"), JSON.stringify(eventProps, null, 2))
      const result = spawnSync(
        "npx",
        ["remotion", "still", "EventPromoStill", join(outDir, "slide-event-promo.png"), `--props=${epPropsPath}`],
        { stdio: "pipe", env: process.env, cwd: rDir },
      )
      try { require("fs").unlinkSync(epPropsPath) } catch {}
      if (result.status === 0) {
        spinner.stop(success("Event promo rendered"))
      } else {
        spinner.stop("Event promo failed", 1)
      }
    }

    // ── Done ──
    console.log()
    prompts.log.success(bold(`Carousel ready: ${outDir}`))
    console.log(`  ${dim("Props:")} ${propsPath}`)
    const slides = Array.from({ length: 9 }, (_, i) => join(outDir, `slide-${i}.png`)).filter(existsSync)
    console.log(`  ${dim("Slides:")} ${slides.length} images`)

    // ── Optional: register into Review Studio (one command: generate → in the UI) ──
    if (args.register && !failed && slides.length > 0) {
      if (!args.board) {
        prompts.log.warn("--register needs --board <id> — skipping registration.")
      } else {
        const userId = await requireUserId(undefined)
        if (userId) {
          spinner.start(`Registering ${slides.length}-slide carousel into board ${args.board}…`)
          const id = await registerCreativeFiles(slides, {
            board: args.board as number,
            userId,
            title: String(props.headline ?? `${brand} carousel`),
            caption: String(props.subtitle ?? props.headline ?? ""),
            platform: "instagram",
          })
          if (id == null) {
            spinner.stop("Registration failed", 1)
          } else {
            spinner.stop(success(`Registered → item #${id} (pending review)`))
            console.log(`  ${dim("View:")} https://web.heyiris.io/iris/bloq/${args.board}?tab=creative`)
          }
        }
      }
    }

    if (args.open) {
      spawnSync("open", [outDir], { stdio: "ignore" })
    }

    prompts.outro("Done")
  },
})

// ============================================================================
// Register rendered creatives into Review Studio (the local↔R2 wire)
// ============================================================================

/**
 * Upload local render file(s) into a board's Review Studio as a Pending creative.
 * The server hosts them to R2 and creates the type=content BloqItem, so the client
 * only needs its auth token — no prod R2 creds. 1 image → image, many images →
 * carousel, a video file → video. Returns the new item id, or null on failure.
 */
export async function registerCreativeFiles(
  files: string[],
  opts: { board: number; userId: number; title?: string; caption?: string; platform?: string },
): Promise<number | null> {
  const existing = files.filter(existsSync)
  if (existing.length === 0) {
    UI.error("No files found to register.")
    return null
  }
  const form = new FormData()
  for (const f of existing) {
    form.append("files[]", new Blob([new Uint8Array(readFileSync(f))]), basename(f))
  }
  if (opts.title) form.append("title", opts.title)
  if (opts.caption) form.append("caption", opts.caption)
  form.append("platform", opts.platform ?? "instagram")

  const res = await irisFetch(
    `/api/v1/user/${opts.userId}/bloqs/${opts.board}/creatives`,
    { method: "POST", body: form },
    FL_API,
  )
  if (!res.ok) {
    await handleApiError(res, "register creative")
    return null
  }
  const data = (await res.json().catch(() => ({}))) as any
  return data?.data?.id ?? null
}

const RegisterCommand = cmd({
  command: "register <files..>",
  describe: "Upload rendered file(s) into a board's Review Studio (hosts to cloud, creates a Pending creative)",
  builder: (yargs: any) =>
    yargs
      .positional("files", {
        type: "string",
        array: true,
        describe: "Local render file(s): one image/video, or several images = one carousel",
      })
      .option("board", { type: "number", demandOption: true, describe: "Board ID to register into (its Creative tab / Review Studio)" })
      .option("user-id", { type: "number", describe: "Owner user id (defaults to your account)" })
      .option("title", { type: "string", describe: "Item title" })
      .option("caption", { type: "string", describe: "Caption shown on the card" })
      .option("platform", { type: "string", default: "instagram", describe: "Platform tag" }),
  async handler(args: any) {
    const token = await requireAuth()
    if (!token) return
    const userId = await requireUserId(args["user-id"])
    if (!userId) return

    const files = (args.files as string[]) ?? []
    const spinner = prompts.spinner()
    spinner.start(`Hosting ${files.filter(existsSync).length} file(s) + registering…`)
    const id = await registerCreativeFiles(files, {
      board: args.board as number,
      userId,
      title: args.title as string | undefined,
      caption: args.caption as string | undefined,
      platform: (args.platform as string) ?? "instagram",
    })
    if (id == null) {
      spinner.stop("Registration failed", 1)
      prompts.outro("Done")
      return
    }
    spinner.stop(success(`Registered → item #${id} on board ${args.board} (pending review)`))
    console.log(`  ${dim("View:")} https://web.heyiris.io/iris/bloq/${args.board}?tab=creative`)
    prompts.outro("Done")
  },
})

// ============================================================================
// Main command
// ============================================================================

export const PlatformRemotionCommand = cmd({
  command: "remotion <subcommand>",
  describe: "Video & image generation with Remotion",
  builder: (yargs) =>
    yargs
      .command(RenderCommand)
      .command(StillCommand)
      .command(CarouselCommand)
      .command(AutoCarouselCommand)
      .command(RegisterCommand)
      .command(PreviewCommand)
      .command(ListCommand)
      .command(InitCommand)
      .command(UpdateCommand)
      .demandCommand(1, "Specify a subcommand: render, still, carousel, auto-carousel, register, preview, list, init, update"),
  async handler() {
    // handled by subcommands
  },
})
