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
  type HeartbeatRow,
} from "./iris-heartbeats-model"

// The real heartbeats of account #193 on 2026-10-12 (18 live). Names, boards, report text and
// emails anonymised — this repo is public. Statuses, times, cadences and error classes are real.
const snap = JSON.parse(readFileSync(new URL("./__fixtures__/heartbeats.json", import.meta.url), "utf8"))
const NOW = Date.parse(snap.capturedAt)
const rows = snap.heartbeats as HeartbeatRow[]
const by = (name: string) => rows.find((r) => r.agentName === name)!

describe("Agents › Heartbeats — what is true", () => {
  test("LATE comes from the clock: `scheduled` with next_run_at three days gone", () => {
    const m = by("Market Watch Agent")
    expect(m.status).toBe("scheduled")
    expect(stateOf(m, NOW)).toBe("late")
    expect(lineOf(m, NOW)).toBe("Late · due 3 days ago")
    const due = Date.parse(m.nextRunAt!)
    expect(stateOf(m, due + 14 * 60_000)).not.toBe("late")
    expect(stateOf(m, due + 16 * 60_000)).toBe("late")
    // every 8 hours since it stopped is owed and missing
    expect(weekOf(m, NOW).missed.length).toBe(12)
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
    expect(sorted[0]).toBe("late")
    expect(sorted.indexOf("ok")).toBeGreaterThan(sorted.lastIndexOf("failing"))
    expect(beatSummary(rows, NOW)).toEqual({ total: 18, beating: 9, attention: 9, paused: 0 })
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
    // its one kept beat (5 days ago) was a laundered 403 — counted failed, not worked
    expect(rollupOf(by("Oversight Agent"), NOW)).toMatchObject({ beats: 0, failed: 1, missed: 15 })
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
