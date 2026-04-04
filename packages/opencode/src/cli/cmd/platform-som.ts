import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, bold, dim, success, highlight } from "./iris-api"

// ============================================================================
// SOM Campaign Overview + Edit — mirrors PHP som:overview and som:edit
// ============================================================================

const RAICHU = process.env.IRIS_FL_API_URL ?? process.env.FL_API_URL ?? "https://raichu.heyiris.io"

const CAMPAIGNS: Record<string, { board: number; strategy: string; ig: string; label: string; audience: string }> = {
  courses:  { board: 38,  strategy: "AI Course | V3",         ig: "heyiris.io",        label: "AI Course Outreach",  audience: "AI builders, tech founders" },
  creators: { board: 80,  strategy: "Creator Outreach | V1",  ig: "thediscoverpage_",   label: "Creator Outreach",    audience: "Artists, creators, hip-hop culture" },
  beatbox:  { board: 224, strategy: "DJ Outreach | V1",       ig: "thebeatbox__",       label: "DJ Outreach",         audience: "DJs, producers, beatmakers" },
  venues:   { board: 292, strategy: "Venue Partnership | V1", ig: "freelabelnet",       label: "Venue Partnership",   audience: "Cafes, venues, event spaces" },
}

function channelLabel(type: string): string {
  const map: Record<string, string> = { instagram: "IG DM", email: "Email", sms: "SMS", phone: "Phone", linkedin: "LinkedIn" }
  return map[type] ?? type
}

async function fetchStrategyByName(boardId: number, name: string): Promise<Record<string, unknown> | null> {
  const resp = await irisFetch(`/api/v1/bloqs/${boardId}/outreach-strategy-templates`, {}, RAICHU)
  if (!resp.ok) return null
  const body = await resp.json()
  const templates = body.data?.templates ?? body.templates ?? []
  return templates.find((t: any) => t.name === name) ?? null
}

async function fetchLeadCount(boardId: number): Promise<number | string> {
  try {
    const resp = await irisFetch(`/api/v1/leads?bloq_id=${boardId}&per_page=1`, {}, RAICHU)
    if (!resp.ok) return "?"
    const body = await resp.json()
    return body.total ?? body.data?.total ?? "?"
  } catch { return "?" }
}

// ── Overview ──

const SomOverviewCommand = cmd({
  command: "overview",
  describe: "view all SOM campaigns, strategies, and scripts at a glance",
  builder: (yargs) =>
    yargs
      .option("campaign", { alias: "c", describe: "show only one campaign", type: "string" })
      .option("scripts", { alias: "s", describe: "show full script text", type: "boolean" })
      .option("json", { describe: "JSON output", type: "boolean" }),
  async handler(args) {
    await requireAuth()

    let campaignNames = Object.keys(CAMPAIGNS)
    if (args.campaign) {
      if (!CAMPAIGNS[args.campaign as string]) {
        prompts.log.error(`Unknown campaign: ${args.campaign}. Options: ${campaignNames.join(", ")}`)
        return
      }
      campaignNames = [args.campaign as string]
    }

    const allData: Record<string, unknown> = {}

    for (const name of campaignNames) {
      const cfg = CAMPAIGNS[name]
      const strategy = await fetchStrategyByName(cfg.board, cfg.strategy)
      const leads = await fetchLeadCount(cfg.board)

      allData[name] = { config: cfg, strategy, total_leads: leads }
    }

    if (args.json) {
      console.log(JSON.stringify(allData, null, 2))
      return
    }

    console.log("")
    console.log(bold("SOM — Outreach Campaign Overview"))
    console.log("")

    for (const name of campaignNames) {
      const data = allData[name] as any
      const cfg = data.config
      const strat = data.strategy
      const leads = data.total_leads

      console.log(bold(`${name.toUpperCase()} — ${cfg.label}`))
      console.log(`  Board: #${cfg.board}  |  IG: @${cfg.ig}  |  Leads: ${leads}`)
      console.log(`  Audience: ${cfg.audience}`)

      if (!strat) {
        console.log(`  ${UI.Style.TEXT_DANGER}Strategy "${cfg.strategy}" NOT FOUND${UI.Style.TEXT_NORMAL}`)
        console.log("")
        continue
      }

      console.log(`  Strategy: ${strat.name} (id:${strat.id}, ${strat.usage_count ?? 0} uses)`)

      const steps = (strat.steps ?? []) as any[]
      if (steps.length === 0) {
        console.log(`  ${UI.Style.TEXT_WARNING}No steps defined!${UI.Style.TEXT_NORMAL}`)
        console.log("")
        continue
      }

      for (const step of steps) {
        const num = (step.order ?? 0) + 1
        const delay = (step.delay_hours ?? 0) > 0 ? dim(` (+${step.delay_hours}h)`) : ""
        const ch = channelLabel(step.type ?? "other")
        console.log(`  Step ${num}: ${step.title} ${dim(`[${ch}]`)}${delay}`)

        const script = (step.instructions ?? "").trim()
        if (script) {
          if (args.scripts) {
            // Full script, word-wrapped
            const lines = script.match(/.{1,90}(\s|$)/g) ?? [script]
            for (const line of lines) {
              console.log(`    ${line.trim()}`)
            }
          } else {
            // Hook (first sentence) + truncated preview
            const hook = script.split(/[.!?—]\s/)[0] ?? ""
            console.log(`    ${dim("Hook:")} ${hook}`)
            const preview = script.length > 120 ? script.slice(0, 120) + "..." : script
            console.log(`    ${dim("Script:")} ${preview}`)
          }
        } else {
          console.log(`    ${dim("(no script)")}`)
        }

        const prompt = (step.ai_prompt ?? "").trim()
        if (prompt) {
          const p = prompt.length > 80 ? prompt.slice(0, 80) + "..." : prompt
          console.log(`    ${dim("AI:")} ${p}`)
        }
      }

      console.log("")
    }
  },
})

// ── Edit ──

const SomEditCommand = cmd({
  command: "edit <campaign>",
  describe: "edit a campaign's outreach scripts inline",
  builder: (yargs) =>
    yargs
      .positional("campaign", { describe: "courses|creators|beatbox|venues", type: "string", demandOption: true })
      .option("step", { describe: "step number (1-based)", type: "number" })
      .option("field", { describe: "script|ai|title", type: "string" }),
  async handler(args) {
    await requireAuth()

    const name = args.campaign as string
    const cfg = CAMPAIGNS[name]
    if (!cfg) {
      prompts.log.error(`Unknown campaign: ${name}. Options: ${Object.keys(CAMPAIGNS).join(", ")}`)
      return
    }

    const strategy = await fetchStrategyByName(cfg.board, cfg.strategy)
    if (!strategy) {
      prompts.log.error(`Strategy "${cfg.strategy}" not found on board ${cfg.board}`)
      return
    }

    const steps = (strategy.steps ?? []) as any[]
    if (steps.length === 0) {
      prompts.log.error("No steps to edit")
      return
    }

    // Sort by order
    steps.sort((a: any, b: any) => (a.order ?? 0) - (b.order ?? 0))

    let stepIdx = args.step ? (args.step as number) - 1 : -1

    // If no step specified, let user pick
    if (stepIdx < 0) {
      const choices = steps.map((s: any, i: number) => ({
        value: i,
        label: `Step ${i + 1}: ${s.title} [${channelLabel(s.type)}] — "${(s.instructions ?? "").slice(0, 50)}..."`,
      }))

      const picked = await prompts.select({ message: "Which step?", options: choices })
      if (prompts.isCancel(picked)) return
      stepIdx = picked as number
    }

    if (stepIdx < 0 || stepIdx >= steps.length) {
      prompts.log.error(`Invalid step. This strategy has ${steps.length} steps.`)
      return
    }

    const step = steps[stepIdx]
    console.log("")
    console.log(bold(`Step ${stepIdx + 1}: ${step.title} [${channelLabel(step.type)}]`))
    console.log("")

    if (step.instructions) {
      console.log(dim("Current script:"))
      console.log(step.instructions)
      console.log("")
    }

    if (step.ai_prompt) {
      console.log(dim("Current AI prompt:"))
      console.log(step.ai_prompt)
      console.log("")
    }

    // Determine field to edit
    let field = args.field as string | undefined
    if (!field) {
      const picked = await prompts.select({
        message: "What to edit?",
        options: [
          { value: "script", label: "Script (the DM/email text)" },
          { value: "ai", label: "AI prompt (personalization instructions)" },
          { value: "both", label: "Script + AI prompt" },
          { value: "title", label: "Step title" },
        ],
      })
      if (prompts.isCancel(picked)) return
      field = picked as string
    }

    let updated = false

    if (field === "script" || field === "both") {
      const newScript = await prompts.text({ message: "New script:", initialValue: step.instructions ?? "" })
      if (!prompts.isCancel(newScript) && newScript && newScript !== step.instructions) {
        steps[stepIdx].instructions = newScript
        updated = true
      }
    }

    if (field === "ai" || field === "both") {
      const newPrompt = await prompts.text({ message: "New AI prompt:", initialValue: step.ai_prompt ?? "" })
      if (!prompts.isCancel(newPrompt) && newPrompt && newPrompt !== step.ai_prompt) {
        steps[stepIdx].ai_prompt = newPrompt
        updated = true
      }
    }

    if (field === "title") {
      const newTitle = await prompts.text({ message: "New title:", initialValue: step.title ?? "" })
      if (!prompts.isCancel(newTitle) && newTitle && newTitle !== step.title) {
        steps[stepIdx].title = newTitle
        updated = true
      }
    }

    if (!updated) {
      prompts.log.info("No changes made.")
      return
    }

    // Push
    const cleanSteps = steps.map((s: any) => ({
      title: s.title,
      type: s.type,
      instructions: s.instructions ?? null,
      order: s.order ?? 0,
      delay_hours: s.delay_hours ?? 0,
      ai_prompt: s.ai_prompt ?? null,
    }))

    const resp = await irisFetch(
      `/api/v1/bloqs/${cfg.board}/outreach-strategy-templates/${strategy.id}`,
      { method: "PUT", body: JSON.stringify({ steps: cleanSteps }) },
      RAICHU,
    )

    if (!resp.ok) {
      await handleApiError(resp, "update strategy")
      return
    }

    prompts.log.success(`${cfg.strategy} updated! Verify: iris som -c ${name}`)
  },
})

// ── Parent command ──

export const PlatformSomCommand = cmd({
  command: "som",
  describe: "SOM outreach dashboard — view and edit all campaigns at a glance",
  builder: (yargs) =>
    yargs
      .command(SomOverviewCommand)
      .command(SomEditCommand)
      // Default to overview when no subcommand
      .option("campaign", { alias: "c", describe: "show only one campaign", type: "string" })
      .option("scripts", { alias: "s", describe: "show full script text", type: "boolean" })
      .option("json", { describe: "JSON output", type: "boolean" }),
  async handler(args) {
    // Default behavior: run overview
    await SomOverviewCommand.handler(args as any)
  },
})
