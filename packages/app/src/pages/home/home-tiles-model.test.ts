import { describe, expect, test } from "bun:test"
import { changeOf, runChangeOf, yesterdayOf } from "./home-tiles-model"
import type { HeartbeatRow } from "@/components/session/iris-heartbeats-model"

const day = new Date(2026, 10, 27).getTime()
const at = (h: number) => new Date(day + h * 3600_000).toISOString()

const row = (runs: string[], extra: Partial<HeartbeatRow> = {}): HeartbeatRow =>
  ({
    jobId: 1,
    agentId: 1,
    agentName: "Demo",
    runsMeasured: true,
    runs: runs.map((startedAt, i) => ({ id: i, status: "completed", startedAt, completedAt: startedAt })),
    ...extra,
  }) as unknown as HeartbeatRow

describe("home tiles: change since yesterday", () => {
  test("yesterday starts at the previous local midnight", () => {
    expect(yesterdayOf(day)).toBe(new Date(2026, 10, 26).getTime())
  })

  test("counts today and yesterday from a list that reaches back far enough", () => {
    expect(changeOf([at(1), at(2), at(-3), at(-30)], day, { capped: false })).toEqual({ today: 2, yesterday: 1 })
  })

  test("a capped page that stops after yesterday began is not a count", () => {
    expect(changeOf([at(1), at(-3)], day, { capped: true })).toBeNull()
    expect(changeOf([at(1), at(-3), at(-25)], day, { capped: true })).toEqual({ today: 1, yesterday: 1 })
  })

  test("missing and unreadable times are skipped", () => {
    expect(changeOf([undefined, null, "not a date", at(1)], day, { capped: false })).toEqual({ today: 1, yesterday: 0 })
  })

  test("heartbeat runs add up across agents", () => {
    expect(runChangeOf([row([at(1), at(-2)]), row([at(3), at(-5), at(-6)])], day)).toEqual({ today: 2, yesterday: 3 })
  })

  test("one heartbeat whose runs were not read means no change is shown", () => {
    expect(runChangeOf([row([at(1)]), row([], { runsMeasured: false })], day)).toBeNull()
    expect(runChangeOf([], day)).toBeNull()
  })

  test("a heartbeat with a full page of runs, all since yesterday, cannot say", () => {
    expect(runChangeOf([row([at(1), at(-1)])], day, 2)).toBeNull()
  })
})
