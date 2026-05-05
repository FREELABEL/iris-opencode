import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, bold, dim, success, highlight } from "./iris-api"
import { SomCampaignCommand } from "./platform-som-campaign"

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

// ── Help ──

const SomHelpCommand = cmd({
  command: "help",
  describe: "show the full SOM outreach management guide",
  builder: (yargs) => yargs,
  async handler() {
    const b = bold
    const d = dim

    console.log("")
    console.log(b("SOM — Sales Outreach Machine"))
    console.log(d("Automated Instagram DM outreach across 4 campaigns"))
    console.log("")

    console.log(b("CAMPAIGNS"))
    console.log("  courses   Board #38   @heyiris.io         AI builders, tech founders")
    console.log("  creators  Board #80   @thediscoverpage_    Artists, creators, hip-hop culture")
    console.log("  beatbox   Board #224  @thebeatbox__        DJs, producers, beatmakers")
    console.log("  venues    Board #292  @freelabelnet        Cafes, venues, event spaces")
    console.log("")

    console.log(b("DASHBOARD"))
    console.log("  iris som                       Overview of all 4 campaigns")
    console.log("  iris som -s                    With full script text")
    console.log("  iris som -c creators           Just one campaign")
    console.log("  iris som --json                JSON output for scripting")
    console.log("")

    console.log(b("EDIT SCRIPTS"))
    console.log("  iris som edit creators          Interactive — pick a step to edit")
    console.log("  iris som edit creators --step=1 Jump to step 1")
    console.log("  iris som edit beatbox --step=1 --field=script   Edit DM text")
    console.log("  iris som edit beatbox --step=1 --field=ai       Edit AI prompt")
    console.log("  iris som edit beatbox --step=1 --field=both     Edit both")
    console.log("")

    console.log(b("STRATEGY CRUD"))
    console.log("  iris outreach list 80           List strategies on a board")
    console.log("  iris outreach show 80 18        Show strategy + all steps")
    console.log("  iris outreach create 80 --from-json=file.json")
    console.log("  iris outreach update 80 18 --from-json=file.json")
    console.log("  iris outreach apply 80 18 412   Apply strategy to a lead")
    console.log("  iris outreach delete 80 18      Delete a strategy")
    console.log("")

    console.log(b("RUN BATCHES"))
    console.log("  npm run som:all -- limit=15 enrich=1    All 4 campaigns")
    console.log("  npm run som:creators -- limit=20        Just creators")
    console.log("  npm run som:beatbox -- limit=5 dry=1    Dry run (no DMs)")
    console.log("")

    console.log(b("LEAD GENERATION"))
    console.log("  npm run leadgen:custom -- custom mode=comments \\")
    console.log("    post=https://instagram.com/p/XXX/ ig=heyiris.io board=80 limit=200")
    console.log("")

    console.log(b("SCRIPT BEST PRACTICES"))
    console.log("  " + d("1.") + " No URLs in Step 1 — triggers Instagram spam filters")
    console.log("  " + d("2.") + " No income claims — triggers skepticism + spam detection")
    console.log("  " + d("3.") + " Lead with monetization — what they get paid for, not your tech")
    console.log("  " + d("4.") + " Single audience per campaign — don't list multiple personas")
    console.log("  " + d("5.") + " Soft CTA — \"What are you working on?\" not \"Sign up now\"")
    console.log("  " + d("6.") + " Under 4 sentences — mobile DMs are small")
    console.log("  " + d("7.") + " AI prompt does the heavy lifting — template + personalization")
    console.log("")

    console.log(b("TROUBLESHOOTING"))
    console.log("  \"All leads already have outreach\"  → Scrape fresh leads")
    console.log("  \"No Instagram handle — skipping\"   → Venue/business lead without IG")
    console.log("  \"Lead map API timed out\"            → API slow under parallel load")
    console.log("  \"No Open Instagram btn\"             → Lead has no IG handle in system")
    console.log("  \"No Send message in menu\"           → Private account or DMs blocked")
    console.log("")
  },
})

// ── Toggle command ──

function findSomConfig(): string | null {
  const { existsSync } = require("fs")
  const { join, resolve } = require("path")
  let dir = process.cwd()
  for (let i = 0; i < 10; i++) {
    const candidate = join(dir, "tests", "e2e", "som-config.js")
    if (existsSync(candidate)) return candidate
    const parent = resolve(dir, "..")
    if (parent === dir) break
    dir = parent
  }
  return null
}

const SomToggleCommand = cmd({
  command: "toggle <campaign> [state]",
  describe: "turn a campaign on or off",
  builder: (yargs) =>
    yargs
      .positional("campaign", { describe: "campaign name (courses, creators, beatbox, mayo, venues, atxbeauty, gooddeals)", type: "string", demandOption: true })
      .positional("state", { describe: "on or off (toggles if omitted)", type: "string" }),
  async handler(args) {
    const { readFileSync, writeFileSync } = require("fs")
    UI.empty()
    prompts.intro("◈  SOM Toggle")

    const configPath = findSomConfig()
    if (!configPath) {
      prompts.log.error("som-config.js not found. Run from the freelabel project root.")
      prompts.outro("Done")
      return
    }

    const content = readFileSync(configPath, "utf-8")
    const campaign = (args.campaign as string).toLowerCase()

    // Find the campaign line
    const regex = new RegExp(`(${campaign}:\\s*\\{[^}]*active:\\s*)(true|false)`, "i")
    const match = content.match(regex)

    if (!match) {
      prompts.log.error(`Campaign "${campaign}" not found in som-config.js`)
      const available = content.match(/^\s+(\w+):\s*\{/gm)?.map((m: string) => m.trim().replace(/:\s*\{/, "")) ?? []
      prompts.log.info(`Available: ${available.join(", ")}`)
      prompts.outro("Done")
      return
    }

    const currentState = match[2] === "true"
    let newState: boolean

    if (args.state === "on") newState = true
    else if (args.state === "off") newState = false
    else newState = !currentState // toggle

    if (currentState === newState) {
      prompts.log.info(`${campaign} is already ${newState ? "ON" : "OFF"}`)
      prompts.outro("Done")
      return
    }

    const updated = content.replace(regex, `$1${newState}`)
    writeFileSync(configPath, updated)

    prompts.log.info(`${bold(campaign)} ${currentState ? "ON → OFF" : "OFF → ON"}`)

    // Show all campaign states
    const allCampaigns = updated.match(/(\w+):\s*\{[^}]*active:\s*(true|false)/gi) ?? []
    console.log("")
    for (const line of allCampaigns) {
      const nameMatch = line.match(/^(\w+):/)
      const activeMatch = line.match(/active:\s*(true|false)/)
      if (nameMatch && activeMatch) {
        const n = nameMatch[1]
        const a = activeMatch[1] === "true"
        console.log(`  ${a ? "✅" : "❌"} ${n}`)
      }
    }
    console.log("")

    prompts.outro(dim("Changes take effect on next som:all run"))
  },
})

const SomStatusCommand = cmd({
  command: "status",
  describe: "show which campaigns are on/off",
  builder: (yargs) => yargs,
  async handler() {
    const { readFileSync } = require("fs")
    UI.empty()
    prompts.intro("◈  SOM Status")

    const configPath = findSomConfig()
    if (!configPath) {
      prompts.log.error("som-config.js not found")
      prompts.outro("Done")
      return
    }

    const content = readFileSync(configPath, "utf-8")
    const allCampaigns = content.match(/(\w+):\s*\{[^}]*active:\s*(true|false)/gi) ?? []

    let on = 0, off = 0
    for (const line of allCampaigns) {
      const nameMatch = line.match(/^(\w+):/)
      const activeMatch = line.match(/active:\s*(true|false)/)
      if (nameMatch && activeMatch) {
        const n = nameMatch[1]
        const a = activeMatch[1] === "true"
        console.log(`  ${a ? "✅" : "❌"} ${n}`)
        a ? on++ : off++
      }
    }
    console.log("")
    prompts.outro(`${on} active, ${off} off`)
  },
})

// ── Update script (non-interactive) ──

const SomUpdateScriptCommand = cmd({
  command: "script <campaign> <text>",
  describe: "update a step's script for a campaign (non-interactive)",
  builder: (yargs) =>
    yargs
      .positional("campaign", { describe: "campaign name", type: "string", demandOption: true })
      .positional("text", { describe: "new script text (quote it)", type: "string", demandOption: true })
      .option("step", { describe: "step number (default: 1)", type: "number", default: 1 }),
  async handler(args) {
    await requireAuth()
    UI.empty()
    prompts.intro(`◈  Update Script — ${args.campaign}`)

    const camp = CAMPAIGNS[args.campaign as string]
    if (!camp) {
      prompts.log.error(`Unknown campaign: ${args.campaign}`)
      prompts.outro("Done")
      return
    }

    const strategy = await fetchStrategyByName(camp.board, camp.strategy)
    if (!strategy) {
      prompts.log.error(`Strategy "${camp.strategy}" not found on board ${camp.board}`)
      prompts.outro("Done")
      return
    }

    const steps = ((strategy.steps ?? []) as any[]).sort((a: any, b: any) => (a.order ?? 0) - (b.order ?? 0))
    const stepIdx = (args.step as number) - 1
    if (stepIdx < 0 || stepIdx >= steps.length) {
      prompts.log.error(`Step ${args.step} doesn't exist (${steps.length} steps total)`)
      prompts.outro("Done")
      return
    }

    const oldScript = steps[stepIdx].instructions ?? ""
    steps[stepIdx].instructions = args.text as string

    const resp = await irisFetch(
      `/api/v1/bloqs/${camp.board}/outreach-strategy-templates/${(strategy as any).id}`,
      { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ steps }) },
      RAICHU
    )

    if (resp.ok) {
      prompts.log.info(`${bold(args.campaign as string)} Step ${args.step} updated`)
      console.log(dim(`  Old: ${oldScript.slice(0, 80)}...`))
      console.log(`  New: ${(args.text as string).slice(0, 80)}...`)
    } else {
      prompts.log.error(`Failed: HTTP ${resp.status}`)
    }
    prompts.outro("Done")
  },
})

// ── Clear AI prompt ──

const SomClearAiCommand = cmd({
  command: "clearai <campaign>",
  describe: "clear ai_prompt from all steps (lightweight variation instead)",
  builder: (yargs) =>
    yargs
      .positional("campaign", { type: "string" })
      .option("step", { type: "number" }),
  async handler(args) {
    await requireAuth()
    UI.empty()
    prompts.intro(`◈  Clear AI Prompt — ${args.campaign}`)

    const camp = CAMPAIGNS[args.campaign as string]
    if (!camp) {
      prompts.log.error(`Unknown campaign: ${args.campaign}`)
      prompts.outro("Done")
      return
    }

    const strategy = await fetchStrategyByName(camp.board, camp.strategy)
    if (!strategy) {
      prompts.log.error(`Strategy "${camp.strategy}" not found`)
      prompts.outro("Done")
      return
    }

    const steps = ((strategy.steps ?? []) as any[]).sort((a: any, b: any) => (a.order ?? 0) - (b.order ?? 0))
    let cleared = 0

    for (let i = 0; i < steps.length; i++) {
      if (args.step && (args.step as number) !== i + 1) continue
      if (steps[i].ai_prompt) {
        steps[i].ai_prompt = null
        cleared++
        console.log(`  Step ${i + 1}: ${steps[i].title} — ai_prompt cleared`)
      }
    }

    if (cleared === 0) {
      prompts.log.info("No steps had ai_prompt set")
      prompts.outro("Done")
      return
    }

    const resp = await irisFetch(
      `/api/v1/bloqs/${camp.board}/outreach-strategy-templates/${(strategy as any).id}`,
      { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ steps }) },
      RAICHU
    )

    if (resp.ok) {
      prompts.log.info(`Cleared ai_prompt on ${cleared} step(s)`)
    } else {
      prompts.log.error(`Failed: HTTP ${resp.status}`)
    }
    prompts.outro(dim("Vary It will now do word swaps instead of full rewrites"))
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
      .command(SomToggleCommand)
      .command(SomStatusCommand)
      .command(SomHelpCommand)
      .command(SomCampaignCommand)
      // Default to overview when no subcommand
      .option("campaign", { alias: "c", describe: "show only one campaign", type: "string" })
      .option("scripts", { alias: "s", describe: "show full script text", type: "boolean" })
      .option("json", { describe: "JSON output", type: "boolean" })
      .demandCommand(0),
  async handler(args) {
    // Default behavior: run overview
    await SomOverviewCommand.handler(args as any)
  },
})
