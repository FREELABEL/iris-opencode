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
  /** Every waiting question with its options, numbered as the agent shows them (#191171). */
  questions?: WaitingQuestion[]
  /** Why this row cannot be messaged or answered from here; null when it can. */
  readOnly?: string | null
}

export type WaitingQuestion = { question: string; header: string | null; options: { n: number; label: string }[] }

/** An old record of a re-registered machine whose rows are not shown (`iris hive sessions` says the same). */
export type RetiredRecord = { name: string; rows: number; at: string }

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
  acp: "ACP",
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
 * What the talk area offers for this session (#191171).
 *  - talk: a message goes in (`iris hive ask`), and its waiting question can be answered.
 *  - readonly: the provider cannot take input from here; `readOnly` says why.
 *  - stale: this machine's report is not current, so a message may reach nobody.
 */
export function replyMode(s: HiveSession, n: HiveSessionNode): "talk" | "readonly" | "stale" {
  if (s.readOnly) return "readonly"
  if (n.report !== "fresh" || s.status === "stale" || s.status === "unknown") return "stale"
  return "talk"
}

/** `iris hive sessions`' age column: 15m, 21h, 2d. */
export function shortAge(iso: string | null | undefined, now: number): string {
  if (!iso) return "—"
  const ms = now - Date.parse(iso)
  if (Number.isNaN(ms)) return "—"
  const m = Math.round(ms / 60000)
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  if (h < 48) return `${h}h`
  return `${Math.round(h / 24)}d`
}

/**
 * The reply to a message we sent, read off the transcript the way `iris hive ask` follows it
 * (CLI hive-chat-follow): anchor on the LAST user text containing what we sent (the bridge
 * prefixes `[via iris · host]`, hence contains), then everything after it. `answered` is true once
 * an assistant text has appeared; until the anchor is seen the message has not landed yet.
 */
export function replyAfter(
  messages: readonly TranscriptMessage[],
  sent: string,
): { anchored: boolean; answered: boolean; parts: { kind: "text" | "tool"; text: string }[] } {
  const needle = sent.trim().slice(0, 200)
  let a = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === "user" && m.type === "text" && typeof m.text === "string" && m.text.includes(needle)) {
      a = i
      break
    }
  }
  if (!needle || a < 0) return { anchored: false, answered: false, parts: [] }
  const parts: { kind: "text" | "tool"; text: string }[] = []
  let answered = false
  for (const m of messages.slice(a + 1)) {
    if (m.type === "tool_use") parts.push({ kind: "tool", text: m.tool ?? "tool" })
    else if (m.type === "text" && m.role === "assistant" && m.text?.trim()) {
      answered = true
      parts.push({ kind: "text", text: m.text })
    }
  }
  return { anchored: true, answered, parts }
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

/**
 * The first entry of a chat continued here from another machine (epic #191485, #191492).
 *
 * Picking a chat up on this machine starts a NEW chat, linked by name: the original keeps running
 * where its files are (ADR-01). This text is added without a reply, so the model reads it as the
 * conversation so far. Oldest entries are dropped first to fit, and the drop is said, not hidden.
 */
export function continueText(
  from: { label: string; provider: string; sessionId: string },
  machine: string,
  messages: readonly TranscriptMessage[],
  maxChars = 24_000,
): string {
  const line = (m: TranscriptMessage) => {
    if (m.type === "tool_use" || (m.tool && !m.text)) return `  · ${m.tool ?? "tool"}${m.text ? `: ${m.text}` : ""}`
    const who = m.role === "user" ? "User" : m.role === "assistant" ? "Assistant" : m.role
    return `${who}: ${(m.text ?? "").trim()}`
  }
  const head =
    `Continued from "${from.label}" on ${machine} (${from.provider}, ${from.sessionId}). ` +
    `The original stays on ${machine}; this chat runs here, so its files and tools are this machine's.\n\n` +
    `The conversation so far:\n`
  const tail = `\n\nPick up where it left off.`
  const lines = messages.filter((m) => (m.text ?? "").trim() || m.tool).map(line)
  let kept = lines
  let dropped = 0
  while (kept.length && head.length + tail.length + kept.join("\n").length > maxChars) {
    kept = kept.slice(1)
    dropped++
  }
  const note = dropped ? `(${dropped} earlier ${dropped === 1 ? "entry" : "entries"} not shown)\n` : ""
  return head + note + kept.join("\n") + tail
}
