/**
 * Reading fl-api's heartbeat records into rows (#189245) — moved verbatim from the Desktop sidecar
 * (iris/1.18.23 packages/opencode/src/iris/heartbeats.ts) so the CLI, the daemon SDK and Desktop
 * turn the same raw job + execution rows into the same HeartbeatRow. Pure: no network here; each
 * caller fetches with its own auth and hands the JSON in.
 *
 * A heartbeat is an agent's own schedule: a `bloq_scheduled_jobs` row whose task is `heartbeat`,
 * and one `agent_job_executions` row per beat, both on fl-api under
 * `/api/v1/users/{id}/bloqs/scheduled-jobs?agent_jobs_only=1` and `…/{job}/executions`.
 */
import type { HeartbeatRow, HeartbeatRun } from "./heartbeats"

/** Statuses a heartbeat can be in and still be yours to look at. Cancelled/completed are gone. */
export const LIVE_STATUSES: ReadonlySet<string> = new Set(["scheduled", "running", "paused", "failed"])
/** Runs to ask for per heartbeat: a week of anything slower than every 4 hours. */
export const RUNS_PER_ROW = 50
export const TIMELINE = 10
const RESPONSE_CAP = 6000

const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : v
  return typeof n === "number" && Number.isFinite(n) ? n : null
}
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null)

export function isHeartbeatJob(j: any): boolean {
  if (!j || j.agent_id == null) return false
  return j.task_name === "heartbeat" || j.data?.type === "heartbeat"
}

export function readRun(e: any, keepResponse = true): HeartbeatRun {
  const err = str(e?.error_message)
  return {
    id: num(e?.id) ?? 0,
    status: String(e?.status ?? "unknown"),
    startedAt: str(e?.started_at),
    completedAt: str(e?.completed_at),
    durationMs: num(e?.duration_ms) ?? (num(e?.duration_seconds) != null ? num(e?.duration_seconds)! * 1000 : null),
    tokens: num(e?.tokens_used),
    model: str(e?.model_used),
    preview: str(e?.response_preview),
    response: keepResponse ? (str(e?.response)?.slice(0, RESPONSE_CAP) ?? null) : null,
    error: err,
    itemId: num(e?.bloq_item_id),
    deliverableId: num(e?.deliverable_id),
    publicUrl: str(e?.public_url),
    emailSent: typeof e?.email_sent === "boolean" ? e.email_sent : null,
  }
}

/** settings.schedule → the enforced gate, normalised ("tuesday" → "tue"); null when off. */
export function readSchedule(sc: any): HeartbeatRow["schedule"] {
  if (!sc || typeof sc !== "object" || sc.enabled !== true) return null
  const days = Array.isArray(sc.working_days) ? sc.working_days.map((d: unknown) => String(d).slice(0, 3).toLowerCase()) : []
  const h = sc.active_hours
  const hours = h && typeof h.start === "string" && typeof h.end === "string" ? { start: h.start, end: h.end } : null
  // iris-api's default when the schedule names none (checkAgentSchedule)
  return { timezone: str(sc.timezone) ?? "America/New_York", days, hours }
}

export function readHeartbeat(j: any, runs: any[] | null): HeartbeatRow {
  const agent = j?.agent ?? {}
  const last = j?.last_result && typeof j.last_result === "object" ? j.last_result : null
  const lastOk = last ? (last.success === false ? false : last.success === true ? true : null) : null
  return {
    jobId: num(j?.id) ?? 0,
    agentId: num(j?.agent_id) ?? 0,
    agentName: String(agent.name ?? j?.data?.agent_name ?? j?.workflowName ?? `Agent ${j?.agent_id}`),
    bloqId: num(j?.bloq_id),
    bloqName: str(j?.bloq?.name),
    mode: str(j?.data?.mode) ?? (typeof agent.heartbeat_mode === "string" ? agent.heartbeat_mode : null),
    frequency: str(j?.frequency),
    status: String(j?.status ?? "unknown"),
    agentActive: typeof agent.active === "boolean" ? agent.active : null,
    nextRunAt: str(j?.next_run_at),
    lastRunAt: str(j?.last_run_at),
    runCount: num(j?.run_count) ?? 0,
    consecutiveFailures: num(agent.consecutive_failures) ?? 0,
    lastOk,
    lastError: lastOk === false ? (str(last?.error) ?? str(last?.message) ?? null) : null,
    reportTo: Array.isArray(j?.data?.report_emails) ? j.data.report_emails.length : 0,
    tools: Array.isArray(j?.data?.required_tools) ? j.data.required_tools.length : 0,
    workingDays: Array.isArray(agent.settings?.heartbeat_working_days)
      ? agent.settings.heartbeat_working_days.map((d: unknown) => String(d).slice(0, 3).toLowerCase())
      : null,
    schedule: readSchedule(agent.settings?.schedule),
    settingsFrequency: str(agent.settings?.heartbeat_frequency),
    timezone: str(j?.timezone),
    lastSkip:
      last && last.skipped === true
        ? { at: str(last.skipped_at), reason: str(last.skip_reason), kind: str(last.skip_kind) }
        : null,
    // Full reports for the beats the timeline shows; the rest feed the week chart only.
    runs: (runs ?? []).map((e, i) => readRun(e, i < TIMELINE)),
    runsMeasured: runs !== null,
  }
}

/** fl-api answers `{data: [...]}` or `{data: {data: [...]}}` (paginated); either way, the array. */
export const unwrap = (j: any): any[] => {
  const d = j?.data ?? j
  return Array.isArray(d) ? d : Array.isArray(d?.data) ? d.data : []
}
