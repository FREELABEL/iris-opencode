import { describe, expect, test } from "bun:test"
import { cronPeriodHours, scheduleVerdict, fleetRows, needsAttention } from "./hive-schedule-fleet"

/**
 * #188731 — a daily job on a laptop silently stopped whenever the laptop was asleep, and no
 * command anywhere could show it. These pin the verdict that `hive schedule list --all` prints.
 */

const NOW = new Date("2026-10-15T12:00:00Z")
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString()
const online = { name: "iris-hive-001", connection_status: "online" }

describe("cronPeriodHours", () => {
  test("daily, weekly, monthly, hourly, every-N-hours", () => {
    expect(cronPeriodHours("0 11 * * *")).toBe(24)
    expect(cronPeriodHours("0 14 * * 0")).toBe(168)
    expect(cronPeriodHours("0 9 1 * *")).toBe(744)
    expect(cronPeriodHours("0 * * * *")).toBe(1)
    expect(cronPeriodHours("0 */6 * * *")).toBe(6)
    expect(cronPeriodHours("*/15 * * * *")).toBe(1)
  })
})

describe("scheduleVerdict", () => {
  test("a healthy daily job is ok", () => {
    expect(scheduleVerdict(online, { cron: "0 11 * * *", last_run: hoursAgo(1), last_status: "completed" }, NOW)).toBe("ok")
  })

  test("THE CASE: a schedule on an offline machine is not running, whatever its last status", () => {
    const asleep = { name: "laptop", connection_status: "offline" }
    expect(scheduleVerdict(asleep, { cron: "0 11 * * *", last_run: hoursAgo(1), last_status: "completed" }, NOW)).toBe("node_offline")
  })

  test("a daily job not run for over two days is overdue even on an online node", () => {
    expect(scheduleVerdict(online, { cron: "0 11 * * *", last_run: hoursAgo(49), last_status: "completed" }, NOW)).toBe("overdue")
    expect(scheduleVerdict(online, { cron: "0 11 * * *", last_run: hoursAgo(30), last_status: "completed" }, NOW)).toBe("ok")
  })

  test("a weekly job five days old is fine", () => {
    expect(scheduleVerdict(online, { cron: "0 14 * * 0", last_run: hoursAgo(120), last_status: "completed" }, NOW)).toBe("ok")
  })

  test("a failed last run, a never-run job and a paused job are each named", () => {
    expect(scheduleVerdict(online, { cron: "0 11 * * *", last_run: hoursAgo(1), last_status: "failed" }, NOW)).toBe("failed")
    expect(scheduleVerdict(online, { cron: "0 11 * * *", last_run: null }, NOW)).toBe("never_ran")
    expect(scheduleVerdict({ name: "x", connection_status: "offline" }, { cron: "0 11 * * *", enabled: false }, NOW)).toBe("paused")
  })
})

describe("fleetRows", () => {
  test("flattens every node's schedules and flags the ones that need attention", () => {
    const rows = fleetRows([
      { ...online, local_schedules: [{ filename: "meal-plan-day.sh", cron: "0 11 * * *", last_run: hoursAgo(1), last_status: "completed" }] },
      { name: "laptop", connection_status: "offline", local_schedules: [{ filename: "old.sh", cron: "0 11 * * *" }] },
      { name: "empty", connection_status: "online", local_schedules: null },
    ], NOW)
    expect(rows.map((r) => [r.node, r.filename, r.verdict])).toEqual([
      ["iris-hive-001", "meal-plan-day.sh", "ok"],
      ["laptop", "old.sh", "node_offline"],
    ])
    expect(rows.filter((r) => needsAttention(r.verdict)).length).toBe(1)
  })
})
