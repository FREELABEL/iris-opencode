/**
 * One message, several recipients — the pure half of `iris comms log`, split out so it can be
 * unit-tested without the CLI's yargs/API graph (same reason page-ref.ts and comms-channel-read.ts
 * live apart).
 *
 * #186156. `comms log` took exactly one lead, so an email to three people had to be logged three
 * times as three unrelated rows. Worse, the server's dedupe key for a manual log had no lead in
 * it: the second and third copies matched the first lead's row and were silently dropped while
 * the CLI printed "Logged". The server now keys manual logs per lead; this module makes the CLI
 * send one shared group id, one timestamp, and the full recipient list on every copy — and
 * `checkLogged` is the read-back that refuses to call a copy logged unless the row that came
 * back is actually on that lead.
 */

export interface Recipient {
  lead_id: number
  name: string | null
  email: string | null
}

export interface LogInput {
  channel: string
  direction: string
  body: string
  subject?: string | null
  sentAt: string
  groupId: string
  cc?: string[]
}

/** A short, url-safe id the server accepts (`^[A-Za-z0-9_-]{1,64}$`). */
export function newGroupId(now = Date.now(), rand = Math.random): string {
  return `grp_${now.toString(36)}${Math.floor(rand() * 36 ** 6).toString(36).padStart(6, "0")}`
}

export const GROUP_ID = /^[A-Za-z0-9_-]{1,64}$/

/** De-duplicate leads by id, keeping first-seen order — `log 1 2 1` is two recipients, not three. */
export function uniqueRecipients(rs: Recipient[]): Recipient[] {
  const seen = new Set<number>()
  return rs.filter((r) => (seen.has(r.lead_id) ? false : (seen.add(r.lead_id), true)))
}

/**
 * One payload per recipient. Every copy carries the SAME group id, timestamp and recipient list,
 * so any one lead's timeline can say who else received it — and re-running the same log with the
 * same group id is idempotent per lead on the server.
 */
export function buildLogPayloads(recipients: Recipient[], input: LogInput) {
  const all = uniqueRecipients(recipients)
  const to = all.map((r) => r.email).filter((e): e is string => !!e)
  return all.map((r) => ({
    lead_id: r.lead_id,
    channel: input.channel,
    direction: input.direction,
    body: input.body,
    subject: input.subject ?? null,
    sent_at: input.sentAt,
    message_group_id: input.groupId,
    to_identifiers: to.length ? to : null,
    metadata: {
      message_group_id: input.groupId,
      recipients: all,
      ...(input.cc?.length ? { cc: input.cc } : {}),
      logged_via: "iris comms log",
    },
  }))
}

export type LogOutcome = "logged" | "already" | "wrong_lead" | "failed"

/**
 * Did this copy really land on this lead? A 2xx is not enough: before #186156 the server answered
 * 200 with ANOTHER lead's row, and "success" was the bug. Only a row whose lead_id matches counts.
 */
export function checkLogged(leadId: number, status: number, record: any): LogOutcome {
  if (status < 200 || status >= 300) return "failed"
  if (!record || Number(record.lead_id) !== leadId) return "wrong_lead"
  return status === 201 ? "logged" : "already"
}

/** "also sent to: J.C. Adams, Clayton" for one lead's timeline row, from the stored recipient list. */
export function alsoSentTo(row: any, leadId: number): string | null {
  const rs: Recipient[] = row?.metadata?.recipients ?? []
  const others = rs.filter((r) => Number(r.lead_id) !== leadId).map((r) => r.name || r.email || `#${r.lead_id}`)
  return others.length ? `also sent to: ${others.join(", ")}` : null
}
