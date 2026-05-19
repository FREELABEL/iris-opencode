import { cmd } from "./cmd"
import * as prompts from "./clack"
import { irisFetch, FL_API, requireAuth, handleApiError, printDivider, printKV, dim, bold, success, highlight } from "./iris-api"
import { aiGenerateCarouselProps, fetchBrandTokens, resolveRemotionDir } from "./platform-remotion"
import { Auth } from "../../auth"
import { spawnSync } from "child_process"
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync } from "fs"
import { join, basename } from "path"
import { homedir } from "os"

// ============================================================================
// Deliver — port of DeliverCommand.php
// Executes a callable workflow and delivers result to a lead.
// Endpoint: /api/v1/leads/{leadId}/deliverables/workflow
// ============================================================================

async function getJson(res: Response): Promise<any> { try { return await res.json() } catch { return {} } }

export const PlatformDeliverCommand = cmd({
  command: "deliver <lead-id> <workflow>",
  describe: "execute a workflow and deliver the result to a lead",
  builder: (yargs) =>
    yargs
      .positional("lead-id", { describe: "lead ID", type: "number", demandOption: true })
      .positional("workflow", { describe: "callable workflow name", type: "string", demandOption: true })
      .option("input", { alias: "i", describe: "workflow input as JSON", type: "string", default: "{}" })
      .option("no-email", { describe: "skip email notification", type: "boolean", default: false })
      .option("subject", { alias: "s", describe: "custom email subject", type: "string" })
      .option("recipients", { alias: "r", describe: "override recipient emails (comma-separated)", type: "string" })
      .option("title", { alias: "t", describe: "custom deliverable title", type: "string" })
      .option("context", { alias: "c", describe: "custom context for AI email generation", type: "string" })
      .option("json", { describe: "JSON output", type: "boolean" }),
  async handler(args) {
    if (!(await requireAuth())) return

    let workflowInput: unknown
    try {
      workflowInput = JSON.parse(String(args.input))
    } catch (e) {
      prompts.log.error(`Invalid JSON for --input: ${(e as Error).message}`)
      return
    }

    const options: Record<string, unknown> = {
      send_email: !args["no-email"],
      message_mode: "ai",
      include_project_context: true,
    }
    if (args.subject) options.email_subject = args.subject
    if (args.recipients) options.recipient_emails = String(args.recipients).split(",").map((s) => s.trim())
    if (args.title) options.deliverable_title = args.title
    if (args.context) options.custom_context = args.context

    const payload = {
      workflow_name: args.workflow,
      input: workflowInput,
      options,
    }

    if (!args.json) {
      console.log("")
      console.log(bold("IRIS Workflow Delivery"))
      printKV("Lead", `#${args.leadId}`)
      printKV("Workflow", args.workflow)
      printKV("Send Email", options.send_email ? "Yes" : "No")
      console.log("")
    }

    const spinner = prompts.spinner()
    spinner.start("Executing workflow…")

    const res = await irisFetch(`/api/v1/leads/${args.leadId}/deliverables/workflow`, {
      method: "POST",
      body: JSON.stringify(payload),
    })
    const ok = await handleApiError(res, "Deliver")
    if (!ok) { spinner.stop("Failed", 1); return }

    const body = await getJson(res)
    spinner.stop(success("Delivered"))
    const data = body.data ?? body

    if (args.json) { console.log(JSON.stringify(data, null, 2)); return }

    console.log("")
    console.log(bold("Delivery Summary"))
    printDivider()
    printKV("Workflow", data.workflow_name ?? args.workflow)
    printKV("Lead ID", `#${args.leadId}`)
    printKV("Execution ID", data.execution_id)
    printKV("Deliverable ID", data.deliverable_id ? `#${data.deliverable_id}` : undefined)
    printKV("Deliverable URL", data.deliverable_url ? highlight(data.deliverable_url) : undefined)
    if (data.email_sent) {
      printKV("Email Sent", "Yes")
      if (Array.isArray(data.email_sent_to)) printKV("Recipients", data.email_sent_to.join(", "))
    } else {
      printKV("Email Sent", "No")
    }
    if (data.time_to_value_seconds != null) printKV("Time to Value", `${data.time_to_value_seconds}s`)

    // Workflow output preview
    if (data.workflow_output) {
      console.log("")
      console.log(bold("Workflow Output Preview"))
      const preview = typeof data.workflow_output === "string" ? data.workflow_output : JSON.stringify(data.workflow_output, null, 2)
      console.log(preview.length > 500 ? preview.slice(0, 500) + "..." : preview)
    }
    printDivider()
  },
})

// ============================================================================
// Deliver:Carousel — one-command carousel pipeline
// AI generate → render 9 slides → upload to CDN → attach note on lead
// ============================================================================

async function resolveUploadToken(): Promise<string> {
  const stored = await Auth.get("iris")
  if (stored?.type === "api" && stored.key) return stored.key
  if (process.env.FL_API_TOKEN) return process.env.FL_API_TOKEN
  if (process.env.IRIS_API_KEY) return process.env.IRIS_API_KEY
  return ""
}

async function uploadFileToCDN(filePath: string, bloqId?: number): Promise<{ cdn_url: string; file_id: number } | null> {
  const fileBuffer = readFileSync(filePath)
  const blob = new Blob([new Uint8Array(fileBuffer)])
  const form = new FormData()
  form.append("file", blob, basename(filePath))
  form.append("type", "digital_product")
  form.append("title", basename(filePath))
  if (bloqId) form.append("bloq_id", String(bloqId))
  const userId = process.env.IRIS_USER_ID ?? "193"
  form.append("user_id", userId)

  const token = await resolveUploadToken()
  const headers: Record<string, string> = { Accept: "application/json" }
  if (token) headers["Authorization"] = `Bearer ${token}`

  const res = await fetch(`${FL_API}/api/v1/cloud-files/upload`, {
    method: "POST",
    body: form,
    headers,
  })
  if (!res.ok) {
    const errText = await res.text().catch(() => `HTTP ${res.status}`)
    prompts.log.warn(`Upload error: ${errText.slice(0, 200)}`)
    return null
  }
  const data = (await res.json()) as any
  const result = data?.data ?? data
  return { cdn_url: result.cdn_url ?? result.url ?? result.filepath ?? "", file_id: result.id }
}

function resolveDiaryContent(slug: string): string | null {
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
  if (!existsSync(diaryDir)) return null
  const files = readdirSync(diaryDir) as string[]
  const exact = files.find((f: string) => f === `${slug}.md`)
  const prefix = files.filter((f: string) => f.startsWith(slug) && f.endsWith(".md")).sort().reverse()
  const diaryFile = exact ? join(diaryDir, exact) : prefix.length > 0 ? join(diaryDir, prefix[0]) : null
  if (!diaryFile || !existsSync(diaryFile)) return null
  return readFileSync(diaryFile, "utf-8")
}

export const DeliverCarouselCommand = cmd({
  command: "deliver:carousel <lead-id>",
  describe: "generate carousel, upload to CDN, attach as deliverable on lead",
  builder: (yargs) =>
    yargs
      .positional("lead-id", { describe: "lead ID", type: "number", demandOption: true })
      .option("brand", { type: "string", default: "heyiris", describe: "brand slug for design tokens" })
      .option("topic", { type: "string", describe: "feature description or topic for AI content generation" })
      .option("tasks", { type: "array", describe: "task IDs (numeric) or text descriptions for release carousel" })
      .option("from", { type: "string", describe: "source: diary:<date>, opportunity:<id>, or free text" })
      .option("prompt", { type: "string", describe: "custom direction for AI content generation" })
      .option("bloq", { type: "number", describe: "bloq ID to attach uploads to" })
      .option("output", { alias: "o", type: "string", describe: "local output dir (default: carousel-<timestamp>)" })
      .option("props", { type: "string", describe: "path to props.json — skip AI, use your own content" })
      .option("draft", { type: "boolean", default: false, describe: "generate props + metadata only, stop before rendering" })
      .option("mode", { type: "string", default: "feature", choices: ["feature", "recruit"], describe: "AI content mode" })
      .option("skip-upload", { type: "boolean", default: false, describe: "render only, skip upload + delivery" })
      .option("square", { type: "boolean", default: false, describe: "render 1080x1080 (default is 1080x1440 for IG)" })
      .option("json", { type: "boolean", default: false, describe: "JSON output" }),
  async handler(args) {
    const leadId = args.leadId as number
    const brand = args.brand as string
    const noUpload = args["skip-upload"] as boolean
    const jsonOutput = args.json as boolean

    if (!jsonOutput) {
      console.log("")
      prompts.intro("Deliver Carousel")
    }

    if (!(await requireAuth())) return

    const spinner = prompts.spinner()

    // ── Resolve props: --props file, or AI generation ──
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
    const outDir = (args.output as string) || join(process.cwd(), `carousel-${timestamp}`)
    mkdirSync(outDir, { recursive: true })
    const propsPath = join(outDir, "props.json")
    const metaPath = join(outDir, "metadata.json")

    let props: Record<string, unknown>
    let resolvedTaskIds: number[] = []
    let textItems: string[] = []
    let brandOverrides: Record<string, string> = {}
    const builtIn = ["freelabel", "discover", "heyiris", "beatbox", "emc_radio", "capital_collective"]
    const mode = (args.mode as string) === "recruit" ? "recruit" : "feature"

    if (args.props) {
      // ── Direct props file — skip AI entirely ──
      const pFile = String(args.props)
      if (!existsSync(pFile)) { prompts.log.error(`Props file not found: ${pFile}`); return }
      try {
        props = JSON.parse(readFileSync(pFile, "utf-8"))
      } catch (e) {
        prompts.log.error(`Invalid JSON in ${pFile}: ${(e as Error).message}`)
        return
      }
      prompts.log.info(dim(`Using props from ${basename(pFile)}`))
      writeFileSync(propsPath, JSON.stringify(props, null, 2))
    } else {
      // ── Step 1: Resolve source material ──
      let context = ""

      if (args.tasks && (args.tasks as (string | number)[]).length > 0) {
        // ── Tasks: numeric IDs fetched from lead, or raw text ──
        const raw = args.tasks as (string | number)[]
        const taskIds = raw.filter(t => /^\d+$/.test(String(t))).map(Number)
        textItems = raw.filter(t => !/^\d+$/.test(String(t))).map(String)

        let resolvedFromApi: { id: number; title: string; description?: string }[] = []
        if (taskIds.length > 0) {
          spinner.start(`Fetching ${taskIds.length} task(s) from lead #${leadId}…`)
          const res = await irisFetch(`/api/v1/leads/${leadId}/tasks`)
          if (res.ok) {
            const data = ((await res.json()) as any)?.data
            const allTasks: any[] = data?.tasks ?? data ?? []
            resolvedFromApi = allTasks
              .filter((t: any) => taskIds.includes(t.id))
              .map((t: any) => ({ id: t.id, title: t.title, description: t.description }))
            const missing = taskIds.filter(id => !resolvedFromApi.find(t => t.id === id))
            if (missing.length) prompts.log.warn(`Task IDs not found on lead: ${missing.join(", ")}`)
            spinner.stop(success(`${resolvedFromApi.length} task(s) resolved`))
          } else {
            spinner.stop("Failed to fetch lead tasks", 1)
          }
          resolvedTaskIds = resolvedFromApi.map(t => t.id)
        }

        const lines: string[] = []
        resolvedFromApi.forEach((t, i) => {
          lines.push(`${i + 1}. ${t.title}${t.description ? ` — ${t.description}` : ""}`)
        })
        textItems.forEach((t, i) => {
          lines.push(`${resolvedFromApi.length + i + 1}. ${t}`)
        })
        context = `Release deliverables:\n${lines.join("\n")}`
      } else if (args.topic) {
        context = args.topic as string
      } else if (args.from) {
        const from = args.from as string
        const diaryMatch = from.match(/^diary:(.+)$/i)
        const oppMatch = from.match(/^opportunity:(\d+)$/i)
        if (diaryMatch) {
          const content = resolveDiaryContent(diaryMatch[1])
          if (!content) { prompts.log.error(`Diary not found: ${diaryMatch[1]}`); return }
          context = content
        } else if (oppMatch) {
          spinner.start("Fetching opportunity…")
          const res = await irisFetch(`/api/v1/marketplace/opportunities/${oppMatch[1]}`)
          if (!await handleApiError(res, "Fetch opportunity")) { spinner.stop("Failed", 1); return }
          const opp = (await res.json()) as any
          context = JSON.stringify(opp.data ?? opp, null, 2)
          spinner.stop(success("Opportunity loaded"))
        } else {
          context = from
        }
      } else {
        prompts.log.error("Provide --tasks, --topic, --from, or --props")
        return
      }

      // ── Append custom prompt direction ──
      if (args.prompt) {
        context += `\n\nContent direction: ${args.prompt as string}`
      }

      // ── Step 2: Resolve brand tokens ──
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
          spinner.stop(success(`Brand tokens: ${Object.keys(brandOverrides).length} overrides`))
        } else {
          spinner.stop(dim("No brand tokens, using defaults"))
        }
      }

      // ── Step 3: AI generates carousel content ──
      spinner.start(`AI generating carousel content (${mode} mode)…`)
      props = (await aiGenerateCarouselProps(context, brand, mode as any))!
      if (!props) { spinner.stop("AI generation failed", 1); return }
      props.brand = builtIn.includes(brand) ? brand : "freelabel"
      Object.assign(props, brandOverrides)
      spinner.stop(success("Carousel content generated"))

      writeFileSync(propsPath, JSON.stringify(props, null, 2))
    }

    // ── Write metadata.json ──
    const metadata = {
      lead_id: leadId,
      brand,
      mode,
      generated_at: new Date().toISOString(),
      source: args.props ? "props-file" : args.tasks ? "tasks" : args.topic ? "topic" : args.from ? "from" : "unknown",
      task_ids: resolvedTaskIds,
      task_texts: textItems,
      topic: (args.topic as string) || null,
      from: (args.from as string) || null,
      prompt: (args.prompt as string) || null,
      props_path: propsPath,
      ai_model: "gpt-4o-mini",
      brand_overrides: brandOverrides,
    }
    writeFileSync(metaPath, JSON.stringify(metadata, null, 2))

    // ── Draft mode: save and exit without rendering ──
    if (args.draft) {
      prompts.log.info(`Props saved: ${dim(propsPath)}`)
      prompts.log.info(`Metadata: ${dim(metaPath)}`)
      prompts.log.info(`Edit, then re-run: ${dim(`iris deliver:carousel ${leadId} --props ${propsPath}`)}`)
      spawnSync("open", [outDir], { stdio: "ignore" })
      prompts.outro("Draft ready")
      return
    }

    const rDir = resolveRemotionDir()
    const compPrefix = args.square ? "CarouselSlide" : "IGCarouselSlide"
    const dims = args.square ? "1080x1080" : "1080x1440"
    spinner.start(`Rendering 9 carousel slides (${dims})…`)
    let renderFailed = false
    for (let i = 0; i < 9; i++) {
      const outFile = join(outDir, `slide-${i}.png`)
      const slideProps = { ...props, slideIndex: i }
      const propsFile = join(outDir, `_props-${i}.json`)
      writeFileSync(propsFile, JSON.stringify(slideProps))
      const result = spawnSync(
        "npx",
        ["remotion", "still", `${compPrefix}${i}`, outFile, `--props=${propsFile}`],
        { stdio: "pipe", env: process.env, cwd: rDir },
      )
      if (result.status !== 0) {
        const stderr = result.stderr?.toString() ?? ""
        prompts.log.error(`Slide ${i}: ${stderr.slice(0, 200)}`)
        spinner.stop(`Slide ${i} failed`, 1)
        renderFailed = true
        break
      }
    }
    if (!renderFailed) spinner.stop(success("9 slides rendered"))
    for (let i = 0; i < 9; i++) { try { require("fs").unlinkSync(join(outDir, `_props-${i}.json`)) } catch {} }

    if (renderFailed) {
      prompts.log.info(`Partial output: ${outDir}`)
      return
    }

    if (noUpload) {
      if (jsonOutput) {
        console.log(JSON.stringify({ output_dir: outDir, slides: 9 }, null, 2))
      } else {
        prompts.log.success(bold(`Carousel rendered: ${outDir}`))
        spawnSync("open", [outDir], { stdio: "ignore" })
        prompts.outro("Done (--skip-upload, skipped delivery)")
      }
      return
    }

    // ── Step 5: Upload all 9 PNGs to CDN ──
    spinner.start("Uploading 9 slides to CDN…")
    const uploads: { slide: number; cdn_url: string; file_id: number }[] = []
    for (let i = 0; i < 9; i++) {
      const slidePath = join(outDir, `slide-${i}.png`)
      if (!existsSync(slidePath)) continue
      const result = await uploadFileToCDN(slidePath, args.bloq as number | undefined)
      if (result) {
        uploads.push({ slide: i, ...result })
      } else {
        prompts.log.warn(`Slide ${i} upload failed`)
      }
    }
    spinner.stop(success(`${uploads.length}/9 slides uploaded`))

    if (uploads.length === 0) {
      prompts.log.error("No slides uploaded — skipping delivery")
      return
    }

    // ── Step 6: Attach deliverable note on lead ──
    spinner.start("Attaching deliverable to lead…")
    const urlList = uploads.map((u) => `- Slide ${u.slide}: ${u.cdn_url}`).join("\n")
    const noteContent = `Carousel Deliverable (${brand})\n\n${uploads.length} slides uploaded:\n${urlList}`

    const noteRes = await irisFetch(`/api/v1/leads/${leadId}/notes`, {
      method: "POST",
      body: JSON.stringify({ message: noteContent, type: "note", activity_type: "note" }),
    })
    const noteOk = await handleApiError(noteRes, "Attach note")
    if (noteOk) {
      spinner.stop(success("Deliverable attached to lead"))
    } else {
      spinner.stop("Note attachment failed (slides still uploaded)", 1)
    }

    // ── Output ──
    if (jsonOutput) {
      console.log(JSON.stringify({
        lead_id: leadId,
        brand,
        output_dir: outDir,
        slides_rendered: 9,
        slides_uploaded: uploads.length,
        uploads,
        note_attached: noteOk,
      }, null, 2))
    } else {
      console.log("")
      printDivider()
      printKV("Lead", `#${leadId}`)
      printKV("Brand", brand)
      printKV("Slides", `${uploads.length} uploaded`)
      console.log("")
      for (const u of uploads) {
        console.log(`  ${dim(`slide-${u.slide}:`)} ${highlight(u.cdn_url)}`)
      }
      printDivider()
      prompts.outro("Carousel delivered")
    }
  },
})
