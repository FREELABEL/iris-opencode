/**
 * Shared workspaces for Desktop (#194307): rooms filed under an Atlas project, which every member of
 * that project can watch, type into and (owners, or whoever sent the turn) stop — the live chats
 * someone shared from their own computer.
 *
 * Same store as `rooms.ts` (iris-api `agent_threads`); this module reads the parts that matter when
 * the room is SHARED: its project, whose it is, what the caller may do, which sessions it delivers
 * to and whether the computers running them are on. Every reader tolerates a server that predates
 * those fields (#456): a missing right reads as "not allowed", so the UI never offers what the
 * server would refuse.
 *
 * Rooms live on iris-api (IRIS_API). A call to the wrong host 404s, and a 404 on a room reads as
 * "no such room", so every call names its base.
 */
import { IRIS_API, irisFetch } from "./platform"

export type Rights = { role: string | null; canPost: boolean; canStop: boolean; isOwner: boolean }
export type SharedRoom = {
  id: string
  name: string
  project: { id: number; name: string } | null
  ownerName: string | null
  you: Rights
  sessionIds: string[]
  messageCount?: number
  updatedAt?: string
}
export type SharedMessage = {
  id: string
  kind: "person" | "agent" | "event"
  senderId: string
  senderName: string
  text: string
  at: string
  deliveredTo: string[]
}
export type SessionState = { sessionId: string; provider: string | null; machine: string | null; online: boolean; lastSeen: string | null }
export type TranscriptEntry = { role: "user" | "assistant"; kind: "text" | "tool"; text: string; tool: string | null; detail: string | null; at: string }
export type SayResult = { outcome: "delivered" | "parked" | "held" | "saved"; delivered: number; note: string | null; agentsNote: string | null }

const str = (v: unknown) => (v === null || v === undefined ? "" : String(v))
const SESSION = "session:"

export function readSharedRoom(t: any): SharedRoom {
  const bloq = t?.bloq_id === null || t?.bloq_id === undefined ? null : Number(t.bloq_id)
  const project =
    t?.project && typeof t.project === "object" && t.project.id
      ? { id: Number(t.project.id), name: str(t.project.name) || "Project" }
      : bloq
        ? { id: bloq, name: "Project" }
        : null
  const you = t?.you && typeof t.you === "object" ? t.you : {}
  return {
    id: str(t?.id),
    name: str(t?.name) || "Untitled room",
    project,
    ownerName: t?.owner_name ? str(t.owner_name) : null,
    you: { role: you.role ? str(you.role) : null, canPost: you.can_post === true, canStop: you.can_stop === true, isOwner: you.is_owner === true },
    sessionIds: (Array.isArray(t?.participants) ? t.participants : [])
      .map((p: any) => str(p?.agent_id))
      .filter((a: string) => a.startsWith(SESSION))
      .map((a: string) => a.slice(SESSION.length)),
    ...(typeof t?.messages_count === "number" ? { messageCount: t.messages_count } : {}),
    ...(t?.updated_at ? { updatedAt: str(t.updated_at) } : {}),
  }
}

export const isShared = (r: SharedRoom) => r.project !== null

export function readSharedMessage(m: any): SharedMessage {
  const meta = m?.metadata && typeof m.metadata === "object" ? m.metadata : {}
  const kind = m?.sender_type === "system" ? "event" : m?.sender_type === "agent" ? "agent" : "person"
  return {
    id: str(m?.id),
    kind,
    senderId: str(m?.sender_id),
    // A room event is IRIS speaking — older servers labelled it "User".
    senderName: kind === "event" ? "IRIS" : str(m?.sender_name) || (kind === "agent" ? "Agent" : "Someone"),
    text: str(m?.content),
    at: str(m?.created_at),
    deliveredTo: Array.isArray(meta.delivered_to) ? meta.delivered_to.map(str) : [],
  }
}

export function readSessionState(s: any): SessionState {
  return {
    sessionId: str(s?.session_id),
    provider: s?.provider ? str(s.provider) : null,
    machine: s?.machine ? str(s.machine) : null,
    online: s?.online === true,
    lastSeen: s?.last_seen ? str(s.last_seen) : null,
  }
}

export function readSayResult(j: any): SayResult {
  const d: any[] = Array.isArray(j?.node_deliveries) ? j.node_deliveries : []
  const note = j?.delivery_note ? str(j.delivery_note) : null
  const agentsNote = j?.agents_note ? str(j.agents_note) : null
  if (j?.delivery_held) return { outcome: "held", delivered: 0, note, agentsNote }
  if (d.some((x) => x?.parked)) return { outcome: "parked", delivered: 0, note, agentsNote }
  return { outcome: d.length ? "delivered" : "saved", delivered: d.length, note, agentsNote }
}

function failure(j: any, status: number): string {
  if (status === 401) return "not signed in to IRIS — run `iris auth login`"
  if (status === 404) return "That room is not shared with you anymore."
  const msg = j?.message ?? j?.error
  return msg ? str(msg) : `IRIS answered ${status}`
}

type Read<T> = { measured: boolean; reason?: string; data: T }

async function call(path: string, init?: RequestInit): Promise<{ ok: boolean; status: number; j: any }> {
  const res = await irisFetch(path, IRIS_API, init)
  const j = (await res.json().catch(() => ({}))) as any
  return { ok: res.ok, status: res.status, j }
}

/** Every room shared with the caller (own rooms filed under a project, and teammates'). */
export async function fetchSharedRooms(): Promise<Read<{ rooms: SharedRoom[] }>> {
  try {
    const r = await call(`/api/threads?per_page=100`)
    if (!r.ok) return { measured: false, reason: failure(r.j, r.status), data: { rooms: [] } }
    const rows: any[] = Array.isArray(r.j?.data) ? r.j.data : []
    return { measured: true, data: { rooms: rows.map(readSharedRoom).filter(isShared) } }
  } catch (e) {
    return { measured: false, reason: e instanceof Error ? e.message : String(e), data: { rooms: [] } }
  }
}

export async function fetchSharedRoom(
  id: string,
): Promise<Read<{ room: SharedRoom | null; messages: SharedMessage[]; sessions: SessionState[] }>> {
  const empty = { room: null, messages: [], sessions: [] }
  try {
    const r = await call(`/api/threads/${encodeURIComponent(id)}`)
    if (!r.ok) return { measured: false, reason: failure(r.j, r.status), data: empty }
    // The room's facts ride at the top level of this response (project, owner_name, you).
    const room = r.j?.thread ? readSharedRoom({ ...r.j.thread, project: r.j.project, owner_name: r.j.owner_name, you: r.j.you }) : null
    const messages = (Array.isArray(r.j?.messages) ? r.j.messages : [])
      .map(readSharedMessage)
      .sort((a: SharedMessage, b: SharedMessage) => (a.at === b.at ? (a.id < b.id ? -1 : 1) : a.at < b.at ? -1 : 1))
    const sessions = (Array.isArray(r.j?.sessions) ? r.j.sessions : []).map(readSessionState)
    return { measured: true, data: { room, messages, sessions } }
  } catch (e) {
    return { measured: false, reason: e instanceof Error ? e.message : String(e), data: empty }
  }
}

/** Type into a shared room — it reaches the room's live session(s), labelled with the sender. */
export async function sayInRoom(id: string, text: string): Promise<{ ok: boolean; reason?: string; result?: SayResult }> {
  const t = text.trim()
  if (!t) return { ok: false, reason: "Nothing to send." }
  try {
    const r = await call(`/api/threads/${encodeURIComponent(id)}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: t, trigger_responses: false }),
    })
    if (!r.ok) return { ok: false, reason: failure(r.j, r.status) }
    return { ok: true, result: readSayResult(r.j) }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
}

export async function stopRoom(id: string): Promise<{ ok: boolean; reason?: string; message?: string }> {
  try {
    const r = await call(`/api/threads/${encodeURIComponent(id)}/stop`, { method: "POST", body: "{}" })
    if (!r.ok) return { ok: false, reason: failure(r.j, r.status) }
    return { ok: true, message: str(r.j?.message) }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
}

/** Share one of this computer's chats with a project: a room around the session, filed under it. */
export async function shareSession(input: {
  sessionId: string
  projectId: number
  name: string
}): Promise<{ ok: boolean; reason?: string; roomId?: string }> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.sessionId)) return { ok: false, reason: "That chat cannot be shared." }
  try {
    const c = await call(`/api/threads`, {
      method: "POST",
      body: JSON.stringify({
        name: input.name || "Shared chat",
        agent_ids: [`${SESSION}${input.sessionId}`],
        agent_roles: ["participant"],
        auto_respond: [true],
      }),
    })
    if (!c.ok) return { ok: false, reason: failure(c.j, c.status) }
    const roomId = str(c.j?.thread?.id)
    const f = await call(`/api/threads/${encodeURIComponent(roomId)}/workspace`, {
      method: "PUT",
      body: JSON.stringify({ bloq_id: input.projectId }),
    })
    if (!f.ok) return { ok: false, reason: failure(f.j, f.status), roomId }
    return { ok: true, roomId }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
}

export async function unshareRoom(id: string): Promise<{ ok: boolean; reason?: string }> {
  try {
    const r = await call(`/api/threads/${encodeURIComponent(id)}/workspace`, { method: "PUT", body: JSON.stringify({ bloq_id: null }) })
    return r.ok ? { ok: true } : { ok: false, reason: failure(r.j, r.status) }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
}

export function readTranscriptEntry(m: any): TranscriptEntry {
  const tool = m?.type === "tool_use"
  return {
    role: m?.role === "user" ? "user" : "assistant",
    kind: tool ? "tool" : "text",
    text: tool ? "" : str(m?.text),
    tool: tool ? str(m?.tool) || "tool" : null,
    detail: tool ? (m?.file_path ? str(m.file_path) : m?.command ? str(m.command) : m?.pattern ? str(m.pattern) : null) : null,
    at: m?.timestamp ? str(m.timestamp) : "",
  }
}

/**
 * The live chat of a session the room shares — what the agent is saying, read from the machine
 * that runs it (through the room owner's reach, #194307). `since` is the byte cursor a previous
 * read returned; with it only what was appended comes back.
 */
export async function fetchSharedTranscript(
  roomId: string,
  sessionId: string,
  since?: number,
): Promise<Read<{ entries: TranscriptEntry[]; offset: number | null; incremental: boolean; reset: boolean; ranOn: string | null }>> {
  const empty = { entries: [], offset: null, incremental: false, reset: false, ranOn: null }
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) return { measured: false, reason: "not a chat id", data: empty }
  try {
    const q = new URLSearchParams({ limit: "60" })
    if (typeof since === "number" && since >= 0) q.set("since", String(since))
    const r = await call(`/api/threads/${encodeURIComponent(roomId)}/sessions/${sessionId}/transcript?${q}`)
    if (!r.ok) return { measured: false, reason: failure(r.j, r.status), data: empty }
    if (r.j?.success === false) return { measured: false, reason: str(r.j?.error) || "the computer did not answer", data: empty }
    return {
      measured: true,
      data: {
        entries: (Array.isArray(r.j?.messages) ? r.j.messages : []).map(readTranscriptEntry),
        offset: typeof r.j?.offset === "number" ? r.j.offset : null,
        incremental: r.j?.incremental === true,
        reset: r.j?.reset === true,
        ranOn: r.j?.ran_on ? str(r.j.ran_on) : null,
      },
    }
  } catch (e) {
    return { measured: false, reason: e instanceof Error ? e.message : String(e), data: empty }
  }
}
