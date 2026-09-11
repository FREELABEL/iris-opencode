import { hiveFetch, fetchNodes, resolveNode } from "./platform-hive-nodes"
import { existsSync, readFileSync } from "fs"
import { join } from "path"
import { homedir, hostname } from "os"

// ============================================================================
// Reaching a node that may belong to someone else (epic #184516)
//
// `iris hive send` and `iris msg send` resolve their target from YOUR node list, so they could
// never reach a peer's machine. The only thing that crosses accounts is the relay on an active
// HiveConnection, which creates the task under the PEER's user. This module is the one place that
// knows the difference: own node → direct task; peer node → relay `message` action. Everything
// that delivers into an inbox (send, inbox send, handoff) goes through deliverToInbox().
// ============================================================================

export interface ReachableNode {
  id: string
  name: string
  connection_status?: string
}

export type ResolvedTarget =
  | { kind: "own"; node: ReachableNode }
  | { kind: "peer"; node: ReachableNode; connectionId: string; peerName: string }

/**
 * The name this machine registered as — what the recipient sees in "From".
 *
 * ~/.iris/config.json stores `node_id`, NOT a name (measured: its keys are api_url,
 * default_bloq_id, node_api_key, node_id, user_id). Reading `node_name` therefore always missed
 * and every message arrived as "From: Unknown" — the bug `iris hive send` has carried since it
 * shipped. So: use a name if the config ever grows one, otherwise resolve node_id against the
 * node list, and fall back to the hostname. Never "Unknown" — a recipient has to be able to tell
 * who sent it, and the machine always has a name of some kind.
 */
export async function senderNodeName(userId?: number): Promise<string> {
  try {
    const p = join(homedir(), ".iris", "config.json")
    if (existsSync(p)) {
      const c = JSON.parse(readFileSync(p, "utf-8"))
      if (c.node_name || c.name) return String(c.node_name || c.name)
      if (c.node_id && userId) {
        const me = (await fetchNodes(userId)).find((n) => n.id === c.node_id)
        if (me?.name) return me.name
      }
    }
  } catch { /* fall through to hostname */ }
  return hostname().replace(/\.local$/, "")
}

/** Inbox TTL — the daemon skips deliveries past expires_at. 7 days, matching `hive send` text. */
export function inboxExpiresAt(days = 7): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString()
}

/**
 * Your own node first (exact id, then name, then prefix). Failing that, every node a peer has put
 * online behind an ACTIVE connection with you. A miss on both is null — never a guess.
 */
export async function resolveOwnOrPeerNode(userId: number, target: string): Promise<ResolvedTarget | null> {
  const own = await resolveNode(userId, target)
  if (own) return { kind: "own", node: { id: own.id, name: own.name, connection_status: own.connection_status } }

  const t = target.toLowerCase()
  const res = await hiveFetch(`/api/v6/nodes/connections?user_id=${userId}`)
  if (!res.ok) return null
  const { connections = [] } = (await res.json()) as {
    connections?: Array<{ id: string; status: string; peer_name?: string | null }>
  }

  for (const c of connections.filter((c) => c.status === "active")) {
    const r = await hiveFetch(`/api/v6/nodes/connections/${c.id}/nodes?user_id=${userId}`)
    if (!r.ok) continue
    const { nodes = [] } = (await r.json()) as { nodes?: ReachableNode[] }
    const hit =
      nodes.find((n) => n.id === target) ??
      nodes.find((n) => n.name.toLowerCase() === t) ??
      nodes.find((n) => n.name.toLowerCase().startsWith(t))
    if (hit) return { kind: "peer", node: hit, connectionId: c.id, peerName: c.peer_name ?? "peer" }
  }

  return null
}

export interface InboxDelivery {
  text: string
  inboxType: "message" | "handoff"
  handoff?: Record<string, unknown>
}

/**
 * Deliver into a target's hive inbox. Own node → a type=message task with the daemon's inbox
 * contract (hive_inbox / inbox_type / expires_at). Peer node → the relay's `message` action,
 * which sets that same contract server-side under the peer's user. One inbox, two doors.
 */
export async function deliverToInbox(
  userId: number,
  target: ResolvedTarget,
  d: InboxDelivery,
): Promise<{ ok: boolean; taskId?: string; error?: string }> {
  const sender = await senderNodeName(userId)
  const json = (body: unknown): RequestInit => ({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })

  if (target.kind === "own") {
    const res = await hiveFetch(`/api/v6/nodes/tasks`, json({
      user_id: userId,
      type: "message",
      node_id: target.node.id,
      title: `${d.inboxType === "handoff" ? "Handoff" : "Message"} from ${sender}`,
      prompt: d.text,
      config: {
        sender_name: sender,
        hive_inbox: true,
        inbox_type: d.inboxType,
        expires_at: inboxExpiresAt(),
        ...(d.handoff ? { handoff: d.handoff } : {}),
      },
      timeout_seconds: 30,
      priority: 10,
    }))
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    const data = (await res.json()) as { task?: { id: string } }
    return { ok: true, taskId: data.task?.id }
  }

  const res = await hiveFetch(`/api/v6/nodes/connections/${target.connectionId}/relay`, json({
    node_id: target.node.id,
    action: "message",
    async: true,
    params: {
      message: d.text,
      sender_name: sender,
      ...(d.handoff ? { handoff: d.handoff } : {}),
    },
  }))
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    return { ok: false, error: `HTTP ${res.status}${body ? ` — ${body.slice(0, 160)}` : ""}` }
  }
  const data = (await res.json()) as { task_id?: string }
  return { ok: true, taskId: data.task_id }
}
