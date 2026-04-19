import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, dim, bold, success, highlight } from "./iris-api"

// ============================================================================
// Atlas Comms CLI — Unified cross-channel lead communications log
//
// Routes: /api/v1/atlas/comms (fl-api)
// Aliases: atlas:comms, leads:comms (same command, same data)
//
// Channels: gmail, imessage, apple_mail, whatsapp, instagram,
//           linkedin, sms, phone, in_person, other
// ============================================================================

const BRIDGE_URL = "http://localhost:3200"
const CHANNELS = ["gmail", "imessage", "apple_mail", "whatsapp", "instagram", "linkedin", "sms", "phone", "in_person", "other"] as const

function channelIcon(ch: string): string {
  const icons: Record<string, string> = {
    gmail: "📧", imessage: "💬", apple_mail: "📨", whatsapp: "📱",
    instagram: "📷", linkedin: "💼", sms: "📲", phone: "📞",
    in_person: "🤝", other: "📝",
  }
  return icons[ch] ?? "•"
}

function directionArrow(dir: string): string {
  return dir === "outbound" ? "→" : "←"
}

function printDivider() { console.log(dim("  " + "─".repeat(72))) }

/**
 * Resolve a lead by numeric ID or search query.
 */
async function resolveLead(idOrQuery: string): Promise<{ id: number; lead: any } | null> {
  let leadId = Number(idOrQuery)
  if (!Number.isFinite(leadId)) {
    const res = await irisFetch(`/api/v1/leads?search=${encodeURIComponent(idOrQuery)}&per_page=1`)
    if (!res.ok) return null
    const data = (await res.json()) as any
    const leads = data?.data?.data ?? data?.data ?? []
    if (leads.length === 0) return null
    leadId = leads[0].id
    return { id: leadId, lead: leads[0] }
  }
  const res = await irisFetch(`/api/v1/leads/${leadId}`)
  if (!res.ok) return null
  const data = (await res.json()) as any
  return { id: leadId, lead: data?.data ?? data }
}

// ── iMessage ingestion (via shared lib) ──

function ingestImessage(lead: any): any[] {
  const { searchByHandle, normalizeHandle } = require("../lib/imessage")
  const identifiers: string[] = []
  if (lead.phone) identifiers.push(normalizeHandle(lead.phone))
  if (lead.email) identifiers.push(lead.email)
  if (lead.instagram) identifiers.push(lead.instagram.replace("@", ""))

  if (identifiers.length === 0) return []

  const items: any[] = []
  for (const ident of identifiers) {
    try {
      const messages = searchByHandle(ident, 90, 100)
      for (const m of messages) {
        items.push({
          direction: m.from_me ? "outbound" : "inbound",
          from_identifier: m.from_me ? "me" : (m.chat_identifier || ident),
          body: m.text,
          sent_at: m.date,
          external_message_id: `imessage_${m.id}`,
          metadata: { chat_identifier: m.chat_identifier || ident },
        })
      }
    } catch { /* SQLite access may fail — skip silently */ }
  }
  return items
}

// ── Gmail ingestion (via bridge or integration) ──

async function ingestGmail(lead: any): Promise<any[]> {
  const email = lead.email
  if (!email) return []

  try {
    // Try bridge first (has full body)
    const res = await fetch(`${BRIDGE_URL}/api/mail/search?from=${encodeURIComponent(email)}&days=90&limit=50&include_body=1`, {
      signal: AbortSignal.timeout(5000),
    })
    if (res.ok) {
      const data = (await res.json()) as any
      const messages = data?.messages ?? []
      return messages.map((m: any) => ({
        direction: "inbound" as const,
        from_identifier: m.sender || m.from || email,
        subject: m.subject,
        body: m.body || m.snippet,
        sent_at: m.date,
        external_message_id: m.messageId || m.id || `mail_${m.date}_${m.subject}`,
        metadata: { source: "apple_mail" },
        channel: "apple_mail", // override — this is Apple Mail, not Gmail API
      }))
    }
  } catch { /* bridge not running */ }

  // Fallback: Gmail API via fl-api integration
  try {
    const res = await irisFetch(`/api/v1/leads/${lead.id}/gmail-threads`)
    if (res.ok) {
      const data = (await res.json()) as any
      const threads = data?.data ?? data?.threads ?? []
      const items: any[] = []
      for (const thread of threads) {
        const messages = thread.messages ?? [thread]
        for (const m of messages) {
          items.push({
            direction: (m.from_email || "").includes(lead.email) ? "inbound" : "outbound",
            from_identifier: m.from_email || m.from || email,
            subject: m.subject,
            body: m.body_text || m.snippet,
            sent_at: m.sent_at || m.date,
            external_message_id: m.gmail_message_id || m.id,
            metadata: { gmail_thread_id: m.gmail_thread_id || thread.id },
          })
        }
      }
      return items
    }
  } catch { /* gmail not connected */ }

  return []
}

// ── list ──

const CommsListCommand = cmd({
  command: "list <id>",
  aliases: ["ls", "view"],
  describe: "view unified comms log for a lead",
  builder: (y) =>
    y
      .positional("id", { type: "string", describe: "lead ID or name", demandOption: true })
      .option("channel", { type: "string", describe: "filter by channel" })
      .option("direction", { type: "string", describe: "inbound|outbound" })
      .option("limit", { type: "number", default: 50 })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Atlas Comms")
    if (!(await requireAuth())) { prompts.outro("Done"); return }

    const sp = prompts.spinner()
    sp.start("Loading…")

    const resolved = await resolveLead(String(args.id))
    if (!resolved) { sp.stop("Lead not found"); prompts.outro("Done"); return }

    const p = new URLSearchParams({ lead_id: String(resolved.id), per_page: String(args.limit) })
    if (args.channel) p.set("channel", args.channel)
    if (args.direction) p.set("direction", args.direction)

    const res = await irisFetch(`/api/v1/atlas/comms?${p}`)
    if (!res.ok) { await handleApiError(res, "List comms"); sp.stop("Failed", 1); prompts.outro("Done"); return }

    const data = (await res.json()) as any
    const rows: any[] = data?.data?.data ?? data?.data ?? []
    const total = data?.data?.total ?? rows.length
    sp.stop(`${rows.length} of ${total} comms for ${bold(resolved.lead.name || `Lead #${resolved.id}`)}`)

    if (args.json) { console.log(JSON.stringify(rows, null, 2)); prompts.outro("Done"); return }
    if (rows.length === 0) {
      prompts.log.warn("No comms logged yet")
      prompts.log.info(`Ingest: ${dim(`iris atlas:comms ingest ${resolved.id} --channel gmail`)}`)
      prompts.log.info(`Log:    ${dim(`iris atlas:comms log ${resolved.id} --channel phone --message "Called, discussed pricing"`)}`)
      prompts.outro("Done")
      return
    }

    printDivider()
    for (const row of rows) {
      const icon = channelIcon(row.channel)
      const arrow = directionArrow(row.direction)
      const date = row.sent_at ? new Date(row.sent_at).toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : ""
      const subj = row.subject ? bold(row.subject) : ""
      const preview = row.body ? dim(row.body.slice(0, 80).replace(/\n/g, " ")) : ""

      console.log(`  ${dim(date.padEnd(18))} ${icon} ${arrow} ${highlight(row.channel.padEnd(12))} ${subj}`)
      if (preview) console.log(`    ${preview}`)
    }
    printDivider()

    prompts.outro("Done")
  },
})

// ── ingest ──

const CommsIngestCommand = cmd({
  command: "ingest <id>",
  aliases: ["sync", "pull"],
  describe: "ingest comms from a channel into the log (deduped)",
  builder: (y) =>
    y
      .positional("id", { type: "string", describe: "lead ID or name", demandOption: true })
      .option("channel", { type: "string", describe: "gmail|imessage|apple_mail (or 'all')", demandOption: true }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Ingest Comms")
    if (!(await requireAuth())) { prompts.outro("Done"); return }

    const sp = prompts.spinner()
    sp.start("Resolving lead…")

    const resolved = await resolveLead(String(args.id))
    if (!resolved) { sp.stop("Lead not found"); prompts.outro("Done"); return }

    const lead = resolved.lead
    const channel = String(args.channel).toLowerCase()
    const channels = channel === "all" ? ["imessage", "gmail"] : [channel]

    let totalNew = 0
    let totalSkipped = 0

    for (const ch of channels) {
      sp.start(`Fetching ${ch}…`)

      let items: any[] = []
      if (ch === "imessage") {
        items = ingestImessage(lead)
      } else if (ch === "gmail" || ch === "apple_mail") {
        items = await ingestGmail(lead)
      } else {
        sp.stop(`Channel "${ch}" not yet supported for auto-ingest`)
        continue
      }

      if (items.length === 0) {
        sp.stop(`${ch}: no messages found`)
        continue
      }

      sp.start(`Ingesting ${items.length} ${ch} messages…`)

      // Send to API for dedup + storage
      const body = {
        lead_id: resolved.id,
        channel: ch,
        items: items.map((i) => ({
          ...i,
          channel: i.channel ?? ch,
        })),
      }

      const res = await irisFetch("/api/v1/atlas/comms/ingest", {
        method: "POST",
        body: JSON.stringify(body),
      })

      if (!res.ok) {
        await handleApiError(res, `Ingest ${ch}`)
        sp.stop(`${ch}: failed`)
        continue
      }

      const result = (await res.json()) as any
      const data = result?.data ?? result
      const newCount = data?.new ?? 0
      const skippedCount = data?.skipped ?? 0
      totalNew += newCount
      totalSkipped += skippedCount

      sp.stop(`${ch}: ${success(`${newCount} new`)}, ${dim(`${skippedCount} already logged`)}`)
    }

    printDivider()
    console.log(`  Total: ${success(`${totalNew} new`)} + ${dim(`${totalSkipped} skipped`)}`)
    prompts.outro("Done")
  },
})

// ── log (manual entry) ──

const CommsLogCommand = cmd({
  command: "log <id>",
  aliases: ["add", "record"],
  describe: "manually log a communication (call, in-person, etc.)",
  builder: (y) =>
    y
      .positional("id", { type: "string", describe: "lead ID or name", demandOption: true })
      .option("channel", { type: "string", describe: "phone|in_person|sms|other", demandOption: true })
      .option("message", { type: "string", aliases: ["m", "body"], describe: "what happened", demandOption: true })
      .option("direction", { type: "string", default: "outbound", describe: "inbound|outbound" })
      .option("subject", { type: "string" })
      .option("date", { type: "string", describe: "YYYY-MM-DD (defaults to now)" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Log Communication")
    if (!(await requireAuth())) { prompts.outro("Done"); return }

    const sp = prompts.spinner()
    sp.start("Resolving lead…")

    const resolved = await resolveLead(String(args.id))
    if (!resolved) { sp.stop("Lead not found"); prompts.outro("Done"); return }

    sp.start("Logging…")

    const body = {
      lead_id: resolved.id,
      channel: args.channel,
      direction: args.direction,
      body: args.message,
      subject: args.subject ?? null,
      sent_at: args.date ?? new Date().toISOString(),
    }

    const res = await irisFetch("/api/v1/atlas/comms/log", {
      method: "POST",
      body: JSON.stringify(body),
    })

    if (!res.ok) { await handleApiError(res, "Log comm"); sp.stop("Failed", 1); prompts.outro("Done"); return }

    const result = (await res.json()) as any
    const record = result?.data?.record ?? result?.data
    sp.stop(success("Logged"))
    console.log(`  ${channelIcon(args.channel as string)} ${directionArrow(args.direction as string)} ${highlight(args.channel as string)} — ${dim(String(args.message).slice(0, 80))}`)

    prompts.outro("Done")
  },
})

// ── summary ──

const CommsSummaryCommand = cmd({
  command: "summary <id>",
  aliases: ["stats"],
  describe: "channel breakdown for a lead",
  builder: (y) =>
    y
      .positional("id", { type: "string", describe: "lead ID or name", demandOption: true })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Comms Summary")
    if (!(await requireAuth())) { prompts.outro("Done"); return }

    const sp = prompts.spinner()
    sp.start("Loading…")

    const resolved = await resolveLead(String(args.id))
    if (!resolved) { sp.stop("Lead not found"); prompts.outro("Done"); return }

    const res = await irisFetch(`/api/v1/atlas/comms/summary?lead_id=${resolved.id}`)
    if (!res.ok) { await handleApiError(res, "Summary"); sp.stop("Failed", 1); prompts.outro("Done"); return }

    const data = ((await res.json()) as any)?.data
    sp.stop(`${data?.total ?? 0} total comms`)

    if (args.json) { console.log(JSON.stringify(data, null, 2)); prompts.outro("Done"); return }

    if (data?.first_contact) console.log(`  ${dim("First contact:")} ${data.first_contact}`)
    if (data?.last_contact) console.log(`  ${dim("Last contact:")}  ${data.last_contact}`)

    const channels = data?.by_channel ?? {}
    if (Object.keys(channels).length > 0) {
      printDivider()
      console.log(`  ${bold("Channel")}${"".padEnd(10)}${bold("In")}    ${bold("Out")}   ${bold("Total")}`)
      for (const [ch, stats] of Object.entries(channels) as any) {
        const icon = channelIcon(ch)
        console.log(`  ${icon} ${ch.padEnd(14)} ${String(stats.inbound).padStart(4)}   ${String(stats.outbound).padStart(4)}   ${String(stats.total).padStart(5)}`)
      }
      printDivider()
    }

    prompts.outro("Done")
  },
})

// ============================================================================
// Parent command — registered as atlas:comms, aliased as leads:comms + comms
// ============================================================================

export const PlatformAtlasCommsCommand = cmd({
  command: "atlas:comms",
  aliases: ["comms", "leads:comms"],
  describe: "[Atlas OS] Unified lead communications log — ingest, view, search across all channels",
  builder: (yargs) =>
    yargs
      .command(CommsListCommand)
      .command(CommsIngestCommand)
      .command(CommsLogCommand)
      .command(CommsSummaryCommand)
      .demandCommand(1, "specify a subcommand: list, ingest, log, summary"),
  async handler() {},
})
