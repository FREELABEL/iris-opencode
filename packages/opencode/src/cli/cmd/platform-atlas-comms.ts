import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, dim, bold, success, highlight, getBridgeToken } from "./iris-api"

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

// ── Gmail ingestion (via Google API) ──

async function ingestGmailApi(lead: any): Promise<any[]> {
  if (!lead.email) return []
  try {
    const { getToken: getGmailToken, searchMessages: gmailSearch } = await import("../lib/gmail")
    const token = await getGmailToken()
    if (!token) return []
    const messages = await gmailSearch(token, `from:${lead.email} OR to:${lead.email}`, 50)
    return messages.map((m: any) => ({
      direction: m.from?.includes(lead.email) ? "inbound" as const : "outbound" as const,
      from_identifier: m.from || lead.email,
      subject: m.subject,
      body: m.body_text || m.snippet,
      sent_at: m.date,
      external_message_id: `gmail_${m.id}`,
      metadata: { gmail_thread_id: m.thread_id, gmail_message_id: m.id },
    }))
  } catch { return [] }
}

// ── Slack ingestion (via Slack API) ──

async function ingestSlack(lead: any): Promise<any[]> {
  if (!lead.slack && !lead.name) return []
  const searchTerm = lead.slack || lead.name
  try {
    const { getToken, searchMessages } = await import("../lib/slack")
    const token = await getToken()
    if (!token) return []
    const messages = await searchMessages(token, searchTerm, 50)
    return messages.map((m: any) => ({
      direction: "inbound" as const,
      from_identifier: m.username || searchTerm,
      body: m.text,
      sent_at: m.timestamp,
      external_message_id: `slack_${m.ts}`,
      metadata: { slack_ts: m.ts },
    }))
  } catch { return [] }
}

// ── Discord ingestion (via bridge) ──

async function ingestDiscord(lead: any): Promise<any[]> {
  if (!lead.discord && !lead.name) return []
  const searchTerm = lead.discord || lead.name
  try {
    const token = getBridgeToken()
    const headers: Record<string, string> = { Accept: "application/json" }
    if (token) headers["X-Bridge-Key"] = token

    const res = await fetch(`${BRIDGE_URL}/api/discord/search?q=${encodeURIComponent(searchTerm)}&limit=50`, {
      headers,
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) return []
    const data = (await res.json()) as any
    const messages = data?.messages ?? []
    return messages.map((m: any) => ({
      direction: "inbound" as const,
      from_identifier: m.author?.username || searchTerm,
      body: m.content,
      sent_at: m.timestamp,
      external_message_id: `discord_${m.id}`,
      metadata: { channel_name: m.channel_name, guild_name: m.guild_name },
    }))
  } catch { return [] }
}

// ── WhatsApp ingestion (via local SQLite) ──

function ingestWhatsapp(lead: any): any[] {
  const { searchByPhone, searchByName, normalizePhone, extractPhone, readGroupsForLead } = require("../lib/whatsapp")
  // Linked GROUP chats (contact_info.whatsapp_groups) — read even when there's no 1:1 phone/name.
  const groupItems: any[] = (() => {
    try {
      return readGroupsForLead(lead, 90, 100)
    } catch {
      return []
    }
  })()
  if (!lead.phone && !lead.name) return groupItems

  try {
    // Try phone first, then fall back to name search (handles WhatsApp contact name mismatches)
    let messages = lead.phone ? searchByPhone(lead.phone, 90, 100) : []
    if (messages.length === 0 && lead.name) {
      // Extract all name variants: full name, nickname, parenthetical aliases, dash-separated parts
      const fullName = lead.name || ""
      const nameParts = [
        fullName,
        lead.nickname,
        fullName.split(" ")[0], // first name
        ...(fullName.match(/\(([^)]+)\)/g) || []).map((m: string) => m.replace(/[()]/g, "")), // (Maxx) -> Maxx
        ...(fullName.split(/\s*[—–-]\s*/).filter((p: string) => p.length > 2)), // "Name — CatoDrive" -> ["Name", "CatoDrive"]
      ].filter(Boolean)
      // Deduplicate and remove very short tokens
      const seen = new Set<string>()
      for (const n of nameParts) {
        const key = n.toLowerCase().trim()
        if (key.length < 3 || seen.has(key)) continue
        seen.add(key)
        messages = searchByName(n.trim(), 90, 100)
        if (messages.length > 0) break
      }
    }
    const oneToOne = messages.map((m: any) => ({
      direction: m.from_me ? "outbound" : "inbound",
      from_identifier: m.from_me ? "me" : (extractPhone(m.from_jid) || lead.phone),
      body: m.text,
      sent_at: m.date,
      external_message_id: `whatsapp_${m.id}`,
      metadata: { from_jid: m.from_jid, push_name: m.push_name },
    }))
    // Merge 1:1 + linked-group messages; server dedups on external_message_id.
    return [...oneToOne, ...groupItems]
  } catch { return groupItems }
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

/**
 * Can this lead plausibly have anything to ingest on this channel?
 *
 * Mirrors what the per-channel ingesters ACTUALLY look at rather than guessing — my first pass
 * assumed iMessage meant "has a phone", but ingestImessage() also accepts an email (Apple ID) and
 * an instagram handle, so a phone-only filter skipped leads that would have ingested fine.
 * Sweeping a lead with no usable identifier is wasted work; skipping one that has a usable
 * identifier is a silent gap, which is the bug this whole command exists to close.
 */
function leadHasHandleForChannel(lead: any, channel: string): boolean {
  const has = (v: any) => String(v ?? "").trim() !== ""
  const ci = lead?.contact_info ?? {}

  if (["imessage", "whatsapp", "sms"].includes(channel)) {
    return has(lead?.phone) || has(ci.phone) || has(lead?.email) || has(ci.email) || has(lead?.instagram)
  }
  if (["gmail", "gmail_api", "apple_mail"].includes(channel)) {
    return has(lead?.email) || has(ci.email)
  }
  return false
}

/** Channels --all knows how to select leads for. */
const SWEEPABLE_CHANNELS = ["imessage", "whatsapp", "sms", "gmail", "gmail_api", "apple_mail"]

/**
 * Every handle with iMessage traffic in the last `days`, newest first. ONE query.
 *
 * This is the pivot of the inverted sweep (#178647): ask the message store who has actually been
 * talking, instead of asking the CRM who might have. Same SQL shape `imessage chats` already uses.
 */
function activeImessageHandles(days: number, cap: number): { identifier: string; count: number; last: string }[] {
  // NOTE: the export is `query`; platform-imessage.ts imports it as `query as queryMessages`.
  // Requiring `queryMessages` directly yields undefined, and the try/catch below would swallow
  // the TypeError and report "no conversations" — a silent empty sweep. Caught by dry-running it.
  const { query: queryMessages } = require("../lib/imessage")
  const cutoff = Math.max(1, days) * 86400
  const sql = `
    SELECT c.chat_identifier, COUNT(m.rowid) as msg_count,
           MAX(datetime(m.date/1000000000 + 978307200, 'unixepoch', 'localtime')) as last_msg
    FROM chat c
    JOIN chat_message_join cmj ON c.rowid = cmj.chat_id
    JOIN message m ON cmj.message_id = m.rowid
    WHERE m.date/1000000000 + 978307200 > unixepoch('now') - ${cutoff}
    GROUP BY c.chat_identifier
    ORDER BY MAX(m.date) DESC
    LIMIT ${Math.max(1, cap)};
  `.replace(/\n/g, " ").trim()

  try {
    const raw = queryMessages(sql)
    if (!raw) return []
    return raw
      .split("\n")
      .map((line: string) => {
        const [identifier, count, last] = line.split("|")
        return { identifier: identifier ?? "", count: parseInt(count || "0"), last: last ?? "" }
      })
      .filter((h: any) => h.identifier && !/^chat\d+$/i.test(h.identifier))
  } catch {
    return []
  }
}

/** Find the lead that owns this handle, or null. Matches on the last 10 digits for phones. */
async function findLeadForHandle(handle: string): Promise<any | null> {
  const digits = handle.replace(/\D/g, "")
  const isPhone = digits.length >= 10
  // Search by the last 10 digits so stored formats like "(972) 469-5970", "+19724695970" and
  // "9724695970" all match the same person.
  const term = isPhone ? digits.slice(-10) : handle

  try {
    const res = await irisFetch(`/api/v1/leads?search=${encodeURIComponent(term)}&per_page=5`)
    if (!res.ok) return null
    const body = (await res.json()) as any
    const leads = body?.data?.data ?? body?.data ?? []
    if (!Array.isArray(leads) || leads.length === 0) return null

    if (!isPhone) return leads[0]

    const tail = digits.slice(-10)
    return (
      leads.find((l: any) => {
        const ld = String(l?.phone ?? l?.contact_info?.phone ?? "").replace(/\D/g, "")
        return ld.length >= 10 && ld.slice(-10) === tail
      }) ?? leads[0]
    )
  } catch {
    return null
  }
}

/**
 * Sweep every lead that has a usable handle for `channel` (#178647).
 *
 * The per-lead command has always worked; what was missing was any way to run it over the whole
 * book, which meant the comms log could only ever be as current as the last time someone
 * remembered to type a specific lead id. On the day this was written, 27 of 28 leads with iMessage
 * history were more than a week stale and several were ~2 months behind — including our co-founder
 * and the investor whose thread prompted the report.
 *
 * Deliberately sequential: this reads a local SQLite database and posts to the API per lead. Doing
 * it in parallel would buy little and risks hammering both. One lead failing must never abort the
 * sweep — a single unresolvable handle should not cost you the other 27.
 */
async function ingestAllLeads(channel: string, days: number, limit: number, dryRun: boolean): Promise<void> {
  if (channel !== "imessage") {
    prompts.log.error(
      `--all currently supports only --channel imessage. It works by asking the local message store ` +
        `who has been talking; other channels have no equivalent local index yet.`,
    )
    prompts.outro("Done")
    return
  }

  const sp = prompts.spinner()
  sp.start(`Reading conversations from the last ${days} days…`)

  // ONE local query. The previous version walked the CRM instead — /api/v1/leads?per_page=500 —
  // and filtered to leads with a handle. That fetched the NEWEST 500 leads (ids 28515..29022), so
  // Richard (15743), Rashad (16750) and Flo (28165) were all outside the page and could never be
  // swept. A scheduled job would have reported success daily while touching none of the stale
  // records it existed to fix: silent success, the exact failure mode of the original bug.
  const handles = activeImessageHandles(days, Math.max(limit * 4, 200))
  if (handles.length === 0) {
    sp.stop("No conversations in that window (or the message store is unreadable).")
    prompts.outro("Done")
    return
  }

  sp.stop(`${handles.length} active conversation(s)`)
  sp.start("Matching conversations to leads…")

  // Resolve handle -> lead. N is the number of ACTIVE handles, not the size of the CRM, and the
  // conversations that have new messages are by definition the ones worth ingesting.
  const byLead = new Map<number, { lead: any; handles: string[] }>()
  const unmatched: string[] = []
  for (const h of handles) {
    const lead = await findLeadForHandle(h.identifier)
    if (!lead?.id) { unmatched.push(h.identifier); continue }
    const entry = byLead.get(lead.id) ?? { lead, handles: [] }
    entry.handles.push(h.identifier)
    byLead.set(lead.id, entry)
  }

  const targets = [...byLead.values()].slice(0, Math.max(1, limit))
  sp.stop(`${targets.length} lead(s) matched · ${unmatched.length} unmatched handle(s)`)

  if (dryRun) {
    printDivider()
    for (const t of targets) {
      console.log(`  ${dim(String(t.lead.id).padStart(6))}  ${String(t.lead.name ?? t.lead.nickname ?? "?").slice(0, 32)}  ${dim(t.handles.join(", "))}`)
    }
    if (unmatched.length) {
      console.log(`  ${dim(`unmatched (no lead): ${unmatched.slice(0, 8).join(", ")}${unmatched.length > 8 ? " …" : ""}`)}`)
      console.log(`  ${dim("these are real conversations with nobody in the CRM — worth capturing as leads.")}`)
    }
    printDivider()
    console.log(`  ${dim(`dry run — nothing ingested. Re-run without --dry-run to sweep ${targets.length} lead(s).`)}`)
    prompts.outro("Done")
    return
  }

  let totalNew = 0, totalSkipped = 0, failed = 0
  printDivider()
  for (const t of targets) {
    const label = `${String(t.lead.id).padStart(6)}  ${String(t.lead.name ?? t.lead.nickname ?? "?").slice(0, 26)}`
    try {
      const items = ingestImessage(t.lead)
      if (!items.length) { console.log(`  ${dim(label)}  ${dim("no messages")}`); continue }

      const res = await irisFetch("/api/v1/atlas/comms/ingest", {
        method: "POST",
        body: JSON.stringify({ lead_id: t.lead.id, channel, items: items.map((i: any) => ({ ...i, channel: i.channel ?? channel })) }),
      })
      if (!res.ok) { failed++; console.log(`  ${dim(label)}  ${dim(`HTTP ${res.status}`)}`); continue }

      const result = (await res.json()) as any
      const data = result?.data ?? result
      const n = Number(data?.new ?? 0), s = Number(data?.skipped ?? 0)
      totalNew += n; totalSkipped += s
      console.log(`  ${dim(label)}  ${n > 0 ? success(`${n} new`) : dim("0 new")}${s ? dim(`, ${s} known`) : ""}`)
    } catch (e: any) {
      // One bad lead must never end the sweep — the whole point of doing this in bulk.
      failed++
      console.log(`  ${dim(label)}  ${dim(`error: ${String(e?.message ?? e).slice(0, 60)}`)}`)
    }
  }
  printDivider()
  console.log(
    `  Swept ${targets.length} lead(s) from ${handles.length} conversation(s): ${success(`${totalNew} new`)} + ${dim(`${totalSkipped} already logged`)}` +
      (failed ? dim(`  ·  ${failed} failed`) : "") +
      (unmatched.length ? dim(`  ·  ${unmatched.length} handle(s) matched no lead`) : ""),
  )
  prompts.outro("Done")
}

const CommsIngestCommand = cmd({
  // eslint-disable-next-line @typescript-eslint/no-use-before-define
  command: "ingest [id]",
  aliases: ["sync", "pull"],
  describe: "ingest comms from a channel into the log (deduped). --all sweeps every lead with a handle",
  builder: (y) =>
    y
      .positional("id", { type: "string", describe: "lead ID or name (omit when using --all)" })
      .option("channel", { type: "string", describe: "gmail|imessage|apple_mail (or 'all')", demandOption: true })
      // #178647: without a bulk mode there is nothing to schedule, so the comms log was only ever
      // as current as the last time a human remembered to run this for one specific lead. Measured
      // on production the day this was added: 27 of 28 leads with iMessage history were more than
      // a week stale, several by ~2 months, including our own co-founder.
      .option("all", { type: "boolean", default: false, describe: "sweep every lead with an ACTIVE conversation (reads the message store, not the CRM)" })
      .option("days", { type: "number", default: 30, describe: "with --all, how far back to look for active conversations" })
      .option("limit", { type: "number", default: 100, describe: "max leads to sweep with --all" })
      .option("dry-run", { type: "boolean", default: false, describe: "with --all, list what would be swept and stop" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Ingest Comms")
    if (!(await requireAuth())) { prompts.outro("Done"); return }

    if (args.all) {
      await ingestAllLeads(String(args.channel).toLowerCase(), Number(args.days), Number(args.limit), Boolean(args["dry-run"]))
      return
    }

    if (!args.id) {
      prompts.log.error("Provide a lead id, or use --all to sweep every lead with a handle.")
      prompts.outro("Done")
      return
    }

    const sp = prompts.spinner()
    sp.start("Resolving lead…")

    const resolved = await resolveLead(String(args.id))
    if (!resolved) { sp.stop("Lead not found"); prompts.outro("Done"); return }

    const lead = resolved.lead
    const channel = String(args.channel).toLowerCase()
    const channels = channel === "all" ? ["imessage", "whatsapp", "discord", "slack", "gmail", "gmail_api"] : [channel]

    let totalNew = 0
    let totalSkipped = 0

    for (const ch of channels) {
      sp.start(`Fetching ${ch}…`)

      let items: any[] = []
      if (ch === "imessage") {
        items = ingestImessage(lead)
      } else if (ch === "whatsapp") {
        items = ingestWhatsapp(lead)
      } else if (ch === "discord") {
        items = await ingestDiscord(lead)
      } else if (ch === "slack") {
        items = await ingestSlack(lead)
      } else if (ch === "gmail_api") {
        items = await ingestGmailApi(lead)
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
