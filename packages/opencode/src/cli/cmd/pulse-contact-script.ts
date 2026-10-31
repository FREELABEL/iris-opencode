/**
 * The contact route as a PulseScript (#189244). A contact is a lead: `iris leads pulse <id>`
 * reads its channels — the lead's email log, iMessage 1:1 and group chats, WhatsApp groups,
 * Apple Mail, the calendar — and each is now a Source with one Stop. The reads are moved here
 * verbatim from the pulse handler; the handler renders the channels exactly as before.
 *
 * Every read here is a GET. Filing what was found into the comms ledger (`--save`) stays in the
 * handler, outside the script: a pulse script is read-only by construction.
 */
import { registerDefault, type PulseScript, type Source, type SourceResult, type Stop } from "../../pulse/core"
import { irisFetch, BRIDGE_URL, getBridgeToken } from "./iris-api"
import { executeIntegrationCall } from "./platform-run"
import { emailChannelLabel, readCalendarEvents, threadInWindow } from "./platform-leads-honesty"
import { desktopAccounts, openDesktopDb, pickAccount, searchPassages } from "../lib/desktop-sessions"

/** One channel the pulse lists — the shape the handler has always rendered and emitted as JSON. */
export interface Channel {
  name: string
  label?: string
  messages: any[]
  error?: string
  undated?: number
}

export interface ContactQuery {
  leadId: number
  lead: any
  name: string
  email: string
  phone: string
  /** Primary email first, then every alternate the lead record knows. Lower-cased. */
  allEmails: string[]
  days: number
  /** How many rows each channel asks for (a count's worth — --limit only trims the display). */
  msgLimit: number
  /** Per-channel ceiling, so one hung read cannot hang the pulse (#104244). */
  timeoutMs: number
}

export interface ContactReading extends SourceResult<any> {
  channels: Channel[]
}

const BRIDGE_BASE = BRIDGE_URL

function bridgeHeaders(): Record<string, string> {
  const token = getBridgeToken()
  const h: Record<string, string> = { Accept: "application/json" }
  if (token) h["X-Bridge-Key"] = token
  return h
}

const withTimeout = <T>(promise: Promise<T>, ms: number, label: string): Promise<T> =>
  Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms)),
  ])

function reading(channels: Channel[], provenance: string[]): ContactReading {
  const errors = channels.filter((c) => c.error)
  const measured = channels.length > 0 && errors.length < channels.length
  return {
    channels,
    hits: channels.reduce((n, c) => n + c.messages.length, 0),
    items: channels.flatMap((c) => c.messages),
    measured,
    reason: measured ? undefined : errors.map((c) => c.error).join("; ") || undefined,
    provenance,
  }
}

// ── calendar ────────────────────────────────────────────────────────────────

/** The lead's meetings: every event in the window whose text names the lead or any of its emails. */
export async function fetchLeadCalendarEvents(
  lead: { name?: string; email?: string; emails?: string[]; id: number },
  opts: { days?: number; futureDays?: number } = {},
): Promise<{ past: any[]; upcoming: any[] }> {
  const pastDays = opts.days ?? 30
  const futureDays = opts.futureDays ?? 30
  const now = new Date()
  const timeMin = new Date(now.getTime() - pastDays * 86400000).toISOString()
  const timeMax = new Date(now.getTime() + futureDays * 86400000).toISOString()

  const result = await executeIntegrationCall("google-calendar", "get_events", { time_min: timeMin, time_max: timeMax, max_results: 2500 }, {})
  // Throws when no calendar was read (#189155) — an unread calendar is "not measured", never 0.
  const events: any[] = readCalendarEvents(result)

  // Client-side filter: match lead name or ANY email in summary/description/attendees
  const nameL = (lead.name ?? "").toLowerCase()
  const emailsToMatch = lead.emails?.length ? lead.emails : (lead.email ? [lead.email.toLowerCase()] : [])
  const filtered = events.filter((ev: any) => {
    const haystack = [ev.summary, ev.description, JSON.stringify(ev.attendees ?? [])].join(" ").toLowerCase()
    if (emailsToMatch.some((e) => haystack.includes(e))) return true
    if (nameL && nameL.length > 2 && haystack.includes(nameL)) return true
    return false
  })

  const past: any[] = []
  const upcoming: any[] = []
  for (const ev of filtered) {
    const start = new Date(ev.start || ev.start_time || "")
    if (start < now) past.push(ev)
    else upcoming.push(ev)
  }
  past.sort((a, b) => new Date(b.start || "").getTime() - new Date(a.start || "").getTime())
  upcoming.sort((a, b) => new Date(a.start || "").getTime() - new Date(b.start || "").getTime())
  return { past, upcoming }
}

// ── sources ─────────────────────────────────────────────────────────────────

/** The lead's email log (fl-api's gmail-threads, scoped to the lead server-side) (#55620). */
const gmailSource: Source<ContactQuery, ContactReading> = {
  id: "gmail",
  label: "Gmail",
  isAvailable: (q) => (q.email ? { ok: true } : { ok: false, reason: "the lead has no email address" }),
  async read(q) {
    const path = `/api/v1/leads/${q.leadId}/gmail-threads`
    const channels: Channel[] = []
    await withTimeout(irisFetch(path), q.timeoutMs, "Gmail")
      .then(async (r) => {
        if (r.ok) {
          const d = (await r.json()) as any
          const threads = d?.data ?? d?.threads ?? []
          // Field names must match fl-api getGmailThreads() (#178548).
          const msgs = Array.isArray(threads)
            ? threads.map((t: any) => ({
                subject: t.latest_subject ?? t.latest_snippet ?? "(no subject)",
                from: t.latest_from ?? "",
                date: t.last_message_at ?? t.first_message_at ?? "",
                message_count: t.message_count ?? 1,
                sent_count: Number(t.sent_count ?? 0),
                thread_id: t.thread_id ?? "",
              }))
            : []
          // Threads involving ANY of the lead's emails (#55723). Unknown sender is kept — the
          // endpoint is already lead-scoped — and so is any thread we sent into: keeping inbound
          // only would starve comms_freshness / last_outbound_at.
          const filtered = msgs.filter((m: any) => {
            // #189205: inside the --days window, like every other channel.
            if (!threadInWindow(m, q.days)) return false
            if (!m.from) return true
            if ((m.sent_count ?? 0) > 0) return true
            const fromLower = m.from.toLowerCase()
            return q.allEmails.some((e) => fromLower.includes(e))
          })
          // The lead email log, not an inbox — named for what it holds (#189155).
          channels.push({ name: "Gmail", label: emailChannelLabel(Array.isArray(threads) ? threads : []), messages: filtered })
        } else {
          const body = await r.text().catch(() => "")
          let errorMsg = `HTTP ${r.status}`
          try {
            errorMsg = JSON.parse(body)?.error ?? JSON.parse(body)?.message ?? errorMsg
          } catch {}
          channels.push({ name: "Gmail", messages: [], error: errorMsg })
        }
      })
      .catch((e) => {
        channels.push({ name: "Gmail", messages: [], error: e.message })
      })
    return reading(channels, [path])
  },
}

/** iMessage 1:1, through the local bridge — by phone/email handle, else by contact name. */
const imessageSource: Source<ContactQuery, ContactReading> = {
  id: "imessage",
  label: "iMessage",
  async read(q) {
    const handle = q.phone || q.email
    const channels: Channel[] = []
    if (!handle && !q.name) {
      channels.push({
        name: "iMessage",
        messages: [],
        error: `No phone, email, or name — add with: iris leads update ${q.leadId} --phone "..."`,
      })
      return reading(channels, [])
    }
    const url = handle
      ? `${BRIDGE_BASE}/api/imessage/search?handle=${encodeURIComponent(handle)}&days=${q.days}&limit=${q.msgLimit}`
      : `${BRIDGE_BASE}/api/imessage/search?name=${encodeURIComponent(q.name)}&days=${q.days}&limit=${q.msgLimit}`
    await withTimeout(fetch(url, { headers: bridgeHeaders() }), q.timeoutMs, "iMessage")
      .then(async (r) => {
        if (r.ok) {
          const d = (await r.json()) as any
          channels.push({ name: "iMessage", messages: d?.messages ?? [] })
        } else {
          const body = await r.text().catch(() => "")
          channels.push({ name: "iMessage", messages: [], error: body || `HTTP ${r.status}` })
        }
      })
      .catch((e) => {
        channels.push({ name: "iMessage", messages: [], error: e.message })
      })
    return reading(channels, [url.replace(BRIDGE_BASE, "bridge")])
  },
}

/** iMessage group chats (#71781): the linked chat ids, or — when none are linked — discovered by handle. */
const imessageGroupsSource: Source<ContactQuery, ContactReading> = {
  id: "imessage_groups",
  label: "iMessage groups",
  async read(q) {
    const handle = q.phone || q.email
    const channels: Channel[] = []
    const chatIds: string[] = Array.isArray(q.lead.contact_info?.chat_ids) ? [...q.lead.contact_info.chat_ids] : []
    const searchUrl = (chatId: string) =>
      `${BRIDGE_BASE}/api/imessage/search?handle=${encodeURIComponent(chatId)}&days=${q.days}&limit=${q.msgLimit}`

    if (chatIds.length === 0 && handle) {
      await fetch(`${BRIDGE_BASE}/api/imessage/group-chats?handle=${encodeURIComponent(handle)}&days=${q.days}&limit=5`, {
        headers: bridgeHeaders(),
      })
        .then(async (r) => {
          if (!r.ok) return
          const d = (await r.json()) as any
          const groups = d?.group_chats ?? []
          for (const gc of groups) if (gc.recent_count > 0) chatIds.push(gc.chat_identifier)
          await Promise.allSettled(
            chatIds.map((chatId: string) =>
              fetch(searchUrl(chatId), { headers: bridgeHeaders() })
                .then(async (r2) => {
                  if (!r2.ok) return
                  const d2 = (await r2.json()) as any
                  const label = groups.find((g: any) => g.chat_identifier === chatId)?.display_name || chatId.slice(0, 12)
                  channels.push({ name: `iMessage Group (${label})`, messages: d2?.messages ?? [] })
                })
                .catch(() => {}),
            ),
          )
        })
        .catch(() => {}) // non-fatal — the bridge may not support group discovery
      return reading(channels, ["bridge /api/imessage/group-chats"])
    }

    await Promise.allSettled(
      chatIds.map((chatId) =>
        fetch(searchUrl(chatId), { headers: bridgeHeaders() })
          .then(async (r) => {
            if (r.ok) {
              const d = (await r.json()) as any
              channels.push({ name: `iMessage Group (${chatId.slice(0, 12)}…)`, messages: d?.messages ?? [] })
            } else {
              channels.push({ name: `iMessage Group`, messages: [], error: `Chat ${chatId.slice(0, 20)} — HTTP ${r.status}` })
            }
          })
          .catch((e) => {
            channels.push({ name: `iMessage Group`, messages: [], error: e.message })
          }),
      ),
    )
    return reading(channels, chatIds.map((id) => `bridge /api/imessage/search?handle=${id}`))
  },
}

/** WhatsApp groups explicitly linked to the lead (contact_info.whatsapp_groups), from the local DB. */
const whatsappGroupsSource: Source<ContactQuery, ContactReading> = {
  id: "whatsapp_groups",
  label: "WhatsApp groups",
  async read(q) {
    const channels: Channel[] = []
    try {
      const wa = require("../lib/whatsapp")
      if (wa.isAvailable()) {
        const waItems = wa.readGroupsForLead(q.lead, q.days, q.msgLimit)
        const byGroup = new Map<string, any[]>()
        for (const it of waItems) {
          const arr = byGroup.get(it.metadata.group_name) ?? []
          arr.push({ text: it.body, ts: it.sent_at, from_me: it.direction === "outbound", push_name: it.metadata.push_name })
          byGroup.set(it.metadata.group_name, arr)
        }
        for (const [gName, msgs] of byGroup) channels.push({ name: `WhatsApp Group (${gName})`, messages: msgs })
      }
    } catch {}
    return reading(channels, ["WhatsApp ChatStorage.sqlite"])
  },
}

/** Apple Mail through the bridge, every known address, merged into one channel (dedup by date+subject). */
const appleMailSource: Source<ContactQuery, ContactReading> = {
  id: "apple_mail",
  label: "Apple Mail",
  isAvailable: (q) =>
    q.allEmails.length > 0 || q.email ? { ok: true } : { ok: false, reason: "the lead has no email address" },
  async read(q) {
    let channel: Channel | null = null
    const addresses = q.allEmails.length > 0 ? q.allEmails : q.email ? [q.email] : []
    await Promise.allSettled(
      addresses.map((scanEmail) =>
        withTimeout(
          fetch(
            `${BRIDGE_BASE}/api/mail/search?from=${encodeURIComponent(scanEmail)}&days=${q.days}&limit=${q.msgLimit}&include_body=0&include_attachments=1`,
            { headers: bridgeHeaders() },
          ),
          q.timeoutMs,
          `Apple Mail (${scanEmail})`,
        )
          .then(async (r) => {
            if (r.ok) {
              const d = (await r.json()) as any
              const msgs = d?.messages ?? []
              if (channel) {
                for (const m of msgs) {
                  if (!channel.messages.some((e: any) => e.date === m.date && e.subject === m.subject)) channel.messages.push(m)
                }
              } else {
                channel = { name: "Apple Mail", messages: msgs }
              }
            } else {
              const body = await r.text().catch(() => "")
              if (!channel) channel = { name: "Apple Mail", messages: [], error: body || `HTTP ${r.status}` }
            }
          })
          .catch((e) => {
            if (!channel) channel = { name: "Apple Mail", messages: [], error: e.message }
          }),
      ),
    )
    return reading(channel ? [channel] : [], addresses.map((a) => `bridge /api/mail/search?from=${a}`))
  },
}

/** Meetings: Google Calendar events naming the lead, 90 days ahead and --days back. */
const calendarSource: Source<ContactQuery, ContactReading> = {
  id: "calendar",
  label: "Meetings",
  async read(q) {
    const channels: Channel[] = []
    await withTimeout(
      fetchLeadCalendarEvents({ name: q.name, email: q.email, emails: q.allEmails, id: q.leadId }, { days: q.days, futureDays: 90 }),
      q.timeoutMs,
      "Calendar",
    )
      .then(({ past, upcoming }) => {
        const allEvents = [...upcoming, ...past].map((ev) => ({
          summary: ev.summary || "(no title)",
          date: ev.start || ev.start_time || "",
          status: new Date(ev.start || ev.start_time || "") >= new Date() ? "upcoming" : "past",
          location: ev.location || "",
        }))
        channels.push({ name: "Meetings", messages: allEvents })
      })
      .catch((e) => {
        channels.push({ name: "Meetings", messages: [], error: e.message })
      })
    return reading(channels, ["google-calendar get_events"])
  },
}

// ── stops ───────────────────────────────────────────────────────────────────

/**
 * Each stop yields the channels its source read, errors included — a channel that could not be
 * read is listed with its error, which is how the pulse shows it shut. A stop the runner shut
 * before reading (no address to read with, or a read that threw) yields what the handler showed
 * for that case before: nothing for the address-gated ones, an error channel otherwise.
 */
function contactStop(source: Source<ContactQuery, ContactReading>, shutOutput: (reason: string) => Channel[]): Stop<ContactQuery, ContactReading, Channel[]> {
  return {
    id: source.id,
    source,
    extract: (r) => r.channels,
    unavailable: (reason) => shutOutput(reason),
  }
}

/**
 * What you said about this person in IRIS Desktop (#190661) — passages in your own chats that name
 * them, read-only from Desktop's SQLite. This is context, NOT contact: it is a separate channel the
 * handler never files into the comms ledger (no channelMap entry) and never counts as outreach.
 * `home` exists for tests.
 */
export const DESKTOP_CHANNEL = "IRIS Desktop (your chats about them)"
export function desktopSourceFor(home?: string): Source<ContactQuery, ContactReading> {
  return {
    id: "iris_desktop",
    label: "IRIS Desktop",
    async read(q) {
      // The name and every address the lead record knows; a phone number is too short to be safe in LIKE.
      const terms = [...new Set([q.name, ...q.allEmails].map((t) => (t || "").trim()).filter((t) => t.length >= 3))]
      if (!terms.length) return reading([{ name: DESKTOP_CHANNEL, messages: [], error: "No name or email on this lead to look for" }], [])
      let db: ReturnType<typeof openDesktopDb>
      try {
        const acct = pickAccount(desktopAccounts(home))
        if (!acct.db) throw new Error("no IRIS Desktop history on this machine")
        db = openDesktopDb(acct.db)
      } catch (e) {
        return reading([{ name: DESKTOP_CHANNEL, messages: [], error: String((e as Error)?.message ?? e) }], [])
      }
      try {
        const since = Date.now() - q.days * 864e5
        const seen = new Set<string>()
        const messages: any[] = []
        for (const term of terms) {
          for (const h of searchPassages(db, term, { archived: true, since, limit: q.msgLimit })) {
            if (h.time < since || seen.has(h.messageId)) continue
            seen.add(h.messageId)
            messages.push({
              date: new Date(h.time).toISOString(),
              ts: new Date(h.time).toISOString(),
              from: h.role === "user" ? "you (IRIS Desktop)" : "IRIS (Desktop)",
              subject: h.sessionTitle,
              text: h.excerpt,
              session_id: h.sessionId,
              message_id: h.messageId,
              open: `iris desktop sessions show ${h.sessionId} --around ${h.messageId}`,
            })
          }
        }
        messages.sort((a, b) => String(b.date).localeCompare(String(a.date)))
        return reading([{ name: DESKTOP_CHANNEL, messages: messages.slice(0, q.msgLimit) }], ["IRIS Desktop history (read-only)"])
      } catch (e) {
        return reading([{ name: DESKTOP_CHANNEL, messages: [], error: `could not read IRIS Desktop history: ${String((e as Error)?.message ?? e)}` }], [])
      } finally {
        db.close()
      }
    },
  }
}
const desktopSource = desktopSourceFor()

export const contactSources = {
  gmail: gmailSource,
  imessage: imessageSource,
  imessage_groups: imessageGroupsSource,
  whatsapp_groups: whatsappGroupsSource,
  apple_mail: appleMailSource,
  calendar: calendarSource,
  iris_desktop: desktopSource,
}

/**
 * The default contact script. Parallel: every channel is an independent network read, and the
 * pulse lists channels in the order they answer — which is what the handler has always done.
 */
export const defaultContactScript: PulseScript<ContactQuery, Channel[]> = {
  route: "contact",
  readOnly: true,
  mode: "parallel",
  stops: [
    contactStop(gmailSource, () => []),
    contactStop(imessageSource, (reason) => [{ name: "iMessage", messages: [], error: reason }]),
    contactStop(imessageGroupsSource, () => []),
    contactStop(whatsappGroupsSource, () => []),
    contactStop(appleMailSource, () => []),
    contactStop(calendarSource, (reason) => [{ name: "Meetings", messages: [], error: reason }]),
    contactStop(desktopSource, (reason) => [{ name: DESKTOP_CHANNEL, messages: [], error: reason }]),
  ],
}

registerDefault("contact", defaultContactScript)
