import { irisFetch } from "./iris-api"
import { readUnlogged, clearUnlogged, logComm, unloggedSpoolPath, type UnloggedSend } from "./comms-send"

/**
 * Can we still SEND, and did everything we sent reach the record?
 *
 * Every health surface in this product measured what came IN — comms freshness, unanswered
 * asks, last-contacted. Nothing measured the outbound half, so on 2026-09-14 a client email
 * attached to the wrong lead and the only way anyone found out was by reading the CLI's
 * output line by line after the fact. An audit trail that is only checked when somebody
 * happens to look is not an audit trail, it is a log.
 *
 * Three questions, cheapest first:
 *   1. Is there anything we sent that the ledger never heard about?   (local spool — free)
 *   2. Can we send at all?                                            (bridge probe)
 *   3. Will the identity we send as be accepted?                      (senders)
 */

export interface SenderRow {
  slug?: string
  name?: string
  email?: string
  verified?: boolean
  is_verified?: boolean
  status?: string
  archived?: boolean
}

export interface OutgoingInputs {
  spool: UnloggedSend[]
  bridgeOk: boolean
  bridgeDetail?: string
  senders: SenderRow[] | null
}

export interface OutgoingReport {
  ok: boolean
  /** Spooled sends we can repair without asking anyone: they already name their lead. */
  healable: UnloggedSend[]
  /** Spooled sends that need a human to say who they were for. */
  needsLead: UnloggedSend[]
  bridgeOk: boolean
  bridgeDetail?: string
  sendersUsable: number
  sendersUnusable: SenderRow[]
  /** Unknown is not the same as zero — say which one it is. */
  sendersKnown: boolean
  lines: string[]
}

const usable = (s: SenderRow): boolean => {
  const archived = s.archived === true || (s.status ?? "").toLowerCase() === "archived"
  const verified = s.verified === true || s.is_verified === true || (s.status ?? "").toLowerCase() === "verified"
  return verified && !archived
}

/**
 * The judgement, separated from the fetching so it can be tested without a network or a Mac.
 */
export function summariseOutgoing(input: OutgoingInputs): OutgoingReport {
  const healable = input.spool.filter((e) => typeof e.leadId === "number" && e.leadId > 0)
  const needsLead = input.spool.filter((e) => !(typeof e.leadId === "number" && e.leadId > 0))

  const sendersKnown = Array.isArray(input.senders)
  const sendersUnusable = sendersKnown ? input.senders!.filter((s) => !usable(s)) : []
  const sendersUsable = sendersKnown ? input.senders!.length - sendersUnusable.length : 0

  const lines: string[] = []

  lines.push(
    input.spool.length === 0
      ? "Unlogged sends     none"
      : `Unlogged sends     ${input.spool.length} — ${healable.length} repairable, ${needsLead.length} need a lead`,
  )
  lines.push(input.bridgeOk ? "Apple Mail         reachable" : `Apple Mail         UNREACHABLE${input.bridgeDetail ? ` — ${input.bridgeDetail}` : ""}`)
  lines.push(
    !sendersKnown
      ? "Send identities    unknown — could not read them"
      : sendersUnusable.length === 0
        ? `Send identities    ${sendersUsable} usable`
        : `Send identities    ${sendersUsable} usable, ${sendersUnusable.length} not (${sendersUnusable.map((s) => s.slug ?? s.email ?? "?").join(", ")})`,
  )

  // A send nobody recorded is the failure this exists to catch, so it alone decides `ok`.
  // An unverified spare identity is worth printing and is not a fault; an unreachable bridge
  // is only a fault on the machine that does the sending, and pulse runs everywhere.
  return {
    ok: input.spool.length === 0,
    healable,
    needsLead,
    bridgeOk: input.bridgeOk,
    bridgeDetail: input.bridgeDetail,
    sendersUsable,
    sendersUnusable,
    sendersKnown,
    lines,
  }
}

/** Gather the three inputs. Never throws — a health check that crashes reports nothing. */
export async function collectOutgoing(probeBridge: () => Promise<{ ok: boolean; message?: string }>): Promise<OutgoingInputs> {
  const spool = await readUnlogged().catch(() => [] as UnloggedSend[])

  let bridgeOk = false
  let bridgeDetail: string | undefined
  try {
    const b = await probeBridge()
    bridgeOk = b.ok
    bridgeDetail = b.ok ? undefined : b.message
  } catch (err: any) {
    bridgeDetail = err?.message ?? String(err)
  }

  let senders: SenderRow[] | null = null
  try {
    const res = await irisFetch("/api/v1/atlas/senders")
    if (res.ok) {
      const p: any = await res.json().catch(() => null)
      const rows = p?.data?.data ?? p?.data ?? p
      if (Array.isArray(rows)) senders = rows as SenderRow[]
    }
  } catch {
    /* null means unknown, which the report prints as unknown rather than zero */
  }

  return { spool, bridgeOk, bridgeDetail, senders }
}

export interface HealResult {
  repaired: number
  failed: number
  messages: string[]
}

/**
 * Put the repairable ones back on the record.
 *
 * Only entries that already name their lead. Guessing is what caused the incident this whole
 * surface exists for, and a health check is the last place that should start doing it.
 */
export async function healOutgoing(report: OutgoingReport): Promise<HealResult> {
  const done: string[] = []
  const messages: string[] = []
  let failed = 0

  for (const e of report.healable) {
    const r = await logComm({ leadId: e.leadId!, channel: e.channel, subject: e.subject, message: e.message, sentAt: e.at })
    if (r.ok) {
      done.push(e.at)
      messages.push(`repaired ${e.to} → lead #${e.leadId}${r.commId ? ` as comm #${r.commId}` : ""}`)
    } else {
      failed++
      messages.push(`could not repair ${e.to} — ${r.error}`)
    }
  }

  if (done.length) await clearUnlogged(done)
  return { repaired: done.length, failed, messages }
}

export { unloggedSpoolPath }
