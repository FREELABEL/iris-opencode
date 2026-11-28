/**
 * Shared rooms — the pure half of the Desktop panel (#194307). No Solid, no fetch: every decision
 * the panel makes about what to show is here and tested.
 *
 * Words are for people (house rule: consumer UI). "Alex's chat", "asleep for 40 min", never a
 * session id, a provider slug or a status code.
 */

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
  activity?: RoomActivity
}
export type LastLine =
  | { kind: "person" | "event"; name: string; isYou: boolean; text: string; at: string }
  | { kind: "agent"; hostUserId: number | null; hostName: string | null; provider: string | null; isYou: boolean; text: string; tool: string | null; detail: string | null; at: string }
export type RoomActivity = { present: Presence[]; last: LastLine | null; unread: number; working: boolean }
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
  /** Whose computer runs it (#194466). Absent from a server that predates it: the room owner's. */
  hostUserId?: number | null
  hostName?: string | null
}
/** Someone in the room right now (#194465). */
export type Presence = { userId: number; name: string; state: "active" | "background"; typing: boolean }
export type SayResult = {
  outcome: "delivered" | "parked" | "held" | "saved"
  delivered: number
  note: string | null
  agentsNote: string | null
  /** How many of the room's cloud agents answered in the first round (#194496). */
  agentsAnswered?: number
}

export type ProjectGroup = { project: { id: number; name: string }; rooms: SharedRoom[]; latest: string }

const byNewest = (a?: string, b?: string) => String(b ?? "").localeCompare(String(a ?? ""))

export function groupByProject(rooms: SharedRoom[]): ProjectGroup[] {
  const map = new Map<number, ProjectGroup>()
  for (const r of rooms) {
    if (!r.project) continue
    const g = map.get(r.project.id) ?? { project: r.project, rooms: [], latest: "" }
    g.rooms.push(r)
    if ((r.updatedAt ?? "") > g.latest) g.latest = r.updatedAt ?? ""
    map.set(r.project.id, g)
  }
  const groups = [...map.values()]
  for (const g of groups) g.rooms.sort((a, b) => byNewest(a.updatedAt, b.updatedAt))
  return groups.sort((a, b) => byNewest(a.latest, b.latest))
}

const HARNESS: Record<string, string> = {
  "claude-code": "Claude Code",
  claude_code: "Claude Code",
  opencode: "IRIS Desktop",
  acp: "Codex / Gemini",
}

function span(fromIso: string | null, now: Date): string | null {
  if (!fromIso) return null
  const mins = Math.floor((now.getTime() - new Date(fromIso).getTime()) / 60000)
  if (!Number.isFinite(mins) || mins < 0) return null
  if (mins < 60) return `${mins} min`
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return m ? `${h} h ${m} min` : `${h} h`
}

export function sessionLine(s: SessionState, now: Date = new Date()): { tone: "live" | "away" | "gone"; text: string; detail: string } {
  if (!s.machine) return { tone: "gone", text: "A chat no computer reports", detail: "it may have been closed" }
  const what = HARNESS[String(s.provider ?? "")] ?? "A chat"
  const text = `${what} on ${s.machine}`
  if (s.online) return { tone: "live", text, detail: "online" }
  const d = span(s.lastSeen, now)
  if (d === "0 min") return { tone: "away", text, detail: "just went to sleep — messages wait for it" }
  return { tone: "away", text, detail: `asleep${d ? ` for ${d}` : ""} — messages wait for it` }
}

export function initials(name: string): string {
  const parts = String(name ?? "").trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return "?"
  const first = parts[0][0] ?? ""
  const last = parts.length > 1 ? (parts[parts.length - 1][0] ?? "") : ""
  return (first + last).toUpperCase() || "?"
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

export function ago(at: string, now: Date = new Date()): string {
  if (!at) return ""
  const t = new Date(at)
  if (Number.isNaN(t.getTime())) return ""
  const secs = (now.getTime() - t.getTime()) / 1000
  if (secs < 60) return "now"
  if (secs < 3600) return `${Math.floor(secs / 60)} min`
  if (secs < 86400) return `${Math.floor(secs / 3600)} h`
  return `${MONTHS[t.getUTCMonth()]} ${t.getUTCDate()}`
}

/** "Alex Mayo" → "Alex": how a teammate is named in passing. */
export function firstName(name: string | null): string {
  return String(name ?? "").trim().split(/\s+/)[0] || "Someone"
}

const whose = (r: { ownerName: string | null }) => `${firstName(r.ownerName)}'s`

export function sayNote(r: SayResult, ownerName: string | null): string {
  const owner = firstName(ownerName)
  // The room's own agents took it (#194496) — that is where it went, whatever else did.
  if ((r.agentsAnswered ?? 0) > 0 && r.outcome !== "delivered" && r.outcome !== "parked")
    return r.agentsAnswered === 1 ? "The room's agent is on it." : `${r.agentsAnswered} of the room's agents are on it.`
  switch (r.outcome) {
    case "delivered":
      return `Sent to ${owner}'s chat.`
    case "parked":
      return `${owner}'s computer is asleep — it gets this when it wakes.`
    case "held":
      return "Saved here. The chat is busy — it was not typed in this minute."
    default:
      return "Saved here. No live chat is connected right now."
  }
}

/**
 * Stop is the safety valve: owners always, and whoever sent the message the chat is working on —
 * the latest message that actually reached a session — until someone else speaks. Never a viewer.
 * Mirrors the server's rule (AgentThreadController::startedTheRunningTurn); the server decides.
 */
export function canStopNow(room: SharedRoom, messages: SharedMessage[], myId: number | null): boolean {
  if (room.you.canStop) return true
  if (!room.you.canPost || myId === null) return false
  const latest = [...messages].reverse().find((m) => m.deliveredTo.length > 0)
  return !!latest && latest.kind === "person" && latest.senderId === String(myId)
}

export function composerHint(room: SharedRoom): string {
  if (!room.you.canPost) return `You can watch this chat. Ask ${firstName(room.ownerName)} for editor access to type in it.`
  return room.you.isOwner ? "Type to your chat…" : `Type to ${whose(room)} chat…`
}

// ── the live chat: the agent's side, merged with what only the room saw ─────

export type TranscriptEntry = { role: "user" | "assistant"; kind: "text" | "tool"; text: string; tool: string | null; detail: string | null; at: string }
export type TimelineItem = {
  key: string
  kind: "person" | "agent" | "tool" | "note" | "event"
  speaker: string
  text: string
  at: string
  viaRoom?: boolean
  /** Which agent said it, when more than one runs in the room (#194466). */
  lane?: string
}

/**
 * Who typed a user turn. A room delivery is labelled by the server (`[room · <room> · <name>]`), a
 * Hive message by the bridge (`[via iris · <name>]`); an unlabelled turn was typed at the owner's
 * own keyboard.
 */
export function speakerOf(text: string, ownerName: string | null): { speaker: string; text: string; viaRoom: boolean } {
  const m = /^\[(room|via iris)((?: · [^\]]*)*)\]\s*/.exec(text)
  if (!m) return { speaker: ownerName || "The owner", text, viaRoom: false }
  const parts = m[2].split(" · ").map((p) => p.trim()).filter(Boolean)
  // room label: [room · <room name> · <person>] — the person is the part after the room name.
  const speaker = m[1] === "room" ? (parts.length >= 2 ? parts[parts.length - 1] : "Someone") : parts[0] || "Someone"
  return { speaker, text: text.slice(m[0].length), viaRoom: true }
}

const base = (p: string | null) => String(p ?? "").split("/").filter(Boolean).pop() ?? ""

export function toolLine(e: TranscriptEntry): string {
  const d = e.detail
  switch (e.tool) {
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return `Edited ${base(d)}`
    case "Write":
      return `Wrote ${base(d)}`
    case "Read":
      return `Read ${base(d)}`
    case "Bash":
      return `Ran ${d ?? "a command"}`
    case "Grep":
    case "Glob":
      return `Searched for ${d ?? "files"}`
    default:
      return `Used ${e.tool ?? "a tool"}`
  }
}

/**
 * One timeline. The transcript is the chat itself — every message typed into the session is in it,
 * labelled — so a room message that WAS delivered is not drawn again. What only the room saw is
 * merged in by time: an event (a Stop) and a message that was held or saved without reaching a chat.
 */
export function mergeTimeline(transcript: TranscriptEntry[], room: SharedMessage[], ownerName: string | null): TimelineItem[] {
  const items: TimelineItem[] = []
  transcript.forEach((e, i) => {
    const key = `t${i}`
    if (e.kind === "tool") items.push({ key, kind: "tool", speaker: "Agent", text: toolLine(e), at: e.at })
    else if (e.role === "assistant") items.push({ key, kind: "agent", speaker: "Agent", text: e.text, at: e.at })
    else {
      const s = speakerOf(e.text, ownerName)
      items.push({ key, kind: "person", speaker: s.speaker, text: s.text, at: e.at, viaRoom: s.viaRoom })
    }
  })
  for (const m of room) {
    if (m.kind === "event") items.push({ key: `r${m.id}`, kind: "event", speaker: "IRIS", text: m.text, at: m.at })
    else if (m.kind === "person" && m.deliveredTo.length === 0) items.push({ key: `r${m.id}`, kind: "note", speaker: m.senderName, text: m.text, at: m.at })
  }
  // Stable: entries without a time keep their place relative to their neighbours.
  return items
    .map((it, i) => ({ it, i }))
    .sort((a, b) => (a.it.at && b.it.at && a.it.at !== b.it.at ? (a.it.at < b.it.at ? -1 : 1) : a.i - b.i))
    .map((x) => x.it)
}

/** Why the chat itself cannot be shown, in words — never a node id, a task count or "BRIDGE". */
export function chatTrouble(reason: string | null, ownerName: string | null): string {
  const r = String(reason ?? "").toLowerCase()
  const who = `${firstName(ownerName)}'s computer`
  if (r.includes("not signed in")) return "You're not signed in to IRIS."
  if (r.includes("busy") || r.includes("capacity")) return `${who} is busy right now.`
  if (r.includes("did not answer") || r.includes("timed out") || r.includes("timeout")) return `${who} isn't answering.`
  if (r.includes("checked in") || r.includes("unreachable") || r.includes("offline") || r.includes("no machine")) return `${who} is off or offline.`
  if (r.includes("not found")) return `That chat isn't open on ${who} anymore.`
  return `${who} couldn't share the chat right now.`
}

// ── telling you, anywhere in the app, that something is shared ──────────────

const ACTIVE_MS = 10 * 60 * 1000

/** The titlebar pill: null when nothing is shared with you (no pill), else what is live now. */
export function pillSummary(rooms: SharedRoom[], now: Date = new Date()): { count: number; active: number; label: string; hint: string } | null {
  if (!rooms.length) return null
  const active = rooms.filter((r) => r.updatedAt && now.getTime() - new Date(r.updatedAt).getTime() < ACTIVE_MS).length
  const count = rooms.length
  return {
    count,
    active,
    label: active ? `${active} live` : `${count} shared`,
    hint: `Shared with your team: ${count} ${count === 1 ? "chat" : "chats"}, ${active ? `${active} active now` : "none active now"}`,
  }
}

/** The room that shares this chat, if any — what the chat's own header marks. */
export function roomForSession(rooms: SharedRoom[], sessionId: string | undefined | null): SharedRoom | null {
  if (!sessionId) return null
  return rooms.find((r) => r.sessionIds.includes(sessionId)) ?? null
}

/** What an invite lets you do, in plain words. Unknown roles read as the least. */
export function roleWords(role: string | null): string {
  const r = (role ?? "").toLowerCase()
  if (r === "owner" || r === "admin") return "watch its shared chats, type into them and stop them"
  if (r === "editor" || r === "edit" || r === "write") return "watch its shared chats and type into them"
  return "watch its shared chats"
}

export type HomeScope = "all" | "local" | "shared"

/** Shared chats in the order Home shows them: the one that moved last first. */
export function homeSharedRows(rooms: SharedRoom[]): SharedRoom[] {
  return [...rooms].sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
}

// ── multiplayer (#194465, #194466) ───────────────────────────────────────────

const SHORT_HARNESS: Record<string, string> = {
  "claude-code": "Claude Code",
  claude_code: "Claude Code",
  opencode: "IRIS",
  acp: "Codex",
}

/** "Flo's Codex", "Your Claude Code", "Alex's agent" — whose agent it is, then what it is. */
export function agentLabel(s: Pick<SessionState, "provider" | "hostUserId" | "hostName">, ownerName: string | null, myId: number | null): string {
  const what = SHORT_HARNESS[String(s.provider ?? "")] ?? "agent"
  if (myId !== null && s.hostUserId === myId) return `Your ${what}`
  return `${firstName(s.hostName ?? ownerName)}'s ${what}`
}

/** One agent's transcript. `host` is the person whose chat it is: what they type straight into it is theirs. */
export type Lane = { sessionId: string; label: string; host: string | null; entries: TranscriptEntry[] }

const DUP_MS = 2 * 60 * 1000

/**
 * Every agent in the room on one timeline (#194466). A line typed in the room reaches EVERY agent,
 * so each transcript holds its own copy of it: shown once (same person, same words, within two
 * minutes). What each agent says and does is labelled with whose agent it is.
 */
export function mergeRoomTimeline(lanes: Lane[], room: SharedMessage[], ownerName: string | null, cloudAgents = false): TimelineItem[] {
  const items: TimelineItem[] = []
  const seen: { key: string; at: number }[] = []
  const many = lanes.length > 1
  for (const lane of lanes) {
    lane.entries.forEach((e, i) => {
      const key = `${lane.sessionId}:${i}`
      if (e.kind === "tool") {
        items.push({ key, kind: "tool", speaker: lane.label, text: many ? `${lane.label} · ${toolLine(e)}` : toolLine(e), at: e.at, lane: lane.sessionId })
        return
      }
      if (e.role === "assistant") {
        items.push({ key, kind: "agent", speaker: lane.label, text: e.text, at: e.at, lane: lane.sessionId })
        return
      }
      const who = speakerOf(e.text, lane.host ?? ownerName)
      const speaker = who.speaker
      const t = Date.parse(e.at)
      const sig = `${speaker}\n${who.text}`
      if (who.viaRoom && seen.some((x) => x.key === sig && (Number.isNaN(t) || Number.isNaN(x.at) || Math.abs(x.at - t) < DUP_MS))) return
      if (who.viaRoom) seen.push({ key: sig, at: t })
      items.push({ key, kind: "person", speaker, text: who.text, at: e.at, viaRoom: who.viaRoom, lane: lane.sessionId })
    })
  }
  for (const m of room) {
    if (m.kind === "event") items.push({ key: `r${m.id}`, kind: "event", speaker: "IRIS", text: m.text, at: m.at })
    // A cloud agent's reply lives in the room itself (#194496): its own name, its own lane.
    else if (m.kind === "agent") items.push({ key: `r${m.id}`, kind: "agent", speaker: m.senderName, text: m.text, at: m.at, lane: `cloud:${m.senderId}` })
    // A line no computer's chat took: "only in the room" — unless the room's cloud agents answer
    // the room itself, in which case it is simply the conversation (#194496).
    else if (m.kind === "person" && m.deliveredTo.length === 0)
      items.push({ key: `r${m.id}`, kind: cloudAgents ? "person" : "note", speaker: m.senderName, text: m.text, at: m.at })
  }
  return items
    .map((it, i) => ({ it, i }))
    .sort((a, b) => (a.it.at && b.it.at && a.it.at !== b.it.at ? (a.it.at < b.it.at ? -1 : 1) : a.i - b.i))
    .map((x) => x.it)
}

export type Chain = { depth: number; turns: number; maxTurns: number; maxHops: number }

/** "Agents are talking · 3 of 6 replies" — while agents hand work to each other (#194495). */
export function chainLine(chain: Chain | null | undefined): string | null {
  if (!chain) return null
  return `Agents are talking · ${chain.turns} of ${chain.maxTurns} replies`
}

/** "Flo is typing…", "Flo and Maya are typing…", "3 people are typing…" — never you. */
export function typingLine(present: Presence[], myId: number | null): string | null {
  const names = present.filter((p) => p.typing && p.userId !== myId).map((p) => firstName(p.name))
  if (!names.length) return null
  if (names.length === 1) return `${names[0]} is typing…`
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`
  return `${names.length} people are typing…`
}

/** The facepile: looking first, then open in the background; at most `max`, the rest as "+N". */
export function facepile(present: Presence[], max = 5): { shown: Presence[]; more: number } {
  const sorted = [...present].sort((a, b) => (a.state === b.state ? a.name.localeCompare(b.name) : a.state === "active" ? -1 : 1))
  return { shown: sorted.slice(0, max), more: Math.max(0, sorted.length - max) }
}

// ── Home, option B (#194490): one list, shared rooms mixed in ────────────────

const oneLine = (t: string) => t.replace(/\s+/g, " ").trim()

/** The row's second voice: "Flo's Codex: Edited launch.md", "Maya: Can you…", "You: …". */
export function previewLine(room: SharedRoom, myId: number | null): string {
  const l = room.activity?.last
  if (!l) return room.you.isOwner ? "Your shared chat" : `${firstName(room.ownerName)}'s shared chat`
  if (l.kind === "agent") {
    const who = agentLabel({ provider: l.provider, hostUserId: l.isYou ? myId : l.hostUserId, hostName: l.hostName }, room.ownerName, l.isYou ? myId : null)
    const what = l.tool ? toolLine({ role: "assistant", kind: "tool", text: "", tool: l.tool, detail: l.detail, at: l.at }) : oneLine(l.text)
    return `${who}: ${what}`
  }
  if (l.kind === "event") return oneLine(l.text)
  return `${l.isYou ? "You" : firstName(l.name)}: ${oneLine(l.text)}`
}

/** When the room last moved — its latest line, else the room itself. */
export function roomWhen(room: SharedRoom): string {
  return room.activity?.last?.at || room.updatedAt || ""
}

/** Faces for the row: who else is here now, else whose room it is. */
export function roomFaces(room: SharedRoom, max = 2, myId: number | null = null): { names: string[]; more: number } {
  // The other people — your own face on your own list says nothing.
  const here = (room.activity?.present ?? []).filter((p) => p.userId !== myId).map((p) => p.name)
  const names = here.length ? here : [room.ownerName ?? room.name]
  return { names: names.slice(0, max), more: Math.max(0, names.length - max) }
}

export type HomeItem<R> = { kind: "local"; at: number; record: R } | { kind: "shared"; at: number; room: SharedRoom }
export type HomeBucket<R> = { id: "today" | "yesterday" | "older"; title: string; items: HomeItem<R>[] }

/**
 * One timeline (#194490): this computer's chats and your team's shared rooms, newest first, in
 * Today / Yesterday / Older. `scope` narrows it — the same list, never a different screen.
 */
export function mixHome<R>(
  local: R[],
  localAt: (r: R) => number,
  rooms: SharedRoom[],
  scope: HomeScope,
  titles: { today: string; yesterday: string; older: string; recent: string },
  now: Date = new Date(),
): HomeBucket<R>[] {
  const items: HomeItem<R>[] = []
  if (scope !== "shared") for (const r of local) items.push({ kind: "local", at: localAt(r), record: r })
  if (scope !== "local") for (const room of rooms) items.push({ kind: "shared", at: Date.parse(roomWhen(room)) || 0, room })
  items.sort((a, b) => b.at - a.at)
  const day = (t: number) => {
    const d = new Date(t)
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
  }
  const today = day(now.getTime())
  const yesterday = day(now.getTime() - 86_400_000)
  const buckets: HomeBucket<R>[] = [
    { id: "today", title: titles.today, items: [] },
    { id: "yesterday", title: titles.yesterday, items: [] },
    { id: "older", title: titles.older, items: [] },
  ]
  for (const it of items) {
    const d = day(it.at)
    buckets[d === today ? 0 : d === yesterday ? 1 : 2].items.push(it)
  }
  if (!buckets[0].items.length && !buckets[1].items.length) buckets[2].title = titles.recent
  return buckets.filter((b) => b.items.length > 0)
}

/**
 * The live strip on Home (#194490, option C's cards): rooms where something is happening — an agent
 * working, lines you have not seen, someone else in it, or a move in the last 10 minutes. Working
 * first, then unread, then most recent. At most `max`.
 */
export function liveRooms(rooms: SharedRoom[], myId: number | null, now: Date = new Date(), max = 3): SharedRoom[] {
  const score = (r: SharedRoom) => {
    const a = r.activity
    const others = (a?.present ?? []).some((p) => p.userId !== myId)
    const recent = now.getTime() - (Date.parse(roomWhen(r)) || 0) < 10 * 60 * 1000
    if (a?.working) return 3
    if ((a?.unread ?? 0) > 0) return 2
    if (others || recent) return 1
    return 0
  }
  return rooms
    .map((r) => ({ r, s: score(r), at: Date.parse(roomWhen(r)) || 0 }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || b.at - a.at)
    .slice(0, max)
    .map((x) => x.r)
}

// ── minimal room UI (#194566) ────────────────────────────────────────────────

const BRANDS: Record<string, string> = {
  gpt: "GPT", glm: "GLM", deepseek: "DeepSeek", qwen: "Qwen", kimi: "Kimi", gemini: "Gemini", claude: "Claude",
  minimax: "MiniMax", mimo: "MiMo", grok: "Grok", llama: "Llama", mistral: "Mistral", hy: "Hy", step: "Step", longcat: "LongCat", iris: "IRIS",
}
const WORDS: Record<string, string> = { ai: "AI", mini: "Mini", nano: "Nano", pro: "Pro", max: "Max", flash: "Flash", plus: "Plus", code: "Code", preview: "Preview", lite: "Lite" }

/** "iris/gpt-6-luna" → "GPT-6 Luna", "iris/deepseek-v4-pro" → "DeepSeek V4 Pro" — a name a person reads, not an id. */
export function modelLabel(id: string | null | undefined): string {
  if (!id) return ""
  const bare = String(id).split("/").pop() ?? ""
  const parts = bare.split("-").filter(Boolean)
  if (!parts.length) return String(id)
  const out: string[] = []
  parts.forEach((p, i) => {
    const low = p.toLowerCase()
    if (i === 0 && BRANDS[low]) out.push(BRANDS[low])
    else if (/^v\d/.test(low)) out.push(low.toUpperCase())
    else if (/^\d/.test(low)) {
      // GPT keeps its hyphen ("GPT-6"); other families read "Gemini 4", "GLM 5.3".
      if (i === 1 && out[0] === "GPT") out[0] = `GPT-${low}`
      else out.push(low)
    } else out.push(WORDS[low] ?? low.charAt(0).toUpperCase() + low.slice(1))
  })
  return out.join(" ")
}
