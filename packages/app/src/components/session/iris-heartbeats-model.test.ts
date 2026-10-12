import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import {
  beatSummary,
  cadenceOf,
  lastBeatAt,
  lineOf,
  previewOf,
  problemsOf,
  sortBeats,
  stateOf,
  stripOf,
  untilOf,
  type HeartbeatRow,
} from "./iris-heartbeats-model"

// The real heartbeats of account #193 on 2026-10-12 (18 live; names, boards, run text and emails anonymised — this repo is public).
const snap = JSON.parse(readFileSync(new URL("./__fixtures__/heartbeats.json", import.meta.url), "utf8"))
const NOW = Date.parse(snap.capturedAt)
const rows = snap.heartbeats as HeartbeatRow[]
const by = (name: string) => rows.find((r) => r.agentName === name)!

describe("Agents › Heartbeats", () => {
  test("a heartbeat that says `scheduled` but is three days past due is LATE — computed from the clock", () => {
    const delo = by("Market Watch Agent")
    expect(delo.status).toBe("scheduled")
    expect(stateOf(delo, NOW)).toBe("late")
    expect(lineOf(delo, NOW)).toBe("Late · due 3 days ago")
    expect(problemsOf(delo, NOW).map((p) => p.kind)).toEqual(["late"])
    // fifteen minutes is the grace: the scheduler ticks every minute, a beat due a moment ago is not late
    const due = Date.parse(delo.nextRunAt!)
    expect(stateOf(delo, due + 14 * 60_000)).toBe("ok")
    expect(stateOf(delo, due + 16 * 60_000)).toBe("late")
  })
  test("the last beat's own verdict counts when no run row was kept", () => {
    const w = by("Article Writer")
    expect(w.runs).toEqual([])
    expect(stateOf(w, NOW)).toBe("failing")
    expect(problemsOf(w, NOW)[0].text).toBe("Last beat failed: Heartbeat Stage 3 endpoint unavailable")
  })
  test("a failure further back shows on the strip, not as a problem", () => {
    const n = by("Newsletter Agent")
    expect(stateOf(n, NOW)).toBe("ok")
    expect(stripOf(n)).toEqual(["ok", "fail", "ok", "ok"])
    const broken = { ...n, runs: [{ ...n.runs[0], status: "failed", error: "boom" }, ...n.runs.slice(1)] }
    expect(stateOf(broken, NOW)).toBe("failing")
    expect(problemsOf(broken, NOW)[0]).toMatchObject({ text: "Last beat failed: boom", fix: "2 of the last 4 beats failed." })
  })
  test("an agent switched off still beats — it is not shown as paused", () => {
    const dj = by("Music Curator")
    expect(dj.agentActive).toBe(false)
    expect(stateOf(dj, NOW)).toBe("ok")
    expect(stateOf({ ...dj, status: "paused" }, NOW)).toBe("paused")
    expect(lineOf({ ...dj, status: "paused" }, NOW)).toBe("Paused · last beat 1 h ago")
  })
  test("last beat is the newer of the job and its newest kept run", () => {
    const o = by("Oversight Agent")
    expect(Date.parse(o.runs[0].completedAt!)).toBeLessThan(Date.parse(o.lastRunAt!))
    expect(lastBeatAt(o)).toBe(o.lastRunAt)
    expect(lineOf(o, NOW)).toBe("Next in 7h · last beat 51 min ago")
  })
  test("problems first, then the next beat soonest; the summary counts what is beating", () => {
    const sorted = sortBeats(rows, NOW).map((r) => r.agentName)
    expect(sorted.slice(0, 3)).toEqual(["Market Watch Agent", "Article Writer", "Clinic Assistant"])
    expect(beatSummary(rows, NOW)).toEqual({ total: 18, beating: 16, attention: 2, paused: 0 })
  })
  test("words", () => {
    expect(cadenceOf("every_8_hours")).toBe("Every 8 hours")
    expect(cadenceOf("every_1_days")).toBe("Every day")
    expect(cadenceOf("hourly")).toBe("Every hour")
    expect(cadenceOf("daily")).toBe("Every day")
    expect(cadenceOf("every_other_tuesday")).toBe("Every other tuesday")
    expect(cadenceOf(null)).toBe("No schedule")
    expect(untilOf(new Date(NOW + 30 * 60_000).toISOString(), NOW)).toBe("in 30m")
    expect(untilOf(new Date(NOW + 5 * 3600_000).toISOString(), NOW)).toBe("in 5h")
    expect(untilOf(null, NOW)).toBe("—")
  })
})

test("a run preview reads as a sentence", () => {
  expect(previewOf("**Workflow Complete**\n\n\n**Tools Used:**\n- ✓ **agent_memory**: 10 memories")).toBe(
    "Workflow Complete Tools Used: agent_memory: 10 memories",
  )
  expect(previewOf(null)).toBe("")
})
