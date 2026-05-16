import { cmd } from "./cmd"
import * as prompts from "./clack"
import { irisFetch, IRIS_API, requireAuth, requireUserId, handleApiError, dim, bold } from "./iris-api"

// ============================================================================
// Instagram CLI — Instagram inbox + outreach automation
// ============================================================================

const RAICHU = process.env.IRIS_FL_API_URL ?? "https://raichu.heyiris.io"

async function dispatchHiveTask(taskPayload: Record<string, unknown>): Promise<any> {
  const userId = await requireUserId()
  if (!userId) return null
  const { type, action, board_id, limit, dry_run, ...rest } = taskPayload
  const promptParts = [`custom mode=${action || "outreach"} board=${board_id} limit=${limit || 20}`]
  if (dry_run) promptParts.push("dry=1")
  const res = await irisFetch("/api/v6/nodes/tasks", {
    method: "POST",
    body: JSON.stringify({
      user_id: userId,
      title: `${action || type || "som"}`,
      type: (type as string) || "som",
      prompt: promptParts.join(" "),
      config: { action, board_id, limit, dry_run, ...rest },
    }),
  }, IRIS_API)
  const ok = await handleApiError(res, "dispatch_hive_task")
  if (!ok) return null
  return await res.json()
}

function timeAgo(ts: string | null | undefined): string {
  if (!ts) return ""
  const diff = Date.now() - new Date(ts).getTime()
  if (diff < 0) return "now"
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 7) return `${days}d ago`
  return `${Math.floor(days / 7)}w ago`
}

// -- check-replies --
const CheckRepliesCommand = cmd({
  command: "check-replies",
  describe: "Scan Instagram DM inbox for lead replies and tag them",
  builder: (yargs) =>
    yargs
      .option("board", { describe: "Board ID", type: "number", default: 38 })
      .option("limit", { describe: "Max conversations to scan", type: "number", default: 30 })
      .option("account", { describe: "IG account handle", type: "string", default: "heyiris.io" })
      .option("dry-run", { describe: "Show matches without tagging", type: "boolean" }),
  async handler(args) {
    const token = await requireAuth()
    if (!token) return
    const boardId = (args as any).board as number
    const limit = (args as any).limit as number
    const account = (args as any).account as string
    const dryRun = (args as any)["dry-run"] as boolean

    prompts.intro(`${bold("iris instagram")} check-replies`)
    console.log(`  Account: @${account}`)
    console.log(`  Board: ${boardId}`)
    console.log(`  Limit: ${limit} conversations`)
    if (dryRun) console.log(`  MODE: ${dim("DRY RUN")}`)

    const result = await dispatchHiveTask({
      type: "som",
      action: "instagram_inbox_check",
      board_id: boardId,
      limit,
      dry_run: dryRun ?? false,
      ig_account: account,
    })

    if (result?.task?.id) {
      console.log(`  Task dispatched: ${bold(result.task.id)}`)
    } else {
      console.log(`  ${dim("No Hive node available -- task queued")}`)
    }
    prompts.outro("Done")
  },
})

// -- replies --
const RepliesCommand = cmd({
  command: "replies",
  describe: "Show all DM replies across boards (leads who replied to outreach)",
  builder: (yargs) =>
    yargs
      .option("board", { describe: "Filter by board ID", type: "number" })
      .option("limit", { describe: "Max leads to show", type: "number", default: 50 })
      .option("platform", { describe: "Filter: instagram, linkedin, all", type: "string", default: "all" })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    const token = await requireAuth()
    if (!token) return
    const boardId = (args as any).board as number | undefined
    const limit = (args as any).limit as number
    const platform = (args as any).platform as string
    const jsonOut = (args as any).json as boolean

    prompts.intro(`${bold("iris instagram")} replies`)

    const spinner = prompts.spinner()
    spinner.start("Fetching replied leads...")

    // Strategy: fetch leads from board, filter for has_replied=true client-side
    try {
      let allLeads: any[] = []
      for (let page = 1; page <= 5 && allLeads.length < limit; page++) {
        const params = new URLSearchParams({
          per_page: "100",
          page: String(page),
        })
        if (boardId) params.set("bloq_id", String(boardId))

        const res = await irisFetch(`/api/v1/leads?${params}`, {}, RAICHU)
        if (!res.ok) break
        const data = (await res.json()) as any
        const batch = data?.data?.data ?? data?.data ?? []
        if (batch.length === 0) break

        // Filter for leads with has_replied=true OR replied_at set
        for (const lead of batch) {
          if (lead.has_replied || lead.replied_at) {
            allLeads.push(lead)
          }
          if (allLeads.length >= limit) break
        }
      }

      const leads = allLeads

      if (leads.length === 0) {
        spinner.stop("No replies found")
        console.log(`  No leads with inbox replies${boardId ? ` on board ${boardId}` : ""}.`)
        console.log(`  Run: iris instagram check-replies --board ${boardId || 38}`)
        prompts.outro("Done")
        return
      }

      spinner.stop(`${leads.length} leads with replies`)

      if (jsonOut) {
        const output = leads.map((l: any) => ({
          id: l.id,
          name: l.name || l.full_name,
          status: l.status,
          replied_at: l.replied_at,
          board_ids: l.bloq_ids,
        }))
        console.log(JSON.stringify(output, null, 2))
        prompts.outro("")
        return
      }

      // Display formatted table
      console.log("")
      console.log(`  ${bold("INBOX REPLIES")}${boardId ? ` — Board ${boardId}` : " — All Boards"}`)
      console.log(`  ${"─".repeat(60)}`)

      for (const lead of leads) {
        const name = (lead.name || lead.full_name || `Lead #${lead.id}`).padEnd(22).slice(0, 22)
        const age = timeAgo(lead.replied_at)
        const status = lead.status || ""
        const icon = "\x1b[32m●\x1b[0m"

        console.log(`  ${icon} ${bold(name)} ${dim(age.padEnd(8))} ${dim(status)}`)
      }

      console.log(`  ${"─".repeat(60)}`)
      console.log(`  ${bold("Total:")} ${leads.length} leads replied`)
      console.log("")
      console.log(`  ${dim("Tip: iris instagram replies --board 38 --json")}`)

    } catch (err: any) {
      spinner.stop("Error")
      console.log(`  ${err.message}`)
    }

    prompts.outro("Done")
  },
})

export const PlatformInstagramCommand = cmd({
  command: "instagram",
  describe: "Instagram inbox automation — check DM replies, tag leads",
  builder: (yargs) =>
    yargs
      .command(CheckRepliesCommand)
      .command(RepliesCommand)
      .demandCommand(0),
  async handler() {
    prompts.intro(`${bold("iris instagram")}`)
    console.log("  Subcommands:")
    console.log("    check-replies  Dispatch inbox scan task (runs via Hive)")
    console.log("    replies        View all DM replies across boards")
    console.log("")
    console.log(`  ${dim("iris instagram check-replies --board 38 --limit 30")}`)
    console.log(`  ${dim("iris instagram replies --board 38")}`)
    prompts.outro("")
  },
})
