import { existsSync, readFileSync } from "fs"
import { homedir } from "os"
import { join } from "path"

/**
 * Room membership for machines (epic #503 list #1688, S1 of item #185277).
 *
 * WHY A NODE JOINS AS AN "AGENT" AND NOT A NEW PARTICIPANT TYPE.
 * `agent_thread_participants` has exactly two types, `user` and `agent`, and `agent_id` is a
 * free string — `AgentThread::addAgent()` writes `participant_type = agent` whatever you give
 * it. Adding a `node` type would mean a migration plus every consumer that switches on the
 * type, for no behaviour the free string does not already carry. GAP #7 on that epic already
 * records `compute_nodes.agent_ids ↔ room participant agent_id` as a derivable link, so the
 * seam was meant for this.
 *
 * Measured against the live API 2026-09-14 before writing any of this: posting
 * `{agent_id:"node:<uuid>", role:"observer"}` to `/api/threads/{id}/agents` returned 200 and the
 * participant appears in the thread; removing it with the id URL-encoded returned 200 and it is
 * gone. No schema change, no external-agent credentials.
 *
 * THE PREFIX IS LOAD-BEARING. A bloq agent's id is an integer rendered as a string ("243"), so a
 * bare node UUID would sit in the same field with nothing distinguishing it. `node:` makes the
 * kind readable at a glance and greppable, and keeps the two id spaces from colliding.
 */
export const NODE_PREFIX = "node:"

/** The participant id for a machine. */
export function nodeParticipantId(nodeId: string): string {
  const id = (nodeId ?? "").trim()
  if (!id) throw new Error("nodeParticipantId: empty node id")
  return id.startsWith(NODE_PREFIX) ? id : `${NODE_PREFIX}${id}`
}

/** Is this participant a machine rather than a bloq agent? */
export function isNodeParticipant(agentId: string | null | undefined): boolean {
  return typeof agentId === "string" && agentId.startsWith(NODE_PREFIX)
}

/** The bare node id, for display and for resolving back to a node. */
export function nodeIdFromParticipant(agentId: string): string {
  return agentId.startsWith(NODE_PREFIX) ? agentId.slice(NODE_PREFIX.length) : agentId
}

/**
 * Path segment for a participant id.
 *
 * `node:` contains a COLON, and removal puts the id in a URL path. Unencoded it is at best a
 * different path and at worst a silent 404 that reads as "that participant was not in the room".
 * Verified against the live API: the encoded form deletes, and the participant disappears.
 */
export function participantPathSegment(agentId: string): string {
  return encodeURIComponent(agentId)
}

/** Roles the API accepts. Anything else is a 422 that surfaces as a validation blob. */
export const ROLES = ["primary", "support", "observer", "participant"] as const
export type Role = (typeof ROLES)[number]

export function isValidRole(role: string): role is Role {
  return (ROLES as readonly string[]).includes(role)
}

/** This machine's node id, as the daemon recorded it. */
export function localNodeId(configPath = join(homedir(), ".iris", "config.json")): string | null {
  try {
    if (!existsSync(configPath)) return null
    const cfg = JSON.parse(readFileSync(configPath, "utf-8"))
    const id = cfg?.node_id
    return typeof id === "string" && id.trim() ? id.trim() : null
  } catch {
    return null
  }
}

/**
 * Turn the selector flags into one participant id.
 *
 * EXACTLY ONE SELECTOR. Two would mean guessing which room the caller meant to change, and
 * membership changes are not obviously reversible to someone watching a room — the wrong machine
 * silently joins and starts receiving messages. Refuse instead.
 */
export function resolveParticipant(input: {
  agent?: string | null
  node?: string | null
  thisNode?: boolean
  localNode?: () => string | null
}): { id: string } | { error: string } {
  const picked = [
    input.agent ? "--agent" : null,
    input.node ? "--node" : null,
    input.thisNode ? "--this-node" : null,
  ].filter(Boolean) as string[]

  if (picked.length === 0) {
    return { error: "Name who is joining: --agent <id>, --node <id>, or --this-node." }
  }
  if (picked.length > 1) {
    return { error: `Pick one of ${picked.join(", ")} — not several.` }
  }

  if (input.agent) return { id: String(input.agent).trim() }
  if (input.node) return { id: nodeParticipantId(String(input.node)) }

  const local = (input.localNode ?? localNodeId)()
  if (!local) {
    return {
      error:
        "This machine has no node id yet (~/.iris/config.json has no node_id). Enrol it with `iris hive connect`, or pass --node <id>.",
    }
  }
  return { id: nodeParticipantId(local) }
}
