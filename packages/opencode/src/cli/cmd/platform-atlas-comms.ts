import { type ChannelRead, readOk, unavailable, nothingToRead, describeHttpFailure, channelOutcome, failedRunWarning, bridgeMailItems } from "./comms-channel-read"
import { mailResponsive, readMailThread, withoutLedgerDuplicates } from "./comms-mail-applescript"
import { cmd } from "./cmd"
import { probeBridge, assessBridge, printDegradations } from "./subsystem-health"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, dim, bold, success, highlight, getBridgeToken, writeJson } from "./iris-api"
import { firstArray } from "../../util/array"

// ============================================================================
// Atlas Comms CLI — Unified cross-channel lead communications log
//
// Routes: /api/v1/atlas/comms (fl-api)
// Aliases: atlas:comms, leads:comms (same command, same data)
//
// Channels: gmail, imessage, apple_mail, whatsapp, instagram,
//           linkedin, sms, phone, in_person, other
// ============================================================================

// Same resolution as iris-api.ts. A hardcoded port here ignored BRIDGE_URL / BRIDGE_PORT, so a
// bridge on another port read as "no messages" through this file only.
const BRIDGE_URL = process.env.BRIDGE_URL ?? `http://localhost:${process.env.BRIDGE_PORT ?? "3200"}`
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

/**
 * Every email address this lead is reachable at — not just the one in the `email` column.
 *
 * A lead has ONE primary email and any number of alternates in contact_info.emails, and the
 * ingest only ever searched the primary. For anyone who writes from a different address than
 * the one we filed them under, most of the relationship was invisible to the comms log, and
 * invisible in the direction that looks like silence rather than like an error.
 *
 * Measured on lead #10394 (2026-09-12): 27 messages on the primary address the ingest reads,
 * 43 on the two alternates it did not — 61% of the correspondence missing from a log that
 * reported success. He is Apple-native and writes from iCloud; the address we had on file was
 * his work one.
 */
function leadEmails(lead: any): string[] {
  const ci = lead?.contact_info ?? {}
  const raw = [lead?.email, ci?.email, ...(Array.isArray(ci?.emails) ? ci.emails : [])]

  const seen = new Set<string>()
  const out: string[] = []
  for (const e of raw) {
    const addr = String(e ?? "").trim().toLowerCase()
    if (!addr || !addr.includes("@") || seen.has(addr)) continue
    seen.add(addr)
    out.push(addr)
  }
  return out
}

/**
 * A local message store that is not usable. ABSENT (not macOS, app not installed) means this
 * machine has nothing to read — reporting it as a failure would make `--channel all` fail on every
 * machine without WhatsApp, and an exit code that always fires gets ignored. PRESENT BUT UNREADABLE
 * (Full Disk Access, a locked file) is a failure: the messages may be there and cannot be seen.
 */
function storeNotReadable(store: string, diagnosis: string): ChannelRead {
  const absent = /not found|only available on macOS/i.test(diagnosis)
  return absent ? nothingToRead(`${store} is not on this machine — ${diagnosis}`) : unavailable(`${store} store unreadable — ${diagnosis}`)
}

// ── iMessage ingestion (via shared lib) ──

function ingestImessage(lead: any): ChannelRead {
  const { searchByHandle, normalizeHandle } = require("../lib/imessage")
  const identifiers: string[] = []
  if (lead.phone) identifiers.push(normalizeHandle(lead.phone))
  for (const addr of leadEmails(lead)) identifiers.push(addr)
  if (lead.instagram) identifiers.push(lead.instagram.replace("@", ""))

  if (identifiers.length === 0) return nothingToRead("lead has no phone, email or instagram handle")

  // searchByHandle() catches every query error and returns [] — so without this gate an unreadable
  // Messages store (no Full Disk Access for whatever process is running this) reads as "no messages".
  const imessageLib = require("../lib/imessage")
  if (!imessageLib.isAvailable()) return storeNotReadable("Messages", imessageLib.diagnoseAccess())

  const items: any[] = []
  const failures: string[] = []
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
    } catch (e: any) {
      // Was `skip silently`. An unreadable Messages store (no Full Disk Access) then read as
      // "no messages" for every lead in an --all sweep.
      failures.push(`message store unreadable for ${ident}: ${String(e?.message ?? e).slice(0, 120)}`)
    }
  }
  return { items, unavailable: failures }
}

// ── Gmail ingestion (via Google API) ──

async function ingestGmailApi(lead: any): Promise<ChannelRead> {
  if (!lead.email) return nothingToRead("lead has no email address")
  try {
    const { getToken: getGmailToken, searchMessages: gmailSearch } = await import("../lib/gmail")
    const token = await getGmailToken()
    if (!token) return unavailable("Gmail API is not connected on this machine")
    const messages = await gmailSearch(token, `from:${lead.email} OR to:${lead.email}`, 50)
    return readOk(messages.map((m: any) => ({
      direction: m.from?.includes(lead.email) ? "inbound" as const : "outbound" as const,
      from_identifier: m.from || lead.email,
      subject: m.subject,
      body: m.body_text || m.snippet,
      sent_at: m.date,
      external_message_id: `gmail_${m.id}`,
      metadata: { gmail_thread_id: m.thread_id, gmail_message_id: m.id },
    })))
  } catch (e: any) {
    return unavailable(`Gmail API read failed: ${String(e?.message ?? e).slice(0, 160)}`)
  }
}

// ── Slack ingestion (via Slack API) ──

async function ingestSlack(lead: any): Promise<ChannelRead> {
  if (!lead.slack && !lead.name) return nothingToRead("lead has no slack handle or name")
  const searchTerm = lead.slack || lead.name
  try {
    const { getToken, searchMessages } = await import("../lib/slack")
    const token = await getToken()
    if (!token) return unavailable("Slack is not connected on this machine")
    const messages = await searchMessages(token, searchTerm, 50)
    return readOk(messages.map((m: any) => ({
      direction: "inbound" as const,
      from_identifier: m.username || searchTerm,
      body: m.text,
      sent_at: m.timestamp,
      external_message_id: `slack_${m.ts}`,
      metadata: { slack_ts: m.ts },
    })))
  } catch (e: any) {
    return unavailable(`Slack read failed: ${String(e?.message ?? e).slice(0, 160)}`)
  }
}

// ── Discord ingestion (via bridge) ──

async function ingestDiscord(lead: any): Promise<ChannelRead> {
  if (!lead.discord && !lead.name) return nothingToRead("lead has no discord handle or name")
  const searchTerm = lead.discord || lead.name
  try {
    const token = getBridgeToken()
    const headers: Record<string, string> = { Accept: "application/json" }
    if (token) headers["X-Bridge-Key"] = token

    const res = await fetch(`${BRIDGE_URL}/api/discord/search?q=${encodeURIComponent(searchTerm)}&limit=50`, {
      headers,
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) return unavailable(describeHttpFailure("bridge /api/discord/search", res.status, await res.text().catch(() => "")))
    const data = (await res.json()) as any
    const messages = data?.messages ?? []
    return readOk(messages.map((m: any) => ({
      direction: "inbound" as const,
      from_identifier: m.author?.username || searchTerm,
      body: m.content,
      sent_at: m.timestamp,
      external_message_id: `discord_${m.id}`,
      metadata: { channel_name: m.channel_name, guild_name: m.guild_name },
    })))
  } catch (e: any) {
    return unavailable(`bridge not reachable at ${BRIDGE_URL}: ${String(e?.message ?? e).slice(0, 120)}`)
  }
}

// ── WhatsApp ingestion (via local SQLite) ──

function ingestWhatsapp(lead: any, opts: { allowNameMatch?: boolean } = {}): ChannelRead {
  const { searchByPhone, searchByName, normalizePhone, extractPhone, readGroupsForLead, isAvailable, diagnoseAccess } = require("../lib/whatsapp")
  // Same trap as iMessage: the store helpers catch and return [], so check the store is readable first.
  if (!isAvailable()) return storeNotReadable("WhatsApp", diagnoseAccess())
  const failures: string[] = []
  // Linked GROUP chats (contact_info.whatsapp_groups) — read even when there's no 1:1 phone/name.
  const groupItems: any[] = (() => {
    try {
      return readGroupsForLead(lead, 90, 100)
    } catch (e: any) {
      failures.push(`WhatsApp group read failed: ${String(e?.message ?? e).slice(0, 120)}`)
      return []
    }
  })()
  if (!lead.phone && !lead.name) {
    return groupItems.length || failures.length ? { items: groupItems, unavailable: failures } : nothingToRead("lead has no phone or name")
  }

  try {
    // Phone first. A phone number is an identifier; a name is not.
    let messages = lead.phone ? searchByPhone(lead.phone, 90, 100) : []
    let matchedByName: string | null = null
    if (messages.length === 0 && lead.name) {
      // NAME FALLBACK — deliberately narrow (#183513). This used to try the first name alone and
      // every dash fragment, with a SUBSTRING match, and take the most recent chat: "Kristen" matched
      // a different "kristen" and 22 of a stranger's private messages landed on a client's record.
      // Now: whole names only (full name, nickname, parenthetical alias, multi-word dash parts),
      // compared exactly, case-insensitively.
      const fullName = String(lead.name || "").trim()
      const variants = [
        fullName,
        lead.nickname,
        ...(fullName.match(/\(([^)]+)\)/g) || []).map((m: string) => m.replace(/[()]/g, "")),
        ...fullName.split(/\s*[—–-]\s*/).filter((p: string) => p.trim().split(/\s+/).length >= 2),
      ].filter(Boolean)
      const seen = new Set<string>()
      for (const n of variants) {
        const key = String(n).toLowerCase().trim()
        if (key.length < 3 || seen.has(key)) continue
        seen.add(key)
        messages = searchByName(String(n).trim(), 90, 100, true)
        if (messages.length > 0) { matchedByName = String(n).trim(); break }
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
    // A chat found by NAME is a guess about who someone is. It is not written unless the operator
    // has looked and said so — two people can share a name, and the cost of a wrong guess is a
    // stranger's messages on a client's record. Linked groups are explicit, so they still go through.
    if (matchedByName && !opts.allowNameMatch && oneToOne.length) {
      const partner = oneToOne.find((m: any) => m.metadata?.push_name)?.metadata?.push_name
      failures.push(
        `held back ${oneToOne.length} message(s) matched by NAME only ("${matchedByName}"` +
          `${partner ? `, WhatsApp contact "${partner}"` : ""}) — not written. Check it is the same person, ` +
          `then re-run with --allow-name-match, or add the lead's phone number.`,
      )
      return { items: groupItems, unavailable: failures, answered: true }
    }
    // Merge 1:1 + linked-group messages; server dedups on external_message_id.
    return { items: [...oneToOne, ...groupItems], unavailable: failures }
  } catch (e: any) {
    failures.push(`WhatsApp store unreadable: ${String(e?.message ?? e).slice(0, 120)}`)
    return { items: groupItems, unavailable: failures }
  }
}

// ── Gmail ingestion (via bridge or integration) ──

async function ingestGmail(lead: any, requested: "gmail" | "apple_mail"): Promise<ChannelRead> {
  const emails = leadEmails(lead)
  if (emails.length === 0) return nothingToRead("lead has no email address")
  const email = emails[0]

  // One search PER ADDRESS. The bridge filters on a single `from`, so a lead with alternates
  // needs one call each — searching only the primary is what left 61% of #10394's mail out of
  // the log while the command reported success. The server dedups on external_message_id, so
  // an address that overlaps another costs a round trip, not a duplicate row.
  const collected: any[] = []
  const failures: string[] = []
  let anyOk = false

  // AUTHENTICATE. The bridge requires X-Bridge-Key; without it every Apple Mail ingest got a 401.
  const bridgeToken = getBridgeToken()
  const bridgeHeaders: Record<string, string> = { Accept: "application/json" }
  if (bridgeToken) bridgeHeaders["X-Bridge-Key"] = bridgeToken

  for (const addr of emails) {
    try {
      const res = await fetch(`${BRIDGE_URL}/api/mail/search?from=${encodeURIComponent(addr)}&days=90&limit=50&include_body=1`, {
        headers: bridgeHeaders,
        signal: AbortSignal.timeout(15000),
      })
      if (!res.ok) {
        // KEEP THE BRIDGE'S REASON (#185776). It answers 503 with a precise sentence — "the iris
        // daemon has no Full Disk Access (the DAEMON's own grant, not your terminal's)" — and this
        // used to print the status, discard that sentence, and go on to report "no messages found".
        failures.push(`${addr}: ${describeHttpFailure("bridge /api/mail/search", res.status, await res.text().catch(() => ""))}`)
        continue
      }

      const data = (await res.json()) as any
      // CONTRACT DRIFT (found 2026-09-17). The bridge moved to Mail's Envelope Index and answers
      // { emails: [...] }; this read `data.messages`, so a bridge that COULD read Mail still ingested
      // nothing and reported "no messages found". Granting the daemon Full Disk Access would have
      // turned a visible 503 into that silent zero. Mapping lives in bridgeMailItems() (tested).
      const envelopeItems = bridgeMailItems(data, addr)
      if (envelopeItems === null) {
        failures.push(`${addr}: bridge answered without an emails list (keys: ${Object.keys(data ?? {}).join(", ") || "none"})`)
        continue
      }
      anyOk = true
      collected.push(...envelopeItems)
    } catch (e: any) {
      failures.push(`${addr}: bridge not reachable at ${BRIDGE_URL}: ${String(e?.message ?? e).slice(0, 120)}`)
    }
  }

  if (anyOk) return { items: collected, unavailable: failures, answered: true }

  // Apple Mail was asked for by name, and could not be read. Do NOT answer with Gmail: the operator
  // asked a question about one mailbox, and a different source's empty result is not its answer.
  if (requested === "apple_mail") return unavailable(...failures)

  // `gmail`: the bridge failed, so fall back to the Gmail threads on the platform — and say so.
  try {
    const res = await irisFetch(`/api/v1/leads/${lead.id}/gmail-threads`)
    if (!res.ok) {
      failures.push(describeHttpFailure("Gmail threads fallback (/leads/{id}/gmail-threads)", res.status, await res.text().catch(() => "")))
      return unavailable(...failures)
    }
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
    // The fallback answered, but Apple Mail did not — a partial read, not a clean one, and not an unreadable one.
    return {
      items,
      answered: true,
      unavailable: failures.map((f) => `Apple Mail could not be read, so only the Gmail threads fallback was used (${items.length} found) — ${f}`),
    }
  } catch (e: any) {
    failures.push(`Gmail threads fallback failed: ${String(e?.message ?? e).slice(0, 120)}`)
    return unavailable(...failures)
  }
}

/**
 * Apple Mail read over AppleEvents from ONE named account (--mail-account). Needs no daemon, no
 * bridge and no Full Disk Access; reads both directions with RFC Message-IDs and bodies. See
 * comms-mail-applescript.ts for why it is opt-in and bounded to one account.
 */
async function ingestAppleMailViaScript(lead: any, account: string, days: number): Promise<ChannelRead> {
  const emails = leadEmails(lead)
  if (emails.length === 0) return nothingToRead("lead has no email address")
  if (!(await mailResponsive())) {
    return unavailable("Mail.app is not answering (not running, or still busy with an earlier request) — not queuing more work behind it; try again in a few minutes")
  }
  const items: any[] = []
  const failures: string[] = []
  let answered = false
  for (const addr of emails) {
    const r = await readMailThread(addr, days, account, true)
    if (r.ok) {
      answered = true
      items.push(...r.items)
    } else {
      failures.push(r.reason)
    }
  }
  const seen = new Set<string>()
  const unique = items.filter((i) => (seen.has(i.external_message_id) ? false : (seen.add(i.external_message_id), true)))
  return { items: unique, unavailable: failures, answered }
}

/**
 * Refresh one lead's comms from the local channels, and REPORT WHAT COULD NOT BE READ (#184926).
 *
 * Pulse used to carry its own copies of the iMessage and WhatsApp readers. They were a fork of the
 * ones above, so they missed every fix made here — including the name-matching that grafted a
 * stranger's private messages onto a client record (#183513) — they never read mail at all, and
 * they POSTed fire-and-forget, so pulse could score before the comms it just read had landed.
 *
 * Returns health-shaped checks so a channel that could not be read degrades the score instead of
 * being scored over: "no contact" and "could not look" are different claims.
 */
export async function refreshLeadComms(
  lead: any,
  leadId: number,
  opts: { mailAccount?: string; days?: number; allowNameMatch?: boolean } = {},
): Promise<{ checks: { name: string; ok: boolean; detail?: string }[]; ingested: number }> {
  const days = opts.days ?? 30
  const reads: { label: string; channel: string; read: ChannelRead }[] = [
    { label: "iMessage", channel: "imessage", read: ingestImessage(lead) },
    { label: "WhatsApp", channel: "whatsapp", read: ingestWhatsapp(lead, { allowNameMatch: opts.allowNameMatch }) },
  ]
  if (opts.mailAccount) {
    reads.push({ label: "Apple Mail", channel: "apple_mail", read: await ingestAppleMailViaScript(lead, opts.mailAccount, days) })
  }

  const checks: { name: string; ok: boolean; detail?: string }[] = []
  let ingested = 0
  let existing: any[] | null = null

  for (const { label, channel, read } of reads) {
    const outcome = channelOutcome(label, read)
    checks.push(outcome.failed ? { name: label, ok: false, detail: outcome.line } : { name: label, ok: true })

    let items = read.items
    if (channel === "apple_mail" && items.length) {
      if (existing === null) {
        try {
          const r = await irisFetch(`/api/v1/atlas/comms?${new URLSearchParams({ lead_id: String(leadId), per_page: "500" })}`)
          const d = r.ok ? ((await r.json()) as any) : null
          existing = d ? firstArray(d?.data?.data, d?.data) : []
        } catch {
          existing = []
        }
      }
      items = withoutLedgerDuplicates(items, existing).keep
    }
    if (!items.length) continue

    // AWAITED. The old inline version fired the POST and moved on, so the score could be computed
    // over a ledger the ingest had not reached yet.
    try {
      const res = await irisFetch("/api/v1/atlas/comms/ingest", {
        method: "POST",
        body: JSON.stringify({ lead_id: leadId, channel, items: items.map((i: any) => ({ ...i, channel: i.channel ?? channel })) }),
      })
      if (!res.ok) {
        checks.push({ name: `${label} (store)`, ok: false, detail: `read ${items.length} message(s) but the ledger refused them (HTTP ${res.status})` })
        continue
      }
      const body = (await res.json()) as any
      ingested += Number((body?.data ?? body)?.new ?? 0)
    } catch (e: any) {
      checks.push({ name: `${label} (store)`, ok: false, detail: `could not store ${items.length} message(s): ${String(e?.message ?? e).slice(0, 100)}` })
    }
  }

  return { checks, ingested }
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
    const rows: any[] = firstArray(data?.data?.data, data?.data)
    const total = data?.data?.total ?? rows.length
    sp.stop(`${rows.length} of ${total} comms for ${bold(resolved.lead.name || `Lead #${resolved.id}`)}`)

    if (args.json) { await writeJson(rows); prompts.outro("Done"); return }
    if (rows.length === 0) {
      // An empty log is ambiguous: it means "nothing here" OR "the reader that
      // fills this is dead". Only probe on the empty path — when there are rows
      // the distinction does not arise and the latency would be wasted.
      printDegradations([assessBridge(await probeBridge())])
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
      const read = ingestImessage(t.lead)
      const outcome = channelOutcome("imessage", read)
      if (outcome.failed) failed++
      if (outcome.kind === "unavailable") { console.log(`  ${dim(label)}  ${outcome.line}`); continue }
      if (outcome.kind === "nothing" || outcome.kind === "empty") { console.log(`  ${dim(label)}  ${dim("no messages")}`); continue }
      if (outcome.kind === "partial") console.log(`  ${dim(label)}  ${dim(outcome.line)}`)
      const items = read.items

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
  if (failed) {
    prompts.log.error(`${failed} lead(s) could not be fully read or stored. Their "0 new" is not a zero.`)
    process.exitCode = 1
  }
  prompts.outro(failed ? "Incomplete" : "Done")
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
      .option("dry-run", { type: "boolean", default: false, describe: "read and report what WOULD be ingested, write nothing (single lead or --all)" })
      .option("allow-name-match", { type: "boolean", default: false, describe: "write WhatsApp chats matched by the lead's name alone (checked it is the same person)" })
      .option("mail-account", { type: "string", describe: "apple_mail: read ONE Mail.app account over AppleEvents (both directions, bodies, no Full Disk Access) — e.g. amayo@mypathwaysai.com" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Ingest Comms")
    if (!(await requireAuth())) { prompts.outro("Done"); return }

    // Ingest is the command a dead bridge hurts most: every bridge-backed
    // reader below catches its own failure and returns an empty array, so the
    // run reports "0 new" and exits 0. That is indistinguishable from a lead
    // who genuinely has no messages. Say it up front, before the work.
    const bridgeBacked = ["imessage", "apple_mail", "gmail", "discord", "slack", "whatsapp", "all"]
    if (bridgeBacked.includes(String(args.channel).toLowerCase())) {
      printDegradations([assessBridge(await probeBridge())])
    }

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
    if (!resolved) { sp.stop("Lead not found", 1); process.exitCode = 1; prompts.outro("Done"); return }

    const lead = resolved.lead
    const channel = String(args.channel).toLowerCase()
    const channels = channel === "all" ? ["imessage", "whatsapp", "discord", "slack", "gmail", "gmail_api"] : [channel]

    let totalNew = 0
    let totalSkipped = 0
    // Every channel that could not be fully read. Non-empty => the run exits non-zero and the
    // total says the zero is not a zero (#185776).
    const failedChannels: string[] = []

    for (const ch of channels) {
      sp.start(`Fetching ${ch}…`)

      let read: ChannelRead
      if (ch === "imessage") {
        read = ingestImessage(lead)
      } else if (ch === "whatsapp") {
        read = ingestWhatsapp(lead, { allowNameMatch: Boolean(args["allow-name-match"]) })
      } else if (ch === "discord") {
        read = await ingestDiscord(lead)
      } else if (ch === "slack") {
        read = await ingestSlack(lead)
      } else if (ch === "gmail_api") {
        read = await ingestGmailApi(lead)
      } else if (ch === "apple_mail" && args["mail-account"]) {
        read = await ingestAppleMailViaScript(lead, String(args["mail-account"]), Number(args.days))
      } else if (ch === "gmail" || ch === "apple_mail") {
        read = await ingestGmail(lead, ch)
      } else {
        // An unknown channel is an operator error, not an empty result.
        sp.stop(`Channel "${ch}" is not supported for auto-ingest`, 1)
        failedChannels.push(ch)
        continue
      }

      const outcome = channelOutcome(ch, read)
      if (outcome.failed) failedChannels.push(ch)
      if (outcome.kind === "unavailable" || outcome.kind === "nothing" || outcome.kind === "empty") {
        sp.stop(outcome.line, outcome.failed ? 1 : 0)
        continue
      }
      if (outcome.kind === "partial") prompts.log.warn(outcome.line)
      let items = read.items

      if (ch === "apple_mail" && args["mail-account"]) {
        // Messages `iris mail send` already logged at send time carry a different id than the same
        // message read back from Sent Mail. Match them on direction + subject + time, or every one
        // would be written twice.
        const existingRes = await irisFetch(`/api/v1/atlas/comms?${new URLSearchParams({ lead_id: String(resolved.id), per_page: "500" })}`)
        if (!existingRes.ok) {
          sp.stop(`${ch}: could not read the lead's existing comms to rule out duplicates — nothing written`, 1)
          failedChannels.push(ch)
          continue
        }
        const existingData = (await existingRes.json()) as any
        const { keep, dropped } = withoutLedgerDuplicates(items, firstArray(existingData?.data?.data, existingData?.data))
        items = keep
        if (dropped) prompts.log.info(`${ch}: ${dropped} message(s) already on the record under another id — skipped`)
      }

      if (args["dry-run"]) {
        // #183513 asked for this on the single-lead path: see what would land on the record first.
        sp.stop(`${ch}: ${items.length} message(s) would be ingested (dry run — nothing written)`)
        for (const it of [...items].sort((a, b) => String(a.sent_at).localeCompare(String(b.sent_at))).slice(-60)) {
          console.log(`    ${dim(String(it.sent_at ?? "").slice(0, 10))} ${it.direction === "outbound" ? "→" : "←"} ${String(it.subject ?? "").slice(0, 80)}`)
        }
        continue
      }
      if (items.length === 0) {
        sp.stop(`${ch}: nothing new — every message read is already on the record`)
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
        sp.stop(`${ch}: read ${items.length} message(s) but could not store them`, 1)
        failedChannels.push(ch)
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
    const warning = failedChannels.length ? failedRunWarning([...new Set(failedChannels)]) : null
    if (warning) {
      prompts.log.error(warning)
      process.exitCode = 1
    }
    prompts.outro(warning ? "Incomplete" : "Done")
  },
})

// ── log (manual entry) ──

const CommsDeleteCommand = cmd({
  command: "delete <lead>",
  aliases: ["remove", "purge"],
  describe: "remove comms from a lead — the undo for a bad ingest",
  builder: (y) =>
    y
      .positional("lead", { type: "string", describe: "lead ID or name", demandOption: true })
      .option("channel", { type: "string", choices: CHANNELS as unknown as string[], describe: "only this channel" })
      .option("since", { type: "string", describe: "YYYY-MM-DD (or with time)" })
      .option("until", { type: "string", describe: "YYYY-MM-DD (or with time)" })
      .option("id", { type: "array", describe: "specific comm id(s)" })
      .option("yes", { alias: "y", type: "boolean", default: false, describe: "skip the confirmation" })
      .example("$0 comms delete 28363 --channel whatsapp --since 2026-06-25 --until 2026-06-27",
               "remove a mis-attributed WhatsApp thread"),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Delete Comms")
    if (!(await requireAuth())) { prompts.outro("Done"); return }

    if (!args.channel && !args.since && !args.until && !args.id) {
      prompts.log.error("Narrow it first — --channel, --since/--until, or --id.")
      prompts.log.info(dim("Deleting every comm on a lead is not something this command will do in one step."))
      prompts.outro("Done"); return
    }

    const sp = prompts.spinner(); sp.start("Resolving lead…")
    const resolved = await resolveLead(String(args.lead))
    if (!resolved) { sp.stop("Lead not found"); prompts.outro("Done"); return }

    const filters: Record<string, unknown> = { lead_id: resolved.id }
    if (args.channel) filters.channel = args.channel
    if (args.since) filters.since = args.since
    if (args.until) filters.until = args.until
    if (args.id) filters.ids = args.id

    // Always ask the server what MATCHES before deleting anything. A count is the
    // only thing that separates "matched nothing" from "deleted nothing".
    sp.start("Checking what matches…")
    const dry = await irisFetch("/api/v1/atlas/comms/purge", {
      method: "POST", body: JSON.stringify(filters),
    })
    if (!dry.ok) { await handleApiError(dry, "Purge check"); sp.stop("Failed", 1); prompts.outro("Done"); return }
    const dryBody = (await dry.json()) as any
    const matched = Number(dryBody?.data?.matched ?? 0)
    sp.stop(`${matched} comm(s) match`)

    if (!matched) { prompts.log.info(dim("Nothing to delete — the filter matched no rows.")); prompts.outro("Done"); return }

    printDivider()
    for (const r of firstArray(dryBody?.data?.sample)) {
      console.log(`  ${dim(String(r.id))}  ${channelIcon(String(r.channel))} ${String(r.channel)}  ${dim(String(r.sent_at ?? ""))}`)
    }
    if (matched > 5) console.log(`  ${dim(`… and ${matched - 5} more`)}`)
    printDivider()

    if (!args.yes) {
      const ok = await prompts.confirm({ message: `Delete ${matched} comm(s) from ${resolved.lead?.name ?? `lead #${resolved.id}`}? This cannot be undone.` })
      if (!ok || prompts.isCancel(ok)) { prompts.outro("Cancelled"); return }
    }

    sp.start("Deleting…")
    const res = await irisFetch("/api/v1/atlas/comms/purge", {
      method: "POST", body: JSON.stringify({ ...filters, confirm: true }),
    })
    if (!res.ok) { await handleApiError(res, "Purge"); sp.stop("Failed", 1); prompts.outro("Done"); return }
    const body = (await res.json()) as any
    sp.stop(`${success("✓")} deleted ${body?.data?.deleted ?? 0} comm(s)`)
    prompts.outro(dim(`iris comms list ${resolved.id}`))
  },
})

const CommsLogCommand = cmd({
  command: "log <id>",
  aliases: ["add", "record"],
  describe: "manually log a communication (call, in-person, etc.)",
  builder: (y) =>
    y
      .positional("id", { type: "string", describe: "lead ID or name", demandOption: true })
      .option("channel", {
          type: "string",
          choices: CHANNELS as unknown as string[],
          describe: `channel (${CHANNELS.join("|")})`,
          demandOption: true,
        })
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

    if (args.json) { await writeJson(data); prompts.outro("Done"); return }

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

/**
 * Attachments — the files, not the words about them.
 *
 * The comms log records that a message HAD an attachment and stops there, so a
 * document someone sent you was visible as a placeholder and unreachable as a
 * file. Every search surface in the CLI then reported the topic had left no
 * trail while the bytes sat on the disk. This is the verb that looks.
 *
 * `--out` is the ingest half: copying a file out of Messages' content-addressed
 * store, under the name the sender gave it, is what turns "I know it exists"
 * into something a person or an agent can actually open.
 */
const CommsAttachmentsCommand = cmd({
  command: "attachments [id]",
  aliases: ["files", "att"],
  describe: "list and export files people sent you over iMessage (by lead, or --search across all)",
  builder: (y) =>
    y
      .positional("id", { type: "string", describe: "lead ID or name (omit to search everything)" })
      .option("search", { type: "string", aliases: ["s"], describe: "match the filename, case-insensitive" })
      .option("days", { type: "number", default: 90, describe: "how far back to look" })
      .option("limit", { type: "number", default: 50 })
      .option("out", { type: "string", aliases: ["o"], describe: "copy the matching files into this directory" })
      .option("include-links", { type: "boolean", default: false, describe: "also list Apple's rich-link payload rows" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Comms Attachments")

    const imsg = require("../lib/imessage")
    if (!imsg.isAvailable()) {
      // Not "no attachments" — a different statement entirely, and the two need
      // opposite responses.
      prompts.log.error(imsg.diagnoseAccess())
      prompts.outro("Done")
      return
    }

    let handle: string | undefined
    let who = "everyone"
    if (args.id) {
      if (!(await requireAuth())) { prompts.outro("Done"); return }
      const resolved = await resolveLead(String(args.id))
      if (!resolved) { prompts.log.error("Lead not found"); prompts.outro("Done"); return }
      handle = resolved.lead?.phone ?? resolved.lead?.contact_info?.phone ?? resolved.lead?.email
      if (!handle) {
        prompts.log.error(`${resolved.lead?.name ?? `Lead #${resolved.id}`} has no phone or email on file, so there is no handle to match`)
        prompts.outro("Done")
        return
      }
      who = resolved.lead?.name || `Lead #${resolved.id}`
    }

    const sp = prompts.spinner()
    sp.start("Reading Messages…")
    const rows = imsg.listAttachments({
      days: args.days,
      limit: args.limit,
      search: args.search,
      handle,
      includePluginPayloads: args["include-links"],
    })
    sp.stop(`${rows.length} attachment(s) from ${bold(who)} in the last ${args.days}d`)

    if (args.json) { await writeJson(rows); prompts.outro("Done"); return }

    if (rows.length === 0) {
      prompts.log.info(dim("Nothing matched. Widen with --days, or drop --search."))
      prompts.outro("Done")
      return
    }

    printDivider()
    for (const a of rows) {
      const size = a.bytes >= 1024 * 1024 ? `${(a.bytes / 1048576).toFixed(1)}MB` : `${Math.max(1, Math.round(a.bytes / 1024))}KB`
      // A row in the table is not a file on the disk. Say which one this is.
      const state = a.onDisk ? "" : dim("  (not on disk)")
      console.log(
        `  ${dim(a.date.slice(0, 10))} ${directionArrow(a.from_me ? "outbound" : "inbound")} ${dim((a.handle ?? "").padEnd(18).slice(0, 18))} ${bold(a.name)} ${dim(size)}${state}`,
      )
    }
    printDivider()

    if (args.out) {
      const { mkdirSync, copyFileSync, existsSync: exists } = require("fs")
      const { join: pjoin, extname, basename } = require("path")
      mkdirSync(String(args.out), { recursive: true })
      let copied = 0
      const skipped: string[] = []
      const used = new Set<string>()
      for (const a of rows) {
        if (!a.onDisk) { skipped.push(a.name); continue }
        // Two people can send `Scan.pdf`. Collisions are disambiguated rather
        // than allowed to overwrite — a silent overwrite here loses a document.
        let name = a.name
        for (let n = 2; used.has(name.toLowerCase()) || exists(pjoin(String(args.out), name)); n++) {
          const ext = extname(a.name)
          name = `${basename(a.name, ext)} (${n})${ext}`
        }
        used.add(name.toLowerCase())
        try { copyFileSync(a.path, pjoin(String(args.out), name)); copied++ } catch { skipped.push(a.name) }
      }
      prompts.log.success(`Copied ${success(String(copied))} file(s) → ${highlight(String(args.out))}`)
      // Named, not summarised: "3 skipped" tells you nothing about which
      // document you still do not have.
      if (skipped.length) prompts.log.warn(`Not copied (${skipped.length}): ${skipped.slice(0, 8).join(", ")}${skipped.length > 8 ? "…" : ""}`)
    } else {
      prompts.log.info(dim(`Export:  iris atlas:comms attachments${args.id ? ` ${args.id}` : ""}${args.search ? ` --search "${args.search}"` : ""} --out ./inbox`))
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
  describe: "[Atlas OS] Unified lead communications log — ingest, view, search messages and attachments across all channels",
  builder: (yargs) =>
    yargs
      .command(CommsListCommand)
      .command(CommsIngestCommand)
      .command(CommsLogCommand)
      .command(CommsDeleteCommand)
      .command(CommsSummaryCommand)
      .command(CommsAttachmentsCommand)
      .demandCommand(1, "specify a subcommand: list, ingest, attachments, log, summary"),
  async handler() {},
})
