/**
 * Who is sending this `iris msg`?
 *
 * MEASURED FAILURE, 2026-10-28 (#191568). `iris msg send iris-hive-001 …` run ON iris-hive-002 was
 * delivered as from "Alexs-MacBook-Pro-11711". The sender was chosen as "the first node in the
 * account list that is not the recipient" — a guess that never asked which machine is local, so it
 * named whichever node the API happened to list first. The recipient (often an agent) then trusts,
 * or replies to, the wrong machine.
 *
 * The sender is the node this command runs on, identified by an AUTHORITATIVE id: the running
 * daemon's /health node_id, else ~/.iris/config.json node_id (see hive-local-node.ts). A hostname
 * match is a heuristic and is not good enough to sign a message with. When neither id names a
 * registered node, the message says so ("unknown") instead of borrowing another machine's name.
 */
import type { LocalNodeResolution } from "./hive-local-node"

export interface MsgSender {
  /** The registered node id of this machine, or null when this machine is not a known node. */
  nodeId: string | null
  /** The name stamped on the message. "unknown" when nodeId is null — never another node's name. */
  name: string
  /** Set when the sender could not be established; the caller shows it to the person. */
  warning?: string
}

export function resolveMsgSender(
  nodes: Array<{ id: unknown; name?: unknown }>,
  local: LocalNodeResolution,
): MsgSender {
  // A hostname match is "uncertain" by contract — a guess, which is exactly the defect.
  if (local.nodeId && !local.uncertain) {
    const self = nodes.find((n) => String(n.id) === local.nodeId)
    if (self) return { nodeId: String(self.id), name: String(self.name ?? local.nodeId) }
  }
  return {
    nodeId: null,
    name: "unknown",
    warning:
      "This machine is not a registered Hive node (no node_id from the local daemon or ~/.iris/config.json " +
      "matches a node on this account), so the message is sent as from \"unknown\". " +
      "Run `iris node install` here to make it a node.",
  }
}
