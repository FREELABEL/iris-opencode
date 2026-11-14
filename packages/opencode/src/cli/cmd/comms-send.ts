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
