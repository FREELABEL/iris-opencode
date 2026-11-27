import { describe, expect, test } from "bun:test"
import { activityOf, beatsByAgent, relative } from "./iris-agent-activity-model"
import type { HeartbeatRow } from "./iris-heartbeats-model"

const now = Date.parse("2026-11-27T12:00:00Z")
const h = (n: number) => new Date(now - n * 3600_000).toISOString()

const beat = (runs: { at: string; status?: string; error?: string }[], extra: Partial<HeartbeatRow> = {}): HeartbeatRow =>
  ({
    jobId: 1,
    agentId: 7,
    agentName: "Demo",
    status: "scheduled",
    agentActive: true,
    nextRunAt: new Date(now + 2 * 3600_000).toISOString(),
    lastRunAt: runs[0]?.at ?? null,
    schedule: null,
    runsMeasured: true,
    runs: runs.map((r, i) => ({ id: i, status: r.status ?? "completed", startedAt: r.at, completedAt: r.at, error: r.error ?? null })),
    ...extra,
  }) as unknown as HeartbeatRow

describe("agent card activity", () => {
  test("an agent nobody ran or used is the only one that says never", () => {
    expect(activityOf({}, undefined, now)).toEqual({ lastAt: undefined, lastKind: undefined, result: undefined, week: null, nextAt: null })
  })

  test("a heartbeat's newest run is its last run, with how it went", () => {
    const a = activityOf({}, beat([{ at: h(1), status: "failed", error: "boom" }, { at: h(4) }]), now)
    expect(a.lastAt).toBe(h(1))
    expect(a.lastKind).toBe("run")
    expect(a.result).toBe("fail")
    expect(a.week).toBe(2)
    expect(a.nextAt).toBe(new Date(now + 2 * 3600_000).toISOString())
  })

  test("a use newer than the last run wins, and carries no result", () => {
    const a = activityOf({ lastUsedAt: h(0.5) }, beat([{ at: h(3) }]), now)
    expect(a).toMatchObject({ lastAt: h(0.5), lastKind: "used", result: undefined })
  })

  test("the job's last_run_at counts only when there is no heartbeat row to read", () => {
    expect(activityOf({ lastRun: h(2) }, undefined, now)).toMatchObject({ lastAt: h(2), lastKind: "run", result: undefined })
    // A row with no runs: last_run_at may be a skip (#189113), so it is not shown as a run.
    expect(activityOf({ lastRun: h(2) }, beat([]), now).lastAt).toBeUndefined()
  })

  test("runs this week only when the runs read reach back a week", () => {
    expect(activityOf({}, beat([{ at: h(1) }, { at: h(200) }]), now).week).toBe(1)
    const full = Array.from({ length: 50 }, (_, i) => ({ at: h(i) }))
    expect(activityOf({}, beat(full), now).week).toBeNull()
  })

  test("a paused agent has no next beat", () => {
    expect(activityOf({ active: false }, beat([{ at: h(1) }]), now).nextAt).toBeNull()
    expect(activityOf({}, beat([{ at: h(1) }], { agentActive: false }), now).nextAt).toBeNull()
  })

  test("two jobs for one agent: the one that ran last", () => {
    const a = beat([{ at: h(5) }], { jobId: 1 })
    const b = beat([{ at: h(1) }], { jobId: 2 })
    expect(beatsByAgent([a, b]).get(7)?.jobId).toBe(2)
  })

  test("relative time reads both ways", () => {
    expect(relative(h(3), now)).toBe("3h ago")
    expect(relative(new Date(now + 2 * 3600_000).toISOString(), now)).toBe("in 2h")
    expect(relative(h(0), now)).toBe("just now")
  })
})
