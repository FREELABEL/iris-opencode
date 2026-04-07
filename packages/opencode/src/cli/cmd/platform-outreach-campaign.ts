import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, printDivider, printKV, dim, bold, success } from "./iris-api"

// ============================================================================
// Outreach Campaigns — port of OutreachCampaignCommand.php
// Endpoint base: /api/v1/outreach-campaigns
// ============================================================================

const BASE = "/api/v1/outreach-campaigns"

const TYPES: Record<string, string> = {
  one_time: "One-Time",
  recurring: "Recurring",
  drip: "Drip",
  broadcast: "Broadcast",
}

const CHANNELS: Record<string, string> = {
  email: "Email",
  sms: "SMS",
  instagram_dm: "Instagram DM",
  linkedin: "LinkedIn",
  multi_channel: "Multi-Channel",
}

function formatStatus(status: string): string {
  const map: Record<string, string> = {
    active: `${UI.Style.TEXT_SUCCESS}● Active${UI.Style.TEXT_NORMAL}`,
    draft: `${UI.Style.TEXT_WARNING}○ Draft${UI.Style.TEXT_NORMAL}`,
    scheduled: `${UI.Style.TEXT_INFO}◎ Scheduled${UI.Style.TEXT_NORMAL}`,
    paused: `${UI.Style.TEXT_WARNING}⏸ Paused${UI.Style.TEXT_NORMAL}`,
    completed: `${UI.Style.TEXT_DIM}✓ Completed${UI.Style.TEXT_NORMAL}`,
    cancelled: `${UI.Style.TEXT_DANGER}✗ Cancelled${UI.Style.TEXT_NORMAL}`,
  }
  return map[status] ?? status
}

function progressBar(pct: number): string {
  const filled = Math.round((pct ?? 0) / 5)
  const empty = Math.max(0, 20 - filled)
  return `[${"█".repeat(filled)}${"░".repeat(empty)}] ${(pct ?? 0).toFixed(1)}%`
}

async function getJson(res: Response): Promise<any> {
  try { return await res.json() } catch { return {} }
}

// ── list ──

const ListCmd = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list outreach campaigns",
  builder: (yargs) =>
    yargs
      .option("bloq", { describe: "filter by bloq ID", type: "number" })
      .option("status", { describe: "filter by status", type: "string" })
      .option("type", { describe: "filter by type", type: "string" })
      .option("json", { describe: "JSON output", type: "boolean" }),
  async handler(args) {
    if (!(await requireAuth())) return
    const params = new URLSearchParams()
    if (args.bloq) params.set("bloq_id", String(args.bloq))
    if (args.status) params.set("status", String(args.status))
    if (args.type) params.set("campaign_type", String(args.type))

    const res = await irisFetch(`${BASE}?${params}`)
    if (!(await handleApiError(res, "List campaigns"))) return
    const body = await getJson(res)
    const campaigns: any[] = body.campaigns ?? body.data ?? []

    if (args.json) { console.log(JSON.stringify(campaigns, null, 2)); return }

    if (campaigns.length === 0) {
      prompts.log.info("No campaigns found.")
      return
    }

    console.log("")
    console.log(bold("Outreach Campaigns"))
    printDivider()
    for (const c of campaigns) {
      const name = bold(String(c.name ?? "(unnamed)"))
      const id = dim(`#${c.id}`)
      const st = formatStatus(String(c.status ?? "draft"))
      const type = TYPES[c.campaign_type] ?? c.campaign_type ?? "-"
      const progress = c.progress_percentage != null ? `${Math.round(c.progress_percentage)}%` : "0%"
      console.log(`  ${id}  ${name}  ${st}  ${dim(type)}  ${dim(`${c.sent_count ?? 0}/${c.total_recipients ?? 0}`)}  ${dim(progress)}`)
    }
    printDivider()
  },
})

// ── show ──

const ShowCmd = cmd({
  command: "show <id>",
  describe: "show campaign details + metrics",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "campaign ID", type: "number", demandOption: true })
      .option("json", { describe: "JSON output", type: "boolean" }),
  async handler(args) {
    if (!(await requireAuth())) return
    const res = await irisFetch(`${BASE}/${args.id}`)
    if (!(await handleApiError(res, "Get campaign"))) return
    const body = await getJson(res)
    const c = body.campaign ?? body.data ?? body

    if (args.json) { console.log(JSON.stringify(c, null, 2)); return }

    console.log("")
    console.log(bold(`Campaign: ${c.name}`))
    printDivider()
    printKV("ID", c.id)
    printKV("Status", formatStatus(String(c.status ?? "draft")))
    printKV("Type", TYPES[c.campaign_type] ?? c.campaign_type)
    printKV("Channel", CHANNELS[c.broadcast_channel] ?? c.broadcast_channel)
    printKV("Bloq ID", c.bloq_id)
    printKV("Agent", c.agent?.name ?? c.agent_id)
    printKV("Strategy", c.strategy_template?.name ?? c.strategy_template_id)
    printKV("Description", c.description)
    console.log("")
    console.log(bold("Metrics"))
    printKV("Recipients", c.total_recipients ?? 0)
    printKV("Sent", c.sent_count ?? 0)
    printKV("Delivered", c.delivered_count ?? 0)
    printKV("Opened", c.opened_count ?? 0)
    printKV("Clicked", c.clicked_count ?? 0)
    printKV("Replied", c.replied_count ?? 0)
    printKV("Bounced", c.bounced_count ?? 0)
    printKV("Failed", c.failed_count ?? 0)
    console.log(`  ${dim("Progress:")}  ${progressBar(c.progress_percentage ?? 0)}`)
    printDivider()
  },
})

// ── create ──

const CreateCmd = cmd({
  command: "create",
  describe: "create a campaign",
  builder: (yargs) =>
    yargs
      .option("bloq", { describe: "bloq ID", type: "number", demandOption: true })
      .option("name", { describe: "campaign name", type: "string" })
      .option("type", { describe: "one_time|recurring|drip|broadcast", type: "string", default: "broadcast" })
      .option("channel", { describe: "email|sms|instagram_dm|linkedin|multi_channel", type: "string", default: "email" })
      .option("strategy", { describe: "strategy template ID", type: "number" })
      .option("agent", { describe: "agent ID", type: "number" })
      .option("subject", { describe: "email subject", type: "string" })
      .option("message", { describe: "broadcast message", type: "string" })
      .option("ig-account", { describe: "IG account override", type: "string" })
      .option("leadgen-mode", { describe: "followers|comments|profiles", type: "string" })
      .option("leadgen-source-url", { describe: "leadgen source URL", type: "string" })
      .option("solution", { describe: "solution key", type: "string" })
      .option("json", { describe: "JSON output", type: "boolean" }),
  async handler(args) {
    if (!(await requireAuth())) return

    const payload: Record<string, unknown> = {
      bloq_id: args.bloq,
      name: args.name ?? "New Campaign",
      campaign_type: args.type,
      broadcast_channel: args.channel,
      strategy_template_id: args.strategy ?? null,
      agent_id: args.agent ?? null,
      broadcast_subject: args.subject ?? null,
      broadcast_message: args.message ?? null,
    }
    if (args["ig-account"]) payload.ig_account = args["ig-account"]
    if (args["leadgen-mode"]) payload.leadgen_mode = args["leadgen-mode"]
    if (args["leadgen-source-url"]) payload.leadgen_source_url = args["leadgen-source-url"]
    if (args.solution) payload.solution = args.solution

    const res = await irisFetch(BASE, { method: "POST", body: JSON.stringify(payload) })
    if (!(await handleApiError(res, "Create campaign"))) return
    const body = await getJson(res)
    const c = body.campaign ?? body.data ?? body

    if (args.json) { console.log(JSON.stringify(c, null, 2)); return }

    prompts.log.success(`${success("✓")} Campaign #${c.id} created: ${bold(String(c.name))}`)
    prompts.log.info(dim(`iris outreach-campaign start ${c.id}`))
  },
})

// ── start/pause/resume/cancel ──

function actionCmd(action: string, destructive = false) {
  return cmd({
    command: `${action} <id>`,
    describe: `${action} a campaign`,
    builder: (yargs) => yargs.positional("id", { describe: "campaign ID", type: "number", demandOption: true }),
    async handler(args) {
      if (!(await requireAuth())) return
      if (destructive) {
        const ok = await prompts.confirm({ message: `${action} campaign #${args.id}?` })
        if (!ok || prompts.isCancel(ok)) { prompts.log.info("Cancelled"); return }
      }
      const res = await irisFetch(`${BASE}/${args.id}/${action}`, { method: "POST" })
      if (!(await handleApiError(res, `${action} campaign`))) return
      const body = await getJson(res)
      prompts.log.success(body.message ?? `Campaign ${action}ed`)
    },
  })
}

// ── schedule ──

const ScheduleCmd = cmd({
  command: "schedule <id>",
  describe: "schedule a campaign for future execution",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "campaign ID", type: "number", demandOption: true })
      .option("at", { describe: 'datetime (e.g. "2026-03-05 10:00")', type: "string", demandOption: true }),
  async handler(args) {
    if (!(await requireAuth())) return
    const res = await irisFetch(`${BASE}/${args.id}/schedule`, {
      method: "POST",
      body: JSON.stringify({ scheduled_at: args.at }),
    })
    if (!(await handleApiError(res, "Schedule campaign"))) return
    const body = await getJson(res)
    prompts.log.success(body.message ?? `Campaign scheduled for ${args.at}`)
  },
})

// ── analytics ──

const AnalyticsCmd = cmd({
  command: "analytics <id>",
  describe: "show campaign performance analytics",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "campaign ID", type: "number", demandOption: true })
      .option("json", { describe: "JSON output", type: "boolean" }),
  async handler(args) {
    if (!(await requireAuth())) return
    const res = await irisFetch(`${BASE}/${args.id}/analytics`)
    if (!(await handleApiError(res, "Analytics"))) return
    const body = await getJson(res)
    const a = body.analytics ?? body.data ?? body

    if (args.json) { console.log(JSON.stringify(a, null, 2)); return }

    console.log("")
    console.log(bold(`Analytics — Campaign #${args.id}`))
    printDivider()
    const ov = a.overview ?? {}
    printKV("Recipients", ov.total_recipients ?? 0)
    printKV("Sent", ov.sent_count ?? 0)
    printKV("Delivered", ov.delivered_count ?? 0)
    printKV("Opened", ov.opened_count ?? 0)
    printKV("Clicked", ov.clicked_count ?? 0)
    printKV("Replied", ov.replied_count ?? 0)
    printKV("Bounced", ov.bounced_count ?? 0)
    printKV("Failed", ov.failed_count ?? 0)
    const r = a.rates ?? {}
    console.log("")
    printKV("Delivery Rate", `${r.delivery_rate ?? 0}%`)
    printKV("Open Rate", `${r.open_rate ?? 0}%`)
    printKV("Click Rate", `${r.click_rate ?? 0}%`)
    printKV("Reply Rate", `${r.reply_rate ?? 0}%`)
    printKV("Bounce Rate", `${r.bounce_rate ?? 0}%`)
    console.log(`  ${dim("Progress:")}  ${progressBar(a.progress ?? 0)}`)
    printDivider()
  },
})

// ── recipients ──

const RecipientsCmd = cmd({
  command: "recipients <id>",
  describe: "show campaign recipients",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "campaign ID", type: "number", demandOption: true })
      .option("status", { describe: "filter by status", type: "string" })
      .option("json", { describe: "JSON output", type: "boolean" }),
  async handler(args) {
    if (!(await requireAuth())) return
    const params = new URLSearchParams()
    if (args.status) params.set("status", String(args.status))
    const res = await irisFetch(`${BASE}/${args.id}/recipients?${params}`)
    if (!(await handleApiError(res, "Recipients"))) return
    const body = await getJson(res)
    const raw = body.recipients ?? body.data ?? []
    const recipients: any[] = raw.data ?? raw

    if (args.json) { console.log(JSON.stringify(raw, null, 2)); return }
    if (recipients.length === 0) { prompts.log.info("No recipients"); return }

    console.log("")
    console.log(bold(`Campaign #${args.id} Recipients`))
    printDivider()
    for (const r of recipients) {
      const lead = r.lead ?? {}
      const name = lead.name ?? lead.first_name ?? `Lead #${r.lead_id}`
      console.log(`  ${dim(`#${r.lead_id}`)}  ${bold(String(name))}  ${dim(lead.email ?? "-")}  ${dim(String(r.status ?? "pending"))}`)
    }
    printDivider()
  },
})

// ── duplicate ──

const DuplicateCmd = cmd({
  command: "duplicate <id>",
  describe: "duplicate a campaign",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "campaign ID", type: "number", demandOption: true })
      .option("new-name", { describe: "name for duplicate", type: "string" }),
  async handler(args) {
    if (!(await requireAuth())) return
    const payload: Record<string, unknown> = {}
    if (args["new-name"]) payload.name = args["new-name"]
    const res = await irisFetch(`${BASE}/${args.id}/duplicate`, { method: "POST", body: JSON.stringify(payload) })
    if (!(await handleApiError(res, "Duplicate"))) return
    const body = await getJson(res)
    const c = body.campaign ?? body.data ?? body
    prompts.log.success(`${success("✓")} Duplicated as #${c.id}: ${bold(String(c.name))}`)
  },
})

// ── delete ──

const DeleteCmd = cmd({
  command: "delete <id>",
  describe: "delete a draft campaign",
  builder: (yargs) => yargs.positional("id", { describe: "campaign ID", type: "number", demandOption: true }),
  async handler(args) {
    if (!(await requireAuth())) return
    const ok = await prompts.confirm({ message: `Delete campaign #${args.id}?` })
    if (!ok || prompts.isCancel(ok)) { prompts.log.info("Cancelled"); return }
    const res = await irisFetch(`${BASE}/${args.id}`, { method: "DELETE" })
    if (!(await handleApiError(res, "Delete"))) return
    prompts.log.success(`${success("✓")} Campaign #${args.id} deleted`)
  },
})

// ── Root ──

export const PlatformOutreachCampaignCommand = cmd({
  command: "outreach-campaign",
  aliases: ["reachr-campaign"],
  describe: "manage outreach campaigns (Reachr)",
  builder: (yargs) =>
    yargs
      .command(ListCmd)
      .command(ShowCmd)
      .command(CreateCmd)
      .command(actionCmd("start"))
      .command(actionCmd("pause"))
      .command(actionCmd("resume"))
      .command(actionCmd("cancel", true))
      .command(ScheduleCmd)
      .command(AnalyticsCmd)
      .command(RecipientsCmd)
      .command(DuplicateCmd)
      .command(DeleteCmd)
      .demandCommand(),
  async handler() {},
})
