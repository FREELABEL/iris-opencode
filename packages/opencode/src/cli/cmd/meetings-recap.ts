import { createHash } from "crypto"
import type { LeadResolution } from "./comms-send"
import type { FoundEvent } from "./calendar-search"

/**
 * Read AI recaps → Atlas (#191935).
 *
 * WHERE A RECAP LANDS, and why it is two writes:
 *
 *   1. One lead_comms row per meeting, with NO lead: channel `meeting_recap`, attendees in the
 *      body (so /atlas/comms?search= finds a meeting by a person) and in metadata. A row on a lead
 *      would count as that lead writing to us: ClientReadinessService reads every inbound
 *      lead_comms row for response time and "unanswered" signals whatever its channel, and an
 *      outbound row would eat the operator's daily send cap (CommsRouter). Sending it without a
 *      lead means nothing about a lead can be derived from it.
 *   2. One `meeting_intel` note on each lead an attendee's EXACT address resolves to. That is the
 *      type `leads:meeting` already writes and the lead timeline already shows. The note carries
 *      the title and the time and nothing else: it can be read by anyone on that lead's board, and
 *      who else was in the room, or what they said, is not theirs to read.
 *
 * NEVER SEND from_identifier TO comms/ingest WITHOUT A LEAD. The server would then guess the lead
 * from it (resolveLeadFromIdentifier, which also matches nicknames and a substring of a phone
 * number). The sender goes in metadata.
 *
 * WHO "ATTENDED". A recap section with addresses says they were there. A calendar event says they
 * were INVITED. Each attendee keeps its sources so nobody reads an invite as attendance.
 *
 * THE RECAP FORMAT IS AN ASSUMPTION. The parser was written from fixtures, not a real recap. It
 * reads only an explicit Attendees/Participants block, and a name with no address stays a name:
 * it is reported and never looked up. If the format differs, the failure is an empty attendee list
 * in the report, not a wrong attachment.
 */

export const RECAP_CHANNEL = "meeting_recap"
export const RECAP_QUERY = "from:read.ai"

export type AttendeeSource = "recap" | "calendar"
export interface RecapAttendee {
  email: string
  name?: string
  sources: AttendeeSource[]
}

export type CalendarMatch = "matched" | "none" | "ambiguous" | "unavailable"

export interface RecapMessage {
  id: string
  from: string
  subject: string
  date: string
  body_text: string
  snippet?: string
  mailbox?: string
  rfc822_message_id?: string
}

export interface CalendarLookup {
  events: FoundEvent[]
  /** false when a calendar could not be read, so "no event" is not a fact about the calendar */
  complete: boolean
}

export interface RecapDeps {
  findEvents(title: string, from: Date, to: Date): Promise<CalendarLookup>
  resolveLead(email: string): Promise<LeadResolution>
  /** POST the meeting row. Returns its id and whether this call created it. */
  writeMeeting(payload: Record<string, unknown>): Promise<{ id?: number; created: boolean }>
  /** The lead's existing notes, for the idempotency marker. */
  leadNotes(leadId: number): Promise<string[]>
  writeLeadNote(leadId: number, payload: Record<string, unknown>): Promise<void>
}

export interface RecapOutcome {
  key: string
  title: string
  when: string
  attendees: RecapAttendee[]
  /** People the recap names with no address. Never looked up: a name is not an identity. */
  names_without_email: string[]
  calendar: CalendarMatch
  created: boolean
  dry_run: boolean
  attached: { lead_id: number; email: string; already: boolean }[]
  unmatched: string[]
  ambiguous: { email: string; lead_ids: number[] }[]
  /** Addresses whose lookup or write failed. Not unmatched: re-running retries them. */
  failed: { email: string; reason: string }[]
}

/** "Read AI <x@e.read.ai>" → "x@e.read.ai". The last <…> is the address; a display name is free text. */
export function addressOf(from: string): string {
  const all = [...String(from ?? "").matchAll(/<([^<>]+)>/g)]
  const raw = all.length ? all[all.length - 1][1] : String(from ?? "")
  return raw.trim().toLowerCase()
}

/** read.ai or a subdomain of it, compared on the DOMAIN. thread.ai and read.ai.example.com are not it. */
export function isReadAiSender(from: string): boolean {
  const addr = addressOf(from)
  const at = addr.lastIndexOf("@")
  if (at < 1) return false
  const domain = addr.slice(at + 1)
  return domain === "read.ai" || domain.endsWith(".read.ai")
}

/**
 * The idempotency key. The RFC Message-ID when the reader returned one; otherwise the Gmail id,
 * which is only stable inside its mailbox and so carries the mailbox.
 */
export function recapKey(m: Pick<RecapMessage, "id" | "mailbox" | "rfc822_message_id">): string | null {
  const rfc = String(m.rfc822_message_id ?? "").trim().replace(/^<|>$/g, "")
  if (rfc) return `rfc822:${rfc}`
  if (m.id) return `gmail:${(m.mailbox ?? "").toLowerCase()}:${m.id}`
  return null
}

const keyHash = (key: string) => createHash("sha256").update(key).digest("hex").slice(0, 32)
const noteMarker = (key: string) => `<!-- iris-recap: ${keyHash(key)} -->`

/** The meeting's name: the subject without reply prefixes or a recap label. */
export function recapTitle(subject: string): string {
  let s = String(subject ?? "").trim()
  for (;;) {
    const next = s.replace(/^(re|fwd?)\s*:\s*/i, "").replace(/^(read\s*ai\s*:?\s*)?(meeting\s+)?(report|recap|summary)\s*(for)?\s*:\s*/i, "").trim()
    if (next === s) return s
    s = next
  }
}

const EMAIL = /[a-z0-9._%+'-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/i
const HEADER = /^[\s*#_-]*(attendees|participants)[\s*_]*(?:\(\d+\))?[\s*_]*:?[\s*_]*(.*)$/i

/** Attendees from an explicit Attendees/Participants block only. An address elsewhere in the text is not an attendee. */
export function parseRecapAttendees(text: string): { attendees: { email: string; name?: string }[]; names: string[] } {
  const attendees = new Map<string, { email: string; name?: string }>()
  const names = new Set<string>()
  const take = (entry: string) => {
    const e = entry.trim().replace(/^[-*•\d.)\s]+/, "").trim()
    if (!e) return
    const m = e.match(EMAIL)
    if (!m) {
      names.add(e)
      return
    }
    const email = m[0].toLowerCase()
    const name = e.replace(m[0], "").replace(/[<>()"]/g, "").trim()
    if (!attendees.has(email)) attendees.set(email, { email, ...(name ? { name } : {}) })
  }

  const lines = String(text ?? "").split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].match(HEADER)
    if (!h) continue
    for (const part of h[2].split(/[,;]/)) take(part)
    for (let j = i + 1; j < lines.length && lines[j].trim(); j++) {
      if (/^[\s*#_-]*[A-Za-z ]+:\s*$/.test(lines[j]) || /^#/.test(lines[j].trim())) break
      for (const part of lines[j].split(/[,;]/)) take(part)
    }
    break
  }
  return { attendees: [...attendees.values()], names: [...names] }
}

/**
 * The one calendar event this recap is about, or a refusal. Same title, and started in the day
 * before the recap arrived. Two candidates (a recurring call run twice) are a refusal: picking one
 * would put the wrong guest list on the meeting.
 */
export function matchCalendarEvent(lookup: CalendarLookup, title: string, at: Date): { match: CalendarMatch; event?: FoundEvent } {
  const want = title.trim().toLowerCase()
  const candidates = lookup.events.filter((ev) => {
    if (String(ev.title ?? "").trim().toLowerCase() !== want) return false
    const start = new Date(ev.start).getTime()
    return Number.isFinite(start) && start <= at.getTime() + 15 * 60_000 && start >= at.getTime() - 24 * 3600_000
  })
  if (candidates.length === 1) return { match: "matched", event: candidates[0] }
  if (candidates.length > 1) return { match: "ambiguous" }
  return { match: lookup.complete ? "none" : "unavailable" }
}

function renderBody(title: string, when: string, attendees: RecapAttendee[], names: string[], text: string): string {
  const lines = [title, when, "", "Attendees:"]
  for (const a of attendees) {
    const how = a.sources.includes("recap") ? "on the recap" : "invited, on the calendar event"
    lines.push(`- ${a.name ? `${a.name} ` : ""}<${a.email}> (${how})`)
  }
  for (const n of names) lines.push(`- ${n} (named on the recap, no address)`)
  return [...lines, "", "---", text].join("\n")
}

/** File one recap. Idempotent: re-running adds what a failed or earlier run could not, and nothing twice. */
export async function ingestRecap(
  m: RecapMessage,
  deps: RecapDeps,
  opts: { dryRun?: boolean; bloqId?: number; selfEmails?: string[] } = {},
): Promise<RecapOutcome | null> {
  const key = recapKey(m)
  if (!key) return null

  const title = recapTitle(m.subject)
  const at = new Date(m.date)
  const when = Number.isFinite(at.getTime()) ? at.toISOString() : m.date
  const text = m.body_text || m.snippet || ""
  const parsed = parseRecapAttendees(text)

  const attendees = new Map<string, RecapAttendee>()
  for (const a of parsed.attendees) attendees.set(a.email, { ...a, sources: ["recap"] })

  let calendar: CalendarMatch = "unavailable"
  if (Number.isFinite(at.getTime())) {
    try {
      const lookup = await deps.findEvents(title, new Date(at.getTime() - 24 * 3600_000), new Date(at.getTime() + 3600_000))
      const found = matchCalendarEvent(lookup, title, at)
      calendar = found.match
      for (const g of found.event?.attendees ?? []) {
        const email = String(g.email ?? "").trim().toLowerCase()
        if (!email) continue
        const seen = attendees.get(email)
        if (seen) {
          seen.sources.push("calendar")
          seen.name ??= g.name
        } else attendees.set(email, { email, ...(g.name ? { name: g.name } : {}), sources: ["calendar"] })
      }
    } catch {
      calendar = "unavailable"
    }
  }

  const list = [...attendees.values()]
  const out: RecapOutcome = {
    key,
    title,
    when,
    attendees: list,
    names_without_email: parsed.names,
    calendar,
    created: false,
    dry_run: opts.dryRun === true,
    attached: [],
    unmatched: [],
    ambiguous: [],
    failed: [],
  }

  const self = new Set([addressOf(m.from), ...(m.mailbox ? [m.mailbox.toLowerCase()] : []), ...(opts.selfEmails ?? []).map((e) => e.toLowerCase())])

  if (!opts.dryRun) {
    // Nothing goes on a lead until the meeting itself is stored.
    const written = await deps.writeMeeting({
      channel: RECAP_CHANNEL,
      direction: "inbound",
      subject: title,
      body: renderBody(title, when, list, parsed.names, text),
      sent_at: when,
      external_message_id: `recap:${keyHash(key)}`,
      ...(opts.bloqId ? { bloq_id: opts.bloqId } : {}),
      metadata: {
        source: "read_ai_email",
        sender: addressOf(m.from),
        ...(m.mailbox ? { mailbox: m.mailbox } : {}),
        ...(m.rfc822_message_id ? { rfc822_message_id: m.rfc822_message_id } : {}),
        attendees: list,
        names_without_email: parsed.names,
        calendar,
      },
    })
    out.created = written.created
  }

  const seenLeads = new Set<number>()
  for (const a of list) {
    if (self.has(a.email)) continue
    let res: LeadResolution
    try {
      res = await deps.resolveLead(a.email)
    } catch (err: any) {
      out.failed.push({ email: a.email, reason: String(err?.message ?? err) })
      continue
    }
    if (res.reason === "error") {
      out.failed.push({ email: a.email, reason: res.error ?? "lead lookup failed" })
      continue
    }
    if (res.reason === "ambiguous") {
      out.ambiguous.push({ email: a.email, lead_ids: res.matches.map((x) => x.id) })
      continue
    }
    if (!res.ok || !res.leadId) {
      out.unmatched.push(a.email)
      continue
    }
    if (seenLeads.has(res.leadId)) continue
    seenLeads.add(res.leadId)

    if (opts.dryRun) {
      out.attached.push({ lead_id: res.leadId, email: a.email, already: false })
      continue
    }
    try {
      const notes = await deps.leadNotes(res.leadId)
      const marker = noteMarker(key)
      if (notes.some((n) => n.includes(marker))) {
        out.attached.push({ lead_id: res.leadId, email: a.email, already: true })
        continue
      }
      const how = a.sources.includes("recap") ? "on the recap" : "invited, on the calendar event"
      await deps.writeLeadNote(res.leadId, {
        message: `Meeting: ${title}\n${when}\n${a.email} (${how})\n\n${marker}`,
        type: "meeting_intel",
        activity_type: "meeting",
        activity_icon: "clipboard-document-list",
      })
      out.attached.push({ lead_id: res.leadId, email: a.email, already: false })
    } catch (err: any) {
      out.failed.push({ email: a.email, reason: String(err?.message ?? err) })
    }
  }
  return out
}

export interface FoundMeeting {
  id: number
  title: string
  when: string
  attendees: RecapAttendee[]
  names_without_email: string[]
  calendar?: string
}

/** A /atlas/comms row back into a meeting. */
export function meetingFromRow(row: any): FoundMeeting {
  const meta = row?.metadata ?? {}
  return {
    id: Number(row?.id),
    title: String(row?.subject ?? ""),
    when: String(row?.sent_at ?? ""),
    attendees: Array.isArray(meta.attendees) ? meta.attendees : [],
    names_without_email: Array.isArray(meta.names_without_email) ? meta.names_without_email : [],
    calendar: meta.calendar,
  }
}
