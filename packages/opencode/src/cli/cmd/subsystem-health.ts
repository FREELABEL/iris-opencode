import { UI } from "../ui"
import { dim } from "./iris-api"

// ============================================================================
// Degraded-mode banners (#180927)
//
// `iris doctor` already checks everything. The problem is that you have to
// KNOW to run it. In June a scheduling outage ran for four days: agent work
// silently stopped firing, the alerting was dead too, and `iris schedules
// list` cheerfully printed a list of jobs that were never going to run. Every
// surface reported intent, not result.
//
// A banner fixes that only if it says three things, in this order:
//
//   1. WHAT is broken        — name the component, not "something went wrong"
//   2. WHAT IT MEANS for you — the consequence you are actually living with
//   3. WHAT YOU CAN STILL DO — the escape hatch, as a runnable command
//
// A warning without (3) is just anxiety. A warning without (1) is unactionable.
//
// The assess* functions below are PURE and exported so the thresholds can be
// tested without a live server — the same reason aiProviderHealth is exported
// from platform-doctor.
// ============================================================================

export type Severity = "down" | "degraded"

export interface Degradation {
  /** The component that is not working, named the way an operator would name it. */
  component: string
  severity: Severity
  /** What is broken. One sentence, specific, ideally with the evidence in it. */
  what: string
  /** What that means for the user right now. */
  consequence: string
  /** Commands that still work — the escape hatch. Empty is allowed but rare. */
  actions: { label: string; command: string }[]
}

const HOUR = 3600_000
const DAY = 24 * HOUR

/** "4 days" / "3 hours" / "25 minutes" — coarse on purpose; precision implies false confidence. */
export function humanizeAge(ms: number): string {
  if (ms >= DAY) {
    const d = Math.floor(ms / DAY)
    return `${d} day${d === 1 ? "" : "s"}`
  }
  if (ms >= HOUR) {
    const h = Math.floor(ms / HOUR)
    return `${h} hour${h === 1 ? "" : "s"}`
  }
  const m = Math.max(1, Math.floor(ms / 60_000))
  return `${m} minute${m === 1 ? "" : "s"}`
}

export interface ScheduleLike {
  status?: string | null
  next_run_at?: string | null
  last_run_at?: string | null
}

const LIVE_STATUSES = ["scheduled", "running", "paused", "active", "enabled"]

/**
 * Decide whether the SCHEDULER is failing, from schedule rows we already fetched.
 *
 * The distinction that matters — and the reason this is not just an "overdue"
 * count — is between one job being stuck and the whole scheduler being dead:
 *
 *   some jobs overdue  -> those jobs have a problem. Not a subsystem banner.
 *   EVERY due job overdue -> nothing is firing. That is the subsystem.
 *
 * Requiring "every due job" is deliberately strict. A banner that cries wolf on
 * a single wedged job gets ignored, and an ignored banner is worse than none —
 * it trains people past the exact signal this exists to deliver.
 *
 * `paused` rows are excluded from the due set: a paused job not running is the
 * system working correctly, and counting it would manufacture false positives
 * for anyone who parks schedules.
 *
 * Returns null when there is nothing to say — the common case, and the one that
 * has to stay silent.
 */
export function assessScheduler(schedules: ScheduleLike[], now: number = Date.now()): Degradation | null {
  const due = schedules.filter((s) => {
    const status = String(s.status ?? "").toLowerCase()
    if (status === "paused") return false
    if (status && !LIVE_STATUSES.includes(status)) return false
    return Boolean(s.next_run_at)
  })

  // Below three, "all of them are overdue" is not evidence of anything. One
  // stuck job out of one is a job problem, not an outage.
  if (due.length < 3) return null

  const overdue = due.filter((s) => new Date(String(s.next_run_at)).getTime() < now)
  if (overdue.length !== due.length) return null

  const worstMs = Math.max(...overdue.map((s) => now - new Date(String(s.next_run_at)).getTime()))

  // Under an hour is normal lag on a busy queue, not an outage.
  if (worstMs < HOUR) return null

  const severity: Severity = worstMs >= DAY ? "down" : "degraded"
  const age = humanizeAge(worstMs)

  return {
    component: "Scheduler",
    severity,
    what: `all ${due.length} due schedule${due.length === 1 ? "" : "s"} are overdue, the oldest by ${age}`,
    consequence:
      "Your schedules are saved and intact, but nothing is firing on its own — recurring agent work has stopped without failing.",
    actions: [
      { label: "Run one now", command: "iris schedules run <id>" },
      { label: "Diagnose", command: "iris schedules diagnose" },
      { label: "Full check", command: "iris doctor" },
    ],
  }
}

export interface BridgeProbe {
  reachable: boolean
  status?: number
  /** Set when fetch() itself rejected — connection refused, DNS, timeout. */
  networkError?: string
}

/**
 * Decide whether the LOCAL BRIDGE is failing.
 *
 * The bridge is the daemon on the user's own machine that carries calendar,
 * mail, iMessage and Hive dispatch. When it is not running, those features do
 * not error — they return nothing, which reads as "no data" rather than "not
 * connected". That ambiguity is the whole reason this banner exists.
 */
export function assessBridge(probe: BridgeProbe): Degradation | null {
  if (probe.reachable) return null

  const actions = [
    { label: "Check", command: "iris hive doctor" },
    { label: "Start it", command: "iris daemon start" },
  ]

  if (probe.networkError) {
    return {
      component: "Local bridge",
      severity: "down",
      what: `nothing is answering on localhost:3200 (${probe.networkError})`,
      consequence:
        "Calendar, Apple Mail, iMessage and Hive dispatch cannot be read — they will look empty rather than disconnected.",
      actions,
    }
  }

  return {
    component: "Local bridge",
    severity: "degraded",
    what: `the bridge answered with HTTP ${probe.status ?? "an error"}`,
    consequence:
      "It is running but not serving requests, so local channel reads may return nothing rather than failing.",
    actions,
  }
}

/**
 * Render one degradation as a banner.
 *
 * Deliberately not a box: this prints above real output that the user asked
 * for, and a heavy frame would compete with it. The severity word carries the
 * weight, and the actions are indented under the consequence so the eye lands
 * on "what can I do" last.
 */
export function formatBanner(d: Degradation): string[] {
  const mark = d.severity === "down" ? UI.Style.TEXT_DANGER : UI.Style.TEXT_WARNING
  const label = d.severity === "down" ? "unavailable" : "degraded"
  const lines: string[] = []

  lines.push(`  ${mark}▲ ${d.component} ${label}${UI.Style.TEXT_NORMAL} ${dim("— " + d.what)}`)
  lines.push(`  ${dim(d.consequence)}`)
  if (d.actions.length > 0) {
    const acts = d.actions.map((a) => `${a.label}: ${a.command}`).join(dim("  ·  "))
    lines.push(`  ${dim(acts)}`)
  }
  return lines
}

/** Print any degradations, then a blank line. No-op when the array is empty. */
export function printDegradations(degradations: (Degradation | null)[]): void {
  const real = degradations.filter((d): d is Degradation => d !== null)
  if (real.length === 0) return
  for (const d of real) {
    for (const line of formatBanner(d)) console.log(line)
  }
  console.log("")
}
