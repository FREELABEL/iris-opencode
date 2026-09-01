/**
 * rabbit R1 meetings — a second source for `iris meetings`.
 *
 * The R1 mails a meeting note to you after every recording: a structured summary followed by
 * a timestamped, speaker-labelled transcript. That is the same shape Wispr Flow produces
 * locally, so it plugs into the existing pipeline (summarise → file on a bloq → lead intel)
 * rather than needing a command of its own.
 *
 * WHERE THE DATA COMES FROM: the local Apple Mail store, read directly (lib/apple-mail.ts).
 * No API, no OAuth, no network. If the mail is in Mail.app, the meeting is available.
 *
 * TWO THINGS THIS MUST GET RIGHT, both learned from the mail it actually sends:
 *
 * 1. NOT EVERY MAIL FROM THE R1 IS A MEETING. "Your Magic Gallery Photo" arrives from the
 *    same address. Filtering on sender alone would file a photo notification as a meeting,
 *    so the discriminator is a Transcript section with at least one timestamped line.
 *
 * 2. THE PROVENANCE CAVEAT IS THE OPPOSITE OF WISPR'S. Wispr records SYSTEM audio, so its
 *    header warns that your own microphone may be missing. The R1 is a device in the room
 *    and captures every side including yours. Copying Wispr's warning onto this would be a
 *    false statement filed permanently onto a bloq, so each source states its own coverage.
 *
 *    But the R1 introduces the opposite hazard: it labels speakers with REAL NAMES rather
 *    than numeric ids. Observed on a live meeting: "Arthur", "Clayton", "Alex". A name is
 *    an attribution, and a wrong one silently assigns a commitment to someone who never
 *    made it — which is worse than an unlabelled transcript, because it reads as certain.
 *    So the header says plainly that the names are rabbit's guess, and --speaker relabels
 *    by name (--speaker Arthur=Arturo) as well as by diarisation id.
 */

import { readBody, searchBySender, availability, type MailMessage } from "../lib/apple-mail"

export const RABBIT_SENDER = "rabbit@r1.rabbit.tech"

/** `r` + the Mail ROWID. Prefixed so it can never collide with a Wispr UUID. */
export const rabbitSessionId = (rowid: number) => `r${rowid}`

export interface RabbitSegment {
  timestamp: string
  speakerId: string
  speakerLabel: string
  text: string
}

export interface RabbitMeeting {
  id: string
  rowid: number
  title: string
  receivedAt: Date
  /** rabbit's own write-up — everything above the Transcript heading. */
  summary: string
  segments: RabbitSegment[]
  duration: string
  mailbox: string
}

// `[0:00] Speaker 1: text` — also tolerates `[1:02:33]` and a named speaker.
const SEGMENT_RE = /^\[(\d{1,2}:\d{2}(?::\d{2})?)\]\s*([^:]{1,60}?):\s*(.*)$/

/**
 * Split a rabbit note into its summary and its transcript.
 * Returns null when the mail is not a meeting note at all.
 */
export function parseRabbitNote(text: string): { summary: string; segments: RabbitSegment[] } | null {
  const lines = text.split(/\r?\n/)
  // The heading is its own line. Take the LAST one: "Transcript" also appears in a subject
  // line echoed at the top of some notes, and the real transcript is what follows the last.
  let head = -1
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*transcript\s*$/i.test(lines[i])) head = i
  }
  if (head === -1) return null

  const segments: RabbitSegment[] = []
  for (const line of lines.slice(head + 1)) {
    const m = line.match(SEGMENT_RE)
    if (!m) continue
    const label = m[2].trim()
    const numbered = label.match(/^speaker\s*(\d+)$/i)
    segments.push({
      timestamp: m[1],
      speakerId: numbered ? numbered[1] : label,
      speakerLabel: label,
      text: m[3].trim(),
    })
  }
  // A Transcript heading with nothing under it is not a meeting — it is a template or a
  // notification that happens to use the word.
  if (!segments.length) return null

  const summary = lines
    .slice(0, head)
    .join("\n")
    // The title is repeated as an <h1> and again under a "Meeting Title" heading; one is enough.
    .replace(/^\s*([^\n]+)\n+\s*Meeting Title\s*\n+\s*\1\s*\n/i, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()

  return { summary, segments }
}

/** Read one message and turn it into a meeting, or null if it is not one. */
function toMeeting(msg: MailMessage): RabbitMeeting | null {
  let body
  try {
    body = readBody(msg.rowid, msg.mailbox)
  } catch {
    // A note whose .emlx has not been downloaded yet is skipped, not guessed at.
    return null
  }
  const parsed = parseRabbitNote(body.text)
  if (!parsed) return null
  return {
    id: rabbitSessionId(msg.rowid),
    rowid: msg.rowid,
    title: msg.subject,
    receivedAt: msg.sentAt,
    summary: parsed.summary,
    segments: parsed.segments,
    duration: parsed.segments[parsed.segments.length - 1]?.timestamp ?? "?",
    mailbox: msg.mailbox,
  }
}

export type RabbitListResult = { meetings: RabbitMeeting[]; unavailable?: string }

/**
 * Recent rabbit meetings, newest first.
 *
 * `unavailable` is set when Mail cannot be read at all — a permission problem must not be
 * reported as "you have no meetings", which is the same class of lie as reporting an error
 * as a fact about the user.
 */
export function listRabbitMeetings(opts: { days?: number; limit?: number } = {}): RabbitListResult {
  const avail = availability()
  if (!avail.ok) return { meetings: [], unavailable: avail.reason }

  let msgs: MailMessage[]
  try {
    // Over-fetch: most rabbit mail is not a meeting, and the filter must not eat the limit.
    msgs = searchBySender(RABBIT_SENDER, { days: opts.days ?? 30, limit: Math.max(20, (opts.limit ?? 15) * 5) })
  } catch (e: any) {
    return { meetings: [], unavailable: String(e?.message ?? e) }
  }

  const out: RabbitMeeting[] = []
  // The R1 can mail the same recording more than once — three copies of one test recording
  // arrived 39 seconds apart here, with different message ids and different timestamps, so
  // neither dedupes them. Identical CONTENT does, and safely: two genuinely different
  // meetings do not produce a byte-identical transcript. Distinct meetings that merely
  // share a subject are kept, which is why the transcript is part of the key.
  const seen = new Set<string>()
  for (const m of msgs) {
    const meeting = toMeeting(m)
    if (!meeting) continue
    const key = `${meeting.title}\u0000${meeting.segments.map((s) => `${s.timestamp}${s.text}`).join("\u0001")}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(meeting)
    if (out.length >= (opts.limit ?? 15)) break
  }
  return { meetings: out }
}

/** One meeting by session id (`r380098`) or bare ROWID. */
export function getRabbitMeeting(sessionId: string, days = 3650): RabbitMeeting | null {
  const rowid = Number(String(sessionId).replace(/^r/i, ""))
  if (!Number.isFinite(rowid)) return null
  const { meetings } = listRabbitMeetings({ days, limit: 500 })
  return meetings.find((m) => m.rowid === rowid) ?? null
}

/** NDJSON-free equivalent of the Wispr renderer — same output contract. */
export function renderRabbitTranscript(
  meeting: RabbitMeeting,
  speakerNames: Record<string, string>,
): { text: string; segments: number } {
  const named = meeting.segments.some((s) => !/^\d+$/.test(s.speakerId))
  const lines = [
    `# Meeting transcript — ${meeting.title}`,
    `# Source: rabbit R1 (device audio — captures the room, INCLUDING your own side)`,
    ...(named
      ? [`# Speakers: named by rabbit's diarisation. Those names are its GUESS, not verified —`,
         `#           confirm before relying on who committed to what. Relabel: --speaker Old=New`]
      : [`# Speakers: numeric diarisation ids, unnamed. Label them with --speaker 1=Alex`]),
    `# Received: ${meeting.receivedAt.toISOString().slice(0, 16).replace("T", " ")} · ` +
      `Segments: ${meeting.segments.length} · Duration: ${meeting.duration}`,
    "",
  ]
  for (const s of meeting.segments) {
    const who = speakerNames[s.speakerId] ?? s.speakerLabel
    lines.push(`[${s.timestamp}] ${who}: ${s.text}`)
  }
  return { text: lines.join("\n"), segments: meeting.segments.length }
}
