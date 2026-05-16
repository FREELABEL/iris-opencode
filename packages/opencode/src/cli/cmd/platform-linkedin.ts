import { cmd } from "./cmd"
import * as prompts from "./clack"
import { irisFetch, requireAuth, handleApiError, dim, bold } from "./iris-api"

// ============================================================================
// LinkedIn CLI — LinkedIn outreach campaign management
//
// 4 subcommands:
//   iris linkedin status                           — show gooddeals campaign config + metrics
//   iris linkedin search <query> [--dry-run]       — dispatch Hive task for LinkedIn scraping
//   iris linkedin outreach <boardId> [--limit=5]   — dispatch batch outreach via Hive
//   iris linkedin connect --board 302 --limit 10   — end-to-end: discover + apply strategy + queue outreach
// ============================================================================

async function dispatchHiveTask(taskPayload: Record<string, unknown>): Promise<any> {
  const res = await irisFetch("/api/v6/tools/execute", {
    method: "POST",
    body: JSON.stringify({
      tool: "dispatch_hive_task",
      parameters: taskPayload,
    }),
  })
  const ok = await handleApiError(res, "dispatch_hive_task")
  if (!ok) return null
  return await res.json()
}

// -- status --
const StatusCommand = cmd({
  command: "status",
  describe: "Show LinkedIn campaign config and metrics",
  builder: (yargs) => yargs.option("json", { describe: "JSON output", type: "boolean" }),
  async handler(args) {
    const token = await requireAuth()
    if (!token) return
    prompts.intro(`${bold("iris linkedin")} status`)

    const res = await irisFetch("/api/v1/leads/stats?bloq_id=302")
    const ok = await handleApiError(res, "leads/stats")
    if (!ok) return

    const data = await res.json()
    const stats = data?.data || {}

    if ((args as any).json) {
      console.log(JSON.stringify(stats, null, 2))
      return
    }

    console.log(`  ${bold("Board")}:       302 (Good Deals — LinkedIn Founder Outreach)`)
    console.log(`  ${bold("Total Leads")}: ${stats.total_leads ?? dim("—")}`)
    console.log(`  ${bold("Engagement")}:`)
    const eng = stats.engagement || {}
    console.log(`    Never contacted:  ${eng.never_contacted ?? 0}`)
    console.log(`    Outreach pending: ${eng.outreach_pending ?? 0}`)
    console.log(`    Completed:        ${eng.completed ?? 0}`)
    console.log(`    Replied:          ${eng.replied ?? 0}`)

    prompts.outro("Done")
  },
})

// -- search --
const SearchCommand = cmd({
  command: "search <query>",
  describe: "Dispatch LinkedIn scraper Hive task",
  builder: (yargs) =>
    yargs
      .positional("query", { describe: "Search query (e.g., 'AI founder Austin')", type: "string", demandOption: true })
      .option("dry-run", { describe: "Show what would be dispatched", type: "boolean" })
      .option("limit", { describe: "Max profiles to scrape", type: "number", default: 20 }),
  async handler(args) {
    const token = await requireAuth()
    if (!token) return
    const query = (args as any).query as string
    const limit = (args as any).limit as number
    const dryRun = (args as any)["dry-run"] as boolean

    prompts.intro(`${bold("iris linkedin")} search`)
    console.log(`  Query: "${query}"`)
    console.log(`  Limit: ${limit}`)

    if (dryRun) {
      console.log(`\n  ${dim("[DRY RUN]")} Would dispatch Hive task:`)
      console.log(`    type: som`)
      console.log(`    action: linkedin_scrape`)
      console.log(`    query: ${query}`)
      console.log(`    limit: ${limit}`)
      prompts.outro("Dry run complete")
      return
    }

    const result = await dispatchHiveTask({
      type: "som",
      action: "linkedin_scrape",
      query,
      limit,
      board_id: 302,
    })

    if (result?.data?.task_id) {
      console.log(`  Task dispatched: ${bold(result.data.task_id)}`)
    } else {
      console.log(`  ${dim("No Hive node available — task queued")}`)
    }
    prompts.outro("Done")
  },
})

// -- outreach --
const OutreachCommand = cmd({
  command: "outreach [boardId]",
  describe: "Dispatch LinkedIn batch outreach via Hive (dry-run by default, --live to send)",
  builder: (yargs) =>
    yargs
      .positional("boardId", { describe: "Board ID", type: "number", default: 302 })
      .option("limit", { describe: "Max leads to process", type: "number", default: 5 })
      .option("live", { describe: "Actually send (default: dry-run)", type: "boolean", default: false })
      .option("strategy", { describe: "Strategy name", type: "string", default: "LinkedIn Founder Outreach | V1" }),
  async handler(args) {
    const token = await requireAuth()
    if (!token) return
    const boardId = (args as any).boardId as number
    const limit = (args as any).limit as number
    const live = (args as any).live as boolean
    const strategy = (args as any).strategy as string

    prompts.intro(`${bold("iris linkedin")} outreach`)
    console.log(`  Board: ${boardId}`)
    console.log(`  Strategy: ${strategy}`)
    console.log(`  Limit: ${limit}`)
    console.log(`  MODE: ${live ? bold("LIVE") : dim("DRY RUN")}`)

    if (live) {
      const confirm = await prompts.confirm({
        message: `Send real LinkedIn DMs to up to ${limit} leads on board ${boardId}?`,
      })
      if (!confirm || prompts.isCancel(confirm)) {
        prompts.outro("Cancelled")
        return
      }
    }

    const result = await dispatchHiveTask({
      type: "som",
      action: "batch_outreach",
      channel: "linkedin",
      board_id: boardId,
      strategy,
      limit,
      dry_run: !live,
    })

    if (result?.data?.task_id) {
      console.log(`  Task dispatched: ${bold(result.data.task_id)}`)
    } else {
      console.log(`  ${dim("No Hive node available -- task queued")}`)
    }
    prompts.outro("Done")
  },
})

// -- connect (end-to-end) --
const ConnectCommand = cmd({
  command: "connect",
  describe: "End-to-end: discover + apply strategy + queue outreach (dry-run by default)",
  builder: (yargs) =>
    yargs
      .option("board", { describe: "Board ID", type: "number", default: 302 })
      .option("limit", { describe: "Max leads to outreach", type: "number", default: 10 })
      .option("query", { describe: "Search query for discovery", type: "string" })
      .option("live", { describe: "Actually send (default: dry-run)", type: "boolean", default: false }),
  async handler(args) {
    const token = await requireAuth()
    if (!token) return
    const boardId = (args as any).board as number
    const limit = (args as any).limit as number
    const live = (args as any).live as boolean
    const query = (args as any).query as string | undefined

    prompts.intro(`${bold("iris linkedin")} connect`)
    console.log(`  MODE: ${live ? bold("LIVE") : dim("DRY RUN")}`)

    if (live) {
      const confirm = await prompts.confirm({
        message: `Run end-to-end LinkedIn pipeline (discover + outreach) for board ${boardId}?`,
      })
      if (!confirm || prompts.isCancel(confirm)) {
        prompts.outro("Cancelled")
        return
      }
    }

    // Step 1: Discovery (if query provided)
    if (query) {
      console.log(`\n  ${bold("Step 1: Discovery")}`)
      console.log(`  Query: "${query}"`)

      if (live) {
        const scrapeResult = await dispatchHiveTask({
          type: "som",
          action: "linkedin_scrape",
          query,
          limit: limit * 2,
          board_id: boardId,
        })
        if (scrapeResult?.data?.task_id) {
          console.log(`  Scrape task: ${bold(scrapeResult.data.task_id)}`)
        }
      } else {
        console.log(`  ${dim("[DRY RUN] Would scrape LinkedIn for leads")}`)
      }
    } else {
      console.log(`\n  ${bold("Step 1: Discovery")} ${dim("(skipped -- no --query)")}`)
    }

    // Step 2: Queue outreach
    console.log(`\n  ${bold("Step 2: Queue Outreach")}`)
    console.log(`  Board: ${boardId}, Limit: ${limit}`)

    if (live) {
      const outreachResult = await dispatchHiveTask({
        type: "som",
        action: "batch_outreach",
        channel: "linkedin",
        board_id: boardId,
        strategy: "LinkedIn Founder Outreach | V1",
        limit,
        dry_run: false,
      })
      if (outreachResult?.data?.task_id) {
        console.log(`  Outreach task: ${bold(outreachResult.data.task_id)}`)
      }
    } else {
      console.log(`  ${dim("[DRY RUN] Would dispatch LinkedIn outreach")}`)
    }

    prompts.outro("Done")
  },
})

// -- check-replies --
const CheckRepliesCommand = cmd({
  command: "check-replies",
  describe: "Scan LinkedIn inbox for lead replies and tag them",
  builder: (yargs) =>
    yargs
      .option("board", { describe: "Board ID", type: "number", default: 302 })
      .option("limit", { describe: "Max conversations to scan", type: "number", default: 20 })
      .option("dry-run", { describe: "Show matches without tagging", type: "boolean" }),
  async handler(args) {
    const token = await requireAuth()
    if (!token) return
    const boardId = (args as any).board as number
    const limit = (args as any).limit as number
    const dryRun = (args as any)["dry-run"] as boolean

    prompts.intro(`${bold("iris linkedin")} check-replies`)
    console.log(`  Board: ${boardId}`)
    console.log(`  Limit: ${limit} conversations`)
    if (dryRun) console.log(`  MODE: ${dim("DRY RUN")}`)

    const result = await dispatchHiveTask({
      type: "som",
      action: "linkedin_inbox_check",
      board_id: boardId,
      limit,
      dry_run: dryRun ?? false,
    })

    if (result?.data?.task_id) {
      console.log(`  Task dispatched: ${bold(result.data.task_id)}`)
    } else {
      console.log(`  ${dim("No Hive node available -- task queued")}`)
    }
    prompts.outro("Done")
  },
})

export const PlatformLinkedInCommand = cmd({
  command: "linkedin",
  describe: "LinkedIn outreach — search, outreach, connect campaigns",
  builder: (yargs) =>
    yargs
      .command(StatusCommand)
      .command(SearchCommand)
      .command(OutreachCommand)
      .command(ConnectCommand)
      .command(CheckRepliesCommand)
      .demandCommand(0),
  async handler(args) {
    // Default: show status
    await StatusCommand.handler(args as any)
  },
})
