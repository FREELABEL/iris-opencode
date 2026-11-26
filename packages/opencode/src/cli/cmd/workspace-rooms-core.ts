/**
 * Pure helpers for `iris workspace rooms|share|open|say|watch|stop` — shared workspaces on Atlas
 * projects (#194307). No I/O here, so every decision is testable without a server.
 *
 * The model: a WORKSPACE is an Atlas project (its id, its members, its roles — viewer watches,
 * editor prompts, owner stops). A ROOM is one live chat with an agent, on any member's machine, in
 * any repo; it is filed under the project and every member sees it as it happens.
 */

import { SESSION_PREFIX, sessionParticipantId } from "./rooms-participants"

export const HARNESS_HINT =
  "Any session `iris hive sessions` lists can be a room: Claude Code (inside tmux), opencode / IRIS Desktop, " +
  "and Codex or Gemini started with `iris acp run --keep --agent codex|gemini`."

/** The session ids a room delivers to, from its participant rows. */
export function roomSessions(participants: Array<{ agent_id?: string | null }> | undefined | null): string[] {
  const out: string[] = []
  for (const p of participants ?? []) {
    const id = typeof p?.agent_id === "string" ? p.agent_id : ""
    if (id.startsWith(SESSION_PREFIX)) out.push(id.slice(SESSION_PREFIX.length))
  }
  return out
}

/** Messages not printed yet, oldest first; marks them seen. */
export function unseen<T extends { id: string; created_at?: string | null }>(seen: Set<string>, messages: T[]): T[] {
  const fresh = (messages ?? []).filter((m) => m && m.id && !seen.has(m.id))
  fresh.sort((a, b) => String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")))
  for (const m of fresh) seen.add(m.id)
  return fresh
}

/** One message as a line: time, who, what. A system event (a Stop) reads as an event. */
export function formatLine(
  m: { sender_type?: string; sender_name?: string | null; content?: string; created_at?: string | null },
  timeZone?: string,
): string {
  const at = m.created_at ? new Date(m.created_at) : null
  const hhmm =
    at && !isNaN(at.getTime())
      ? at.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, ...(timeZone ? { timeZone } : {}) })
      : "--:--"
  const text = String(m.content ?? "")
  if (m.sender_type === "system") return `${hhmm}  — ${text}`
  const who = (m.sender_name ?? "").trim() || (m.sender_type === "agent" ? "agent" : "someone")
  return `${hhmm}  ${who}: ${text}`
}

/** POST /api/threads body that opens a room around one live session (always-on, no @mention needed). */
export function openRoomBody(o: { name: string; sessionId: string }) {
  return {
    name: o.name,
    agent_ids: [sessionParticipantId(o.sessionId)],
    agent_roles: ["participant"],
    auto_respond: [true],
  }
}

/** An Atlas project id, or null. */
export function parseProjectId(v: string | number | undefined | null): number | null {
  const s = String(v ?? "").trim()
  if (!/^[1-9][0-9]*$/.test(s)) return null
  return Number(s)
}
