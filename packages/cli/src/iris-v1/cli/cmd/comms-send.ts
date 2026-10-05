import { irisFetch } from "./iris-api"

/**
 * The CLI's single call into the Comms Router (CR-8).
 *
 * `iris imessage send` shelled out to osascript and `iris mail send` POSTed straight to the
 * bridge. Both worked, and both were invisible: nothing wrote lead_comms, so the log was only
 * ever as fresh as the last time somebody remembered to run `atlas:comms ingest`. Measured on
 * production (#178647): 27 of 28 leads with iMessage history were more than a week stale.
 *
 * The bridge is still the transport. The router is now the bookkeeper.
 */

export interface RouterSendInput {
  /** CRM lead id — preferred, because it gets full attribution and authorization. */
  toLeadId?: number
  /** Raw phone / email / iMessage address for someone who is not a lead. */
  toHandle?: string
  channel?: string
  message: string
  subject?: string
  stepId?: number
  strategyId?: number
  scriptId?: number
  campaignId?: number
  origin?: string
  dryRun?: boolean
  /**
   * WHICH registered identity is sending — a `senders` slug. The API resolves it scoped to you,
   * refuses it if unverified or archived, and routes on that sender's own channel order.
   *
   * Only valid with a lead (or a handle that resolves to one): the ad-hoc handle path bypasses
   * the channel bindings, so a sender there would be signed by one identity and delivered from
   * another. The API rejects that rather than ignoring the flag.
   */
  sender?: string
}

export interface RouterSendResult {
  ok: boolean
  sent: boolean
  channel?: string
  commId?: number | null
  externalId?: string | null
  stepAdvanced?: number | null
  error?: string
  /** Present for --dry-run: which channel would be used and why. */
  plan?: { channel: string | null; reason: string; alternatives: Record<string, string> }
}

const ENDPOINT = "/api/v1/atlas/comms/send"

/**
 * Send through the router. Never throws — a CLI send failing is a message to print, not a stack
 * trace, and the caller needs the reason to be able to fall back.
 */
export async function routerSend(input: RouterSendInput): Promise<RouterSendResult> {
  const body: Record<string, unknown> = { message: input.message }
  if (input.toLeadId != null) body.to_lead_id = input.toLeadId
  if (input.toHandle) body.to_handle = input.toHandle
  if (input.channel) body.channel = input.channel
  if (input.subject) body.subject = input.subject
  if (input.stepId != null) body.step_id = input.stepId
  if (input.strategyId != null) body.strategy_id = input.strategyId
  if (input.scriptId != null) body.script_id = input.scriptId
  if (input.campaignId != null) body.campaign_id = input.campaignId
  if (input.sender) body.sender = input.sender
  if (input.dryRun) body.dry_run = true
  body.origin = input.origin ?? "cli.reachr"

  let res: Response
  try {
    res = await irisFetch(ENDPOINT, { method: "POST", body: JSON.stringify(body) })
  } catch (err: any) {
    return { ok: false, sent: false, error: `Could not reach the comms API: ${err?.message ?? err}` }
  }

  let payload: any = null
  try {
    payload = await res.json()
  } catch {
    /* non-JSON error body — handled below */
  }

  if (!res.ok) {
    return {
      ok: false,
      sent: false,
      error: payload?.error ?? payload?.message ?? `HTTP ${res.status}`,
    }
  }

  const data = payload?.data ?? payload ?? {}

  // dry-run returns a ChannelPlan rather than a send result
  if (input.dryRun) {
    return { ok: true, sent: false, plan: data }
  }

  return {
    ok: true,
    sent: Boolean(data.sent),
    channel: data.channel,
    commId: data.comm_id ?? null,
    externalId: data.external_id ?? null,
    stepAdvanced: data.step_advanced ?? null,
    error: data.error,
  }
}

/**
 * One-line status for the operator after a send.
 *
 * "Sent" and "sent AND on the record" are different states and the CLI must not blur them —
 * a message that went out with no comm id is exactly the failure this epic removes, so it is
 * reported rather than dressed up as success.
 */
export function describeSend(r: RouterSendResult): string {
  if (!r.ok || !r.sent) return `Not sent — ${r.error ?? "unknown error"}`
  const logged = r.commId ? `logged as comm #${r.commId}` : "NOT LOGGED (sent, but no ledger row)"
  const step = r.stepAdvanced ? `, completed step #${r.stepAdvanced}` : ""
  return `Sent via ${r.channel} — ${logged}${step}`
}

export interface RecordSendInput {
  /** Recipient handle — an email address for apple_mail. Kept for the spool, not for resolution. */
  toHandle: string
  /**
   * WHICH lead this belongs to. Required, and resolved by the CALLER before anything is sent.
   *
   * This used to be discovered here, with `?search=<handle>&per_page=1` and `rows[0]`. On
   * 2026-09-14 that put a client email on a Stripe-created duplicate of the client — and it
   * could not have warned, because per_page=1 means it never learned a second row existed.
   * An instrument that asks for one answer cannot discover that the question was ambiguous.
   */
  leadId: number
  channel: string
  subject?: string
  message: string
  /** Where it went out from, for the record. */
  origin?: string
}

export interface RecordSendResult {
  ok: boolean
  leadId?: number
  commId?: number | null
  /** Why nothing was written. Always set when ok is false — "it didn't log" is not an answer. */
  error?: string
}

/**
 * Put a message that has ALREADY been sent onto the record.
 *
 * routerSend sends and books in one call, but it cannot carry attachments, cc, or a raw --from,
 * so those sends go out through the bridge instead. That was treated as a reason not to log them
 * — the CLI printed "not logged to comms" and wrote nothing — which quietly reintroduced the
 * exact failure CR-8 existed to remove. A send the log does not know about makes every "have we
 * contacted them?" answer wrong, and it is wrong in the dangerous direction: it looks like
 * silence.
 *
 * Transport and bookkeeping are separate concerns. The bridge can own the first without taking
 * the second with it.
 */
export async function recordDirectSend(input: RecordSendInput): Promise<RecordSendResult> {
  const leadId = input.leadId

  try {
    const res = await irisFetch("/api/v1/atlas/comms/log", {
      method: "POST",
      body: JSON.stringify({
        lead_id: leadId,
        channel: input.channel,
        direction: "outbound",
        body: input.message,
        subject: input.subject ?? null,
        sent_at: new Date().toISOString(),
      }),
    })

    if (!res.ok) {
      return { ok: false, leadId, error: `comms/log returned ${res.status}` }
    }

    const payload = (await res.json().catch(() => null)) as any
    const record = payload?.data?.record ?? payload?.data ?? null

    return { ok: true, leadId, commId: record?.id ?? null }
  } catch (err: any) {
    return { ok: false, leadId, error: `could not reach the comms API: ${err?.message ?? err}` }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// WHO is this for — answered ONCE, in front of the send
// ─────────────────────────────────────────────────────────────────────────────

export interface LeadMatch {
  id: number
  name?: string
  email?: string
  source?: string
}

export interface LeadResolution {
  /** true only when exactly one lead owns this handle. */
  ok: boolean
  leadId?: number
  /** Every exact match found — 0, 1, or the tie that must be broken by hand. */
  matches: LeadMatch[]
  reason: "ok" | "none" | "ambiguous" | "error"
  error?: string
}

/**
 * Resolve a recipient handle to exactly one lead, or refuse and show the candidates.
 *
 * Three things this does that the two resolvers it replaces did not:
 *
 *  1. Asks for MANY rows. `per_page=1` cannot report a tie; it returns the tie's winner and no
 *     evidence that there was one.
 *  2. Filters to an EXACT address match. `?search=` is fuzzy and matches names and notes, so a
 *     "match" could be someone who merely mentions the address.
 *  3. Returns the ambiguity as a first-class outcome instead of picking. Both previous callers
 *     ended in an unordered `->first()` / `rows[0]`, which is a coin toss wearing a result's
 *     clothes.
 */
export async function resolveLeadForHandle(handle: string): Promise<LeadResolution> {
  const needle = handle.trim().toLowerCase()
  if (!needle) return { ok: false, matches: [], reason: "error", error: "empty recipient" }

  let rows: any[] = []
  try {
    const res = await irisFetch(`/api/v1/leads?search=${encodeURIComponent(handle)}&per_page=50`)
    if (!res.ok) {
      return { ok: false, matches: [], reason: "error", error: `leads API returned ${res.status}` }
    }
    const payload = (await res.json().catch(() => null)) as any
    const data = payload?.data?.data ?? payload?.data ?? []
    rows = Array.isArray(data) ? data : []
  } catch (err: any) {
    return { ok: false, matches: [], reason: "error", error: `could not reach the leads API: ${err?.message ?? err}` }
  }

  return decideLeadMatch(rows, handle)
}

/**
 * The decision, separated from the fetch so it can be tested with the rows production returned.
 *
 * This is where the defect lived. Both previous resolvers took the first row of a query — one
 * with `per_page=1`, one with an unordered `->first()` — so "which lead?" was answered by sort
 * order. The rule now: an EXACT address match, and a count, and a tie is a distinct outcome
 * rather than a winner.
 */
export function decideLeadMatch(rows: any[], handle: string): LeadResolution {
  const needle = handle.trim().toLowerCase()

  const emailsOf = (r: any): string[] =>
    [r?.email, r?.contact_info?.email, ...(Array.isArray(r?.contact_info?.emails) ? r.contact_info.emails : [])]
      .filter((e: any) => typeof e === "string" && e)
      .map((e: string) => e.trim().toLowerCase())

  const matches: LeadMatch[] = (Array.isArray(rows) ? rows : [])
    .filter((r) => emailsOf(r).includes(needle))
    .map((r) => ({ id: Number(r.id), name: r.name, email: r.email, source: r.source }))

  if (matches.length === 1) return { ok: true, leadId: matches[0].id, matches, reason: "ok" }
  if (matches.length === 0) return { ok: false, matches, reason: "none" }
  return { ok: false, matches, reason: "ambiguous" }
}

/**
 * The local ledger of sends the remote ledger does not have.
 *
 * `recordDirectSend` fixed the path forward and could not fix the past: it cannot find sends
 * that went out before it existed, or ones where the mail left and the record POST then failed.
 * There was no sweep, so the size of that gap was unknown — and an unknown gap in an audit trail
 * is indistinguishable from no gap. Every send that goes out without landing in lead_comms now
 * writes a line here, and `iris mail audit` is what reads it back.
 */
export interface UnloggedSend {
  at: string
  channel: string
  to: string
  subject?: string
  message: string
  leadId?: number
  reason: string
  origin?: string
}

export function unloggedSpoolPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || "."
  return `${home}/.iris/comms-unlogged.jsonl`
}

export async function spoolUnlogged(entry: UnloggedSend): Promise<string | null> {
  try {
    const fs = await import("node:fs/promises")
    const path = unloggedSpoolPath()
    await fs.mkdir(path.replace(/\/[^/]+$/, ""), { recursive: true })
    await fs.appendFile(path, JSON.stringify(entry) + "\n", "utf8")
    return path
  } catch {
    // A spool that cannot be written must not swallow the send report; the caller still prints
    // the loud SENT BUT NOT LOGGED line, which is the part that matters.
    return null
  }
}

export async function readUnlogged(): Promise<UnloggedSend[]> {
  try {
    const fs = await import("node:fs/promises")
    const raw = await fs.readFile(unloggedSpoolPath(), "utf8")
    return raw
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l) as UnloggedSend
        } catch {
          return null
        }
      })
      .filter((e): e is UnloggedSend => e !== null)
  } catch {
    return []
  }
}

/** Remove spool lines that have since been logged, identified by their `at` timestamps. */
export async function clearUnlogged(timestamps: string[]): Promise<void> {
  const keep = (await readUnlogged()).filter((e) => !timestamps.includes(e.at))
  try {
    const fs = await import("node:fs/promises")
    await fs.writeFile(unloggedSpoolPath(), keep.map((e) => JSON.stringify(e)).join("\n") + (keep.length ? "\n" : ""), "utf8")
  } catch {
    /* best effort — a spool we cannot rewrite still reports correctly, just repeatedly */
  }
}

/** Write one comm row against a known lead. Shared by the send path and the backfiller. */
export async function logComm(input: {
  leadId: number
  channel: string
  subject?: string
  message: string
  sentAt?: string
}): Promise<{ ok: boolean; commId?: number | null; error?: string }> {
  try {
    const res = await irisFetch("/api/v1/atlas/comms/log", {
      method: "POST",
      body: JSON.stringify({
        lead_id: input.leadId,
        channel: input.channel,
        direction: "outbound",
        body: input.message,
        subject: input.subject ?? null,
        sent_at: input.sentAt ?? new Date().toISOString(),
      }),
    })
    if (!res.ok) return { ok: false, error: `comms/log returned ${res.status}` }
    const payload = (await res.json().catch(() => null)) as any
    const record = payload?.data?.record ?? payload?.data ?? null
    return { ok: true, commId: record?.id ?? null }
  } catch (err: any) {
    return { ok: false, error: `could not reach the comms API: ${err?.message ?? err}` }
  }
}
