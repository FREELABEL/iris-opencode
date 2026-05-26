import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, IRIS_API, requireAuth, requireUserId, handleApiError, printDivider, dim, bold, isNonInteractive, bridgeFetch } from "./iris-api"

// ============================================================================
// Shared Helpers
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

// ============================================================================
// Helpers
// ============================================================================


interface OutreachStep {
  step: number
  title: string
  is_completed: boolean
}

interface InboxEntry {
  lead_id: number
  lead_name: string
  channel: "ig" | "email" | "imessage" | "whatsapp" | "discord" | "crm" | "calendar"
  direction: "inbound" | "outbound"
  preview: string
  timestamp: string | null
  metadata?: Record<string, unknown>
  outreach_steps?: OutreachStep[]
  outreach_total?: number
  outreach_done?: number
}

const CHANNEL_ICONS: Record<string, string> = {
  ig: "\x1b[35m◉\x1b[0m",       // purple
  email: "\x1b[34m✉\x1b[0m",    // blue
  imessage: "\x1b[32m◈\x1b[0m", // green
  whatsapp: "\x1b[32m◉\x1b[0m", // green
  discord: "\x1b[35m◈\x1b[0m",  // purple
  crm: "\x1b[90m●\x1b[0m",      // gray
  calendar: "\x1b[33m◆\x1b[0m", // yellow
}

const CHANNEL_LABELS: Record<string, string> = {
  ig: "IG",
  email: "Email",
  imessage: "iMessage",
  whatsapp: "WhatsApp",
  discord: "Discord",
  crm: "CRM",
  calendar: "Calendar",
}

function timeAgo(ts: string | null): string {
  if (!ts) return ""
  const diff = Date.now() - new Date(ts).getTime()
  if (diff < 0) return "soon"
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 7) return `${days}d ago`
  return `${Math.floor(days / 7)}w ago`
}

// ============================================================================
// Subcommand: iris inbox scan
// ============================================================================

const SUPPORTED_PLATFORMS = ["instagram", "linkedin", "whatsapp"] as const
type ScanPlatform = typeof SUPPORTED_PLATFORMS[number]

const PLATFORM_ALIASES: Record<string, ScanPlatform> = {
  ig: "instagram", insta: "instagram", instagram: "instagram",
  li: "linkedin", linkedin: "linkedin",
  wa: "whatsapp", whatsapp: "whatsapp",
}

const PLATFORM_DISPLAY: Record<ScanPlatform, string> = {
  instagram: "Instagram",
  linkedin: "LinkedIn",
  whatsapp: "WhatsApp",
}

const ScanCommand: any = cmd({
  command: "scan",
  describe: "Scan platform inbox for new lead replies and tag them",
  builder: (yargs: any) =>
    yargs
      .option("platform", {
        describe: "Platform to scan: instagram (ig), linkedin (li), whatsapp (wa)",
        type: "string",
        demandOption: true,
        alias: "p",
      })
      .option("board", { describe: "Board ID (default: your primary board)", type: "number" })
      .option("limit", { describe: "Max conversations to scan", type: "number", default: 20 })
      .option("account", { describe: "Account handle (IG) or session name (WA)", type: "string" })
      .option("dry-run", { describe: "Show matches without tagging", type: "boolean", default: false })
      .option("json", { describe: "JSON output", type: "boolean", default: false })
      .example("iris inbox scan --platform whatsapp", "Scan WhatsApp for new replies")
      .example("iris inbox scan -p ig --board 38", "Scan Instagram DMs on board 38")
      .example("iris inbox scan -p linkedin --dry-run", "Preview LinkedIn matches without tagging"),
  async handler(args: any) {
    const token = await requireAuth()
    if (!token) return

    const rawPlatform = (args.platform as string).toLowerCase()
    const platform = PLATFORM_ALIASES[rawPlatform]
    if (!platform) {
      prompts.log.error(`Unknown platform "${rawPlatform}". Use: instagram (ig), linkedin (li), or whatsapp (wa)`)
      return
    }

    const boardId = args.board as number | undefined
    const limit = args.limit as number
    const dryRun = args["dry-run"] as boolean
    const jsonOut = args.json as boolean
    const account = args.account as string | undefined

    const displayName = PLATFORM_DISPLAY[platform]

    prompts.intro(`${bold("iris inbox scan")} — ${displayName}`)

    // Resolve board: use flag, or try to detect user's default board
    let resolvedBoard = boardId
    if (!resolvedBoard) {
      try {
        const meRes = await irisFetch("/api/v1/me", {}, RAICHU)
        if (meRes.ok) {
          const me = (await meRes.json()) as any
          resolvedBoard = me?.data?.default_bloq_id ?? me?.data?.bloqs?.[0]?.id
        }
      } catch {}
    }
    if (!resolvedBoard) {
      prompts.log.error("Could not detect your default board. Use --board <id> to specify one.")
      prompts.log.info(`${dim("Find your boards:")} iris leads boards`)
      return
    }

    if (!jsonOut) {
      console.log(`  Platform: ${displayName}`)
      console.log(`  Board:    ${resolvedBoard}`)
      console.log(`  Limit:    ${limit} conversations`)
      if (account) console.log(`  Account:  ${account}`)
      if (dryRun) console.log(`  Mode:     ${bold("DRY RUN")} — will show matches but not tag`)
      console.log()
    }

    const spinner = prompts.spinner()
    spinner.start(`Dispatching ${displayName} inbox scan to Hive...`)

    const taskConfig: Record<string, unknown> = {
      type: "som",
      action: `${platform}_inbox_check`,
      board_id: resolvedBoard,
      limit,
      dry_run: dryRun,
    }
    if (platform === "instagram") taskConfig.ig_account = account ?? "heyiris.io"
    if (platform === "whatsapp") taskConfig.wa_account = account ?? "default"

    const result = await dispatchHiveTask(taskConfig)

    if (result?.task?.id) {
      spinner.stop(`${displayName} scan dispatched`)
      const taskId = result.task.id

      if (jsonOut) {
        console.log(JSON.stringify({ task_id: taskId, platform, board: resolvedBoard, status: "dispatched" }, null, 2))
      } else {
        console.log(`  Task: ${bold(taskId)}`)
        console.log(`  ${dim("Your Hive node will scan the inbox and tag leads with replies.")}`)
        if (dryRun) {
          console.log(`  ${dim("Dry run — no leads will be modified.")}`)
        }
        console.log()
        console.log(`  Check results:`)
        console.log(`    ${dim("iris inbox")}               — view all replies`)
        console.log(`    ${dim(`iris instagram replies --board ${resolvedBoard}`)} — see tagged leads`)
      }
    } else {
      spinner.stop("Dispatched (queued)")
      if (!jsonOut) {
        console.log(`  ${dim("No Hive node online right now — task is queued.")}`)
        console.log(`  ${dim("It will run automatically when a node comes online.")}`)
        console.log()
        console.log(`  ${dim("Start a node:")} iris bridge start`)
      }
    }

    prompts.outro("")
  },
})

// ============================================================================
// Subcommand: iris inbox connect
// ============================================================================

const ConnectCommand: any = cmd({
  command: "connect <platform>",
  describe: "Set up or refresh a platform inbox session",
  builder: (yargs: any) =>
    yargs
      .positional("platform", {
        describe: "Platform: instagram, linkedin, whatsapp",
        type: "string",
      })
      .option("account", { describe: "Account name (for multiple accounts)", type: "string" }),
  async handler(args: any) {
    const rawPlatform = (args.platform as string).toLowerCase()
    const platform = PLATFORM_ALIASES[rawPlatform]
    if (!platform) {
      prompts.log.error(`Unknown platform "${rawPlatform}". Use: instagram, linkedin, or whatsapp`)
      return
    }

    const displayName = PLATFORM_DISPLAY[platform]
    const account = (args.account as string) || (platform === "instagram" ? "heyiris.io" : "default")

    prompts.intro(`${bold("iris inbox connect")} — ${displayName}`)

    if (platform === "whatsapp") {
      console.log(`  WhatsApp uses a persistent browser session (QR code login).`)
      console.log()
      console.log(`  To set up or refresh your session, run:`)
      console.log()
      console.log(`    ${bold(`WA_ACCOUNT=${account} npx playwright test som/save-whatsapp-session.spec.ts --headed`)}`)
      console.log()
      console.log(`  This will open WhatsApp Web — scan the QR code with your phone.`)
      console.log(`  The session is saved to ${dim(`~/.iris/whatsapp-sessions/${account}/`)}`)
    } else if (platform === "instagram") {
      console.log(`  Instagram uses browser cookies for authentication.`)
      console.log()
      console.log(`  To save your session:`)
      console.log()
      console.log(`    ${bold(`iris hive credentials save-session --platform instagram --account ${account}`)}`)
      console.log()
      console.log(`  This will open Instagram — log in and the session will be saved.`)
    } else if (platform === "linkedin") {
      console.log(`  LinkedIn uses browser cookies for authentication.`)
      console.log()
      console.log(`  To save your session:`)
      console.log()
      console.log(`    ${bold("iris hive credentials save-session --platform linkedin")}`)
      console.log()
      console.log(`  This will open LinkedIn — log in and the session will be saved.`)
    }

    console.log()
    console.log(`  After connecting, scan with:`)
    console.log(`    ${dim(`iris inbox scan --platform ${rawPlatform}`)}`)

    prompts.outro("")
  },
})

// ============================================================================
// Subcommand: iris inbox status
// ============================================================================

const StatusCommand: any = cmd({
  command: "status",
  describe: "Show last scan results and session health",
  builder: (yargs: any) =>
    yargs
      .option("board", { describe: "Board ID", type: "number" })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args: any) {
    const token = await requireAuth()
    if (!token) return

    const boardId = args.board as number | undefined
    const jsonOut = args.json as boolean

    prompts.intro(`${bold("iris inbox status")}`)

    const spinner = prompts.spinner()
    spinner.start("Checking scan status...")

    // Check for recent inbox-sync data
    try {
      const params = new URLSearchParams({ limit: "50" })
      if (boardId) params.set("bloq_id", String(boardId))
      const res = await irisFetch(`/api/v1/leads?${params}&has_replied=true`, {}, RAICHU)
      if (res.ok) {
        const body = (await res.json()) as any
        const leads = body?.data?.data ?? body?.data ?? []
        const replied = leads.filter((l: any) => l.has_replied || l.replied_at)

        spinner.stop(`${replied.length} leads with replies`)

        if (jsonOut) {
          const output = replied.map((l: any) => ({
            id: l.id,
            name: l.name || l.full_name,
            replied_at: l.replied_at,
            status: l.status,
          }))
          console.log(JSON.stringify(output, null, 2))
        } else if (replied.length > 0) {
          printDivider()
          for (const l of replied.slice(0, 20)) {
            const name = bold((l.name || l.full_name || `Lead #${l.id}`).slice(0, 25).padEnd(25))
            const status = l.status ?? ""
            const repliedAt = l.replied_at ? dim(timeAgo(l.replied_at)) : ""
            console.log(`  ${name}  ${status.padEnd(12)}  ${repliedAt}`)
          }
          if (replied.length > 20) console.log(`  ${dim(`...and ${replied.length - 20} more`)}`)
        } else {
          console.log(`  ${dim("No replied leads found. Run:")} iris inbox scan -p instagram`)
        }
      } else {
        spinner.stop("Could not fetch status")
      }
    } catch (err: any) {
      spinner.stop("Error")
      prompts.log.error(err.message)
    }

    prompts.outro("")
  },
})

// ============================================================================
// Subcommand: iris inbox view (the original unified inbox)
// ============================================================================

const ViewCommand: any = cmd({
  command: "view",
  describe: "Unified inbox — all leads, all channels, newest first",
  builder: (yargs: any) =>
    yargs
      .option("days", { describe: "look-back window", type: "number", default: 7 })
      .option("channel", { describe: "filter: ig, email, imessage, whatsapp, discord, crm, calendar", type: "string" })
      .option("bloq", { describe: "scope to a bloq/board ID", type: "number" })
      .option("status", { describe: "filter by reply status (replied, pending, all)", type: "string" })
      .option("outreach", { describe: "show only leads with pending outreach steps", type: "boolean", default: false })
      .option("search", { describe: "full-text search across messages", type: "string" })
      .option("limit", { describe: "max leads to scan", type: "number", default: 25 })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args: any) {
    await inboxViewHandler(args)
  },
})

// ============================================================================
// Parent Command: iris inbox
// ============================================================================

export const PlatformInboxCommand: any = cmd({
  command: "inbox",
  describe: "Inbox scanner & unified view — scan for replies, check status, view messages",
  builder: (yargs: any) =>
    yargs
      .command(ScanCommand)
      .command(ConnectCommand)
      .command(StatusCommand)
      .command(ViewCommand)
      // Pass through all view options so bare `iris inbox` still works as before
      .option("days", { describe: "look-back window", type: "number", default: 7 })
      .option("channel", { describe: "filter: ig, email, imessage, whatsapp, discord, crm, calendar", type: "string" })
      .option("bloq", { describe: "scope to a bloq/board ID", type: "number" })
      .option("status", { describe: "filter by reply status (replied, pending, all)", type: "string" })
      .option("outreach", { describe: "show only leads with pending outreach steps", type: "boolean", default: false })
      .option("search", { describe: "full-text search across messages", type: "string" })
      .option("limit", { describe: "max leads to scan", type: "number", default: 25 })
      .option("json", { describe: "JSON output", type: "boolean", default: false })
      .demandCommand(0),
  async handler(args: any) {
    // Default behavior: run the unified inbox view (backwards compatible)
    await inboxViewHandler(args)
  },
})

// ============================================================================
// Unified inbox view handler (extracted from old command)
// ============================================================================

async function inboxViewHandler(args: any) {
    UI.empty()

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const days = args.days ?? 7
    const channelFilter = args.channel?.toLowerCase() ?? null
    const bloqFilter = args.bloq ?? null
    const searchFilter = args.search ?? null
    const maxLeads = args.limit ?? 25

    prompts.intro(`◈  Unified Inbox  ${dim(`(last ${days} days)`)}`)

    const spinner = prompts.spinner()

    // ── Strategy: Try Redis-backed API first, fall back to live bridge scan ──
    let entries: InboxEntry[] = []
    let source = "live"

    // Attempt 1: Server-side inbox endpoint (Redis → MySQL fallback on server)
    spinner.start("Loading inbox…")
    try {
      const params = new URLSearchParams({ days: String(days), limit: String(maxLeads * 10) })
      if (channelFilter) params.set("channel", channelFilter)
      if (bloqFilter) params.set("bloq_id", String(bloqFilter))
      const res = await irisFetch(`/api/v1/atlas/comms/inbox?${params}`)
      if (res.ok) {
        const body = (await res.json()) as any
        const serverEntries = body?.data?.entries ?? []
        if (serverEntries.length > 0) {
          source = body?.data?.source ?? "server"
          entries = serverEntries.map((e: any) => ({
            lead_id: e.lead_id,
            lead_name: e.lead_name ?? `Lead #${e.lead_id}`,
            channel: e.channel as InboxEntry["channel"],
            direction: (e.direction ?? "inbound") as "inbound" | "outbound",
            preview: (e.subject || e.body || "").slice(0, 120),
            timestamp: e.sent_at,
          }))
          spinner.stop(`${entries.length} messages ${dim(`(${source})`)}`)
        }
      }
    } catch { /* server endpoint not available — fall back to live scan */ }

    // Attempt 2: Live bridge scan (if server returned nothing)
    if (entries.length === 0) {
      spinner.stop("Cache empty — scanning live…")
      const scanSpinner = prompts.spinner()
      scanSpinner.start("Fetching leads…")

      let leads: any[] = []
      try {
        // Fetch active leads only — exclude Prospected (bulk-scraped, no real conversations)
        // Query multiple statuses that indicate real engagement
        const statuses = ["Won", "Active", "Contacted", "Interested", "In Negotiation", "Converted", "New"]
        const fetches = statuses.map(status => {
          const params = new URLSearchParams({ per_page: String(maxLeads), status })
          if (bloqFilter) params.set("bloq_id", String(bloqFilter))
          if (searchFilter) params.set("search", searchFilter)
          return irisFetch(`/api/v1/leads?${params}`).then(async r => r.ok ? ((await r.json()) as any)?.data ?? [] : []).catch(() => [])
        })
        const results = await Promise.all(fetches)
        // Deduplicate by ID, take first maxLeads
        const seen = new Set<number>()
        for (const batch of results) {
          for (const lead of batch) {
            if (!seen.has(lead.id)) { seen.add(lead.id); leads.push(lead) }
            if (leads.length >= maxLeads) break
          }
          if (leads.length >= maxLeads) break
        }
      } catch (err) {
        scanSpinner.stop("Error", 1)
        prompts.log.error(err instanceof Error ? err.message : String(err))
        prompts.outro("Done")
        return
      }

      if (leads.length === 0) {
        scanSpinner.stop("No leads found")
        prompts.outro("Done")
        return
      }

      scanSpinner.stop(`Scanning ${leads.length} leads…`)
      const liveSpinner = prompts.spinner()
      liveSpinner.start("Scanning channels…")

      await Promise.allSettled(leads.map(async (lead: any) => {
        const leadId = lead.id
        const leadName = lead.name ?? lead.first_name ?? `Lead #${leadId}`
        const email = lead.email ?? ""
        const phone = lead.phone ?? ""
        const commsToIngest: Array<{ channel: string; items: any[] }> = []

        // CRM notes
        if (!channelFilter || channelFilter === "crm") {
          const notes: any[] = Array.isArray(lead.notes) ? lead.notes : []
          for (const n of notes.slice(0, 5)) {
            const content = typeof n === "object" ? (n.content ?? n.body ?? "") : String(n)
            const ts = typeof n === "object" ? (n.created_at ?? null) : null
            entries.push({ lead_id: leadId, lead_name: leadName, channel: "crm", direction: "outbound", preview: content.split("\n")[0]?.slice(0, 120) ?? "", timestamp: ts })
          }
        }

        // Activities (IG DMs)
        if (!channelFilter || channelFilter === "ig") {
          try {
            const actRes = await irisFetch(`/api/v1/leads/${leadId}/activities?limit=10`)
            if (actRes.ok) {
              const actBody = (await actRes.json()) as any
              const activities = Array.isArray(actBody?.data) ? actBody.data : []
              for (const act of activities) {
                if (act.type === "ig_dm" || act.channel === "instagram" || (act.description ?? "").includes("DM")) {
                  entries.push({ lead_id: leadId, lead_name: leadName, channel: "ig", direction: act.direction ?? "outbound", preview: (act.description ?? act.body ?? "").slice(0, 120), timestamp: act.created_at ?? null })
                }
              }
            }
          } catch { /* non-fatal */ }
        }

        // iMessage via bridge
        if ((!channelFilter || channelFilter === "imessage") && (phone || email)) {
          try {
            const handle = phone || email
            const r = await bridgeFetch(`/api/imessage/search?handle=${encodeURIComponent(handle)}&days=${days}&limit=10`)
            if (r.ok) {
              const d = (await r.json()) as any
              const msgs = (d?.messages ?? []).slice(0, 10)
              for (const msg of msgs) {
                entries.push({ lead_id: leadId, lead_name: leadName, channel: "imessage", direction: msg.from_me ? "outbound" : "inbound", preview: (msg.text ?? "").slice(0, 120), timestamp: msg.ts ?? msg.date ?? null })
              }
              if (msgs.length > 0) {
                commsToIngest.push({ channel: "imessage", items: msgs.map((msg: any) => ({
                  direction: msg.from_me ? "outbound" : "inbound",
                  from_identifier: msg.from_me ? "me" : (phone || email),
                  body: msg.text ?? "",
                  sent_at: msg.ts ?? msg.date ?? null,
                  metadata: { source: "inbox_scan" },
                })) })
              }
            }
          } catch { /* bridge may be offline */ }
        }

        // WhatsApp via local SQLite
        if ((!channelFilter || channelFilter === "whatsapp") && phone) {
          try {
            const wa = require("../lib/whatsapp")
            if (wa.isAvailable()) {
              const msgs = wa.searchByPhone(phone, days, 10)
              for (const msg of msgs) {
                entries.push({ lead_id: leadId, lead_name: leadName, channel: "whatsapp" as const, direction: msg.from_me ? "outbound" : "inbound", preview: (msg.text ?? "").slice(0, 120), timestamp: msg.date ?? null })
              }
              if (msgs.length > 0) {
                commsToIngest.push({ channel: "whatsapp", items: msgs.map((msg: any) => ({
                  direction: msg.from_me ? "outbound" : "inbound",
                  from_identifier: msg.from_me ? "me" : (wa.extractPhone(msg.from_jid) || phone),
                  body: msg.text ?? "",
                  sent_at: msg.date ?? null,
                  metadata: { source: "inbox_scan", from_jid: msg.from_jid },
                })) })
              }
            }
          } catch { /* WhatsApp DB not accessible */ }
        }

        // Apple Mail via bridge
        if ((!channelFilter || channelFilter === "email") && email) {
          try {
            const r = await bridgeFetch(`/api/mail/search?from=${encodeURIComponent(email)}&days=${days}&limit=10&include_body=0`)
            if (r.ok) {
              const d = (await r.json()) as any
              const msgs = (d?.messages ?? []).slice(0, 10)
              for (const msg of msgs) {
                entries.push({ lead_id: leadId, lead_name: leadName, channel: "email", direction: "inbound", preview: (msg.subject ?? msg.snippet ?? "").slice(0, 120), timestamp: msg.date ?? msg.ts ?? null })
              }
              if (msgs.length > 0) {
                commsToIngest.push({ channel: "apple_mail", items: msgs.map((msg: any) => ({
                  direction: "inbound",
                  from_identifier: email,
                  subject: msg.subject ?? "",
                  body: msg.body ?? msg.subject ?? "",
                  sent_at: msg.date ?? msg.ts ?? null,
                  metadata: { source: "inbox_scan" },
                })) })
              }
            }
          } catch { /* bridge may be offline */ }
        }

        // Fire-and-forget: persist to DB + Redis (dedup hash prevents duplicates)
        for (const { channel, items } of commsToIngest) {
          irisFetch("/api/v1/atlas/comms/ingest", {
            method: "POST",
            body: JSON.stringify({ lead_id: leadId, channel, items }),
          }).catch(() => {})
        }
      }))

      source = "live"
      liveSpinner.stop(`${entries.length} messages scanned`)
    }

    // ── Fetch outreach steps per lead (if --outreach flag or --bloq) ──
    const showOutreach = args.outreach || bloqFilter
    if (showOutreach) {
      const uniqueLeadIds = [...new Set(entries.map(e => e.lead_id))]
      const stepsByLead = new Map<number, OutreachStep[]>()

      await Promise.allSettled(uniqueLeadIds.map(async (leadId) => {
        try {
          const res = await irisFetch(`/api/v1/leads/${leadId}/outreach-steps?limit=20`)
          if (res.ok) {
            const body = (await res.json()) as any
            const raw = Array.isArray(body?.data) ? body.data : (body?.data?.steps ?? [])
            const steps: OutreachStep[] = raw.map((s: any) => ({
              step: s.order ?? s.step ?? 0,
              title: s.title ?? `Step ${s.order ?? '?'}`,
              is_completed: !!(s.is_completed ?? s.completed),
            }))
            stepsByLead.set(leadId, steps)
          }
        } catch { /* non-fatal */ }
      }))

      // Attach to entries
      for (const entry of entries) {
        const steps = stepsByLead.get(entry.lead_id)
        if (steps && steps.length > 0) {
          entry.outreach_steps = steps
          entry.outreach_total = steps.length
          entry.outreach_done = steps.filter(s => s.is_completed).length
        }
      }

      // If --outreach flag, filter to only leads with pending steps
      if (args.outreach) {
        const leadsWithPending = new Set<number>()
        for (const [leadId, steps] of stepsByLead) {
          if (steps.some(s => !s.is_completed)) leadsWithPending.add(leadId)
        }
        entries = entries.filter(e => leadsWithPending.has(e.lead_id))
      }
    }

    // ── Filter & sort ──
    entries = entries
      .filter(e => e.timestamp)
      .sort((a, b) => new Date(b.timestamp!).getTime() - new Date(a.timestamp!).getTime())

    if (searchFilter) {
      const q = searchFilter.toLowerCase()
      entries = entries.filter(e => e.preview.toLowerCase().includes(q) || e.lead_name.toLowerCase().includes(q))
    }
    if (args.status === "replied") {
      entries = entries.filter(e => e.direction === "inbound")
    } else if (args.status === "pending") {
      entries = entries.filter(e => e.direction === "outbound")
    }

    const uniqueLeads = new Set(entries.map(e => e.lead_id)).size
    console.log(`  ${bold(String(entries.length))} messages across ${bold(String(uniqueLeads))} leads ${dim(`(${source})`)}`)

    // Counts header
    const counts: Record<string, number> = {}
    for (const e of entries) {
      counts[e.channel] = (counts[e.channel] ?? 0) + 1
    }
    const countParts = Object.entries(counts).map(([ch, n]) => `${n} ${CHANNEL_LABELS[ch] ?? ch}`)
    if (countParts.length > 0) {
      console.log(`  ${dim(countParts.join(", "))}`)
    }

    // JSON output
    if (args.json) {
      console.log(JSON.stringify({ total: entries.length, source, entries }, null, 2))
      prompts.outro("Done")
      return
    }

    // Step 4: Render timeline
    printDivider()

    if (entries.length === 0) {
      console.log(`  ${dim("No messages found in the last " + days + " days")}`)
      prompts.outro("Done")
      return
    }

    // Group by lead for display, but show in chronological order
    const displayLimit = 50
    const seenLeadOutreach = new Set<number>()
    for (const entry of entries.slice(0, displayLimit)) {
      const icon = CHANNEL_ICONS[entry.channel] ?? "●"
      const age = dim(timeAgo(entry.timestamp))
      const dir = entry.direction === "inbound" ? "←" : "→"
      const name = bold(entry.lead_name.slice(0, 20))
      const preview = entry.preview.replace(/\n/g, " ").slice(0, 80)

      // Outreach step badge (show once per lead)
      let outreachBadge = ""
      if (showOutreach && entry.outreach_steps && !seenLeadOutreach.has(entry.lead_id)) {
        seenLeadOutreach.add(entry.lead_id)
        const badges = entry.outreach_steps.map((s, i) => {
          const n = i + 1
          const total = entry.outreach_total ?? entry.outreach_steps!.length
          if (s.is_completed) return `\x1b[32m[${n}/${total} ✓]\x1b[0m`
          return `\x1b[33m[${n}/${total} pending]\x1b[0m`
        })
        outreachBadge = " " + badges.join(" ")
      }

      console.log(`  ${icon} ${name}  ${dir}  ${preview}  ${age}${outreachBadge}`)
    }

    if (entries.length > displayLimit) {
      console.log(`  ${dim(`…and ${entries.length - displayLimit} more (use --json for full output)`)}`)
    }

    console.log()
    prompts.outro(`${dim("iris inbox scan -p ig")}  ·  ${dim("iris inbox --outreach")}  ·  ${dim("iris inbox --bloq 355")}`)
}
