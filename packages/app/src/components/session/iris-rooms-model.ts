/**
 * The pure half of the Rooms pane (#186511): who a draft is addressed to, who answers when
 * nobody is, and the @-autocomplete. Kept out of the component so it can be tested without a
 * DOM, and kept in step with the server's matcher (AgentOrchestrator::matchMentions) — the
 * server's resolution is what gets recorded; this only tells the user before they send.
 */

export type RoomAgent = { id: string; name: string; role: string; autoRespond: boolean }
export type RoomMessage = {
  id: string
  sender: "user" | "agent"
  senderId: string
  senderName: string
  text: string
  at: string
  inReplyTo?: string
  addressees: string[]
  routing?: "mention" | "room-default"
}
export type Room = { id: string; name: string; agents: RoomAgent[]; messageCount?: number; updatedAt?: string }

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** Agents a draft @mentions. Name must end at a boundary; longest first; each match consumed. */
export function mentionedAgents(text: string, agents: RoomAgent[]): RoomAgent[] {
  let rest = text
  const out: RoomAgent[] = []
  for (const a of [...agents].sort((x, y) => y.name.length - x.name.length)) {
    const name = a.name.trim()
    if (!name) continue
    const re = new RegExp(`(?<![\\p{L}\\p{N}_@])@${esc(name)}(?![\\p{L}\\p{N}_-])`, "giu")
    if (re.test(rest)) {
      out.push(a)
      rest = rest.replace(re, " ")
    }
  }
  return out
}

/**
 * Who answers a message with NO @mention: the room's always-on agents; if none, its primary;
 * if neither, nobody. This is the documented default for #186511 — the pane states it under the
 * composer so an unaddressed message is never a guess.
 */
export function defaultResponders(agents: RoomAgent[]): RoomAgent[] {
  const always = agents.filter((a) => a.autoRespond)
  if (always.length) return always
  const primary = agents.find((a) => a.role === "primary")
  return primary ? [primary] : []
}

/** The line under the composer: exactly who this draft will reach. */
export function recipientsLine(text: string, agents: RoomAgent[]): { text: string; warn: boolean } {
  const named = mentionedAgents(text, agents)
  if (named.length) return { text: `to ${named.map((a) => a.name).join(", ")}`, warn: false }
  const fallback = defaultResponders(agents)
  if (fallback.length)
    return { text: `no @mention — ${fallback.map((a) => a.name).join(", ")} will answer (room default)`, warn: false }
  return { text: "no @mention and this room has no primary — nobody will answer. @mention an agent.", warn: true }
}

/** The line on a SENT user message: who it went to, from the server's own record. */
export function sentToLine(m: RoomMessage, agents: RoomAgent[]): string | undefined {
  if (m.sender !== "user") return undefined
  if (m.addressees.length) {
    const byId = new Map(agents.map((a) => [a.id, a.name]))
    return `to ${m.addressees.map((id) => byId.get(id) ?? `agent ${id}`).join(", ")}`
  }
  if (m.routing === "room-default") return "to the room default"
  return undefined
}

/**
 * The @-query being typed at the caret, if any: "hey @pa|" → "pa". Only when the @ starts a
 * word, so an email address is not an autocomplete trigger.
 */
export function mentionQuery(beforeCaret: string): string | undefined {
  const m = beforeCaret.match(/(?:^|[\s(])@([^\s@]{0,40})$/u)
  return m ? m[1] : undefined
}

export function mentionSuggestions(query: string, agents: RoomAgent[]): RoomAgent[] {
  const q = query.toLowerCase()
  return agents.filter((a) => a.name.toLowerCase().startsWith(q) || a.name.toLowerCase().includes(` ${q}`)).slice(0, 6)
}

/** Replace the @-query at the caret with the full name. Returns the new text and caret. */
export function insertMention(text: string, caret: number, name: string): { text: string; caret: number } {
  const before = text.slice(0, caret)
  const at = before.lastIndexOf("@")
  if (at < 0) return { text, caret }
  const head = text.slice(0, at) + `@${name} `
  return { text: head + text.slice(caret), caret: head.length }
}

/** Send order, stable: created_at is second-precision; UUIDv7 ids break the tie. */
export function sortMessages(messages: RoomMessage[]): RoomMessage[] {
  return [...messages].sort((a, b) => (a.at === b.at ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.at < b.at ? -1 : 1))
}
