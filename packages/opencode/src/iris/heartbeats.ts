/**
 * Agents › Heartbeats (#189110) — the sidecar half.
 *
 * A heartbeat is an agent's own schedule: a `bloq_scheduled_jobs` row whose task is `heartbeat`,
 * and one `agent_job_executions` row per beat. Both live on fl-api, scoped to the signed-in user
 * — the same calls `iris schedules` and `iris monitor agent` make. NOT the iris-api monitor
 * overview: that one is operator-only and lists every tenant.
 *
 * Why the runs come along with the list: a heartbeat row that says `scheduled` is not evidence it
 * is beating. Measured 2026-10-12, an autonomous agent read `scheduled` with `next_run_at` three
 * days in the past. Only the run history (and the clock) can tell a live schedule from a stopped
 * one, so the panel never shows one without the other.
 *
 * `read*` functions are pure, so the shapes the panel depends on are tested without a network.
 */
import { irisFetch, resolveUserId, tokenSource } from "./platform"

type Result<T> = { measured: boolean; reason?: string; data: T }

export type HeartbeatRun = {
  id: number
  status: string
  startedAt: string | null
  completedAt: string | null
  durationMs: number | null
  tokens: number | null
  model: string | null
  preview: string | null
  /** The run's own report (markdown), capped. What the beat-detail sections are read from. */
  response: string | null
  error: string | null
  /** What it left behind — any of these may be absent. */
  itemId: number | null
  deliverableId: number | null
  publicUrl: string | null
  emailSent: boolean | null
}

export type HeartbeatRow = {
  jobId: number
  agentId: number
  agentName: string
  bloqId: number | null
  bloqName: string | null
  /** passive | reactive | autonomous | briefing — what the agent does on each beat. */
  mode: string | null
  frequency: string | null
  /** The job's own status: scheduled, running, paused, failed. */
  status: string
  agentActive: boolean | null
  nextRunAt: string | null
  lastRunAt: string | null
  runCount: number
  consecutiveFailures: number
  /** The last beat's own verdict, from the job — present even when runs could not be read. */
  lastOk: boolean | null
  lastError: string | null
  reportTo: number
  tools: number
  /** settings.heartbeat_working_days — the days it wakes. Null = not set (every day). */
  workingDays: string[] | null
  /** Newest first. Empty with `runsMeasured: false` means NOT READ, not "never ran". */
  runs: HeartbeatRun[]
  runsMeasured: boolean
}

/** Statuses a heartbeat can be in and still be yours to look at. Cancelled/completed are gone. */
const LIVE = new Set(["scheduled", "running", "paused", "failed"])
// A week of an hourly heartbeat is 168; 50 is fl-api's default page and covers every cadence
// slower than every 4 hours for a full week, which is all but two of the live ones.
const RUNS_PER_ROW = 50
const RESPONSE_CAP = 6000
export const TIMELINE = 10
const MAX_ROWS = 60

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
    // Full reports for the beats the timeline shows; the rest feed the week chart only.
    runs: (runs ?? []).map((e, i) => readRun(e, i < TIMELINE)),
    runsMeasured: runs !== null,
  }
}

const unwrap = (j: any): any[] => {
  const d = j?.data ?? j
  return Array.isArray(d) ? d : Array.isArray(d?.data) ? d.data : []
}

async function failure(res: Response): Promise<string> {
  const j = (await res.json().catch(() => null)) as any
  const msg = j?.message ?? j?.error
  return typeof msg === "string" && msg ? `fl-api ${res.status}: ${msg}` : `fl-api ${res.status}`
}

export async function fetchHeartbeats(): Promise<Result<{ heartbeats: HeartbeatRow[] }>> {
  const userId = await resolveUserId()
  if (!userId) return { measured: false, reason: `not signed in (token: ${tokenSource()})`, data: { heartbeats: [] } }
  try {
    const res = await irisFetch(`/api/v1/users/${userId}/bloqs/scheduled-jobs?agent_jobs_only=1`)
    if (!res.ok) return { measured: false, reason: await failure(res), data: { heartbeats: [] } }
    const jobs = unwrap(await res.json())
      .filter((j) => isHeartbeatJob(j) && LIVE.has(String(j.status)))
      .slice(0, MAX_ROWS)
    const heartbeats = await Promise.all(
      jobs.map(async (j) => {
        try {
          const r = await irisFetch(`/api/v1/users/${userId}/bloqs/scheduled-jobs/${j.id}/executions?limit=${RUNS_PER_ROW}`)
          return readHeartbeat(j, r.ok ? unwrap(await r.json()) : null)
        } catch {
          return readHeartbeat(j, null)
        }
      }),
    )
    return { measured: true, data: { heartbeats } }
  } catch (e) {
    return { measured: false, reason: e instanceof Error ? e.message : String(e), data: { heartbeats: [] } }
  }
}

export type HeartbeatAction = { ok: boolean; reason?: string; status?: string }

/** One beat, now, outside the schedule — `iris schedules run`. */
export async function runHeartbeat(jobId: number): Promise<HeartbeatAction> {
  const userId = await resolveUserId()
  if (!userId) return { ok: false, reason: "not signed in" }
  try {
    const res = await irisFetch(`/api/v1/users/${userId}/bloqs/scheduled-jobs/${jobId}/run`, undefined, { method: "POST" })
    if (!res.ok) return { ok: false, reason: await failure(res) }
    return { ok: true, status: "running" }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * Pause or resume. `is_active` is the field every CLI sends and fl-api maps it to
 * paused/scheduled (#179802). The answer is the status fl-api SAVED, read back — not the one
 * asked for, because a 200 that changed nothing is how that bug hid.
 */
export async function setHeartbeatPaused(jobId: number, paused: boolean): Promise<HeartbeatAction> {
  const userId = await resolveUserId()
  if (!userId) return { ok: false, reason: "not signed in" }
  try {
    const res = await irisFetch(`/api/v1/users/${userId}/bloqs/scheduled-jobs/${jobId}`, undefined, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ is_active: !paused }),
    })
    if (!res.ok) return { ok: false, reason: await failure(res) }
    const saved = String(((await res.json().catch(() => null)) as any)?.data?.status ?? "")
    const want = paused ? "paused" : "scheduled"
    if (saved !== want) return { ok: false, status: saved || undefined, reason: `fl-api saved "${saved || "nothing"}", not "${want}"` }
    return { ok: true, status: saved }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
}
