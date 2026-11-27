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
import { FL_API, IRIS_API, irisFetch } from "./platform"

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
  /** What a list row shows (#194490): absent from a server that predates it. */
  activity?: RoomActivity
}
/** The latest line in a room: a person (or IRIS) in the room, or what an agent just said or did. */
export type LastLine =
  | { kind: "person" | "event"; name: string; isYou: boolean; text: string; at: string }
  | { kind: "agent"; hostUserId: number | null; hostName: string | null; provider: string | null; isYou: boolean; text: string; tool: string | null; detail: string | null; at: string }
export type RoomActivity = {
  present: { userId: number; name: string; state: "active" | "background"; typing: boolean }[]
  last: LastLine | null
  unread: number
  working: boolean
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
export type SessionState = {
  sessionId: string
  provider: string | null
  machine: string | null
  online: boolean
  lastSeen: string | null
  /** Whose computer runs it (#194466) — "Flo's Codex". Null from a server that predates it. */
  hostUserId: number | null
  hostName: string | null
}
/** One of the platform's cloud agents in the room (#194496): its own model and instructions. */
export type CloudAgent = { id: string; name: string; model: string | null; role: string; autoRespond: boolean }
/** Agents handing work to each other right now (#194495). */
export type Chain = { depth: number; turns: number; maxTurns: number; maxHops: number }
/** Someone in the room right now (#194465). */
export type Presence = { userId: number; name: string; state: "active" | "background"; typing: boolean }
export type TranscriptEntry = { role: "user" | "assistant"; kind: "text" | "tool"; text: string; tool: string | null; detail: string | null; at: string }
export type SayResult = {
  outcome: "delivered" | "parked" | "held" | "saved"
  delivered: number
  note: string | null
  agentsNote: string | null
  /** How many of the room's cloud agents answered in the first round (#194496). */
  agentsAnswered?: number
}

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
    ...(t?.activity && typeof t.activity === "object" ? { activity: readActivity(t.activity) } : {}),
  }
}

export function readActivity(a: any): RoomActivity {
  const l = a?.last && typeof a.last === "object" ? a.last : null
  let last: LastLine | null = null
  if (l && l.kind === "agent")
    last = {
      kind: "agent",
      hostUserId: typeof l.host_user_id === "number" ? l.host_user_id : null,
      hostName: l.host_name ? str(l.host_name) : null,
      provider: l.provider ? str(l.provider) : null,
      isYou: l.is_you === true,
      text: str(l.text),
      tool: l.tool ? str(l.tool) : null,
      detail: l.detail ? str(l.detail) : null,
      at: str(l.at),
    }
  else if (l) last = { kind: l.kind === "event" ? "event" : "person", name: str(l.name) || "Someone", isYou: l.is_you === true, text: str(l.text), at: str(l.at) }
  return {
    present: (Array.isArray(a?.present) ? a.present : []).map((p: any) => ({
      userId: Number(p?.user_id) || 0,
      name: str(p?.name) || "Someone",
      state: p?.state === "background" ? ("background" as const) : ("active" as const),
      typing: p?.typing === true,
    })),
    last,
    unread: Math.max(0, Number(a?.unread) || 0),
    working: a?.working === true,
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
    hostUserId: typeof s?.host_user_id === "number" ? s.host_user_id : null,
    hostName: s?.host_name ? str(s.host_name) : null,
  }
}

export function readPresence(p: any): Presence {
  return {
    userId: Number(p?.user_id) || 0,
    name: str(p?.name) || "Someone",
    state: p?.state === "background" ? "background" : "active",
    typing: p?.typing === true,
  }
}

export function readSayResult(j: any): SayResult {
  const d: any[] = Array.isArray(j?.node_deliveries) ? j.node_deliveries : []
  const note = j?.delivery_note ? str(j.delivery_note) : null
  const agentsNote = j?.agents_note ? str(j.agents_note) : null
  const agentsAnswered = Number(j?.response_count) || 0
  if (j?.delivery_held) return { outcome: "held", delivered: 0, note, agentsNote, agentsAnswered }
  if (d.some((x) => x?.parked)) return { outcome: "parked", delivered: 0, note, agentsNote, agentsAnswered }
  return { outcome: d.length ? "delivered" : "saved", delivered: d.length, note, agentsNote, agentsAnswered }
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
): Promise<Read<{ room: SharedRoom | null; messages: SharedMessage[]; sessions: SessionState[]; present: Presence[]; agents: CloudAgent[]; chain: Chain | null }>> {
  const empty = { room: null, messages: [], sessions: [], present: [], agents: [], chain: null }
  try {
    const r = await call(`/api/threads/${encodeURIComponent(id)}`)
    if (!r.ok) return { measured: false, reason: failure(r.j, r.status), data: empty }
    // The room's facts ride at the top level of this response (project, owner_name, you).
    const room = r.j?.thread ? readSharedRoom({ ...r.j.thread, project: r.j.project, owner_name: r.j.owner_name, you: r.j.you }) : null
    const messages = (Array.isArray(r.j?.messages) ? r.j.messages : [])
      .map(readSharedMessage)
      .sort((a: SharedMessage, b: SharedMessage) => (a.at === b.at ? (a.id < b.id ? -1 : 1) : a.at < b.at ? -1 : 1))
    const sessions = (Array.isArray(r.j?.sessions) ? r.j.sessions : []).map(readSessionState)
    const present = (Array.isArray(r.j?.present) ? r.j.present : []).map(readPresence)
    const agents = (Array.isArray(r.j?.thread?.agents) ? r.j.thread.agents : []).map(readCloudAgent)
    return { measured: true, data: { room, messages, sessions, present, agents, chain: readChain(r.j?.chain) } }
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
      // The room's cloud agents answer the owner's message (#194496). A member's message never
      // starts them — the server refuses that (they run on the owner's bill) and says so.
      body: JSON.stringify({ content: t, trigger_responses: true }),
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

// ─────────────────────────────────────────────────────────────────────────────
// Join a workspace from an invite link (#194307)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The token out of whatever was pasted: a full invite link (`…/invite/<token>`), a link with a
 * query or trailing slash, or the bare token. Null when it is not shaped like one.
 */
export function parseInviteToken(input: string | null | undefined): string | null {
  const s = String(input ?? "").trim()
  if (!s) return null
  const m = /\/invite\/([A-Za-z0-9_-]{8,128})(?:[/?#]|$)/.exec(s)
  if (m) return m[1]
  return /^[A-Za-z0-9_-]{8,128}$/.test(s) ? s : null
}

export type InvitePreview = { projectId: number; projectName: string; ownerName: string | null; role: string | null }
export type JoinResult = {
  ok: boolean
  reason?: string
  /** "joined" — you are in now · "member" — you already were · "check_email" — the server wants
   * you to confirm by email first (it could not tell this app is signed in as you). */
  outcome?: "joined" | "member" | "check_email"
  projectId?: number
  projectName?: string
}

/** Plain words for the ways an invite can be refused. */
export function inviteTrouble(status: number, j: any): string {
  if (status === 404) return "That invite link is not valid. Ask for a new one."
  if (status === 410) return "That invite has expired or has been used up. Ask for a new one."
  if (status === 403) return "That invite was made for a different email address."
  if (status === 400 && /own share link/i.test(str(j?.error))) return "That is your own project's invite — you are already in it."
  if (status === 429) return "Too many tries. Wait a minute and try again."
  return str(j?.error) || `The invite did not go through (${status}).`
}

/** What the invite is for, before joining. fl-api, public route. */
export async function previewInvite(token: string): Promise<Read<InvitePreview | null>> {
  try {
    const res = await irisFetch(`/api/v1/bloq/share-link/${encodeURIComponent(token)}`, FL_API, {}, null)
    const j = (await res.json().catch(() => ({}))) as any
    if (!res.ok || j?.success === false) return { measured: false, reason: inviteTrouble(res.status, j), data: null }
    const d = j?.data ?? {}
    return {
      measured: true,
      data: { projectId: Number(d.bloq_id), projectName: str(d.bloq_name) || "a project", ownerName: d.owner_name ? str(d.owner_name) : null, role: d.permission ? str(d.permission) : null },
    }
  } catch (e) {
    return { measured: false, reason: e instanceof Error ? e.message : String(e), data: null }
  }
}

/**
 * Join as the person signed in to this app. fl-api grants the invite to an EXISTING account only
 * when the caller proves it is that account (its own sign-in on the request), so this sends the
 * account's own email with its own key — never an email typed by someone.
 */
export async function joinInvite(token: string): Promise<JoinResult> {
  try {
    let email: string | null = null
    for (const ep of ["/api/user", "/api/v1/me"]) {
      const r = await irisFetch(ep, FL_API)
      if (!r.ok) continue
      const j = (await r.json().catch(() => ({}))) as any
      const e = j?.data?.email ?? j?.email
      if (typeof e === "string" && e.includes("@")) {
        email = e
        break
      }
    }
    if (!email) return { ok: false, reason: "Sign in to IRIS first, then try the invite again." }
    const res = await irisFetch(`/api/v1/bloq/share-link/${encodeURIComponent(token)}/redeem`, FL_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    })
    const j = (await res.json().catch(() => ({}))) as any
    const d = j?.data ?? {}
    const project = { projectId: d.bloq_id != null ? Number(d.bloq_id) : undefined, projectName: d.bloq_name ? str(d.bloq_name) : undefined }
    if (j?.success === true) {
      // The server could not tie this request to the account (it mails a sign-in link instead).
      if (d.requires_sign_in) return { ok: true, outcome: "check_email", ...project }
      if (d.already_member || res.status === 409) return { ok: true, outcome: "member", ...project }
      if (res.ok) return { ok: true, outcome: "joined", ...project }
    }
    return { ok: false, reason: inviteTrouble(res.status, j) }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Multiplayer (#194465, #194466): who is here, and bringing your own agent in
// ─────────────────────────────────────────────────────────────────────────────

/** "I am here" — and who else is. A server that predates presence answers 404/405: no one shown. */
export async function checkInToRoom(
  id: string,
  state: "active" | "background",
  typing: boolean,
): Promise<Read<Presence[]>> {
  try {
    const r = await call(`/api/threads/${encodeURIComponent(id)}/presence`, { method: "POST", body: JSON.stringify({ state, typing }) })
    if (!r.ok) return { measured: false, reason: failure(r.j, r.status), data: [] }
    return { measured: true, data: (Array.isArray(r.j?.present) ? r.j.present : []).map(readPresence) }
  } catch (e) {
    return { measured: false, reason: e instanceof Error ? e.message : String(e), data: [] }
  }
}

/** Bring a chat from one of YOUR computers into the room, next to everyone else's agents. */
export async function addSessionToRoom(id: string, sessionId: string): Promise<{ ok: boolean; reason?: string }> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) return { ok: false, reason: "That chat cannot be added." }
  try {
    const r = await call(`/api/threads/${encodeURIComponent(id)}/sessions`, { method: "POST", body: JSON.stringify({ session_id: sessionId }) })
    return r.ok ? { ok: true } : { ok: false, reason: failure(r.j, r.status) }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
}

/** Take an agent out of the room. Its chat keeps running on its computer. */
export async function removeSessionFromRoom(id: string, sessionId: string): Promise<{ ok: boolean; reason?: string }> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) return { ok: false, reason: "Not a chat." }
  try {
    const r = await call(`/api/threads/${encodeURIComponent(id)}/sessions/${sessionId}`, { method: "DELETE" })
    return r.ok ? { ok: true } : { ok: false, reason: failure(r.j, r.status) }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Cloud agents in a room, and their hand-offs (#194493–#194496)
// ─────────────────────────────────────────────────────────────────────────────

export function readCloudAgent(a: any): CloudAgent {
  const cfg = a?.config && typeof a.config === "object" ? a.config : {}
  const set = a?.settings && typeof a.settings === "object" ? a.settings : {}
  const model = cfg.model ?? cfg.ai_model ?? set.model ?? set.ai_model ?? a?.model ?? null
  return {
    id: str(a?.id),
    name: str(a?.name) || `Agent ${str(a?.id)}`,
    model: model ? str(model) : null,
    role: str(a?.pivot?.role ?? a?.role) || "participant",
    autoRespond: Boolean(a?.pivot?.auto_respond ?? a?.auto_respond),
  }
}

export function readChain(c: any): Chain | null {
  if (!c || typeof c !== "object") return null
  return {
    depth: Number(c.depth) || 0,
    turns: Number(c.turns) || 0,
    maxTurns: Number(c.max_turns) || 6,
    maxHops: Number(c.max_hops) || 3,
  }
}

const ROLES = new Set(["lead", "participant", "observer", "support", "primary"])

/** Put one of your cloud agents in the room — as the lead, or answering everything / only @mentions. */
export async function addRoomAgent(id: string, input: { agentId: number; role?: string; autoRespond?: boolean }): Promise<{ ok: boolean; reason?: string }> {
  const role = input.role && ROLES.has(input.role) ? input.role : "participant"
  try {
    const r = await call(`/api/threads/${encodeURIComponent(id)}/agents`, {
      method: "POST",
      body: JSON.stringify({ agent_id: String(input.agentId), role, auto_respond: input.autoRespond === true }),
    })
    return r.ok ? { ok: true } : { ok: false, reason: failure(r.j, r.status) }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
}

/** Change an agent's role in the room, or whether it answers everything. */
export async function updateRoomAgent(id: string, agentId: string, input: { role?: string; autoRespond?: boolean }): Promise<{ ok: boolean; reason?: string }> {
  const body: Record<string, unknown> = {}
  if (input.role && ROLES.has(input.role)) body.role = input.role
  if (typeof input.autoRespond === "boolean") body.auto_respond = input.autoRespond
  try {
    const r = await call(`/api/threads/${encodeURIComponent(id)}/agents/${encodeURIComponent(agentId)}`, { method: "PATCH", body: JSON.stringify(body) })
    return r.ok ? { ok: true } : { ok: false, reason: failure(r.j, r.status) }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
}

export async function removeRoomAgent(id: string, agentId: string): Promise<{ ok: boolean; reason?: string }> {
  try {
    const r = await call(`/api/threads/${encodeURIComponent(id)}/agents/${encodeURIComponent(agentId)}`, { method: "DELETE" })
    return r.ok ? { ok: true } : { ok: false, reason: failure(r.j, r.status) }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
}
