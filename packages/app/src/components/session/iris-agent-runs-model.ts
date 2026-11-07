/**
 * Agents › Running (#192855) — the pure half of the run inspector.
 *
 * A "run" is a chat and every sub-agent it started (sessions linked by parentID). Each agent is a
 * box; its tool calls are rows with a timing bar. This file turns sessions, their live status and
 * their messages into that tree and decides what is Active and what has folded into Inactive. It
 * fetches nothing and draws nothing, so the rules are tested without a DOM.
 *
 * Design: heyiris.io/p/background-agents-run-inspector (boxes, lines who-started-whom, calls with
 * bars) and heyiris.io/p/background-agents-side-pane (Active box, finished work folds to Inactive).
 */
import { fmtDuration, fmtSeconds } from "./iris-agent-live-model"

export type RunSession = {
  id: string
  title?: string
  parentID?: string
  directory?: string
  cost?: number
  time?: { created: number; updated?: number }
}

/** The fields of an SDK message + parts that the tree reads. Everything else is ignored. */
export type RunMessage = {
  info: { role: string; agent?: string; modelID?: string; cost?: number; error?: unknown; time?: { created: number; completed?: number } }
  parts: RunPart[]
}
export type RunPart = {
  id: string
  type: string
  tool?: string
  state?: {
    status: "pending" | "running" | "completed" | "error"
    input?: Record<string, unknown>
    title?: string
    output?: string
    error?: string
    time?: { start: number; end?: number }
  }
}

export type CallStatus = "pending" | "running" | "done" | "failed"
export type RunCall = {
  id: string
  tool: string
  /** What the row says: the call's own title, else the most telling argument, else the tool. */
  label: string
  status: CallStatus
  start?: number
  end?: number
  /** Inputs, one short line each, for "Called with". */
  args: string
  /** The output tail (or the error) for an opened call. */
  result: string
}

export type AgentState = "running" | "retry" | "done" | "failed"
export type RunNode = {
  id: string
  /** The agent's name ("build", "explore"…), capitalised for the box. */
  agent: string
  /** The session's title — what it was asked to do. */
  task: string
  model?: string
  state: AgentState
  cost: number
  start?: number
  end?: number
  calls: RunCall[]
  children: RunNode[]
}

export type RunStats = { agents: number; running: number; calls: number; errors: number; cost: number; start?: number; end?: number }

const RESULT_MAX = 600
const ARG_MAX = 160

const LABEL_KEYS = ["description", "command", "filePath", "file_path", "path", "pattern", "url", "query", "prompt"]

function short(value: unknown, max: number): string {
  const text = typeof value === "string" ? value : JSON.stringify(value)
  if (!text) return ""
  const one = text.replace(/\s+/g, " ").trim()
  return one.length > max ? one.slice(0, max - 1) + "…" : one
}

/** The row's words. A file path shows only its file name; everything else its first line. */
export function callLabel(tool: string, title: string | undefined, input: Record<string, unknown> | undefined): string {
  if (title?.trim()) return short(title, 80)
  for (const key of LABEL_KEYS) {
    const v = input?.[key]
    if (typeof v !== "string" || !v.trim()) continue
    if (key === "filePath" || key === "file_path" || key === "path") return v.split(/[\\/]/).filter(Boolean).pop() ?? v
    return short(v, 80)
  }
  return tool
}

export function callArgs(input: Record<string, unknown> | undefined): string {
  if (!input) return ""
  return short(
    Object.entries(input)
      .map(([k, v]) => `${k}: ${short(v, 60)}`)
      .join(", "),
    ARG_MAX,
  )
}

function tail(text: string | undefined): string {
  if (!text) return ""
  const t = text.trim()
  return t.length > RESULT_MAX ? "…" + t.slice(t.length - RESULT_MAX) : t
}

export function toCall(part: RunPart): RunCall | undefined {
  if (part.type !== "tool" || !part.tool || !part.state) return undefined
  const s = part.state
  const status: CallStatus =
    s.status === "completed" ? "done" : s.status === "error" ? "failed" : s.status === "running" ? "running" : "pending"
  return {
    id: part.id,
    tool: part.tool,
    label: callLabel(part.tool, s.title, s.input),
    status,
    start: s.time?.start,
    end: s.time?.end,
    args: callArgs(s.input),
    result: status === "failed" ? tail(s.error) : tail(s.output),
  }
}

/** "explore" → "Explore". A missing agent falls back to the title's "(@x subagent)" tag, then "Agent". */
export function agentName(messages: RunMessage[], title: string | undefined): string {
  const fromMessage = messages.find((m) => m.info.role === "assistant" && m.info.agent)?.info.agent
  const fromTitle = title?.match(/\(@([\w-]+) subagent\)/)?.[1]
  const name = fromMessage ?? fromTitle ?? "agent"
  return name.charAt(0).toUpperCase() + name.slice(1)
}

/** The title without opencode's "(@explore subagent)" suffix — the box already names the agent. */
export function taskTitle(title: string | undefined): string {
  return (title ?? "").replace(/\s*\(@[\w-]+ subagent\)\s*$/, "").trim() || "Untitled"
}

export function buildNode(input: {
  session: RunSession
  messages: RunMessage[]
  working: boolean
  retrying: boolean
  children: RunNode[]
}): RunNode {
  const { session, messages } = input
  const calls = messages.flatMap((m) => m.parts.map(toCall).filter((c): c is RunCall => !!c))
  const assistants = messages.filter((m) => m.info.role === "assistant")
  const last = assistants[assistants.length - 1]
  // Failed means the agent itself ended on an error (an aborted or errored turn) — a failed CALL it
  // recovered from is red on its row, not on the whole box.
  const state: AgentState = input.retrying ? "retry" : input.working ? "running" : last?.info.error ? "failed" : "done"
  const cost = session.cost ?? assistants.reduce((sum, m) => sum + (m.info.cost ?? 0), 0)
  const starts = [session.time?.created, ...calls.map((c) => c.start)].filter((n): n is number => typeof n === "number")
  const ends = [last?.info.time?.completed, session.time?.updated, ...calls.map((c) => c.end)].filter((n): n is number => typeof n === "number")
  return {
    id: session.id,
    agent: agentName(messages, session.title),
    task: taskTitle(session.title),
    model: last?.info.modelID ?? assistants[0]?.info.modelID,
    state,
    cost,
    start: starts.length ? Math.min(...starts) : undefined,
    end: state === "running" || state === "retry" ? undefined : ends.length ? Math.max(...ends) : undefined,
    calls,
    children: [...input.children].sort((a, b) => (a.start ?? 0) - (b.start ?? 0)),
  }
}

export function walk(node: RunNode): RunNode[] {
  return [node, ...node.children.flatMap(walk)]
}

/** Is anything in this run still working? A run stays Active until every agent in it has stopped. */
export function isActive(node: RunNode): boolean {
  return walk(node).some((n) => n.state === "running" || n.state === "retry")
}

export function runStats(root: RunNode): RunStats {
  const all = walk(root)
  const starts = all.map((n) => n.start).filter((n): n is number => n !== undefined)
  const active = isActive(root)
  const ends = all.map((n) => n.end).filter((n): n is number => n !== undefined)
  return {
    agents: all.length,
    running: all.filter((n) => n.state === "running" || n.state === "retry").length,
    calls: all.reduce((s, n) => s + n.calls.length, 0),
    errors: all.reduce((s, n) => s + n.calls.filter((c) => c.status === "failed").length, 0),
    cost: all.reduce((s, n) => s + n.cost, 0),
    start: starts.length ? Math.min(...starts) : undefined,
    end: active || !ends.length ? undefined : Math.max(...ends),
  }
}

/**
 * Where a call's bar sits on its agent's own timeline, in percent. A running call (or agent) runs
 * to `now`. A bar is never thinner than 4%, so a 50 ms read is still something you can see.
 */
export function bar(call: RunCall, node: RunNode, now: number): { left: number; width: number } {
  const from = node.start ?? call.start ?? now
  const to = Math.max(node.end ?? now, from + 1)
  const span = to - from
  const s = Math.min(Math.max((call.start ?? from) - from, 0), span)
  const e = Math.min(Math.max((call.end ?? now) - from, s), span)
  const width = Math.max((100 * (e - s)) / span, 4)
  const left = Math.min((100 * s) / span, 100 - width)
  return { left: Math.round(left * 10) / 10, width: Math.round(width * 10) / 10 }
}

export function callTime(call: RunCall, now: number): string {
  if (call.status === "running" || call.status === "pending") return "…"
  if (call.start === undefined || call.end === undefined) return ""
  return fmtDuration(call.end - call.start)
}

export function elapsed(start: number | undefined, end: number | undefined, now: number): string {
  if (start === undefined) return ""
  return fmtSeconds(((end ?? now) - start) / 1000)
}

export function money(n: number): string {
  if (!n) return "$0"
  return n < 0.01 ? `$${n.toFixed(3)}` : `$${n.toFixed(2)}`
}

/** The newest calls a box shows; the rest fold behind "+N earlier". */
export const CALLS_SHOWN = 4
export function visibleCalls(calls: RunCall[], all: boolean): { shown: RunCall[]; hidden: number } {
  if (all || calls.length <= CALLS_SHOWN) return { shown: calls, hidden: 0 }
  return { shown: calls.slice(-CALLS_SHOWN), hidden: calls.length - CALLS_SHOWN }
}

/** A finished sub-agent keeps its full box this long, so you see it land, then folds to one line. */
export const FOLD_AFTER_MS = 5000
export function folded(node: RunNode, now: number): boolean {
  if (node.state === "running" || node.state === "retry") return false
  return node.end !== undefined && now - node.end > FOLD_AFTER_MS
}

/** The sessions to start runs from: the top ancestor of everything working, plus the open chat. */
export function runRoots(input: {
  working: string[]
  info: (id: string) => RunSession | undefined
  current?: string
}): string[] {
  const top = (id: string) => {
    let at = id
    for (let i = 0; i < 20; i++) {
      const parent = input.info(at)?.parentID
      if (!parent) return at
      at = parent
    }
    return at
  }
  const ids = [...input.working, ...(input.current ? [input.current] : [])]
  return [...new Set(ids.map(top))]
}

/**
 * Active runs first (newest first), then Inactive — finished runs, newest first, capped. A run
 * moves to Inactive the moment its last agent stops; nothing is dropped while you watch.
 */
export const INACTIVE_MAX = 20
export function splitRuns(runs: RunNode[]): { active: RunNode[]; inactive: RunNode[] } {
  const newest = (a: RunNode, b: RunNode) => (b.start ?? 0) - (a.start ?? 0)
  return {
    active: runs.filter(isActive).sort(newest),
    inactive: runs.filter((r) => !isActive(r)).sort((a, b) => (b.end ?? 0) - (a.end ?? 0)).slice(0, INACTIVE_MAX),
  }
}
