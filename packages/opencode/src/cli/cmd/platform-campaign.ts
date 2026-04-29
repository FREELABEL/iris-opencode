import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { irisFetch, requireAuth, requireUserId, handleApiError, printDivider, printKV, dim, bold, success } from "./iris-api"
import { existsSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"
import { homedir } from "os"
import { execSync } from "child_process"

// ============================================================================
// iris campaign create — interactive wizard for new outreach campaigns
// ============================================================================

const CampaignCreateCommand = cmd({
  command: "create",
  describe: "create a new outreach campaign (interactive wizard)",
  builder: (yargs) =>
    yargs
      .option("vertical", { describe: "campaign vertical", type: "string" })
      .option("ig-account", { describe: "Instagram account handle", type: "string" })
      .option("location", { describe: "target location (e.g., Austin, TX)", type: "string" })
      .option("keywords", { describe: "target keywords (comma-separated)", type: "string" })
      .option("frequency", { describe: "run frequency", type: "string" })
      .option("user-id", { describe: "user ID", type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Create Campaign")

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { prompts.outro("Done"); return }

    // Step 1: Vertical
    let vertical = args.vertical
    if (!vertical) {
      vertical = (await prompts.select({
        message: "What vertical is this campaign for?",
        options: [
          { value: "restaurants", label: "Restaurants & Food" },
          { value: "venues", label: "Venues & Event Spaces" },
          { value: "dentists", label: "Dentists & Medical" },
          { value: "creators", label: "Content Creators" },
          { value: "realtors", label: "Real Estate Agents" },
          { value: "fitness", label: "Fitness & Wellness" },
          { value: "beauty", label: "Beauty & Salons" },
          { value: "lawyers", label: "Law Firms" },
          { value: "custom", label: "Custom (enter your own)" },
        ],
      })) as string
      if (prompts.isCancel(vertical)) { prompts.outro("Cancelled"); return }
    }

    if (vertical === "custom") {
      vertical = (await prompts.text({
        message: "Enter your vertical name",
        placeholder: "e.g., pet grooming",
        validate: (x) => (x && x.length > 0 ? undefined : "Required"),
      })) as string
      if (prompts.isCancel(vertical)) { prompts.outro("Cancelled"); return }
    }

    // Step 2: IG Account
    let igAccount = args["ig-account"]
    if (!igAccount) {
      igAccount = (await prompts.text({
        message: "Your Instagram handle (for sending DMs)",
        placeholder: "e.g., myrestaurant",
        validate: (x) => (x && x.length > 0 ? undefined : "Required"),
      })) as string
      if (prompts.isCancel(igAccount)) { prompts.outro("Cancelled"); return }
    }
    igAccount = igAccount.replace("@", "")

    // Step 3: Location
    let location = args.location
    if (!location) {
      location = (await prompts.text({
        message: "Target location",
        placeholder: "e.g., Austin, TX",
      })) as string
      if (prompts.isCancel(location)) { prompts.outro("Cancelled"); return }
    }

    // Step 4: Keywords
    let keywords = args.keywords
    if (!keywords) {
      keywords = (await prompts.text({
        message: "Target keywords (comma-separated)",
        placeholder: `e.g., ${vertical}, local businesses`,
        initialValue: vertical,
      })) as string
      if (prompts.isCancel(keywords)) { prompts.outro("Cancelled"); return }
    }

    // Step 5: Channel
    const channel = (await prompts.select({
      message: "Outreach channel",
      options: [
        { value: "instagram", label: "Instagram DM (Recommended)" },
        { value: "email", label: "Email" },
        { value: "both", label: "Instagram DM + Email" },
        { value: "linkedin", label: "LinkedIn" },
      ],
    })) as string
    if (prompts.isCancel(channel)) { prompts.outro("Cancelled"); return }

    // Step 6: Frequency
    let frequency = args.frequency
    if (!frequency) {
      frequency = (await prompts.select({
        message: "How often should outreach run?",
        options: [
          { value: "hourly", label: "Every hour" },
          { value: "every_4_hours", label: "Every 4 hours (Recommended)" },
          { value: "daily", label: "Daily" },
          { value: "weekly", label: "Weekly" },
        ],
      })) as string
      if (prompts.isCancel(frequency)) { prompts.outro("Cancelled"); return }
    }

    // Step 7: Message style
    const messageStyle = (await prompts.select({
      message: "Message style",
      options: [
        { value: "friendly", label: "Friendly & casual" },
        { value: "professional", label: "Professional & direct" },
        { value: "custom", label: "Custom (write your own)" },
      ],
    })) as string
    if (prompts.isCancel(messageStyle)) { prompts.outro("Cancelled"); return }

    let messageTemplate = ""
    if (messageStyle === "custom") {
      messageTemplate = (await prompts.text({
        message: "Enter your DM template (use {name}, {company} for personalization)",
        placeholder: "Hey {name}! I saw your page and loved...",
      })) as string
      if (prompts.isCancel(messageTemplate)) { prompts.outro("Cancelled"); return }
    } else {
      const templates: Record<string, string> = {
        friendly: `Hey {name}! Love what you're doing with {company}. We're building something that could help you reach more people in ${location || "your area"} — would love to show you. What are you working on?`,
        professional: `Hi {name}, I came across {company} and think there's a strong fit with what we're building. We help businesses like yours automate outreach and grow their audience. Would you be open to a quick chat?`,
      }
      messageTemplate = templates[messageStyle] || templates.friendly
    }

    // ──── BUILD CAMPAIGN ────────────────────────────────

    const spinner = prompts.spinner()
    const slug = vertical.toLowerCase().replace(/[^a-z0-9]+/g, "-")
    const campaignName = `${vertical.charAt(0).toUpperCase() + vertical.slice(1)} Outreach${location ? ` - ${location}` : ""}`

    // 1. Create Board (Bloq)
    spinner.start("Creating board...")
    try {
      const bloqRes = await irisFetch(`/api/v1/users/${userId}/bloqs`, {
        method: "POST",
        body: JSON.stringify({
          name: campaignName,
          type: "user",
        }),
      })
      if (!(await handleApiError(bloqRes, "Create board"))) { spinner.stop("Failed", 1); prompts.outro("Done"); return }
      const bloq = ((await bloqRes.json()) as any)?.data ?? (await bloqRes.json())
      const boardId = bloq.id
      spinner.stop(success(`Board #${boardId}: ${campaignName}`))

      // 2. Create Outreach Strategy
      spinner.start("Creating outreach strategy...")
      const strategyName = `${vertical.charAt(0).toUpperCase() + vertical.slice(1)} Outreach | V1`
      const steps = []

      if (channel === "instagram" || channel === "both") {
        steps.push({
          title: "Instagram DM",
          type: "instagram",
          instructions: messageTemplate,
          delay_hours: 0,
        })
        steps.push({
          title: "Follow-up DM",
          type: "instagram",
          instructions: `Hey {name}, just following up on my last message! Would love to connect about {company}. Let me know if you're interested.`,
          delay_hours: 48,
        })
      }

      if (channel === "email" || channel === "both") {
        steps.push({
          title: "Email Outreach",
          type: "email",
          instructions: `Subject: Quick question about {company}\n\n${messageTemplate}`,
          delay_hours: channel === "both" ? 72 : 0,
        })
      }

      if (channel === "linkedin") {
        steps.push({
          title: "LinkedIn Connection",
          type: "linkedin",
          instructions: messageTemplate,
          delay_hours: 0,
        })
      }

      const strategyRes = await irisFetch(`/api/v1/users/${userId}/bloqs/${boardId}/outreach-strategies`, {
        method: "POST",
        body: JSON.stringify({
          name: strategyName,
          category: "cold_outreach",
          icon: "fab fa-instagram",
          steps,
        }),
      })
      const strategyOk = await handleApiError(strategyRes, "Create strategy")
      if (strategyOk) {
        const strategy = ((await strategyRes.json()) as any)?.data
        spinner.stop(success(`Strategy: ${strategyName} (${steps.length} steps)`))
      } else {
        spinner.stop(dim("Strategy creation skipped (API may not support it)"))
      }

      // 3. Create Schedule
      spinner.start("Creating schedule...")
      const cronMap: Record<string, string> = {
        hourly: "0 * * * *",
        every_4_hours: "0 */4 * * *",
        daily: "0 9 * * *",
        weekly: "0 9 * * 1",
      }

      // Create cloud schedule
      const scheduleRes = await irisFetch(`/api/v1/users/${userId}/bloqs/scheduled-jobs`, {
        method: "POST",
        body: JSON.stringify({
          agent_id: 11,
          task_name: campaignName,
          prompt: `${slug} limit=15 warmup=1`,
          time: "09:00",
          frequency,
          timezone: "America/Chicago",
          data: {
            type: "hive_task_dispatch",
            campaign_id: slug,
            params: {
              boardId: String(boardId),
              strategy: strategyName,
              igAccount,
              location,
              keywords,
              channel,
            },
          },
        }),
      })
      if (await handleApiError(scheduleRes, "Create schedule")) {
        const sched = ((await scheduleRes.json()) as any)?.data
        spinner.stop(success(`Schedule: ${frequency} (${cronMap[frequency] || frequency})`))
      } else {
        spinner.stop(dim("Schedule creation skipped"))
      }

      // 4. Summary
      printDivider()
      printKV("Campaign", campaignName)
      printKV("Board ID", boardId)
      printKV("Vertical", vertical)
      printKV("IG Account", `@${igAccount}`)
      printKV("Location", location || "—")
      printKV("Keywords", keywords || "—")
      printKV("Channel", channel)
      printKV("Frequency", frequency)
      printKV("Strategy", strategyName)
      printKV("Message", messageTemplate.slice(0, 80) + "...")
      printDivider()

      // 5. Offer to save IG session
      if (channel === "instagram" || channel === "both") {
        const saveSession = await prompts.confirm({
          message: "Save Instagram session now? (opens browser for login)",
        })
        if (saveSession) {
          prompts.log.info("Opening browser for Instagram login...")
          try {
            execSync(
              `IG_ACCOUNT=${igAccount} IG_USERNAME=${igAccount} npx playwright test tests/e2e/save-instagram-session.spec.ts --headed --timeout 300000`,
              { cwd: join(homedir(), "Sites", "freelabel"), stdio: "inherit" }
            )
            prompts.log.info(success("IG session saved"))
          } catch {
            prompts.log.warn("Session save failed or was cancelled. Run later:")
            prompts.log.info(dim(`IG_ACCOUNT=${igAccount} npm run som:save-session`))
          }
        } else {
          prompts.log.info(dim(`Save later: IG_ACCOUNT=${igAccount} npm run som:save-session`))
        }
      }

      // 6. Register as HiveCampaignTemplate in DB (replaces manual som-config.js edit)
      spinner.start("Registering campaign in database...")
      try {
        const templateRes = await irisFetch(`/api/v1/campaign-templates?user_id=${userId}`, {
          method: "POST",
          body: JSON.stringify({
            user_id: userId,
            category: "SOM",
            label: campaignName,
            subtitle: `@${igAccount} ${location || ""}`.trim(),
            badge_class: "bg-purple-500 bg-opacity-20 text-purple-400",
            type: "som",
            title: `SOM: ${campaignName}`,
            prompt_base: slug,
            inputs: [
              { key: "ig", label: "Send as", kind: "ig_account", default: igAccount },
              { key: "limit", label: "Limit", kind: "number", default: 15, min: 1, max: 50 },
              { key: "dry", label: "Dry Run", kind: "toggle", default: false },
            ],
            config: {
              igAccount,
              strategy: strategyName,
              boardId: String(boardId),
              location: location || null,
              keywords: keywords || null,
              channel,
            },
          }),
        })
        if (templateRes.ok) {
          spinner.stop(success("Campaign registered in DB"))
        } else {
          spinner.stop(dim("DB registration skipped (API returned " + templateRes.status + ")"))
          // Fallback: show manual instructions
          prompts.log.info(dim(`  Fallback: edit tests/e2e/som-config.js and add:`))
          prompts.log.info(dim(`  ${slug}: { boardId: '${boardId}', strategy: '${strategyName}', igAccount: '${igAccount}', active: true, label: '${campaignName}', color: '\\x1b[36m' }`))
        }
      } catch {
        spinner.stop(dim("DB registration skipped"))
      }

      prompts.log.info("")
      prompts.log.info(dim("Monitor: iris bridge runs"))
      prompts.log.info(dim(`Leads:   iris leads list --bloq-id ${boardId}`))
      prompts.log.info(dim(`Config:  iris campaigns list`))
      prompts.outro(success("Campaign created"))

    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

// ============================================================================
// iris campaign list — show all campaigns from som-config.js
// ============================================================================

const CampaignListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list all outreach campaigns (DB-first, som-config.js fallback)",
  builder: (yargs) =>
    yargs
      .option("user-id", { describe: "user ID", type: "number" })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Campaigns")

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])

    // Try DB first via daemon-configs API
    let campaigns: Record<string, any> = {}
    let source = "none"

    if (userId) {
      const spinner = prompts.spinner()
      spinner.start("Loading campaigns...")
      try {
        const res = await irisFetch(`/api/v1/campaign-templates/daemon-configs?user_id=${userId}`)
        if (res.ok) {
          const data = (await res.json()) as any
          if (data.configs && Object.keys(data.configs).length > 0) {
            campaigns = data.configs
            source = "database"
          }
        }
      } catch { /* fallback below */ }
      spinner.stop(source === "database" ? success(`Loaded from ${source}`) : dim("API unavailable — using local config"))
    }

    // Fallback to som-config.js
    if (Object.keys(campaigns).length === 0) {
      const configPaths = [
        join(homedir(), "Sites", "freelabel", "tests", "e2e", "som-config.js"),
        join(process.cwd(), "tests", "e2e", "som-config.js"),
      ]
      for (const p of configPaths) {
        if (existsSync(p)) {
          try {
            delete require.cache[require.resolve(p)]
            const config = require(p)
            if (config?.campaigns) {
              for (const [id, c] of Object.entries(config.campaigns) as [string, any][]) {
                campaigns[id] = { boardId: c.boardId, strategy: c.strategy, igAccount: c.igAccount, label: c.label, active: c.active, type: "som" }
              }
              source = "som-config.js"
            }
            break
          } catch {}
        }
      }
    }

    if (Object.keys(campaigns).length === 0) {
      prompts.log.warn("No campaigns found. Create one with: iris campaigns create")
      prompts.outro("Done")
      return
    }

    if (args.json) {
      console.log(JSON.stringify({ campaigns, source }, null, 2))
      prompts.outro("Done")
      return
    }

    console.log(`  ${dim(`source: ${source}`)}`)
    printDivider()
    for (const [id, c] of Object.entries(campaigns) as [string, any][]) {
      const status = c.active !== false
        ? `${UI.Style.TEXT_SUCCESS}● active${UI.Style.TEXT_NORMAL}`
        : dim("○ inactive")
      const ig = c.igAccount ? `@${c.igAccount}` : "—"
      const typeTag = c.type ? dim(` [${c.type}]`) : ""
      console.log(`  ${bold(c.label || id)}  ${status}  ${dim(ig)}  ${dim(`board:${c.boardId}`)}${typeTag}`)
      console.log(`    ${dim(`Strategy: ${c.strategy || "—"}`)}`)
      console.log()
    }
    printDivider()

    prompts.log.info(dim("iris campaign create   — create a new campaign"))
    prompts.outro("Done")
  },
})

// ============================================================================
// Root command
// ============================================================================

export const PlatformCampaignCommand = cmd({
  command: "campaign",
  aliases: ["campaigns"],
  describe: "manage outreach campaigns — create, list, monitor",
  builder: (yargs) =>
    yargs
      .command(CampaignCreateCommand)
      .command(CampaignListCommand)
      .demandCommand(),
  async handler() {},
})
