import { describe, expect, test } from "bun:test"
import { countsDocument, fleetScript, fleetSourceId, parseCounts, sweepFleet, type FleetNode } from "./pulse-fleet"
import type { SourceSweep } from "./pulse-check-sweep"

// #190970 — the topic sweep across every machine in the Hive, counts only.
const node = (id: string, name: string, status = "online"): FleetNode => ({ id, name, connection_status: status, last_heartbeat_at: "2026-10-23T18:00:00Z" })
const counts = (rows: Partial<SourceSweep>[]) =>
  JSON.stringify(countsDocument("creator os", 30, rows.map((r) => ({ source: "claude_code", searched: true, hits: 0, items: [], ...r }) as SourceSweep)))

describe("pulse --fleet", () => {
  test("each other online node's counts are filed under a per-machine source; this machine is skipped", async () => {
    const ran: string[] = []
    const r = await sweepFleet("creator os", 30, ["claude_code", "opencode"], {
      selfNodeId: "self",
      nodes: async () => [node("self", "Alexs MacBook"), node("n1", "iris-hive-001")],
      run: async (n) => {
        ran.push(n.name)
        return counts([{ source: "claude_code", hits: 4, hitsPrior: 2, lastHitEpoch: 1_700_000_000 }, { source: "opencode", searched: false, unavailableReason: "no opencode history" }])
      },
    })
    expect(ran).toEqual(["iris-hive-001"])
    expect(r.nodes).toEqual([{ node: "iris-hive-001", state: "ok", sources: 2 }])
    const cc = r.sweeps.find((s) => s.source === "claude_code.iris-hive-001")!
    expect(cc).toMatchObject({ searched: true, hits: 4, hitsPrior: 2, lastHitEpoch: 1_700_000_000, items: [] })
    const oc = r.sweeps.find((s) => s.source === "opencode.iris-hive-001")!
    expect(oc.searched).toBe(false)
    expect(oc.unavailableReason).toContain("no opencode history")
  })

  test("a node that cannot answer is NOT zero — every source it was asked for is shut, with why", async () => {
    const r = await sweepFleet("x y", 30, ["claude_code", "opencode"], {
      nodes: async () => [node("n1", "hive-2")],
      run: async () => "Unknown argument: counts-only",
    })
    expect(r.nodes[0].state).toBe("failed")
    expect(r.nodes[0].reason).toMatch(/iris update/)
    expect(r.sweeps.map((s) => [s.source, s.searched])).toEqual([["claude_code.hive-2", false], ["opencode.hive-2", false]])
  })

  test("a node whose iris is too old to know --counts-only is told to update, in plain words", async () => {
    const r = await sweepFleet("x y", 30, ["claude_code"], {
      nodes: async () => [node("n1", "mbp")],
      run: async () => {
        throw new Error("exited 1: Error: Unknown arguments: counts-only, countsOnly")
      },
    })
    expect(r.nodes[0]).toMatchObject({ state: "failed", reason: expect.stringContaining("iris update") })
  })

  test("offline nodes are named and contribute nothing; a re-registered name asks the live one once", async () => {
    const ran: string[] = []
    const r = await sweepFleet("x y", 30, ["claude_code"], {
      nodes: async () => [node("dead", "laptop", "offline"), node("live", "laptop"), node("gone", "old-box", "offline")],
      run: async (n) => {
        ran.push(n.id)
        return counts([{ hits: 1 }])
      },
    })
    expect(ran).toEqual(["live"])
    expect(r.nodes.map((n) => [n.node, n.state])).toEqual([["laptop", "ok"], ["old-box", "offline"]])
    expect(r.sweeps.map((s) => s.source)).toEqual(["claude_code.laptop"])
  })

  test("source names fit the 32-character column and the server's pattern", () => {
    const pattern = /^(?=.{1,32}$)[a-z][a-z0-9_]*(\.[a-z0-9][a-z0-9_-]*)?$/
    for (const name of ["Alex's MacBook Pro (2)", "iris-hive-001", "A-very-long-machine-name-that-goes-on-and-on", "---"]) {
      for (const src of ["claude_code", "iris_desktop", "opencode"]) {
        const id = fleetSourceId(src, name)
        expect(id).toMatch(pattern)
      }
    }
    expect(fleetSourceId("claude_code", "Alex's MacBook Pro")).toBe("claude_code.alexs-macbook-pro")
  })

  test("the topic cannot break out of the node's command", () => {
    const script = fleetScript(`it's $(rm -rf ~) "x"`, 30, ["claude_code"])
    expect(script).toContain(`'it'\\''s $(rm -rf ~) "x"'`)
    expect(script).toContain("--counts-only --no-push".split(" ")[0])
  })

  test("the counts document carries numbers, never content", () => {
    const doc = countsDocument("t", 7, [{ source: "claude_code", searched: true, hits: 2, items: [{ when: "x", where: "secret-path", text: "secret text" }] } as SourceSweep])
    expect(JSON.stringify(doc)).not.toContain("secret")
    expect(parseCounts("noise\n" + JSON.stringify(doc))).toEqual(doc.counts)
    expect(parseCounts("not json")).toBeNull()
  })
})
