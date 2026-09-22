/**
 * Multi-agent rooms for the desktop side panel (#186511 — threaded chat with @mention).
 *
 * The backend already exists: iris-api `agent_threads` ("rooms"), the same ones `iris agents
 * thread` and Elon's AgentRooms read. Nothing here is a second store. What the panel adds is
 * addressing: an @mention names the agents a message is FOR, the server records its own
 * resolution of that as `metadata.addressees`, and each reply points at the message it answers
 * through `in_reply_to`.
 *
 * The zero-@mention default, stated once so the UI can repeat it: the room's always-on agents
 * answer; if there are none, its PRIMARY agent does. A room created here always has one — the
 * first agent picked — so an unaddressed message is never silently dropped.
 *
 * Rooms live on iris-api (IRIS_API), not fl-api. A call to the wrong host 404s, and a 404 on a
 * room reads as "no such room" — so every call here names its base explicitly.
 */
import { IRIS_API, irisFetch } from "./platform"

export type RoomAgent = { id: string; name: string; role: string; autoRespond: boolean }
export type Room = { id: string; name: string; agents: RoomAgent[]; messageCount?: number; updatedAt?: string }
export type RoomMessage = {
  id: string
  sender: "user" | "agent"
  senderId: string
  senderName: string
  text: string
  at: string
  /** The message this one answers — set by the server on every agent reply. */
  inReplyTo?: string
  /** Agent ids the SERVER resolved from @mentions. Empty = routed by the room default. */
  addressees: string[]
  routing?: "mention" | "room-default"
}

type Result<T> = { measured: boolean; reason?: string; data: T }

const str = (v: unknown) => (v === null || v === undefined ? "" : String(v))

export function readRoomAgent(a: any): RoomAgent {
  return {
    id: str(a?.id),
    name: str(a?.name) || `Agent ${str(a?.id)}`,
    role: str(a?.pivot?.role ?? a?.role) || "participant",
    autoRespond: Boolean(a?.pivot?.auto_respond ?? a?.auto_respond),
  }
}

export function readRoom(t: any): Room {
  return {
    id: str(t?.id),
    name: str(t?.name) || "Untitled room",
    agents: Array.isArray(t?.agents) ? t.agents.map(readRoomAgent) : [],
    messageCount: typeof t?.messages_count === "number" ? t.messages_count : undefined,
    updatedAt: t?.updated_at ? str(t.updated_at) : undefined,
  }
}

export function readRoomMessage(m: any): RoomMessage {
  const meta = m?.metadata && typeof m.metadata === "object" ? m.metadata : {}
  const routing = meta.routing === "mention" || meta.routing === "room-default" ? meta.routing : undefined
  return {
    id: str(m?.id),
    sender: m?.sender_type === "agent" ? "agent" : "user",
    senderId: str(m?.sender_id),
    senderName: str(m?.sender_name) || (m?.sender_type === "agent" ? "Agent" : "You"),
    text: str(m?.content),
    at: str(m?.created_at),
    inReplyTo: m?.in_reply_to ? str(m.in_reply_to) : meta.in_response_to ? str(meta.in_response_to) : undefined,
    addressees: Array.isArray(meta.addressees) ? meta.addressees.map(str) : [],
    routing,
  }
}

/**
 * Send order, stable. created_at is second-precision on the server and a question and its
 * replies land in the same second routinely; ids are UUIDv7 (time-ordered), so they break ties.
 */
export function sortRoomMessages(messages: RoomMessage[]): RoomMessage[] {
  return [...messages].sort((a, b) => (a.at === b.at ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.at < b.at ? -1 : 1))
}

function failure(j: any, status: number): string {
  const msg = j?.message ?? j?.error
  if (status === 401) return "not signed in to IRIS — run `iris auth login`"
  return msg ? `iris-api ${status}: ${msg}` : `iris-api ${status}`
}

export async function fetchRooms(): Promise<Result<{ rooms: Room[] }>> {
  try {
    const res = await irisFetch(`/api/threads`, IRIS_API)
    const j = (await res.json().catch(() => ({}))) as any
    if (!res.ok) return { measured: false, reason: failure(j, res.status), data: { rooms: [] } }
    const rows: any[] = Array.isArray(j?.data) ? j.data : Array.isArray(j) ? j : []
    return { measured: true, data: { rooms: rows.map(readRoom) } }
  } catch (e) {
    return { measured: false, reason: e instanceof Error ? e.message : String(e), data: { rooms: [] } }
  }
}

export async function fetchRoom(id: string): Promise<Result<{ room: Room | null; messages: RoomMessage[] }>> {
  try {
    const res = await irisFetch(`/api/threads/${encodeURIComponent(id)}`, IRIS_API)
    const j = (await res.json().catch(() => ({}))) as any
    if (!res.ok) return { measured: false, reason: failure(j, res.status), data: { room: null, messages: [] } }
    const messages = sortRoomMessages((Array.isArray(j?.messages) ? j.messages : []).map(readRoomMessage))
    return { measured: true, data: { room: j?.thread ? readRoom(j.thread) : null, messages } }
  } catch (e) {
    return { measured: false, reason: e instanceof Error ? e.message : String(e), data: { room: null, messages: [] } }
  }
}

/**
 * The first agent is the room's PRIMARY — that is what makes the zero-@mention default
 * ("the primary answers") true for every room made here. Nobody is always-on: in a room of
 * several agents, always-on means every message costs every agent a model call.
 */
export async function createRoom(input: {
  name: string
  agentIds: string[]
}): Promise<{ ok: boolean; reason?: string; room?: Room }> {
  if (!input.agentIds.length) return { ok: false, reason: "pick at least one agent" }
  try {
    const res = await irisFetch(`/api/threads`, IRIS_API, {
      method: "POST",
      body: JSON.stringify({
        name: input.name || "Room",
        agent_ids: input.agentIds,
        agent_roles: input.agentIds.map((_, i) => (i === 0 ? "primary" : "participant")),
        auto_respond: input.agentIds.map(() => false),
      }),
    })
    const j = (await res.json().catch(() => ({}))) as any
    if (!res.ok) return { ok: false, reason: failure(j, res.status) }
    return { ok: true, room: readRoom(j?.thread ?? j) }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * One turn. The server saves the message, resolves its addressees, and runs every responding
 * agent before it answers — so this waits N model calls for N addressees.
 */
export async function sendRoomMessage(
  id: string,
  text: string,
): Promise<{ ok: boolean; reason?: string; message?: RoomMessage; replies: RoomMessage[] }> {
  try {
    const res = await irisFetch(`/api/threads/${encodeURIComponent(id)}/messages`, IRIS_API, {
      method: "POST",
      body: JSON.stringify({ content: text }),
    })
    const j = (await res.json().catch(() => ({}))) as any
    if (!res.ok) return { ok: false, reason: failure(j, res.status), replies: [] }
    const replies = (Array.isArray(j?.agent_responses) ? j.agent_responses : []).map(readRoomMessage)
    return { ok: true, message: j?.message ? readRoomMessage(j.message) : undefined, replies }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e), replies: [] }
  }
}
