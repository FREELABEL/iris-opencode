// Meeting action items → proposed Hive tasks you approve (#188354).
//
// `iris meetings <session> --file` already extracts "OWNER — action — due" lines. Filing them as
// prose is where they used to stop. With --propose-tasks each becomes a PROPOSAL item on the same
// project — nothing runs. `iris meetings --approve <item> --node <node>` sends one to a Hive node
// as an agent task, keyed by the proposal so a second approval returns the same task instead of
// running it twice. A meeting ending is the trigger; a person still decides what runs.

export type ActionItem = { owner: string; action: string; due?: string }

export const PROPOSAL_MARKER = "<!-- meeting-proposal v1 -->"
export const PROPOSALS_LIST = "Proposed tasks — approve to run"
/** The Hive task type that runs the node's IRIS agent on a prompt (daemon: iris-code --non-interactive). */
export const AGENT_TASK_TYPE = "code_generation"

/** The heading that opens the action-item section, in the shapes our summaries and rabbit notes use. */
const ACTION_HEADING = /^\s*(?:#{1,6}\s*|\d+[.)]\s*)?(?:\*\*)?\s*action\s*items?\s*(?:\*\*)?\s*[:—-]?\s*(?:\*\*)?\s*$/i
/** Any other section heading ends it. */
const OTHER_HEADING = /^\s*(?:#{1,6}\s+\S|\d+[.)]\s*\*\*|\*\*[^*]+\*\*\s*[:—-]?\s*$|---\s*$|<details)/i

/** Pull "OWNER — action — due" lines out of a meeting summary. Never invents an owner. */
export function parseActionItems(markdown: string): ActionItem[] {
  const lines = markdown.split(/\r?\n/)
  const start = lines.findIndex((l) => ACTION_HEADING.test(l))
  if (start < 0) return []
  const out: ActionItem[] = []
  for (const raw of lines.slice(start + 1)) {
    if (OTHER_HEADING.test(raw)) break
    const line = raw.replace(/^\s*(?:[-*+•]|\d+[.)])\s+/, "").replace(/\*\*/g, "").trim()
    if (!line) continue
    if (/^(none|n\/a|no action items?)\.?$/i.test(line)) continue
    const parts = line.split(/\s+[—–]\s+|\s+-\s+/).map((p) => p.trim()).filter(Boolean)
    if (parts.length >= 2) {
      const [owner, action, ...rest] = parts
      const due = rest.join(" — ").replace(/^due[:\s]*/i, "").trim()
      out.push({ owner, action, ...(due && !/^(not stated|none|n\/a)$/i.test(due) ? { due } : {}) })
    } else {
      // A line with no separator is an action with nobody named. Say so rather than guess.
      out.push({ owner: "unassigned", action: line })
    }
  }
  return out.filter((a) => a.action.length >= 3)
}

/** Title for a proposal item: short, searchable, and inside the 191-character column. */
export function proposalTitle(item: ActionItem): string {
  const who = item.owner && item.owner.toLowerCase() !== "unassigned" ? ` (${item.owner})` : ""
  const t = `PROPOSED: ${item.action}${who}`
  return t.length <= 190 ? t : t.slice(0, 187) + "…"
}

export function proposalBody(item: ActionItem, meeting: { itemId?: number | string; title: string }): string {
  return [
    PROPOSAL_MARKER,
    `**Proposed from the meeting** "${meeting.title}"${meeting.itemId ? ` (item #${meeting.itemId})` : ""}. Nothing has run.`,
    "",
    `- **Action:** ${item.action}`,
    `- **Owner named in the meeting:** ${item.owner}`,
    item.due ? `- **Due:** ${item.due}` : "- **Due:** not stated",
    "",
    "**To run it on one of your machines:** `iris meetings --approve <this item id> --node <node>`",
    "To drop it: set this item's status to rejected.",
  ].join("\n")
}

/** The action text of a filed proposal, or null when the item is not one. */
export function proposalAction(content: unknown): string | null {
  const s = typeof content === "string" ? content : ""
  if (!s.includes(PROPOSAL_MARKER)) return null
  const m = s.match(/^- \*\*Action:\*\* (.+)$/m)
  return m ? m[1].trim() : null
}

/** The prompt the node's agent receives. It names the source and the limits of what was agreed. */
export function proposalPrompt(action: string, meetingTitle?: string): string {
  return [
    `Action item from a meeting${meetingTitle ? ` ("${meetingTitle}")` : ""}, approved to run: ${action}`,
    "",
    "Do only this. If it needs something you do not have (a login, a file, a decision), stop and say exactly what is missing instead of guessing.",
  ].join("\n")
}
