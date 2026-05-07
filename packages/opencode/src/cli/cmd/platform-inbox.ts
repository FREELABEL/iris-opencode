import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { irisFetch, requireAuth, printDivider, dim, bold, isNonInteractive, BRIDGE_URL, getBridgeToken } from "./iris-api"

// ============================================================================
// Helpers
// ============================================================================

const BRIDGE_BASE = BRIDGE_URL

function bridgeHeaders(): Record<string, string> {
  const token = getBridgeToken()
  return token ? { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" } : { "Content-Type": "application/json" }
}

interface InboxEntry {
  lead_id: number
  lead_name: string
  channel: "ig" | "email" | "imessage" | "crm" | "calendar"
  direction: "inbound" | "outbound"
  preview: string
  timestamp: string | null
  metadata?: Record<string, unknown>
}

const CHANNEL_ICONS: Record<string, string> = {
  ig: "\x1b[35m◉\x1b[0m",       // purple
  email: "\x1b[34m✉\x1b[0m",    // blue
  imessage: "\x1b[32m◈\x1b[0m", // green
  crm: "\x1b[90m●\x1b[0m",      // gray
  calendar: "\x1b[33m◆\x1b[0m", // yellow
}

const CHANNEL_LABELS: Record<string, string> = {
  ig: "IG",
  email: "Email",
  imessage: "iMessage",
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
// Command
// ============================================================================

export const PlatformInboxCommand: any = cmd({
  command: "inbox",
  describe: "unified inbox — all leads, all channels, newest first",
  builder: (yargs: any) =>
    yargs
      .option("days", { describe: "look-back window", type: "number", default: 7 })
      .option("channel", { describe: "filter: ig, email, imessage, crm, calendar", type: "string" })
      .option("bloq", { describe: "scope to a bloq/board ID", type: "number" })
      .option("status", { describe: "filter by reply status (replied, pending, all)", type: "string" })
      .option("search", { describe: "full-text search across messages", type: "string" })
      .option("limit", { describe: "max leads to scan", type: "number", default: 25 })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args: any) {
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
            const r = await fetch(`${BRIDGE_BASE}/api/imessage/search?handle=${encodeURIComponent(handle)}&days=${days}&limit=10`, { headers: bridgeHeaders() })
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

        // Apple Mail via bridge
        if ((!channelFilter || channelFilter === "email") && email) {
          try {
            const r = await fetch(`${BRIDGE_BASE}/api/mail/search?from=${encodeURIComponent(email)}&days=${days}&limit=10&include_body=0`, { headers: bridgeHeaders() })
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
    for (const entry of entries.slice(0, displayLimit)) {
      const icon = CHANNEL_ICONS[entry.channel] ?? "●"
      const age = dim(timeAgo(entry.timestamp))
      const dir = entry.direction === "inbound" ? "←" : "→"
      const name = bold(entry.lead_name.slice(0, 20))
      const preview = entry.preview.replace(/\n/g, " ").slice(0, 80)
      console.log(`  ${icon} ${name}  ${dir}  ${preview}  ${age}`)
    }

    if (entries.length > displayLimit) {
      console.log(`  ${dim(`…and ${entries.length - displayLimit} more (use --json for full output)`)}`)
    }

    console.log()
    prompts.outro(`${dim("iris inbox --days 30")}  ·  ${dim("iris leads pulse <id>")}`)
  },
})
