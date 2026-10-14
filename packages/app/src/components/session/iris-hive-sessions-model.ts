/**
 * Hive › Sessions (epic #189446) — every AI session on every machine you can reach.
 *
 * Pure: rows in, what to draw out. The sidecar (packages/opencode/src/iris/hive-sessions.ts) has
 * already applied the server's freshness rule, so a machine whose report is old arrives with every
 * session `unknown`. This file decides how that reads; it does not decide whether it is true.
 */

export type HiveSession = {
  sessionId: string
  provider: string
  label: string
  status: string
  activity: string | null
  model: string | null
  branch: string | null
  updatedAt: string | null
  question: string | null
}

export type HiveSessionNode = {
  id: string
  name: string
  online: boolean
  lastHeartbeat: string | null
  report: string
  reportedAt: string | null
  incomplete: string[]
  sessions: HiveSession[]
}

export type TranscriptMessage = { role: string; type: string; text: string | null; tool: string | null; at: string | null }

const ORDER: Record<string, number> = { needs_you: 0, active: 1, idle: 2, unknown: 3, stale: 4 }

/** needs you → working → active → idle → unknown → stale; freshest first within a group. */
export function sortSessions(list: readonly HiveSession[]): HiveSession[] {
  const t = (s: HiveSession) => (s.updatedAt ? Date.parse(s.updatedAt) || 0 : 0)
  return [...list].sort((a, b) => {
    const wa = a.activity ? -0.5 : 0
    const wb = b.activity ? -0.5 : 0
    const d = (ORDER[a.status] ?? 3) + wa - ((ORDER[b.status] ?? 3) + wb)
    return d !== 0 ? d : t(b) - t(a)
  })
}

/**
 * What a machine's list shows by default. `stale` sessions (untouched for over a day) are hidden
 * behind a count, as `iris hive sessions` does without --all: measured 2026-10-14, the two live
 * machines reported 39 and 50 sessions, 29 and 38 of them stale — the live ones were buried.
 * A machine whose REPORT is old has no stale/live split to make (all `unknown`), so it shows all.
 */
export function visibleSessions(n: HiveSessionNode, showOlder: boolean): { shown: HiveSession[]; hidden: number } {
  const all = sortSessions(n.sessions)
  if (showOlder) return { shown: all, hidden: 0 }
  const shown = all.filter((s) => s.status !== "stale")
  return { shown, hidden: all.length - shown.length }
}

/** Is anything on this machine actually being worked on right now? Only a MEASURED activity counts. */
export function isWorking(n: HiveSessionNode): boolean {
  return n.report === "fresh" && n.sessions.some((s) => s.activity === "working" || s.activity === "retrying")
}

export function needsYou(n: HiveSessionNode): number {
  return n.sessions.filter((s) => s.status === "needs_you").length
}

/**
 * Machines with something to show first; within that, fresh before stale, then by name. A machine
 * with nothing reported still appears — absent and empty must not look alike.
 */
export function sortNodes(nodes: readonly HiveSessionNode[]): HiveSessionNode[] {
  const rank = (n: HiveSessionNode) => (needsYou(n) ? 0 : isWorking(n) ? 1 : n.report === "fresh" ? 2 : n.report === "stale" ? 3 : 4)
  return [...nodes].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
}

export function summaryOf(nodes: readonly HiveSessionNode[]) {
  let sessions = 0
  let needs = 0
  let working = 0
  let stale = 0
  for (const n of nodes) {
    sessions += n.sessions.length
    needs += needsYou(n)
    if (n.report === "fresh") working += n.sessions.filter((s) => s.activity === "working" || s.activity === "retrying").length
    else if (n.sessions.length) stale++
  }
  return { sessions, machines: nodes.length, needs, working, staleMachines: stale }
}

export function ago(iso: string | null | undefined, now: number): string {
  if (!iso) return "never"
  const s = (now - Date.parse(iso)) / 1000
  if (!Number.isFinite(s)) return "unknown"
  if (s < 0) return "in the future"
  if (s < 120) return "just now"
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  const d = Math.floor(s / 86400)
  return d === 1 ? "yesterday" : `${d} days ago`
}

/** One line under a machine's name: is this list a reading, or a memory? */
export function reportLine(n: HiveSessionNode, now: number): { tone: "fresh" | "stale" | "none"; text: string } {
  switch (n.report) {
    case "fresh":
      return { tone: "fresh", text: `reported ${ago(n.reportedAt, now)}` }
    case "stale":
      return { tone: "stale", text: `last report ${ago(n.reportedAt, now)} — not current` }
    case "unknown":
      return { tone: "stale", text: "report is dated in the future — clock problem" }
    default:
      return { tone: "none", text: n.online ? "online, has not reported sessions" : "has never reported sessions" }
  }
}

const PROVIDER_WORD: Record<string, string> = {
  claude_code: "Claude Code",
  opencode: "IRIS / opencode",
  codex: "Codex",
  ollama: "Ollama",
}
export const providerWord = (p: string) => PROVIDER_WORD[p] ?? p

export const STATUS_WORD: Record<string, string> = {
  needs_you: "needs you",
  active: "active",
  idle: "idle",
  stale: "stale",
  unknown: "unknown",
}

/**
 * What the reply area offers for this session.
 *  - reply: types into the window that is already open on that machine (opencode).
 *  - claude: Claude Code's own Remote Control already does this, in Claude.
 *  - none: nothing would land where the person expects.
 */
export function replyMode(s: HiveSession, n: HiveSessionNode): "reply" | "claude" | "none" | "stale" {
  if (n.report !== "fresh" || s.status === "stale" || s.status === "unknown") return "stale"
  if (s.provider === "opencode") return "reply"
  if (s.provider === "claude_code") return "claude"
  return "none"
}

/** Merge a transcript read: append when the server says the rows are new, replace otherwise. Capped. */
export function mergeTranscript(
  prev: readonly TranscriptMessage[],
  next: readonly TranscriptMessage[],
  incremental: boolean,
  cap = 400,
): TranscriptMessage[] {
  const out = incremental ? [...prev, ...next] : [...next]
  return out.length > cap ? out.slice(out.length - cap) : out
}
