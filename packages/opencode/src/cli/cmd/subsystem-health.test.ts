import { describe, expect, test } from "bun:test"
import { assessScheduler, assessBridge, humanizeAge, formatBanner } from "./subsystem-health"

const NOW = Date.parse("2026-08-19T12:00:00Z")
const HOUR = 3600_000
const DAY = 24 * HOUR

const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString()

describe("assessScheduler", () => {
  test("stays silent when schedules are firing on time", () => {
    const rows = [
      { status: "scheduled", next_run_at: at(10 * 60_000) },
      { status: "scheduled", next_run_at: at(HOUR) },
      { status: "scheduled", next_run_at: at(3 * HOUR) },
    ]
    expect(assessScheduler(rows, NOW)).toBeNull()
  })

  test("stays silent when only SOME jobs are overdue — that is a job problem, not an outage", () => {
    const rows = [
      { status: "scheduled", next_run_at: at(-3 * DAY) }, // one wedged job
      { status: "scheduled", next_run_at: at(HOUR) },
      { status: "scheduled", next_run_at: at(2 * HOUR) },
    ]
    expect(assessScheduler(rows, NOW)).toBeNull()
  })

  test("stays silent under three due schedules — too small a sample to call an outage", () => {
    const rows = [
      { status: "scheduled", next_run_at: at(-4 * DAY) },
      { status: "scheduled", next_run_at: at(-4 * DAY) },
    ]
    expect(assessScheduler(rows, NOW)).toBeNull()
  })

  test("stays silent when everything is overdue by only minutes — normal queue lag", () => {
    const rows = [
      { status: "scheduled", next_run_at: at(-5 * 60_000) },
      { status: "scheduled", next_run_at: at(-9 * 60_000) },
      { status: "scheduled", next_run_at: at(-2 * 60_000) },
    ]
    expect(assessScheduler(rows, NOW)).toBeNull()
  })

  test("reports DOWN when every due schedule is overdue by days — the June outage shape", () => {
    const rows = [
      { status: "scheduled", next_run_at: at(-4 * DAY) },
      { status: "scheduled", next_run_at: at(-3 * DAY) },
      { status: "active", next_run_at: at(-2 * DAY) },
      { status: "scheduled", next_run_at: at(-30 * HOUR) },
    ]
    const d = assessScheduler(rows, NOW)
    expect(d).not.toBeNull()
    expect(d!.severity).toBe("down")
    expect(d!.component).toBe("Scheduler")
    expect(d!.what).toContain("4 days")
    expect(d!.what).toContain("all 4 due schedules")
    // The escape hatch is the whole point of the banner.
    expect(d!.actions.map((a) => a.command)).toContain("iris schedules run <id>")
  })

  test("reports DEGRADED between one hour and one day", () => {
    const rows = [
      { status: "scheduled", next_run_at: at(-2 * HOUR) },
      { status: "scheduled", next_run_at: at(-3 * HOUR) },
      { status: "scheduled", next_run_at: at(-5 * HOUR) },
    ]
    const d = assessScheduler(rows, NOW)
    expect(d!.severity).toBe("degraded")
    expect(d!.what).toContain("5 hours")
  })

  test("paused schedules are excluded — a paused job not running is correct behaviour", () => {
    const rows = [
      { status: "paused", next_run_at: at(-9 * DAY) },
      { status: "paused", next_run_at: at(-9 * DAY) },
      { status: "paused", next_run_at: at(-9 * DAY) },
      { status: "scheduled", next_run_at: at(2 * HOUR) },
    ]
    // Only one live schedule remains and it is on time; the paused backlog must
    // not manufacture an outage for anyone who parks schedules.
    expect(assessScheduler(rows, NOW)).toBeNull()
  })

  test("completed one-offs are excluded from the due set", () => {
    const rows = [
      { status: "completed", next_run_at: at(-30 * DAY) },
      { status: "cancelled", next_run_at: at(-30 * DAY) },
      { status: "scheduled", next_run_at: at(HOUR) },
    ]
    expect(assessScheduler(rows, NOW)).toBeNull()
  })

  test("rows without next_run_at cannot be overdue", () => {
    const rows = [
      { status: "scheduled", next_run_at: null },
      { status: "scheduled", next_run_at: null },
      { status: "scheduled", next_run_at: null },
    ]
    expect(assessScheduler(rows, NOW)).toBeNull()
  })

  test("an empty list says nothing", () => {
    expect(assessScheduler([], NOW)).toBeNull()
  })
})

describe("assessBridge", () => {
  test("silent when reachable", () => {
    expect(assessBridge({ reachable: true })).toBeNull()
  })

  test("connection refused reads as down, and names the port", () => {
    const d = assessBridge({ reachable: false, networkError: "connection refused" })
    expect(d!.severity).toBe("down")
    expect(d!.what).toContain("localhost:3200")
    expect(d!.consequence).toContain("look empty rather than disconnected")
  })

  test("an HTTP error reads as degraded, not down — it is running, just not serving", () => {
    const d = assessBridge({ reachable: false, status: 503 })
    expect(d!.severity).toBe("degraded")
    expect(d!.what).toContain("503")
  })
})

describe("humanizeAge", () => {
  test("coarse units, correct pluralisation", () => {
    expect(humanizeAge(4 * DAY)).toBe("4 days")
    expect(humanizeAge(DAY)).toBe("1 day")
    expect(humanizeAge(5 * HOUR)).toBe("5 hours")
    expect(humanizeAge(HOUR)).toBe("1 hour")
    expect(humanizeAge(90_000)).toBe("1 minute")
    // Never "0 minutes" — anything under a minute still rounds up to one.
    expect(humanizeAge(400)).toBe("1 minute")
  })
})

describe("formatBanner", () => {
  test("carries all three parts: what, consequence, and a way out", () => {
    const rows = [
      { status: "scheduled", next_run_at: at(-4 * DAY) },
      { status: "scheduled", next_run_at: at(-4 * DAY) },
      { status: "scheduled", next_run_at: at(-4 * DAY) },
    ]
    const lines = formatBanner(assessScheduler(rows, NOW)!)
    expect(lines).toHaveLength(3)
    const text = lines.join("\n")
    expect(text).toContain("Scheduler")
    expect(text).toContain("overdue")
    expect(text).toContain("nothing is firing on its own")
    expect(text).toContain("iris schedules run <id>")
  })
})
