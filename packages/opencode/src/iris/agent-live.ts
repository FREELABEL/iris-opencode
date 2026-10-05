/**
 * A live view of a running agent, and "Take over" / "Hand back" (#187921).
 *
 * On 28 Sep a Pathways user asked three times whether her agent was stuck during a 75-minute
 * Drive rename loop. Her screen said "Thinking"; the answer was in telemetry she could not see.
 * iris-api now keeps, per run, the current step (which iteration, which phase, how long on it)
 * and the last N tool calls (name, argument SHAPE, status, duration — never argument values),
 * and lets the run's owner pause it at the next step boundary and hand it back.
 *
 * This module is the sidecar half: the desktop webview cannot read the token on disk, so it asks
 * the sidecar, which asks iris-api. Everything lives on IRIS_API, not FL_API — a call to the wrong
 * host 404s, and a 404 here reads as "no such run".
 *
 * `read*` functions are pure, so the shape the panel depends on is tested without a network.
 */
import { IRIS_API, irisFetch } from "./platform"

export type LiveToolCall = {
  tool: string
  iteration: number
  /** Argument keys → value type/length, e.g. { name: "string(12)" }. Values never leave the server. */
  args: Record<string, string>
  /** Same fingerprint twice = the same call again. */
  fingerprint: string
  status: "running" | "success" | "error" | "held" | "skipped"
  error?: string
  startedAt: string
  durationMs?: number
}

export type LiveStep = {
  iteration: number
  maxIterations?: number
  phase: string
  tool?: string
  since?: string
  secondsOnStep?: number
}

export type LiveTakeover = {
  id: number
  status: "pause_requested" | "paused" | "resuming" | "resumed" | "cancelled" | "expired"
  pausedAtIteration?: number
}

export type LiveRun = {
  runId: string
  workflowId?: string
  agentId?: number
  status: string
  startedAt?: string
  finishedAt?: string
  lastEventAt?: string
  secondsSinceLastEvent?: number
  step: LiveStep | null
  toolCalls: LiveToolCall[]
  takeover: LiveTakeover | null
}

type Result<T> = { measured: boolean; reason?: string; data: T }

const str = (v: unknown) => (v === null || v === undefined ? "" : String(v))
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined)
const opt = (v: unknown) => (v === null || v === undefined || v === "" ? undefined : String(v))

const TOOL_STATUSES = new Set(["running", "success", "error", "held", "skipped"])
const TAKEOVER_STATUSES = new Set(["pause_requested", "paused", "resuming", "resumed", "cancelled", "expired"])

export function readToolCall(c: any): LiveToolCall {
  const args: Record<string, string> = {}
  if (c?.args && typeof c.args === "object") for (const [k, v] of Object.entries(c.args)) args[k] = str(v)
  return {
    tool: str(c?.tool) || "unknown",
    iteration: num(c?.iteration) ?? 0,
    args,
    fingerprint: str(c?.args_fingerprint),
    status: TOOL_STATUSES.has(c?.status) ? c.status : "running",
    error: opt(c?.error),
    startedAt: str(c?.started_at),
    durationMs: num(c?.duration_ms),
  }
}

export function readTakeover(t: any): LiveTakeover | null {
  if (!t || typeof t !== "object" || !TAKEOVER_STATUSES.has(t.status)) return null
  return { id: num(t.id) ?? 0, status: t.status, pausedAtIteration: num(t.paused_at_iteration) }
}

export function readLiveRun(r: any): LiveRun | null {
  if (!r || typeof r !== "object" || !r.run_id) return null
  const s = r.current_step
  return {
    runId: str(r.run_id),
    workflowId: opt(r.workflow_id),
    agentId: num(r.agent_id),
    status: str(r.status) || "unknown",
    startedAt: opt(r.started_at),
    finishedAt: opt(r.finished_at),
    lastEventAt: opt(r.last_event_at),
    secondsSinceLastEvent: num(r.seconds_since_last_event),
    step:
      s && typeof s === "object"
        ? {
            iteration: num(s.iteration) ?? 0,
            maxIterations: num(s.max_iterations),
            phase: str(s.phase) || "unknown",
            tool: opt(s.tool),
            since: opt(s.since),
            secondsOnStep: num(s.seconds_on_step),
          }
        : null,
    toolCalls: Array.isArray(r.recent_tool_calls) ? r.recent_tool_calls.map(readToolCall) : [],
    takeover: readTakeover(r.takeover),
  }
}

function failure(j: any, status: number): string {
  const msg = j?.error ?? j?.message
  if (status === 401) return "not signed in to IRIS — run `iris auth login`"
  if (status === 404) return "not found — or not yours to watch"
  return msg ? `iris-api ${status}: ${msg}` : `iris-api ${status}`
}

/** The agent's current (or most recent) run. `run: null` = nothing has run recently. */
export async function fetchAgentLive(agentId: number, limit = 10): Promise<Result<{ run: LiveRun | null }>> {
  try {
    const res = await irisFetch(`/api/v1/agents/${agentId}/live?limit=${limit}`, IRIS_API)
    const j = (await res.json().catch(() => ({}))) as any
    if (!res.ok) return { measured: false, reason: failure(j, res.status), data: { run: null } }
    return { measured: true, data: { run: readLiveRun(j?.run) } }
  } catch (e) {
    return { measured: false, reason: e instanceof Error ? e.message : String(e), data: { run: null } }
  }
}

export type ControlResult = { ok: boolean; reason?: string; message?: string; takeover?: LiveTakeover | null }

async function control(runId: string, action: "take-over" | "hand-back", body: unknown): Promise<ControlResult> {
  try {
    const res = await irisFetch(`/api/v1/runs/${encodeURIComponent(runId)}/${action}`, IRIS_API, {
      method: "POST",
      body: JSON.stringify(body ?? {}),
    })
    const j = (await res.json().catch(() => ({}))) as any
    if (!res.ok) return { ok: false, reason: failure(j, res.status) }
    return { ok: true, message: opt(j?.message), takeover: readTakeover(j?.takeover) }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
}

/** Pause the run after the step it is on finishes. */
export function takeOverRun(runId: string): Promise<ControlResult> {
  return control(runId, "take-over", {})
}

/** Resume it; `message`, if given, is what the agent is told when it continues. */
export function handBackRun(runId: string, message?: string): Promise<ControlResult> {
  const text = message?.trim()
  return control(runId, "hand-back", text ? { message: text } : {})
}
