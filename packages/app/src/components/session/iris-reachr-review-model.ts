/** Reachr Review (#191990): what a batch's states mean to the person reviewing it. No I/O here. */
export type ReviewMessage = {
  id: number
  status: string
  lead_id: number
  lead_name: string | null
  to_email: string | null
  to_name: string | null
  group: string | null
  subject: string | null
  body: string | null
  warning: string | null
  hold_reason: string | null
  send_error: string | null
  check_result: { ok: boolean; failed: string[]; at: string } | null
  scheduled_for: string | null
  sent_at: string | null
}

export type ReviewBatch = {
  id: number
  name: string
  status: string
  stopped_reason: string | null
  starts_at: string | null
  pace_min_seconds: number
  pace_max_seconds: number
  counts: Record<string, number>
  messages?: ReviewMessage[]
}

export const FILTERS = ["all", "review", "approved", "held", "sent", "problem"] as const
export type ReviewFilter = (typeof FILTERS)[number]

const BUCKET: Record<string, ReviewFilter> = {
  draft: "review",
  pending_approval: "review",
  approved: "approved",
  scheduled: "approved",
  pre_check: "problem",
  failed: "problem",
  held: "held",
  sent: "sent",
  replied: "sent",
}

export const STATE_WORD: Record<string, string> = {
  draft: "Draft",
  pending_approval: "In review",
  approved: "Approved",
  scheduled: "Scheduled",
  pre_check: "Sending",
  held: "Held",
  declined: "Declined",
  failed: "Failed",
  sent: "Sent",
  replied: "Replied",
}

export const bucketOf = (status: string): ReviewFilter | undefined => BUCKET[status]
export const stateWord = (status: string) => STATE_WORD[status] ?? status

export function matchesFilter(m: ReviewMessage, filter: ReviewFilter): boolean {
  return filter === "all" || bucketOf(m.status) === filter
}

export function tally(messages: ReviewMessage[]): Record<ReviewFilter, number> {
  const out: Record<ReviewFilter, number> = { all: messages.length, review: 0, approved: 0, held: 0, sent: 0, problem: 0 }
  for (const m of messages) {
    const bucket = bucketOf(m.status)
    if (bucket) out[bucket]++
  }
  return out
}

/** Only these words can still change. Sent, sending and declined are history. */
export const canEdit = (m: ReviewMessage) => ["pending_approval", "approved", "scheduled", "held", "failed"].includes(m.status)
export const canApprove = (m: ReviewMessage) => m.status === "pending_approval"
export const canHold = (m: ReviewMessage) => ["pending_approval", "approved", "scheduled"].includes(m.status)
export const canRelease = (m: ReviewMessage) => m.status === "held" || m.status === "failed"

/**
 * A failed pre-check stopped before the send, so nothing left. Any other failure happened during the
 * send and the provider may have accepted it. Saying "may have gone" about the first is as wrong as
 * saying "not sent" about the second.
 */
export const failureLine = (m: ReviewMessage) =>
  m.check_result?.ok === false ? `Not sent: ${m.send_error}` : `This may have gone out. Check the mailbox first: ${m.send_error}`

/** What "approve the batch" may touch. A flagged message needs a person to open it. */
export const cleanForBulk = (messages: ReviewMessage[]) => messages.filter((m) => canApprove(m) && !m.warning)

/** "3–5 min apart", "1 min apart", or seconds when the pace is under a minute. */
export function paceLine(min: number, max: number): string {
  const word = (s: number) => (s % 60 === 0 ? String(s / 60) : (s / 60).toFixed(1))
  if (min === max) return `${word(min)} min apart`
  return `${word(min)}–${word(max)} min apart`
}

/** The value a datetime-local input needs: local wall-clock, to the minute. */
export function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function whenLine(iso: string | null, now = new Date()): string {
  if (!iso) return ""
  const d = new Date(iso)
  const sameDay = d.toDateString() === now.toDateString()
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
  return sameDay ? `Today ${time}` : `${d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })} ${time}`
}

/** The next message worth looking at after deciding on one, so a keyboard run never loses its place. */
export function nextId(visible: ReviewMessage[], currentId: number | undefined, step: 1 | -1): number | undefined {
  if (visible.length === 0) return undefined
  const at = visible.findIndex((m) => m.id === currentId)
  if (at === -1) return visible[0]!.id
  return visible[Math.min(visible.length - 1, Math.max(0, at + step))]!.id
}
