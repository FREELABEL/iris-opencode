/**
 * Delegation lineage (#188667): a Hive task sent from inside an `iris` session reports back INTO
 * that session — a line when it starts running on the other machine, then its final report.
 *
 * The engine already ran the child; what was missing was any link from the task to the place
 * that sent it. You delegated from a conversation and then had to leave it for `iris hive board`
 * to learn what happened. T3 Code's "Lineage: 1 running" is the same idea (EVAL #188657).
 *
 * The link is `metadata.origin` on the task: which machine and which session sent it. The API
 * (DelegationLineage) turns each status change into a `session_message` task pinned back to the
 * origin machine, whose daemon drops it into the live session as a notification. No model turn
 * is spent and nothing has to stay open on this side — the CLI that sent it may have exited.
 *
 * Both halves are required, and both come from places that cannot be guessed:
 *   - session id: the bash tool exports IRIS_SESSION_ID to every command it runs. Outside an
 *     agent session there is nothing to report to, so no origin is sent.
 *   - node id: the RUNNING DAEMON's own /health. It is the daemon that delivers the report, so a
 *     machine without one could never receive it; config or hostname would name a node that
 *     cannot deliver, and every report would fail on arrival.
 */

/** Session ids from every provider are [A-Za-z0-9_-]; the daemon refuses anything else. */
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/

export interface DelegationOrigin {
  node_id: string
  session_id: string
  message_id?: string
  provider: "opencode"
}

export function delegationOrigin(input: {
  env: Record<string, string | undefined>
  daemonNodeId: string | null | undefined
}): DelegationOrigin | null {
  const session = String(input.env.IRIS_SESSION_ID ?? "").trim()
  const node = String(input.daemonNodeId ?? "").trim()
  if (!SESSION_ID.test(session) || !node) return null
  const origin: DelegationOrigin = { node_id: node, session_id: session, provider: "opencode" }
  const message = String(input.env.IRIS_MESSAGE_ID ?? "").trim()
  if (SESSION_ID.test(message)) origin.message_id = message
  return origin
}

/** The local daemon's node id, or null when no daemon answers. */
export async function readDaemonNodeId(bridgeUrl = process.env.IRIS_BRIDGE_URL ?? "http://localhost:3200"): Promise<string | null> {
  try {
    const res = await fetch(`${bridgeUrl}/health`, { signal: AbortSignal.timeout(1500) })
    if (!res.ok) return null
    const id = ((await res.json()) as { node_id?: unknown })?.node_id
    return typeof id === "string" && id ? id : null
  } catch {
    return null
  }
}

/** Resolve the origin for this process, or null when it was not run from an agent session. */
export async function currentDelegationOrigin(env: Record<string, string | undefined> = process.env): Promise<DelegationOrigin | null> {
  if (!env.IRIS_SESSION_ID) return null
  return delegationOrigin({ env, daemonNodeId: await readDaemonNodeId() })
}
