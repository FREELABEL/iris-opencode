import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import {
  ADD_COMPUTER_STEPS,
  agentWords,
  agentsOf,
  aiOf,
  attentionOf,
  computerRows,
  computerTotals,
  filterComputers,
  fleetSummary,
  gb,
  gpuOf,
  isTailnetIp,
  machinesOf,
  mapLayout,
  reachOf,
  readComputersFilter,
  readMachinesView,
  shellWords,
  shellsOfComputer,
  specOf,
  statusOf,
  type HereRow,
  type SessionsPayload,
} from "./iris-hive-machines-model"
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

describe("#192222 Machines › GPU and AI models", () => {
  const base = { id: "1", name: "n", online: true, lastHeartbeat: null } as HiveNodeRow
  test("never reported, none, and a real GPU are three different answers", () => {
    expect(gpuOf(base)).toBe("Not reported")
    expect(gpuOf({ ...base, gpu: { available: false } })).toBe("None")
    expect(gpuOf({ ...base, gpu: { available: true, name: "Apple M1 Pro", type: "metal", vramGb: 16 } })).toBe("Apple M1 Pro · 16 GB")
  })
  test("serving is named; installed-but-not-shared never reads as serving; nothing says nothing", () => {
    expect(aiOf({ ...base, modelsServing: ["hive/qwen3:14b"] })?.text).toBe("Serving qwen3:14b")
    expect(aiOf({ ...base, modelsServing: ["hive/a", "hive/b", "hive/c"], modelsInstalled: ["a", "b", "c", "d"] })?.text).toBe("Serving a +2")
    expect(aiOf({ ...base, modelsInstalled: ["a", "b"] })?.text).toBe("2 models installed, not shared")
    expect(aiOf(base)).toBeNull()
  })
})

// ── #192608 Computers: how each is reached, agents vs shells, the filter ──────────────────────────

describe("#192608 Computers", () => {
  // The fixture fleet with the addresses each machine advertised on 2026-11-05 (the real values).
  const ADDR: Record<string, Partial<HiveNodeRow>> = {
    "01a09d2c-2076-72e5-9292-7f69c00e8407": { tailscaleIp: "100.100.67.48", tailscaleIpAt: "2026-10-09T21:04:43Z", lastIp: "169.150.224.130" },
    "01a10379-0c9f-73c5-bf83-157496a21589": { tailscaleIp: "100.79.222.57", tailscaleIpAt: "2026-10-09T21:04:36Z", lastIp: "169.150.224.129" },
    "019e1d80-a446-71fa-84a3-6269bf19fab0": { tailscaleIp: "100.114.214.29", tailscaleIpAt: "2026-10-07T13:00:00Z", lastIp: "89.222.103.194" },
    "01a097a9-3cab-73ef-92ee-e639c92e34b4": { lastIp: "152.233.30.101" },
  }
  const fleet = machinesOf(nodes.map((n) => ({ ...n, ...ADDR[n.id] })))
  const c = (name: string) => fleet.find((x) => x.name === name)!
  const HUB = "01a10379-0c9f-73c5-bf83-157496a21589"
  const here = (over: Partial<HereRow> = {}): HereRow => ({
    measured: true,
    nodeId: HUB,
    onTailnet: true,
    shells: { measured: true, workspaces: [{ panes: 3, kind: "swarm" }, { panes: 1, kind: null }] },
    ...over,
  })

  test("connection type comes from what both sides reported", () => {
    const h = here()
    expect(reachOf(c("iris-hive-001"), h, fleet, NOW).kind).toBe("self")
    const mac = reachOf(c("Alexs-MacBook-Pro-11711"), h, fleet, NOW)
    expect(mac).toMatchObject({ kind: "tailscale", label: "Tailscale" })
    expect(mac.detail).toBe("Over Tailscale at 100.100.67.48")
    // an address advertised two days ago says how old it is
    expect(reachOf(c("AlexMaysnow1063"), h, fleet, NOW).detail).toBe("Over Tailscale at 100.114.214.29 (address as of 2 days ago)")
    // no tailnet address, a known internet address → Other, through IRIS
    expect(reachOf(c("qb-host-vanguard"), h, fleet, NOW)).toMatchObject({ kind: "other", detail: "Over the internet, through IRIS" })
    // never said anything → Unknown, not Other
    expect(reachOf({ ...c("qb-host-vanguard"), lastIp: undefined }, h, fleet, NOW).kind).toBe("unknown")
  })

  test("Tailscale needs THIS computer on a tailnet too; same internet connection is This network", () => {
    const off = here({ onTailnet: false })
    expect(reachOf(c("Alexs-MacBook-Pro-11711"), off, fleet, NOW)).toMatchObject({
      kind: "other",
      detail: "It is on Tailscale, but this computer is not — Hive still reaches it through IRIS",
    })
    // the MacBook shares the hub's internet connection → This network
    const sameNet = machinesOf(nodes.map((n) => ({ ...n, ...ADDR[n.id], ...(n.id === HUB ? { lastIp: "169.150.224.130" } : {}) })))
    const mac = sameNet.find((x) => x.name === "Alexs-MacBook-Pro-11711")!
    expect(reachOf(mac, off, sameNet, NOW)).toMatchObject({ kind: "lan", label: "This network" })
    // on a tailnet too: Tailscale is how it is reached, and the shared connection is said beside it
    expect(reachOf(mac, here(), sameNet, NOW).detail).toBe("Over Tailscale at 100.100.67.48 · same internet connection as this computer")
    // a LAN or public address is never taken for a tailnet one
    expect(isTailnetIp("192.168.1.5")).toBe(false)
    expect(isTailnetIp("169.150.224.129")).toBe(false)
    expect(isTailnetIp("100.128.0.1")).toBe(false)
    expect(isTailnetIp("100.64.0.1")).toBe(true)
  })

  test("could not check this computer → every connection is Unknown, never guessed", () => {
    for (const x of fleet) expect(reachOf(x, { ...here(), measured: false }, fleet, NOW).kind).toBe("unknown")
    expect(reachOf(fleet[0], undefined, fleet, NOW).label).toBe("Unknown")
  })

  const s = (id: string, status = "active") => ({ sessionId: id, provider: "claude_code", label: id, status, activity: null, model: null, branch: null, updatedAt: null, question: null })
  const sessions: SessionsPayload = {
    measured: true,
    nodes: [
      { id: HUB, name: "iris-hive-001", online: true, lastHeartbeat: null, report: "fresh", reportedAt: "2026-10-09T21:19:00Z", incomplete: [], sessions: [s("a"), s("b", "idle"), s("c", "needs_you"), s("d", "stale"), s("e", "stale")] },
      // the MacBook's two records: the current one reported, the older one's rows are summed in
      { id: "01a09d2c-2076-72e5-9292-7f69c00e8407", name: "Alexs-MacBook-Pro-11711", online: true, lastHeartbeat: null, report: "fresh", reportedAt: "2026-10-09T21:18:00Z", incomplete: ["claude_code"], sessions: [s("f"), s("g")] },
      { id: "01a098bd-fcfe-70ad-a518-9329e933860b", name: "Alexs-MacBook-Pro-11711", online: false, lastHeartbeat: null, report: "stale", reportedAt: "2026-09-13T23:48:00Z", incomplete: [], sessions: [s("h", "unknown")] },
      { id: "019e1d80-a446-71fa-84a3-6269bf19fab0", name: "AlexMaysnow1063", online: false, lastHeartbeat: null, report: "stale", reportedAt: "2026-10-07T13:00:00Z", incomplete: [], sessions: [s("i", "unknown"), s("j", "unknown")] },
      { id: "01a097a9-3cab-73ef-92ee-e639c92e34b4", name: "qb-host-vanguard", online: false, lastHeartbeat: null, report: "never", reportedAt: null, incomplete: [], sessions: [] },
    ],
  }

  test("agent counts are the rows `iris hive sessions` lists — stale hidden, a floor said, never-reported is not zero", () => {
    const hub = agentsOf(c("iris-hive-001"), sessions)
    expect(hub).toMatchObject({ state: "counted", n: 3, stale: 2, floor: false, old: false })
    expect(agentWords(hub, NOW)).toEqual({ text: "3 agent sessions", note: "2 older hidden", counted: true })
    const mac = agentsOf(c("Alexs-MacBook-Pro-11711"), sessions)
    expect(mac).toMatchObject({ state: "counted", n: 3, floor: true, old: false })
    expect(agentWords(mac, NOW).text).toBe("≥3 agent sessions")
    const snow = agentsOf(c("AlexMaysnow1063"), sessions)
    expect(snow).toMatchObject({ state: "counted", n: 2, old: true })
    expect(agentWords(snow, NOW).note).toBe("as of 2 days ago")
    expect(agentsOf(c("qb-host-vanguard"), sessions)).toEqual({ state: "never" })
    expect(agentWords({ state: "never" }, NOW).text).toBe("Agents: never reported")
    expect(agentsOf(c("qb-host-vanguard"), { measured: false, reason: "iris-api 500", nodes: [] })).toEqual({ state: "unmeasured", reason: "iris-api 500" })
  })

  test("shells: Hive-started panes, counted on this computer only — elsewhere is not zero", () => {
    expect(shellsOfComputer(c("iris-hive-001"), here())).toEqual({ state: "counted", n: 4, workspaces: 2 })
    expect(shellWords(shellsOfComputer(c("iris-hive-001"), here()))).toEqual({ text: "4 shells", note: "Hive-started only · 2 workspaces", counted: true })
    expect(shellsOfComputer(c("Alexs-MacBook-Pro-11711"), here())).toEqual({ state: "elsewhere" })
    expect(shellWords({ state: "elsewhere" }).text).toBe("Shells: not counted")
    // no tmux on this computer is a measured nothing
    expect(shellWords(shellsOfComputer(c("iris-hive-001"), here({ shells: { measured: true, workspaces: [] } })))).toEqual({
      text: "0 shells",
      note: "Hive-started only",
      counted: true,
    })
    const down = here({ shells: { measured: false, reason: "Hive is not running on this computer", workspaces: [] } })
    expect(shellWords(shellsOfComputer(c("iris-hive-001"), down))).toEqual({ text: "Shells: couldn't check", note: "Hive is not running on this computer", counted: false })
  })

  test("totals add counted computers only, and say how many they cover; the filter never hides unknown as none", () => {
    const rows = computerRows(fleet, sessions, here(), NOW)
    expect(rows.map((r) => r.computer.name)).toEqual(fleet.map((x) => x.name))
    expect(computerTotals(rows)).toEqual({ computers: 4, agents: 3 + 3 + 2, agentsFloor: true, agentMachines: 3, shells: 4, shellMachines: 1 })
    expect(filterComputers(rows, "all").rows.length).toBe(4)
    const ag = filterComputers(rows, "agents")
    expect(ag.rows.map((r) => r.computer.name).sort()).toEqual(["AlexMaysnow1063", "Alexs-MacBook-Pro-11711", "iris-hive-001"])
    expect(ag.hiddenUnknown).toBe(1)
    const sh = filterComputers(rows, "shells")
    expect(sh.rows.map((r) => r.computer.name)).toEqual(["iris-hive-001"])
    expect(sh.hiddenUnknown).toBe(3)
    expect(readComputersFilter("shells")).toBe("shells")
    expect(readComputersFilter("bogus")).toBe("all")
  })

  test("Add a computer is the hive-secure-mesh playbook's steps, in order", () => {
    expect(ADD_COMPUTER_STEPS.map((s) => s.command.split(" --action ")[1].split(" ")[0])).toEqual(["onboard", "enroll", "doctor"])
    expect(ADD_COMPUTER_STEPS.every((s) => s.command.startsWith("iris playbook run hive-secure-mesh "))).toBe(true)
  })
})
