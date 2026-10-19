/**
 * DELEGATE (#189933) — the rail beside Atlas › Board: drag a card onto an agent or a session.
 *
 * Framework-free on purpose (#189933 ADR-04): the Genesis component that comes later is Vue, this
 * panel is Solid, and the rules for "who is free" and "what does a session get told" must not be
 * written twice and drift.
 *
 * Two kinds of target, and they are NOT the same act:
 *  - an AGENT gets a task on the card carrying its id — the primitive `iris agents assign --item`
 *    writes and `iris agents tasks` reads back. That is assignment; the agent picks it up on its
 *    own heartbeat or schedule, not now.
 *  - a SESSION gets the card as a prompt, and starts on it immediately. Nothing is written to the
 *    card: the session's transcript is the record.
 */

/** What a board card carries while it is dragged — the board's own payload, unchanged. */
export const DRAG_PREFIX = "atlas-item:"
export const dragPayload = (itemId: number) => `${DRAG_PREFIX}${itemId}`

/** The card id from a drag payload, or null for anything that is not a board card. */
export function cardFromDrag(text: string | null | undefined): number | null {
  if (!text || !text.startsWith(DRAG_PREFIX)) return null
  const id = Number(text.slice(DRAG_PREFIX.length))
  return Number.isInteger(id) && id > 0 ? id : null
}

export type DelegateAgent = {
  id: number
  name: string
  status: string
  model?: string
  heartbeat: boolean
  active?: boolean
  description?: string
}

/**
 * People shared onto a board are imported as agent rows (#189933, measured on bloq 503: three of
 * its four "agents" were email addresses). A person is assigned through the card's members picker
 * (#189796); offering them here as an agent would put a human in a lane that reads "Free".
 */
export const isImportedPerson = (a: Pick<DelegateAgent, "description">) =>
  (a.description ?? "").startsWith("Human team member imported")

export type AgentTaskRow = { source: string; done: boolean }

/**
 * Open work in an agent's queue. Heartbeat boards are excluded: a board the agent watches is not a
 * task waiting for it, and counting it would show every heartbeat agent as permanently busy.
 */
export function openWork(tasks: readonly AgentTaskRow[]): number {
  return tasks.filter((t) => !t.done && t.source !== "heartbeat_bloq").length
}

/**
 * Whether the card already carries an open task for this agent. Dropping twice must not queue the
 * same work twice — found on 2026-10-19, when two drops of one card left it at "0/2" and the
 * agent at "2 open tasks" for a single piece of work.
 */
export function alreadyAssigned(tasks: readonly { agentId?: number; done: boolean }[], agentId: number): boolean {
  return tasks.some((t) => t.agentId === agentId && !t.done)
}

/**
 * The five things a drop can come to. They are not degrees of one thing: "assigned" means on the
 * agent's list for later, "sent" means a session starts now, "queued" means a session takes it
 * after its current turn, "already" means nothing changed. Each gets its own icon in the rail.
 */
export type DropOutcome = "assigned" | "sent" | "queued" | "already" | "failed"

/**
 * What a drop on this target WILL do — shown while the card is held over it, so nobody has to let
 * go to find out. An agent always takes it onto its list; a session starts now or queues.
 */
export function dropIntent(target: { kind: "agent" } | { kind: "session"; busy: boolean }): DropOutcome {
  if (target.kind === "agent") return "assigned"
  return target.busy ? "queued" : "sent"
}

export type AgentTone = "free" | "busy" | "off" | "unknown"

/**
 * `open` is null when the queue could not be read. That is "unknown", never "free" — a lane that
 * says Free because its read failed is the one people will pile work onto.
 */
export function agentTone(agent: DelegateAgent, open: number | null): AgentTone {
  const s = agent.status.toLowerCase()
  if (agent.active === false || s === "paused" || s === "stopped" || s === "inactive") return "off"
  if (open === null) return "unknown"
  return open > 0 ? "busy" : "free"
}

const TONE_ORDER: Record<AgentTone, number> = { free: 0, busy: 1, unknown: 2, off: 3 }

/** Free first, then the least loaded, then by name — the order "Auto" would pick in. */
export function sortAgents<T extends DelegateAgent>(agents: readonly T[], open: (id: number) => number | null): T[] {
  return [...agents].sort((a, b) => {
    const ta = TONE_ORDER[agentTone(a, open(a.id))]
    const tb = TONE_ORDER[agentTone(b, open(b.id))]
    if (ta !== tb) return ta - tb
    const oa = open(a.id) ?? Infinity
    const ob = open(b.id) ?? Infinity
    if (oa !== ob) return oa - ob
    return a.name.localeCompare(b.name)
  })
}

export type DelegateSession = {
  id: string
  title?: string
  parentID?: string
  time?: { updated?: number; created?: number; archived?: number }
}

/**
 * The sessions a card can be handed to: top-level (a subagent's child session is not somewhere a
 * person sends work), not archived, most recently active first.
 */
export function sessionTargets<T extends DelegateSession>(sessions: readonly T[], limit = 8): T[] {
  const at = (s: DelegateSession) => s.time?.updated ?? s.time?.created ?? 0
  return sessions
    .filter((s) => !s.parentID && !s.time?.archived)
    .sort((a, b) => at(b) - at(a))
    .slice(0, limit)
}

export type HandoffCard = { id: number; title: string; listName?: string; boardName?: string }

/**
 * What a session is told. Model-facing, not UI copy: it names the card by id and the command that
 * reads it, so the session works from the card as it is now — not from a title that may be stale.
 */
export function handoffPrompt(card: HandoffCard): string {
  const where = [card.boardName && `board "${card.boardName}"`, card.listName && `list "${card.listName}"`]
    .filter(Boolean)
    .join(", ")
  return [
    `Atlas card #${card.id} — "${card.title}"${where ? ` (${where})` : ""} was handed to this session from the Delegate rail.`,
    ``,
    `Read it first: \`iris boards get ${card.id}\`. Do the work it describes.`,
    `When you finish, say what you did on the card and mark it done: \`iris boards update ${card.id} --status done\`.`,
    `If you cannot finish, leave the card open and say why.`,
  ].join("\n")
}
