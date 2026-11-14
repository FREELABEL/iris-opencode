import { describe, expect, test } from "bun:test"
import { resolveMsgSender } from "../../src/cli/cmd/msg-sender"
import { resolveLocalNode } from "../../src/cli/cmd/hive-local-node"

/**
 * #191568 — `iris msg send iris-hive-001 …` run ON iris-hive-002 was delivered as from
 * "Alexs-MacBook-Pro-11711": the sender was "the first node that is not the recipient".
 * The node list below is in the order the API returned it on 2026-10-28 (the Mac first).
 */
const NODES = [
  { id: "mac-0001", name: "Alexs-MacBook-Pro-11711" },
  { id: "01a10379", name: "iris-hive-001" },
  { id: "01a1801e", name: "iris-hive-002" },
]

describe("resolveMsgSender — the sender is the machine the command runs on", () => {
  test("hive-002 sending to hive-001 is signed iris-hive-002, not the first other node", () => {
    const local = resolveLocalNode({ configNodeId: "01a1801e", nodes: NODES })
    const s = resolveMsgSender(NODES, local)
    expect(s.name).toBe("iris-hive-002")
    expect(s.nodeId).toBe("01a1801e")
    expect(s.warning).toBeUndefined()
  })

  test("the daemon's node id wins over a stale config id", () => {
    const local = resolveLocalNode({ daemonNodeId: "01a10379", configNodeId: "01a1801e", nodes: NODES })
    expect(resolveMsgSender(NODES, local).name).toBe("iris-hive-001")
  })

  test("a machine that is not a node says so — it never borrows another node's name", () => {
    const local = resolveLocalNode({ configNodeId: null, nodes: NODES })
    const s = resolveMsgSender(NODES, local)
    expect(s.name).toBe("unknown")
    expect(s.nodeId).toBeNull()
    expect(s.warning).toContain("not a registered Hive node")
    for (const n of NODES) expect(s.name).not.toBe(n.name)
  })

  test("a config id from a previous install (not on the account) is not trusted", () => {
    const local = resolveLocalNode({ configNodeId: "gone-old-install", nodes: NODES })
    expect(resolveMsgSender(NODES, local).name).toBe("unknown")
  })

  test("a hostname match is a guess and does not sign a message", () => {
    const local = resolveLocalNode({ hostname: "Alexs-MacBook-Pro-9999.local", nodes: NODES })
    expect(local.uncertain).toBe(true)
    expect(resolveMsgSender(NODES, local).name).toBe("unknown")
  })
})
