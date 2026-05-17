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

// -- follow-up --
const FollowUpCommand = cmd({
  command: "follow-up",
  describe: "Reply to a lead's DM (manual by default, --ai for auto-generated)",
  builder: (yargs) =>
    yargs
      .option("lead", { describe: "Lead ID to follow up with", type: "number", demandOption: true })
      .option("ai", { describe: "Generate reply with AI and send automatically", type: "boolean", default: false })
      .option("message", { describe: "Custom message to send (skips AI)", type: "string" })
      .option("account", { describe: "IG account to send from", type: "string", default: "heyiris.io" })
      .option("dry-run", { describe: "Type message but don't send", type: "boolean", default: false }),
  async handler(args) {
    const token = await requireAuth()
    if (!token) return
    const leadId = (args as any).lead as number
    const useAi = (args as any).ai as boolean
    const customMessage = (args as any).message as string | undefined
    const account = (args as any).account as string
    const dryRun = (args as any)["dry-run"] as boolean

    prompts.intro(`${bold("iris instagram")} follow-up`)

    const spinner = prompts.spinner()
    spinner.start("Fetching lead details...")

    // Fetch lead with notes
    let lead: any = null
    try {
      const res = await irisFetch(`/api/v1/leads/${leadId}`, {}, RAICHU)
      if (!res.ok) { spinner.stop("Error"); console.log(`  Lead #${leadId} not found (${res.status})`); return }
      const data = (await res.json()) as any
      lead = data?.data ?? data
    } catch (err: any) {
      spinner.stop("Error"); console.log(`  ${err.message}`); return
    }

    // Extract IG handle from lead
    const igHandle = lead.nickname
      || (lead.name?.startsWith("@") ? lead.name.slice(1) : null)
      || lead.name
      || ""

    if (!igHandle) {
      spinner.stop("Error"); console.log("  No IG handle found on this lead"); return
    }

    spinner.stop(`Lead: ${lead.name || igHandle} (@${igHandle})`)

    // Show conversation context
    const notes = (lead.notes || []).slice(0, 10)
    const replyNotes = notes.filter((n: any) => {
      const msg = (n.message || n.content || "").toLowerCase()
      return msg.includes("[inbox reply]") || msg.includes("reply")
    })

    if (replyNotes.length > 0 || notes.length > 0) {
      console.log("")
      console.log(`  ${bold("Conversation Context:")}`)
      const displayNotes = replyNotes.length > 0 ? replyNotes : notes.slice(0, 5)
      for (const note of displayNotes.slice(0, 5)) {
        const msg = (note.message || note.content || "").slice(0, 100)
        const age = timeAgo(note.created_at)
        console.log(`    ${dim(age.padEnd(8))} ${msg}`)
      }
      console.log("")
    }

    // Determine message to send
    let message = customMessage || ""

    if (!message && useAi) {
      // Generate AI reply
      const aiSpinner = prompts.spinner()
      aiSpinner.start("Generating reply...")
      try {
        const context = replyNotes.map((n: any) => n.message || n.content || "").join("\n")
        const leadName = lead.name || igHandle
        const aiRes = await irisFetch("/api/v6/openai/chat/completions", {
          method: "POST",
          body: JSON.stringify({
            model: "iris/gpt-4o-mini",
            messages: [
              {
                role: "system",
                content: `You are a friendly outreach assistant for a music/tech platform. Write a short, casual Instagram DM reply (1-3 sentences max). Be warm, direct, and conversational. No hashtags, no emoji spam. Sound like a real person following up on a conversation. Keep it under 200 characters.`,
              },
              {
                role: "user",
                content: `Lead: ${leadName}\nIG Handle: @${igHandle}\nPrevious conversation:\n${context}\n\nWrite a brief follow-up reply to continue this conversation and move toward booking a call or next step.`,
              },
            ],
            max_tokens: 150,
          }),
        }, IRIS_API)

        if (aiRes.ok) {
          const aiData = (await aiRes.json()) as any
          message = aiData?.choices?.[0]?.message?.content?.trim() || ""
        }
      } catch {}

      if (!message) {
        aiSpinner.stop("AI generation failed")
        console.log(`  Could not generate reply. Use --message "your text" instead.`)
        return
      }
      aiSpinner.stop("Reply generated")
    }

    if (!message && !useAi) {
      // Manual mode — dispatch task to open browser
      console.log(`  ${bold("Manual mode")} — opening DM thread with @${igHandle}`)
      console.log(`  The browser will open. Type your reply and send it manually.`)
      console.log("")

      const userId = await requireUserId()
      if (!userId) return

      const result = await dispatchHiveTask({
        type: "som",
        action: "instagram_follow_up",
        board_id: lead.bloq_ids?.[0] || 38,
        target_handle: igHandle,
        ig_account: account,
        manual_mode: true,
      })

      if (result?.task?.id) {
        console.log(`  Task dispatched: ${bold(result.task.id)}`)
        console.log(`  Browser will open on your daemon machine.`)
      } else {
        // Fallback: try to run locally
        console.log(`  ${dim("No daemon available. Running locally...")}`)
        const { execSync } = await import("child_process")
        const somDir = process.env.SOM_DIR || `${process.env.HOME}/Sites/freelabel/fl-docker-dev/coding-agent-bridge/som`
        const sessionFile = process.env.BROWSER_SESSION_FILE || `${process.env.HOME}/Sites/freelabel/tests/e2e/instagram-auth-${account}.json`
        try {
          execSync(
            `TARGET_HANDLE=${igHandle} MANUAL_MODE=1 IG_ACCOUNT=${account} BROWSER_SESSION_FILE="${sessionFile}" npx playwright test instagram-follow-up.spec.ts --headed --timeout=600000`,
            { cwd: somDir, stdio: "inherit" }
          )
        } catch { /* user closed browser */ }
      }
      prompts.outro("Done")
      return
    }

    // Show the message and confirm
    console.log(`  ${bold("To:")} @${igHandle}`)
    console.log(`  ${bold("Message:")} "${message}"`)
    if (dryRun) console.log(`  ${bold("Mode:")} DRY RUN (won't send)`)
    console.log("")

    if (!dryRun && !customMessage) {
      // Ask for confirmation unless --message was explicit
      const confirm = await prompts.confirm({ message: "Send this message?" })
      if (!confirm) { prompts.outro("Cancelled"); return }
    }

    // Dispatch the follow-up task
    const userId = await requireUserId()
    if (!userId) return

    const result = await dispatchHiveTask({
      type: "som",
      action: "instagram_follow_up",
      board_id: lead.bloq_ids?.[0] || 38,
      target_handle: igHandle,
      message: message,
      ig_account: account,
      dry_run: dryRun,
    })

    if (result?.task?.id) {
      console.log(`  Task dispatched: ${bold(result.task.id)}`)
      console.log(`  ${dryRun ? "Will type but NOT send" : "Message will be sent"} via daemon.`)
    } else {
      console.log(`  ${dim("No Hive node available — task queued")}`)
    }

    prompts.outro("Done")
  },
})

export const PlatformInstagramCommand = cmd({
  command: "instagram",
  describe: "Instagram inbox automation — check replies, view, follow up",
  builder: (yargs) =>
    yargs
      .command(CheckRepliesCommand)
      .command(RepliesCommand)
      .command(FollowUpCommand)
      .demandCommand(0),
  async handler() {
    prompts.intro(`${bold("iris instagram")}`)
    console.log("  Subcommands:")
    console.log("    check-replies  Scan inbox for new replies (via Hive)")
    console.log("    replies        View leads who replied")
    console.log("    follow-up      Reply to a lead's DM")
    console.log("")
    console.log(`  ${dim("iris instagram check-replies --board 38")}`)
    console.log(`  ${dim("iris instagram replies --board 38")}`)
    console.log(`  ${dim("iris instagram follow-up --lead 21665")}`)
    console.log(`  ${dim("iris instagram follow-up --lead 21665 --ai")}`)
    console.log(`  ${dim("iris instagram follow-up --lead 21665 --message \"Hey! Let's connect\"")}`)
    prompts.outro("")
  },
})
