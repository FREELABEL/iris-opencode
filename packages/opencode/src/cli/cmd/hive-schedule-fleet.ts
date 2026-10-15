/**
 * #188731 — a schedule on one machine was invisible everywhere else.
 *
 * A daily job ran on a laptop. When the laptop was asleep at fire time, the job simply did not
 * happen, and nothing anywhere said so: `iris schedules list` is the cloud registry and never
 * held it, and `iris hive schedule list` only asks the node you are sitting at. Measured
 * 2026-10-09: 23 runs in 45 days, then nothing for a week, discovered by a person reading a board.
 *
 * Every daemon already reports its schedules in its heartbeat (`local_schedules`). This turns
 * that report into a verdict per schedule, so one command answers "is anything scheduled that
 * is not actually running?" across every machine.
 */

export interface ReportedSchedule {
  id?: string
  filename?: string
  cron?: string
  enabled?: boolean
  running?: boolean
  last_run?: string | null
  last_status?: string | null
  run_count?: number
}

export interface ScheduleNode {
  name: string
  connection_status: string
  last_heartbeat_at?: string | null
  local_schedules?: ReportedSchedule[] | null
}

export type ScheduleVerdict = "ok" | "paused" | "node_offline" | "failed" | "never_ran" | "overdue"

/** Longest gap a cron expression allows between two fires, in hours. Coarse on purpose. */
export function cronPeriodHours(cron: string): number {
  const f = String(cron ?? "").trim().split(/\s+/)
  if (f.length < 5) return 24
  const [min, hour, dom, , dow] = f
  if (dow !== "*" && dom === "*") return 24 * 7
  if (dom !== "*") return 24 * 31
  if (hour === "*" || hour.startsWith("*/")) {
    const step = hour.startsWith("*/") ? Number(hour.slice(2)) || 1 : 1
    return min.startsWith("*") ? 1 : step
  }
  return 24
}

export function scheduleVerdict(node: ScheduleNode, s: ReportedSchedule, now = new Date()): ScheduleVerdict {
  if (s.enabled === false) return "paused"
  // The case that cost a week: the schedule is fine, the machine it lives on is not there.
  if (node.connection_status !== "online") return "node_offline"
  if (s.last_status && !["completed", "running"].includes(s.last_status)) return "failed"
  if (!s.last_run) return "never_ran"
  const ageH = (now.getTime() - new Date(s.last_run).getTime()) / 3_600_000
  // One full period of slack: a daily job last run 30h ago is late but not alarming; 48h+ is.
  if (ageH > cronPeriodHours(s.cron ?? "") * 2) return "overdue"
  return "ok"
}

export interface FleetRow {
  node: string
  filename: string
  cron: string
  lastRun: string | null
  lastStatus: string | null
  verdict: ScheduleVerdict
}

export function fleetRows(nodes: ScheduleNode[], now = new Date()): FleetRow[] {
  const rows: FleetRow[] = []
  for (const n of nodes) {
    for (const s of n.local_schedules ?? []) {
      rows.push({
        node: n.name,
        filename: String(s.filename ?? "?"),
        cron: String(s.cron ?? ""),
        lastRun: s.last_run ?? null,
        lastStatus: s.last_status ?? null,
        verdict: scheduleVerdict(n, s, now),
      })
    }
  }
  return rows
}

/** Anything other than ok/paused means a job that should be running is not. */
export function needsAttention(v: ScheduleVerdict): boolean {
  return v !== "ok" && v !== "paused"
}
