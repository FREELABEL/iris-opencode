import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import {
  beatStory,
  beatSummary,
  cadenceOf,
  kindOf,
  laundered,
  lastBeatAt,
  lineOf,
  periodOf,
  previewOf,
  problemsOf,
  rollupOf,
  sectionsOf,
  sortBeats,
  stateOf,
  stripOf,
  toolsOf,
  untilOf,
  weekOf,
  byDesign,
  cadenceDrift,
  hoursOf,
  mayAct,
  heldForHours,
  nextFireAt,
  silentSince,
  type HeartbeatRow,
} from "./iris-heartbeats-model"

// The real heartbeats of account #193 on 2026-10-12 (18 live). Names, boards, report text and
// emails anonymised — this repo is public. Statuses, times, cadences and error classes are real.
const snap = JSON.parse(readFileSync(new URL("./__fixtures__/heartbeats.json", import.meta.url), "utf8"))
const NOW = Date.parse(snap.capturedAt)
const rows = snap.heartbeats as HeartbeatRow[]
const by = (name: string) => rows.find((r) => r.agentName === name)!

describe("Agents › Heartbeats — what is true", () => {
  test("LATE comes from the clock — but a wake due outside its hours WAITS, and that is not late", () => {
    const m = by("Market Watch Agent") // works Tue–Thu 07:00–16:00 ET; due Thu 23:00 ET
    expect(m.status).toBe("scheduled")
    // the scheduler holds an after-hours wake until the window opens: Tuesday 07:00 ET
    expect(nextFireAt(m)).toBe("2026-10-13T11:00:00.000Z")
    expect(heldForHours(m)).toBe(true)
    expect(stateOf(m, NOW)).toBe("ok")
    expect(lineOf(m, NOW)).toBe("Next in 14h · held for its hours · last beat 4 days ago")
    // past its window opening with no beat → late
    expect(stateOf(m, Date.parse("2026-10-13T11:16:00Z"))).toBe("late")
    expect(stateOf(m, Date.parse("2026-10-13T11:14:00Z"))).toBe("ok")
    // with no schedule it WOULD have been 3 days late, and owed every 8-hourly wake since
    const free = { ...m, schedule: null }
    expect(stateOf(free, NOW)).toBe("late")
    expect(lineOf(free, NOW)).toBe("Late · due 3 days ago")
    expect(weekOf(free, NOW).missed.length).toBe(12)
    expect(problemsOf(free, NOW)[0].kind).toBe("late")
    const w = weekOf(m, NOW)
    expect(hoursOf(m)).toBe("Tue–Thu · 07:00–16:00 ET")
    expect([w.expected.length, w.missed.length]).toEqual([6, 0])
  })

  test("#189113: last_run_at moves on a SKIP — a wake with no run behind it is not a beat", () => {
    const c = by("Music Curator") // every 2 hours, woke 19:30, newest run 13:04
    expect(Date.parse(c.lastRunAt!)).toBeGreaterThan(Date.parse(lastBeatAt(c)!))
    expect(stateOf(c, NOW)).toBe("silent")
    expect(lineOf(c, NOW)).toBe("Wakes but does nothing · last real beat 8 h ago")
    expect(weekOf(c, NOW).missed.length).toBe(3)
    // a heartbeat created months ago that wakes every day and has never run
    const s = by("Sales Agent")
    expect(s.runs).toEqual([])
    expect(s.runCount).toBe(0)
    expect(problemsOf(s, NOW)[0].text).toBe("Wakes up but has never done anything — woke 9 h ago")
    // one late write-back is not a skip: an hourly beat whose run is a minute older than its wake
    expect(stateOf(by("Store Assistant"), NOW)).toBe("ok")
  })

  test("#189114: a `completed` run whose reply is a provider error is a FAILED beat, and says so", () => {
    const c = by("Chief of Staff")
    const x = c.runs[0]
    expect(x.status).toBe("completed")
    expect(x.error).toBeNull()
    expect(laundered(x)).toBe(true)
    expect(kindOf(x)).toBe("fail")
    expect(stateOf(c, NOW)).toBe("failing")
    expect(lineOf(c, NOW)).toBe("Last beat failed · next in 13m")
    expect(problemsOf(c, NOW)[0].text).toBe("Last beat failed: AI API error: 402")
    expect(problemsOf(c, NOW)[0].fix).toContain("recorded as a success")
    expect(beatStory(x)).toMatchObject({ error: "AI API error: 402", laundered: true, happened: null })
  })

  test("#189132: wakes before the newest kept run are not judged — the platform overwrote them", () => {
    const w = weekOf(by("Store Assistant"), NOW) // hourly, weekdays: 120 due, 1 row kept
    expect(w.expected.length).toBe(120)
    expect(w.beats.length).toBe(1)
    expect(w.missed).toEqual([])
    expect(w.unknown).toBe(119)
  })

  test("an agent switched off still beats — not shown as paused", () => {
    const c = by("Music Curator")
    expect(c.agentActive).toBe(false)
    expect(stateOf(c, NOW)).not.toBe("paused")
    expect(stateOf({ ...c, status: "paused" }, NOW)).toBe("paused")
  })

  test("problems first; the summary does not call a skipping heartbeat beating", () => {
    const sorted = sortBeats(rows, NOW).map((r) => stateOf(r, NOW))
    expect(sorted[0]).toBe("silent")
    expect(sorted.indexOf("ok")).toBeGreaterThan(sorted.lastIndexOf("failing"))
    expect(beatSummary(rows, NOW)).toEqual({ total: 18, beating: 10, attention: 8, paused: 0 })
  })
})

describe("the enforced schedule (#189170)", () => {
  test("the replayed scheduler gives a 16:00–17:00 weekday agent one beat a weekday", () => {
    const w = weekOf(by("Oversight Agent"), NOW)
    expect(w.expected.length).toBe(5)
    expect(new Set(w.expected.map((e) => new Date(e).toISOString().slice(11, 16)))).toEqual(new Set(["20:00"])) // 16:00 ET — the real Oct 7 run started 20:00:46Z
  })
  test("a wake may act only inside the schedule's days and hours, in ITS timezone", () => {
    const o = by("Oversight Agent") // weekdays 16:00–17:00 ET
    expect(mayAct(o, Date.parse("2026-10-12T20:30:00Z"))).toBe(true) // Mon 16:30 ET
    expect(mayAct(o, Date.parse("2026-10-12T21:00:00Z"))).toBe(false) // 17:00 ET — end is exclusive
    expect(mayAct(o, Date.parse("2026-10-12T20:00:00Z"))).toBe(true) // 16:00 ET — start inclusive
    expect(mayAct(o, Date.parse("2026-10-11T20:30:00Z"))).toBe(false) // Sunday
    expect(mayAct({ ...o, schedule: null }, Date.parse("2026-10-11T20:30:00Z"))).toBe(true)
  })
  test("a gap made only of wakes outside its hours is not silence", () => {
    const o = by("Oversight Agent")
    // last real beat Mon 16:10 ET, woke again at 00:10 and 08:10 ET — both outside 16–17
    const quiet = {
      ...o,
      runs: [{ ...o.runs[0], status: "completed", error: null, response: "ok", startedAt: "2026-10-12T20:10:00Z", completedAt: "2026-10-12T20:11:00Z" }],
      lastRunAt: "2026-10-13T12:10:00Z",
    }
    expect(silentSince(quiet)).toBeNull()
    // one more wake that WAS inside its hours, with nothing to show → silent
    expect(silentSince({ ...quiet, lastRunAt: "2026-10-13T20:10:00Z" })).toBe("2026-10-12T20:11:00Z")
  })
  test("the editors' cadence and the one that fires are compared, and called out when they differ", () => {
    expect(cadenceDrift(by("Market Watch Agent"))).toBe("every_5_minutes")
    expect(problemsOf(by("Market Watch Agent"), NOW).find((p) => p.kind === "config")!.text).toBe(
      "Its settings say every 5 minutes; it actually wakes every 8 hours",
    )
    expect(cadenceDrift(by("Backtest Agent"))).toBeNull() // daily_6am is daily
    expect(rows.filter((r) => cadenceDrift(r)).length).toBe(5)
  })
})

describe("fl-api's skip record (#189113)", () => {
  const c = by("Chief of Staff")
  const at = (h: number) => new Date(NOW - h * 3_600_000).toISOString()
  test("a skip outside its hours is by design — not silence", () => {
    expect(byDesign("Outside active hours (02:10 not in 09:00-17:00 America/New_York)")).toBe(true)
    const r = { ...c, lastSkip: { at: at(1), reason: "Outside working days (sunday not in monday, friday)", kind: "skipped" } }
    expect(silentSince(r)).toBeNull()
  })
  test("any other skip is silence, and the line and problem say why", () => {
    const r = { ...c, runs: c.runs.filter((x) => !x.response?.startsWith("AI API")), lastSkip: { at: at(1), reason: "No projects to monitor", kind: "skipped" } }
    expect(stateOf(r, NOW)).toBe("silent")
    expect(lineOf(r, NOW)).toEndWith("· No projects to monitor")
    expect(problemsOf(r, NOW)[0].text).toContain("No projects to monitor")
  })
  test("a circuit-breaker pause says how to resume", () => {
    const r = { ...c, lastSkip: { at: at(1), reason: "Paused: 5 consecutive failures. Use Run Now to resume.", kind: "circuit_breaker" } }
    expect(problemsOf(r, NOW).find((p) => p.kind === "silent")!.fix).toContain("Run now to resume")
  })
})

describe("one beat, opened", () => {
  const x = by("Newsletter Agent").runs[0]
  test("a report splits on the agent's own headings into the four questions", () => {
    const s = beatStory(x)
    expect(s.happened).toBe("The project is progressing; two new items were drafted.")
    expect(s.changed).toStartWith("Two new articles were added")
    expect(s.did).toBe("- Created two articles from current sources.\n- Checked every claim against its source.")
    expect(s.numbers).toStartWith("Total items: 344")
    expect(s.error).toBeNull()
  })
  test("tools come from its Tools Used list", () => {
    const report = by("Beauty Content Agent").runs[0].response
    expect(toolsOf(report).map((t) => t.name)).toEqual(["agent_memory", "SearchKnowledgeBaseTool", "agent_memory"])
    expect(sectionsOf(report).map((s) => s.title)).toEqual(["Tools Used"])
  })
  test("a report with no headings is one section, not nothing", () => {
    expect(sectionsOf("Checked the inbox; nothing new.")).toEqual([{ title: "Report", body: "Checked the inbox; nothing new." }])
    expect(sectionsOf("Error: AI API error: 403")).toEqual([])
  })
  test("the roll-up counts what the week actually holds", () => {
    // its one kept beat (5 days ago) was a laundered 403 — counted failed, not worked; and of
    // the wakes since, only the 3 that fell inside its 16:00–17:00 window count as skipped
    expect(rollupOf(by("Oversight Agent"), NOW)).toMatchObject({ beats: 0, failed: 1, missed: 3 })
    expect(rollupOf(by("Beauty Content Agent"), NOW).tools[0]).toEqual(["agent_memory", 2])
  })
})

describe("words", () => {
  test("cadence, periods, times", () => {
    expect(cadenceOf("every_8_hours")).toBe("Every 8 hours")
    expect(cadenceOf("hourly")).toBe("Every hour")
    expect(cadenceOf("every_other_tuesday")).toBe("Every other tuesday")
    expect(cadenceOf(null)).toBe("No schedule")
    expect(periodOf("every_2_hours")).toBe(7_200_000)
    expect(periodOf("daily_430pm")).toBe(86_400_000)
    expect(periodOf("whenever")).toBeNull()
    expect(untilOf(new Date(NOW + 30 * 60_000).toISOString(), NOW)).toBe("in 30m")
    expect(untilOf(null, NOW)).toBe("—")
    expect(stripOf(by("Chief of Staff"))).toEqual(["ok", "fail"])
  })
  test("a run preview reads as a sentence", () => {
    expect(previewOf("**Workflow Complete**\n\n\n**Tools Used:**\n- ✓ **agent_memory**: 10 memories")).toBe(
      "Workflow Complete Tools Used: agent_memory: 10 memories",
    )
  })
})
