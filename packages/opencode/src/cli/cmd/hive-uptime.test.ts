import { describe, expect, test } from "bun:test"
import { describeUptime, restartsInWindow, formatDuration, LOOP_WINDOW_MS } from "./hive-uptime"

/**
 * #182434 — `hive nodes list` showed ONLINE for a machine crash-looping every thirty seconds.
 * The cloud marks a node offline only when it MISSES heartbeats, and a looping daemon
 * heartbeats once per restart, so it never misses one. Work kept being dispatched there and
 * hung to timeout, which reads as a broken transport rather than a machine that went away.
 */

const NOW = Date.parse("2026-08-27T12:00:00Z")
const agoMs = (ms: number) => new Date(NOW - ms).toISOString()

describe("describeUptime", () => {
  test("a long-lived node reads as stable", () => {
    const r = describeUptime({ uptime_seconds: 8 * 3600 + 12 * 60, connection_status: "online" }, NOW)
    expect(r.kind).toBe("stable")
    expect((r as any).label).toBe("up 8h 12m")
  })

  test("repeated restarts inside the window read as LOOPING, not as a fresh boot", () => {
    // The case the whole gap is about: uptime is small AND keeps resetting.
    const r = describeUptime(
      {
        uptime_seconds: 12,
        connection_status: "online",
        recent_restarts: [agoMs(30_000), agoMs(90_000), agoMs(150_000)],
      },
      NOW,
    )
    expect(r.kind).toBe("looping")
    expect((r as any).restarts).toBe(3)
  })

  test("ONE restart is not a loop — that is a deploy or a lid close", () => {
    // A threshold of one would fire on every legitimate daemon update, and an alarm that is
    // always on is an alarm nobody reads.
    const r = describeUptime(
      { uptime_seconds: 20, connection_status: "online", recent_restarts: [agoMs(10_000)] },
      NOW,
    )
    expect(r.kind).toBe("stable")
  })

  test("old restarts age out — a machine that looped yesterday and is fine now is fine now", () => {
    const r = describeUptime(
      {
        uptime_seconds: 40_000,
        connection_status: "online",
        recent_restarts: [agoMs(LOOP_WINDOW_MS * 4), agoMs(LOOP_WINDOW_MS * 5)],
      },
      NOW,
    )
    expect(r.kind).toBe("stable")
  })

  // ── the rule that this whole ticket exists to enforce ────────────────────────

  test("a MISSING uptime is never rendered as a measurement", () => {
    // "up 0s" would say the node just booted. The truth is that nobody measured it.
    const r = describeUptime({ connection_status: "online" }, NOW)
    expect(r.kind).toBe("unknown")
    expect((r as any).label).toBeUndefined()
  })

  test("an online node with no uptime is told it has an OLD DAEMON, specifically", () => {
    const r = describeUptime({ connection_status: "online" }, NOW)
    expect((r as any).reason).toContain("predates")
    expect((r as any).reason).toContain("update it")
  })

  test("an offline node is not blamed on an old daemon", () => {
    // Different not-knowing, different next step. Collapsing the two is how a fleet gets
    // told to upgrade daemons that are simply switched off.
    const r = describeUptime({ connection_status: "offline" }, NOW)
    expect(r.kind).toBe("unknown")
    expect((r as any).reason).not.toContain("predates")
  })

  test("a negative or nonsense uptime is unknown, not a number", () => {
    expect(describeUptime({ uptime_seconds: -5 }, NOW).kind).toBe("unknown")
    expect(describeUptime({ uptime_seconds: "banana" }, NOW).kind).toBe("unknown")
    expect(describeUptime({ uptime_seconds: null }, NOW).kind).toBe("unknown")
  })

  test("a genuinely fresh boot IS zero seconds and still reports as measured", () => {
    // 0 is a real reading when it is reported. Only ABSENCE is unknown.
    const r = describeUptime({ uptime_seconds: 0, connection_status: "online" }, NOW)
    expect(r.kind).toBe("stable")
    expect((r as any).label).toBe("up 0s")
  })
})

describe("restartsInWindow", () => {
  test("an unparseable entry is not counted as a restart", () => {
    // Guessing at a bad timestamp would manufacture a crash report.
    //
    // HONEST NOTE: this pins the OUTCOME, not the explicit `Number.isNaN` guard in the
    // implementation. Mutation-testing showed the guard is redundant — NaN already fails the
    // window comparison, so removing it changes nothing and this test still passes. The guard
    // stays because it states the intent at the point of the decision; it is not, however,
    // load-bearing, and claiming this test covers it would be the sort of false confidence
    // the rest of this file exists to prevent.
    expect(restartsInWindow(["not a date", agoMs(1000)], NOW)).toBe(1)
  })

  test("a future timestamp is not counted", () => {
    expect(restartsInWindow([new Date(NOW + 60_000).toISOString()], NOW)).toBe(0)
  })

  test("a missing or malformed list is zero, never a crash", () => {
    expect(restartsInWindow(undefined, NOW)).toBe(0)
    expect(restartsInWindow("nope", NOW)).toBe(0)
    expect(restartsInWindow({}, NOW)).toBe(0)
  })
})

describe("formatDuration", () => {
  test("reads at the scale a person thinks in", () => {
    expect(formatDuration(45)).toBe("45s")
    expect(formatDuration(600)).toBe("10m")
    expect(formatDuration(3600 * 3 + 60 * 5)).toBe("3h 5m")
    expect(formatDuration(86400 * 2 + 3600 * 3)).toBe("2d 3h")
  })
})
