/**
 * `iris hive nodes list` — identifying which registered node is this machine (#179064).
 *
 * MEASURED FAILURE, 2026-08-05: the "(you)" marker never appeared for any node. Resolution read
 * `node_id` from ~/.iris/config.json, which contains only { api_url, node_api_key, user_id } —
 * nothing writes node_id, so the value was always null and every lookup fell through to matching
 * `os.hostname()`, which macOS rewrites on each mDNS collision:
 *
 *   registered   Alexs-MacBook-Pro-5054
 *   /health      Alexs-MacBook-Pro-8435.local
 *   os.hostname  Alexs-MacBook-Pro-8436.local
 *
 * Three names, one machine, one run. The running daemon knew its own node_id the whole time and
 * was simply never asked.
 */
import { describe, test, expect } from "bun:test"
import { resolveLocalNode, hostnameStem, type NodeSummary } from "../../src/cli/cmd/hive-local-node"

const NODES: NodeSummary[] = [
  { id: "019ef807-093f-73f0-baa9-2ac59691f986", name: "Alexs-MacBook-Pro-5054" },
  { id: "019e1d80-a446-71fa-84a3-6269bf19fab0", name: "AlexMaysnow1063" },
  { id: "019e6658-25b8-7257-8cf7-feb4ce64a2ec", name: "MacBookPro" },
]

describe("resolving the local node (#179064)", () => {
  test("the REAL case: config has no node_id and the hostname has drifted", () => {
    // Exactly the state measured on the machine. Before the fix this produced null; the daemon's
    // answer resolves it.
    const r = resolveLocalNode({
      daemonNodeId: "019ef807-093f-73f0-baa9-2ac59691f986",
      configNodeId: null,
      hostname: "Alexs-MacBook-Pro-8436.local",
      nodes: NODES,
    })
    expect(r.nodeId).toBe("019ef807-093f-73f0-baa9-2ac59691f986")
    expect(r.source).toBe("daemon")
    expect(r.uncertain).toBe(false)
  })

  test("the daemon outranks a stale config value", () => {
    // A config written by an older install must never win over the process that is running now.
    const r = resolveLocalNode({
      daemonNodeId: "019ef807-093f-73f0-baa9-2ac59691f986",
      configNodeId: "019e6658-25b8-7257-8cf7-feb4ce64a2ec",
      nodes: NODES,
    })
    expect(r.nodeId).toBe("019ef807-093f-73f0-baa9-2ac59691f986")
    expect(r.source).toBe("daemon")
  })

  test("falls back to config when the daemon is not running", () => {
    const r = resolveLocalNode({
      daemonNodeId: null,
      configNodeId: "019e6658-25b8-7257-8cf7-feb4ce64a2ec",
      nodes: NODES,
    })
    expect(r.nodeId).toBe("019e6658-25b8-7257-8cf7-feb4ce64a2ec")
    expect(r.source).toBe("config")
  })

  test("an id that matches no registered node is rejected, not reported", () => {
    // A stale id from a previous install would otherwise mark nothing while looking definitive.
    const r = resolveLocalNode({ daemonNodeId: "does-not-exist", nodes: NODES })
    expect(r.nodeId).toBeNull()
    expect(r.source).toBe("none")
  })

  test("hostname matching survives the macOS counter changing", () => {
    // The whole point. -8436 must still match the node registered as -5054.
    const r = resolveLocalNode({ hostname: "Alexs-MacBook-Pro-8436.local", nodes: NODES })
    expect(r.nodeId).toBe("019ef807-093f-73f0-baa9-2ac59691f986")
    expect(r.source).toBe("hostname")
  })

  test("a hostname match is flagged UNCERTAIN", () => {
    // It is a heuristic on a mutating value. Presenting a guess as a fact is how the wrong node
    // gets targeted by a future --node flag.
    const r = resolveLocalNode({ hostname: "Alexs-MacBook-Pro-8436.local", nodes: NODES })
    expect(r.uncertain).toBe(true)
  })

  test("refuses to guess when several nodes share a hostname stem", () => {
    // This is the duplicate-registration case. Picking one at random mislabels the fleet, and a
    // wrong "(you)" is worse than no "(you)".
    const dupes: NodeSummary[] = [
      { id: "a", name: "MacBookPro" },
      { id: "b", name: "MacBookPro" },
      { id: "c", name: "MacBookPro-2" },
    ]
    const r = resolveLocalNode({ hostname: "MacBookPro.local", nodes: dupes })
    expect(r.nodeId).toBeNull()
    expect(r.source).toBe("none")
  })

  test("returns none rather than throwing when there is nothing to go on", () => {
    expect(resolveLocalNode({}).nodeId).toBeNull()
    expect(resolveLocalNode({ nodes: [] }).source).toBe("none")
    expect(resolveLocalNode({ hostname: "", nodes: NODES }).nodeId).toBeNull()
  })
})

describe("hostnameStem", () => {
  test("strips the mDNS collision counter and .local", () => {
    // The counter is the mutating part; everything else is stable.
    expect(hostnameStem("Alexs-MacBook-Pro-8436.local")).toBe("alexs-macbook-pro")
    expect(hostnameStem("Alexs-MacBook-Pro-5054")).toBe("alexs-macbook-pro")
    expect(hostnameStem("Alexs-MacBook-Pro")).toBe("alexs-macbook-pro")
  })

  test("all three observed names for the same machine reduce to one stem", () => {
    const observed = ["Alexs-MacBook-Pro-5054", "Alexs-MacBook-Pro-8435.local", "Alexs-MacBook-Pro-8436.local"]
    const stems = new Set(observed.map(hostnameStem))
    expect(stems.size).toBe(1)
  })

  test("does not collapse genuinely different machines", () => {
    // Over-aggressive stripping would merge distinct hosts, which is a worse failure than the
    // one being fixed.
    expect(hostnameStem("AlexMaysnow1063")).not.toBe(hostnameStem("Alexs-MacBook-Pro-5054"))
    expect(hostnameStem("build-server-1")).not.toBe(hostnameStem("web-server-1"))
  })

  test("handles empty and missing input", () => {
    for (const v of ["", "   ", null, undefined]) {
      expect(hostnameStem(v as string | null)).toBeNull()
    }
  })
})
