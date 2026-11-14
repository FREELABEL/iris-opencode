/**
 * Which registered Hive node is THIS machine?
 *
 * MEASURED FAILURE, 2026-08-05. `iris hive nodes list` marks the local node with "(you)". It
 * never appeared for anyone, because the resolution had exactly one real source and it was empty:
 *
 *   ~/.iris/config.json  ->  { api_url, node_api_key, user_id }        // no node_id, ever
 *
 * `localNodeId` was therefore always null and every lookup fell through to the hostname match
 * `n.name.includes(os.hostname())`. On macOS `os.hostname()` returns LocalHostName, which the OS
 * INCREMENTS on each mDNS name collision — so one laptop reported three different names in a
 * single run:
 *
 *   registered node name   Alexs-MacBook-Pro-5054
 *   daemon /health         Alexs-MacBook-Pro-8435.local
 *   os.hostname()          Alexs-MacBook-Pro-8436.local
 *
 * A frozen registered name compared against a mutating hostname cannot match, so the fallback
 * could not work either.
 *
 * The fix is that the answer was already available and simply never asked for: the running daemon
 * knows its own node_id and returns it from /health. Order the sources by authority — the daemon
 * first, config second, hostname last and only as a heuristic.
 *
 * SCOPE NOTE. This does NOT explain the duplicate/offline rows in the node list. Server-side
 * identity is keyed on node_api_key, so a re-install minting a fresh key is the likelier cause of
 * those. Fixing local-node detection is a separate, provable problem and this only claims that.
 */

export interface NodeSummary {
  id: string
  name: string
}

export type LocalNodeSource = "daemon" | "config" | "hostname" | "none"

export interface LocalNodeResolution {
  nodeId: string | null
  source: LocalNodeSource
  /** True when the answer came from a heuristic that can be wrong. */
  uncertain: boolean
}

export interface LocalNodeInputs {
  /** node_id reported by the running daemon at /health — authoritative when present. */
  daemonNodeId?: string | null
  /** node_id persisted in ~/.iris/config.json, if anything ever writes it. */
  configNodeId?: string | null
  /** os.hostname() — mutates on macOS, so it is a last resort. */
  hostname?: string | null
  /** The registered nodes to match against. */
  nodes?: NodeSummary[]
}

/**
 * Resolve which registered node is this machine.
 *
 * Sources are tried in order of authority, and the winner is reported so the caller can say how
 * confident it is. A guess presented as a fact is how the wrong node gets targeted.
 */
export function resolveLocalNode(inputs: LocalNodeInputs): LocalNodeResolution {
  const nodes = inputs.nodes ?? []
  const known = (id: string | null | undefined): string | null => {
    if (!id) return null
    // Only accept an id that actually exists in the list. A stale id from a previous install
    // would otherwise mark nothing while looking authoritative.
    return nodes.length === 0 || nodes.some((n) => n.id === id) ? id : null
  }

  const fromDaemon = known(inputs.daemonNodeId)
  if (fromDaemon) return { nodeId: fromDaemon, source: "daemon", uncertain: false }

  const fromConfig = known(inputs.configNodeId)
  if (fromConfig) return { nodeId: fromConfig, source: "config", uncertain: false }

  // Last resort. Compare on the STABLE stem of the hostname, because the trailing counter is
  // exactly the part macOS rewrites: Alexs-MacBook-Pro-8436.local -> Alexs-MacBook-Pro.
  const stem = hostnameStem(inputs.hostname)
  if (stem) {
    const matches = nodes.filter((n) => hostnameStem(n.name) === stem)
    // Only claim a match when it is UNambiguous. Several nodes sharing a stem is precisely the
    // duplicate-registration case, and picking one at random would mislabel the fleet.
    if (matches.length === 1) {
      return { nodeId: matches[0].id, source: "hostname", uncertain: true }
    }
  }

  return { nodeId: null, source: "none", uncertain: false }
}

/**
 * Strip the mDNS collision counter and the .local suffix, so a name survives the OS renaming it.
 *
 *   Alexs-MacBook-Pro-8436.local -> alexs-macbook-pro
 *   Alexs-MacBook-Pro-5054       -> alexs-macbook-pro
 */
export function hostnameStem(name: string | null | undefined): string | null {
  if (!name) return null
  const bare = String(name)
    .trim()
    .replace(/\.local$/i, "")
    .replace(/-\d+$/, "")
    .toLowerCase()
  return bare.length ? bare : null
}
