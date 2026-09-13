// ============================================================================
// Instrument-honesty helpers for `iris leads pulse`
// ============================================================================
//
// Extracted from the pulse command so the behaviour is testable without a live
// bridge, a live API or a live model. Every function here exists because an
// output reported a confident answer over a measurement that did not happen:
//
//   #184926  a score over 4/6 blind channels, indistinguishable from a real one
//   #184927  "we haven't heard from you" sent to a lead phoned that same day
//   #184936  `status: null` on every task row — fails open for any consumer
//   #184940  a relationship characterised from a single 16-week-old outbound
//   #184941  duplicate tasks counted separately, inflating derived metrics
//
// The shape of the fix is the same in all five: refuse to state a verdict the
// measurement cannot support, and say which input was missing instead.

export interface ChannelHealthLike {
  name: string
  ok: boolean
  status?: string
  error?: string
  hint?: string
}

/** Probe display names → the short tokens pulse prints in its summaries. */
const CHANNEL_SHORT_NAMES: Record<string, string> = {
  gmail: "gmail",
  "google calendar": "calendar",
  calendar: "calendar",
  imessage: "imessage",
  whatsapp: "whatsapp",
  "apple mail": "applemail",
  mail: "applemail",
  "iris bridge": "bridge",
  bridge: "bridge",
}

export function channelShortName(name: string): string {
  const key = name.trim().toLowerCase()
  const known = CHANNEL_SHORT_NAMES[key]
  if (known) return known
  return key.replace(/[^a-z0-9]/g, "")
}

export interface ChannelBlindness {
  total: number
  blind: number
  live: number
  blindNames: string[]
  /** True when blindness makes any score or recommendation unsupportable. */
  unavailable: boolean
  /** True when at least one channel is blind but a verdict may still be offered. */
  partial: boolean
  summary: string
}

/**
 * Decide how much of the instrument is actually working (#184926).
 *
 * `unavailable` is deliberately strict — blindness must *exceed* live channels,
 * because a 3-of-6 read is a partial measurement (report it with a qualifier),
 * not a failed one. The failure this prevents is a 4/6-blind run rendering the
 * same "20/100" as a six-channel run, so a reader cannot tell "gone quiet" from
 * "we went blind", and the Next Best Action chases a lead we simply could not
 * see.
 *
 * An empty input (the probe batch itself failed) is blind, not clean: that is
 * exactly the case where a fail-open default would claim health it never saw.
 */
export function groupChannelBlindness(checks: ChannelHealthLike[]): ChannelBlindness {
  const total = checks.length
  const blindChecks = checks.filter((c) => !c.ok)
  const blind = blindChecks.length
  const live = total - blind
  const blindNames = blindChecks.map((c) => channelShortName(c.name))

  if (total === 0) {
    return {
      total: 0,
      blind: 0,
      live: 0,
      blindNames: [],
      unavailable: true,
      partial: false,
      summary: "channel health could not be measured",
    }
  }

  const unavailable = blind > live
  return {
    total,
    blind,
    live,
    blindNames,
    unavailable,
    partial: blind > 0,
    summary: `${blind}/${total} channels blind${blindNames.length > 0 ? ` (${blindNames.join(", ")})` : ""}`,
  }
}

// ============================================================================
// #184940 — sentiment needs a sample, and the sample needs an inbound message
// ============================================================================

/** Minimum messages before a relationship may be characterised at all. */
export const MIN_SENTIMENT_SAMPLE = 3

export interface SentimentMessageLike {
  date?: string
  isOutbound?: boolean
  channel?: string
}

export interface SentimentSufficiency {
  sufficient: boolean
  reason: "ok" | "no_messages" | "sample_too_small" | "no_inbound"
  sampled: number
  inbound: number
  outbound: number
  newestAgeDays: number | null
  detail: string
}

function ageInDays(iso: string | undefined, now: Date): number | null {
  if (!iso) return null
  const t = new Date(iso).getTime()
  if (isNaN(t)) return null
  return Math.max(0, Math.floor((now.getTime() - t) / 86_400_000))
}

/**
 * State the sample, or refuse to characterise it (#184940).
 *
 * Two floors, both from a measured failure: a sample of one is not a sample,
 * and a sample with no inbound message cannot describe a *relationship* —
 * one-sided evidence only shows what we said. The 112-day-old bug case passes
 * neither floor, yet produced a fluent sentence about the client's sentiment.
 */
export function sentimentSufficiency(
  messages: SentimentMessageLike[],
  opts: { blindCount?: number; totalChannels?: number; now?: Date } = {},
): SentimentSufficiency {
  const now = opts.now ?? new Date()
  const blindCount = opts.blindCount ?? 0
  const totalChannels = opts.totalChannels ?? 0

  const sampled = messages.length
  const inbound = messages.filter((m) => !m.isOutbound).length
  const outbound = messages.filter((m) => m.isOutbound).length

  let newestAgeDays: number | null = null
  for (const m of messages) {
    const age = ageInDays(m.date, now)
    if (age !== null && (newestAgeDays === null || age < newestAgeDays)) newestAgeDays = age
  }

  const channelClause =
    blindCount > 0 && totalChannels > 0 ? `; ${blindCount} of ${totalChannels} channels unreadable` : ""

  if (sampled === 0) {
    return {
      sufficient: false,
      reason: "no_messages",
      sampled,
      inbound,
      outbound,
      newestAgeDays,
      detail: `no messages sampled${channelClause}`,
    }
  }

  const direction = inbound === 0 ? "outbound" : outbound === 0 ? "inbound" : "mixed"
  const ageText =
    newestAgeDays === null ? "age unknown" : `${newestAgeDays} day${newestAgeDays === 1 ? "" : "s"} old`
  const detail = `${sampled} message${sampled === 1 ? "" : "s"} sampled (${direction}, ${ageText})${channelClause}`

  if (sampled < MIN_SENTIMENT_SAMPLE) {
    return { sufficient: false, reason: "sample_too_small", sampled, inbound, outbound, newestAgeDays, detail }
  }
  if (inbound === 0) {
    return { sufficient: false, reason: "no_inbound", sampled, inbound, outbound, newestAgeDays, detail }
  }

  return { sufficient: true, reason: "ok", sampled, inbound, outbound, newestAgeDays, detail }
}

// ============================================================================
// #184927 — "last contact" means any channel, not just an outreach sequence
// ============================================================================

export interface TouchCandidate {
  at?: string | Date | null
  source: "outreach_send" | "note" | "call_log" | "meeting_intel" | "inbound" | string
}

export interface LatestTouch {
  at: Date | null
  source: string | null
}

/**
 * Most recent contact across every recorded channel (#184927).
 *
 * The hydration gate read only `outreach_completed_count`-style outbound
 * sequence sends, so a lead spoken to by phone that same day still matched
 * "we haven't heard from you" and would have been emailed. Notes, call logs,
 * meeting intel and inbound messages are all contact; the gate has to see them.
 */
export function latestTouch(candidates: TouchCandidate[]): LatestTouch {
  let best: LatestTouch = { at: null, source: null }
  for (const c of candidates) {
    if (c.at === null || c.at === undefined) continue
    const t = c.at instanceof Date ? c.at : new Date(c.at)
    if (isNaN(t.getTime())) continue
    if (!best.at || t.getTime() > best.at.getTime()) best = { at: t, source: c.source }
  }
  return best
}

/**
 * Collect every recorded touch from the payloads pulse already holds (#184927).
 *
 * This is the part that was missing rather than wrong: `last_outbound_at` on the
 * comms signal only counts outbound *sequence* sends. A phone call logged to the
 * activity feed, a CRM note, a meeting note and an inbound message are all
 * contact, and before this the hydration gate could not see any of them.
 *
 * `activities` carries the note/call/meeting records; `outreachSteps` carries
 * sequence sends; `inboundMessages` carries inbound channel traffic. Returning
 * candidates rather than a timestamp keeps the decision testable separately.
 */
export function collectTouchCandidates(input: {
  lastOutboundAt?: string | Date | null
  lastInboundAt?: string | Date | null
  notes?: any[]
  activities?: any[]
  outreachSteps?: any[]
  /** Channel scan results, already flattened to {date, isOutbound}. */
  channelMessages?: Array<{ date?: string | Date | null; isOutbound?: boolean }>
}): TouchCandidate[] {
  const out: TouchCandidate[] = []

  if (input.lastOutboundAt) out.push({ at: input.lastOutboundAt, source: "outreach_send" })
  if (input.lastInboundAt) out.push({ at: input.lastInboundAt, source: "inbound" })

  // CRM notes carry created_at; a note is a human having interacted with the lead.
  for (const n of input.notes ?? []) {
    const at = n?.created_at ?? n?.date ?? null
    if (at) out.push({ at, source: "note" })
  }

  // The activity feed is where call_log and meeting_intel land (#376265, #376264).
  for (const a of input.activities ?? []) {
    const at = a?.created_at ?? a?.date ?? null
    if (!at) continue
    const type = String(a?.type ?? a?.activity_type ?? "note").toLowerCase()
    const source =
      type.includes("call") ? "call_log" : type.includes("meeting") || type.includes("meet") ? "meeting_intel" : "note"
    out.push({ at, source })
  }

  // Outreach steps that actually completed — a step that never ran is not a touch.
  for (const s of input.outreachSteps ?? []) {
    const at = s?.completed_at ?? s?.sent_at ?? null
    if (at) out.push({ at, source: "outreach_send" })
  }

  // Channel traffic: a message we sent is a touch (#184927's gate must not send
  // "we haven't heard from you" over the top of it), and so is one received.
  for (const m of input.channelMessages ?? []) {
    if (m?.date) out.push({ at: m.date, source: m.isOutbound ? "outreach_send" : "inbound" })
  }

  return out
}

export interface HydrationDecision {
  eligible: boolean
  reason: "eligible" | "inside_window" | "channels_blind" | "forced_despite_blindness"
  suppressedByBlindness: boolean
  hoursSinceLabel: string
}

/**
 * Whether an automated follow-up may be sent (#184927).
 *
 * Blindness is checked *before* recency on purpose: if we cannot read the
 * channels, a stale timestamp is not evidence of silence — it is evidence we
 * could not look. A recent touch and a blind read both suppress the send, but
 * they mean opposite things, so they get different reasons.
 */
export function hydrationDecision(opts: {
  lastTouchAt: Date | null
  now?: Date
  windowHours?: number
  blind?: boolean
  blindSummary?: string
  force?: boolean
}): HydrationDecision {
  const now = opts.now ?? new Date()
  const windowHours = opts.windowHours ?? 24
  const blind = opts.blind ?? false
  const force = opts.force ?? false

  const hoursSince = opts.lastTouchAt ? (now.getTime() - opts.lastTouchAt.getTime()) / 3_600_000 : Infinity
  const hoursSinceLabel = opts.lastTouchAt ? `${Math.floor(hoursSince)}h ago` : "never"

  if (blind && !force) {
    return { eligible: false, reason: "channels_blind", suppressedByBlindness: true, hoursSinceLabel }
  }
  if (hoursSince < windowHours) {
    return { eligible: false, reason: "inside_window", suppressedByBlindness: blind, hoursSinceLabel }
  }
  if (blind && force) {
    return { eligible: true, reason: "forced_despite_blindness", suppressedByBlindness: true, hoursSinceLabel }
  }
  return { eligible: true, reason: "eligible", suppressedByBlindness: false, hoursSinceLabel }
}

// ============================================================================
// #184936 — `status: null` fails open; derive a real value
// ============================================================================

export type NormalizedTaskStatus = "pending" | "completed" | "overdue"

/**
 * Derive the status the API never sent (#184936).
 *
 * fl-api emits `is_completed` + `completed_at`, and the `--json` path dumped the
 * rows raw, so every row carried `status: null`. A consumer filtering
 * `status != 'completed'` then reported completed tasks as open. Deriving the
 * value here means the key cannot silently disagree with the flags beside it.
 */
export function normalizeTaskStatus(task: any, now: Date = new Date()): NormalizedTaskStatus {
  if (task?.is_completed === true || task?.completed_at) return "completed"
  if (task?.due_date) {
    const due = new Date(task.due_date).getTime()
    if (!isNaN(due) && due < now.getTime()) return "overdue"
  }
  return "pending"
}

/** Add a derived `status` while leaving every raw field intact for consumers. */
export function normalizeTask(task: any, now: Date = new Date()): any {
  return { ...task, status: normalizeTaskStatus(task, now) }
}

// ============================================================================
// #184941 — duplicates inflate every metric derived from the task list
// ============================================================================

/**
 * Identity of a task for duplicate detection.
 *
 * Case, punctuation and a trailing "…" are not differences — #682 and #685 were
 * byte-identical, and #673 differed only by a truncation mark added in display.
 */
export function taskTitleKey(title: string | undefined | null): string {
  return String(title ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
}

export interface DuplicateTaskGroup {
  key: string
  ids: number[]
  title: string
}

/**
 * Group live tasks whose titles are the same task (#184941).
 *
 * Completed rows are excluded: a resolved duplicate is not a live problem, and
 * counting it would reintroduce the inflation this exists to stop. Blank titles
 * are excluded too — "" is not a shared identity.
 */
export function findDuplicateTaskGroups(tasks: any[]): DuplicateTaskGroup[] {
  const byKey = new Map<string, DuplicateTaskGroup>()
  for (const t of tasks ?? []) {
    if (t?.is_completed === true) continue
    const key = taskTitleKey(t?.title)
    if (!key) continue
    const existing = byKey.get(key)
    if (existing) existing.ids.push(t.id)
    else byKey.set(key, { key, ids: [t.id], title: String(t.title) })
  }
  return [...byKey.values()].filter((g) => g.ids.length > 1)
}

// ============================================================================
// #184926 — recommend the fix, not an outreach action, when we cannot see
// ============================================================================

export interface NextBestAction {
  action: string
  priority: "high" | "medium" | "low"
  hint: string
}

const CHANNEL_FIX_HINT = "grant Full Disk Access to iris-daemon, then: iris-daemon restart"

/**
 * Rule-based next action, with blindness as the first gate (#184926).
 *
 * Every rule below this one is a claim about the lead. When the channels are
 * blind, the honest recommendation is about the *instrument*, because any
 * outreach decision made here would be made on a read we know is incomplete —
 * and in the measured run that meant "last outreach never" about someone who
 * had been phoned that day.
 */
export function resolveNextBestAction(input: {
  blindness: ChannelBlindness
  hasPaymentGate?: boolean
  paymentReceived?: boolean
  lastOutboundAt?: Date | null
  status?: string
  now?: Date
}): NextBestAction {
  const now = input.now ?? new Date()

  if (input.blindness.unavailable) {
    return {
      action: `Do not act on outreach — ${input.blindness.summary}. Fix channel access first.`,
      priority: "high",
      hint: CHANNEL_FIX_HINT,
    }
  }

  if (input.hasPaymentGate && !input.paymentReceived) {
    const hoursSince = input.lastOutboundAt
      ? (now.getTime() - input.lastOutboundAt.getTime()) / 3_600_000
      : Infinity
    if (hoursSince > 48) {
      return {
        action: `Send payment follow-up — gate unpaid, last outreach ${hoursSince === Infinity ? "never" : `${Math.floor(hoursSince)}h ago`}`,
        priority: "high",
        hint: "",
      }
    }
    return {
      action: `Wait for payment — follow-up sent ${Math.floor(hoursSince)}h ago (next eligible in ${Math.ceil(24 - hoursSince)}h)`,
      priority: "low",
      hint: "",
    }
  }

  return { action: "", priority: "medium", hint: "" }
}

// =============================================================================
// #184939 — there was nowhere to put a date, so a recommendation could never close
// =============================================================================
//
// Observed 2026-09-13 on lead #15743. After a substantive client call there was no field
// to record "spoke to him today" or "next touch Wednesday" — the only dates on the row
// were created_at / updated_at / replied_at / locked_at / converted_at / score_updated_at,
// all system-maintained. So the answer to a pulse recommendation could only live in prose
// inside a note, where nothing can sort, filter or alert on it, and the next run recomputed
// the same recommendation from the same stale inputs. The loop could not close.
//
// The lead row's `contact_info` is a JSON blob the server merges without a validator
// allow-list, so the dates live there without a migration. `last_contacted` is the real
// last touch (what pulse should have been reading all along); `next_follow_up` is the
// scheduled one (what lets pulse stop recommending something already on the books).

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/

/**
 * Turn operator input into a `YYYY-MM-DD` string, or null if it is not a date.
 *
 * Deliberately strict. A date field that quietly accepts "spoke to him the other day" is
 * not a date field — it is a note with a misleading name, and every consumer that sorts or
 * compares it silently gets nothing. Refusing is the honest answer, and the caller can say
 * so rather than writing prose into a slot that promises a comparison.
 */
export function normalizeTouchDate(input: string | null | undefined, now: Date = new Date()): string | null {
  if (input == null) return null
  const raw = String(input).trim()
  if (!raw) return null

  const lower = raw.toLowerCase()
  if (lower === "today" || lower === "now") return toDateOnly(now)
  if (lower === "yesterday") return toDateOnly(new Date(now.getTime() - 86_400_000))
  if (lower === "tomorrow") return toDateOnly(new Date(now.getTime() + 86_400_000))

  // A full timestamp is a date; take the date part.
  const isoPrefix = raw.slice(0, 10)
  if (DATE_ONLY.test(isoPrefix) && (raw.length === 10 || raw[10] === "T" || raw[10] === " ")) {
    return validDateOnly(isoPrefix) ? isoPrefix : null
  }

  if (DATE_ONLY.test(raw)) return validDateOnly(raw) ? raw : null
  return null
}

/** Reject 2026-02-31 and friends rather than letting Date() roll them into March. */
function validDateOnly(yyyymmdd: string): boolean {
  const [y, m, d] = yyyymmdd.split("-").map(Number)
  const probe = new Date(Date.UTC(y, m - 1, d))
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d
}

function toDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/**
 * Build the PUT payload for a touch, merging into whatever `contact_info` already holds.
 *
 * The merge is the point: `contact_info` carries email, chat_ids, whatsapp_groups and
 * alternate addresses. Replacing it wholesale to write one date would drop every other key
 * — the same overwrite bug the --chat-id / --add-email flags already guard against.
 *
 * An unset date emits NOTHING rather than a null, so choosing only one of the two dates
 * cannot blank the other.
 */
export function buildTouchPayload(input: {
  existing?: unknown
  lastContacted?: string | null
  nextFollowUp?: string | null
}): Record<string, unknown> {
  const existing =
    input.existing && typeof input.existing === "object" && !Array.isArray(input.existing)
      ? (input.existing as Record<string, unknown>)
      : {}

  const changes: Record<string, unknown> = {}
  if (input.lastContacted) changes.last_contacted = input.lastContacted
  if (input.nextFollowUp) changes.next_follow_up = input.nextFollowUp

  if (Object.keys(changes).length === 0) return {}
  return { contact_info: { ...existing, ...changes } }
}

export interface NextFollowUpState {
  /** A future-or-today touch is already on the books — pulse should not recommend it again. */
  scheduled: boolean
  /** The date has passed: this is a missed commitment, which is a different fact. */
  overdue: boolean
  daysAway: number | null
  label: string
}

/**
 * Read `next_follow_up` off the lead so pulse can suppress what is already scheduled.
 *
 * `overdue` and NOT `scheduled` is the answer for a past date: a commitment that came and
 * went is not a booking, and reporting it as one would hide a missed touch behind a
 * reassuring green. Unparseable input fails open to neither — never to "scheduled", because
 * that would let one prose value silence every recommendation on the lead.
 */
export function nextFollowUpState(contactInfo: unknown, now: Date = new Date()): NextFollowUpState {
  const none: NextFollowUpState = { scheduled: false, overdue: false, daysAway: null, label: "" }
  if (!contactInfo || typeof contactInfo !== "object" || Array.isArray(contactInfo)) return none

  const raw = (contactInfo as Record<string, unknown>).next_follow_up
  if (typeof raw !== "string" || !raw.trim()) return none

  const dateOnly = normalizeTouchDate(raw)
  if (!dateOnly) return none

  const target = new Date(`${dateOnly}T00:00:00Z`)
  const today = new Date(`${toDateOnly(now)}T00:00:00Z`)
  const daysAway = Math.round((target.getTime() - today.getTime()) / 86_400_000)

  if (daysAway < 0) {
    const n = Math.abs(daysAway)
    return {
      scheduled: false,
      overdue: true,
      daysAway,
      label: `${dateOnly} — overdue by ${n} day${n === 1 ? "" : "s"}`,
    }
  }

  const when =
    daysAway === 0 ? "today" : daysAway === 1 ? "tomorrow" : `in ${daysAway} days`
  return { scheduled: true, overdue: false, daysAway, label: `${dateOnly} (${when})` }
}
