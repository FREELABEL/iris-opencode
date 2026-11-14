/**
 * Where an `iris mail` call is served: this machine's bridge, or the Hive node that has
 * Apple Mail (#189480).
 *
 * `iris mail` used to talk only to localhost:3200. On a machine without Mail — the cloud box,
 * a Linux server, a Mac that never set Mail up — it failed with "is Mail.app configured on
 * this Mac?", which is wrong off a Mac and points nowhere. Meanwhile the cloud's bridge-call
 * rail (POST /api/v6/nodes/bridge-call → the node dials out over Pusher → its own bridge)
 * could reach an online Mac's Mail in 1.6s. Measured 2026-10-15.
 *
 * The functions here are pure so the routing decision is tested, not just exercised.
 */

import { hiveFetch } from "./platform-hive-nodes"
import { requireUserId } from "./iris-api"

export type MailVia = "auto" | "local" | "hive"

/**
 * A reason to use the Hive node, or null to stay on this machine.
 *
 * Only "this machine has no Apple Mail at all" falls back. A permission refusal on a Mac that
 * HAS Mail stays local: the fix (grant Full Disk Access) is here, and quietly answering from
 * another machine would bury it — and could answer from a different mailbox than the one the
 * user is looking at.
 */
export function hiveReason(a: { platform: string; via: MailVia; localError?: string }): string | null {
  if (a.via === "local") return null
  if (a.via === "hive") return "--via hive"
  if (a.platform !== "darwin") return `this machine is not a Mac (${a.platform})`
  const err = String(a.localError ?? "")
  if (/Envelope Index not found|macOS-only|only available on macOS/i.test(err)) return "Apple Mail is not set up on this Mac"
  return null
}

export type RemoteResult = { ok: true; data: any; nodeId?: string } | { ok: false; error: string; code?: string }

/** Read a bridge-call response. Every failure is NAMED — an unreachable Mac must never read as an empty inbox. */
export function remoteResult(status: number, body: any): RemoteResult {
  const code = body?.reason_code as string | undefined
  if (status >= 200 && status < 300 && body?.success) {
    let data = body.data
    if (data == null && typeof body.output === "string") {
      // Daemons before the structured `data` field returned JSON inside a string.
      try {
        data = JSON.parse(body.output)
      } catch {
        data = null
      }
    }
    if (data == null) return { ok: false, error: "the node answered without any data — treat as unread, not as empty", code: "no_data" }
    return { ok: true, data, nodeId: body.node_id }
  }
  const raw = String(body?.error ?? body?.message ?? `HTTP ${status}`)
  if (code === "no_node_online") return { ok: false, code, error: `no Mac with Apple Mail is online (${raw}) — check: iris hive nodes list` }
  if (code === "provider_unavailable") return { ok: false, code, error: `the Hive node cannot read Apple Mail right now: ${raw}` }
  if (code === "unknown_function") return { ok: false, code, error: `${raw} — the API or the Mac's daemon predates this; update them` }
  if (code === "timeout") return { ok: false, code, error: raw }
  return { ok: false, code, error: raw }
}

/** Call an apple_mail function on whichever online Hive node has it. */
export async function hiveMailCall(fn: string, args: Record<string, unknown>): Promise<RemoteResult> {
  const userId = await requireUserId(undefined)
  if (!userId) return { ok: false, error: "not signed in — run: iris login" }
  try {
    const res = await hiveFetch(`/api/v6/nodes/bridge-call`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userId, provider: "apple_mail", function: fn, args }),
    })
    const body = await res.json().catch(() => ({}))
    return remoteResult(res.status, body)
  } catch (e: any) {
    return { ok: false, error: `could not reach the IRIS API: ${e?.message ?? e}` }
  }
}

/** Which Hive node would serve a bridge provider, without calling it. null = could not check. */
export async function bridgeReach(provider: string): Promise<{ state: string; node_name?: string; reason?: string } | null> {
  try {
    const userId = await requireUserId(undefined)
    if (!userId) return null
    const res = await hiveFetch(`/api/v6/nodes/bridge-reach?user_id=${userId}&provider=${encodeURIComponent(provider)}`, {
      signal: AbortSignal.timeout(4000),
    })
    if (!res.ok) return null
    const body = (await res.json().catch(() => null)) as any
    return body?.providers?.[provider] ?? null
  } catch {
    return null
  }
}

type Row = { id?: number; sender?: string; subject?: string; date?: string; mailbox?: string }

/**
 * One message, one row. Gmail files every message in All Mail AND its label, so the index
 * returns it twice; keep the copy that is not All Mail, because that is the one a person
 * means by "my inbox" and the one a reply should come from.
 */
export function dedupeInbox<T extends Row>(rows: T[]): T[] {
  const byKey = new Map<string, T>()
  const order: string[] = []
  for (const r of rows) {
    const key = `${String(r.sender ?? "").toLowerCase()}|${r.subject ?? ""}|${r.date ?? ""}`
    const prev = byKey.get(key)
    if (!prev) {
      byKey.set(key, r)
      order.push(key)
    } else if (/All%20Mail|All Mail/i.test(String(prev.mailbox ?? "")) && !/All%20Mail|All Mail/i.test(String(r.mailbox ?? ""))) {
      byKey.set(key, r)
    }
  }
  return order.map((k) => byKey.get(k)!)
}
