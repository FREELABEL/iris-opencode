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
export type SayResult = { outcome: "delivered" | "parked" | "held" | "saved"; delivered: number; note: string | null; agentsNote: string | null }

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
  const mins = Math.round((now.getTime() - new Date(fromIso).getTime()) / 60000)
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

const whose = (r: { ownerName: string | null }) => `${r.ownerName || "their"}'s`

export function sayNote(r: SayResult, ownerName: string | null): string {
  const owner = ownerName || "Their"
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
  if (!room.you.canPost) return `You can watch this chat. Ask ${room.ownerName || "its owner"} for editor access to type in it.`
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
