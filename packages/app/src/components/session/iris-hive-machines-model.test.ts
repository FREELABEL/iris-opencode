import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { attentionOf, fleetSummary, gb, machinesOf, mapLayout, readMachinesView, specOf, statusOf } from "./iris-hive-machines-model"
import type { HiveNodeRow } from "./iris-hive-scripts-model"

// The real fleet of account #193 on 2026-10-09 (6 registrations, 4 computers).
const NOW = Date.parse("2026-10-09T21:20:00Z")
const snap = JSON.parse(readFileSync(new URL("./__fixtures__/hive-scripts.json", import.meta.url), "utf8"))
const nodes = snap.nodes as HiveNodeRow[]
const cs = machinesOf(nodes)
const by = (name: string) => cs.find((c) => c.name === name)!

describe("Hive › Machines", () => {
  test("one card per computer; the MacBook's three records add up their work", () => {
    expect(cs.length).toBe(4)
    const mac = by("Alexs-MacBook-Pro-11711")
    expect(mac.regs).toBe(3)
    expect(mac.online).toBe(true)
    expect(mac.tasksCompleted).toBe(734 + 37 + 455)
  })
  test("triage: 2 of 4 online, the two nearly-full disks need attention, duplicates do not count", () => {
    expect(fleetSummary(cs, NOW)).toMatchObject({ online: 2, total: 4, attention: 2 })
    const mac = attentionOf(by("Alexs-MacBook-Pro-11711"), NOW)
    expect(mac.map((a) => a.kind)).toEqual(["disk", "dupes"])
    expect(mac[0].text).toBe("Disk almost full — 2.1 GB free")
    expect(mac[0].level).toBe("crit")
    // a two-day-old snapshot says how old it is
    expect(attentionOf(by("AlexMaysnow1063"), NOW)[0].text).toBe("Disk almost full — 0.1 GB free (as of 2 days ago)")
    expect(attentionOf(by("iris-hive-001"), NOW)).toEqual([])
    expect(attentionOf(by("qb-host-vanguard"), NOW)).toEqual([])
  })
  test("status says whether it can take work", () => {
    expect(statusOf(by("iris-hive-001"), NOW)).toEqual({ text: "Free — can take 3 tasks", tone: "free" })
    expect(statusOf({ ...by("iris-hive-001"), activeTasks: 1 }, NOW).text).toBe("Busy — 1 running, room for 2")
    expect(statusOf({ ...by("iris-hive-001"), activeTasks: 3 }, NOW).tone).toBe("full")
    expect(statusOf(by("AlexMaysnow1063"), NOW).text).toBe("Away since yesterday")
    expect(statusOf(by("qb-host-vanguard"), NOW).text).toBe("Away since 3 days ago")
  })
  test("words: spec, sizes, a silent daemon, restarts are not a signal", () => {
    expect(specOf(by("Alexs-MacBook-Pro-11711"))).toBe("Mac · 10 cores · 16 GB memory")
    expect(specOf(by("iris-hive-001"))).toBe("Linux · 4 cores · 31.2 GB memory")
    expect(gb(1521.3)).toBe("1,521 GB")
    const hub = by("iris-hive-001")
    expect(attentionOf({ ...hub, capabilities: [] }, NOW).map((a) => a.kind)).toEqual(["silent"])
    // the hub's restart list is capped at 20 with no window — never a problem by itself
    expect(attentionOf({ ...hub, recentRestarts: 20 }, NOW)).toEqual([])
    expect(readMachinesView("map")).toBe("map")
    expect(readMachinesView("x")).toBe("list")
  })
  test("map: you in the middle, computers inside, people outside, stable", () => {
    const peers = [{ id: "1", name: "Emily", status: "accepted", active: true, inviter: true }]
    const m = mapLayout(cs, peers, 500, 400, NOW)
    expect(m[0]).toMatchObject({ kind: "you", x: 250, y: 200 })
    const dist = (n: { x: number; y: number }) => Math.hypot(n.x - 250, n.y - 200)
    const comp = m.filter((n) => n.kind === "computer")
    expect(comp.length).toBe(4)
    expect(dist(m.find((n) => n.kind === "peer")!)).toBeGreaterThan(dist(comp[0]) + 20)
    expect(comp.filter((n) => n.attention).length).toBe(2)
    expect(mapLayout(cs, peers, 500, 400, NOW)).toEqual(m)
  })
})
