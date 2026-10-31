/**
 * `iris pulse check <topic> --fleet` (#190970) — the same topic sweep on every other machine in your
 * Hive, so a thread worked on from the OptiPlex or a second laptop counts.
 *
 * Each node sweeps ITS OWN sessions and returns COUNTS ONLY (`--counts-only`): no excerpts, titles
 * or paths. Hive task output passes through the cloud, and agent transcripts carry client data —
 * moving them between machines is in BAA scope; moving numbers is not. The machine that asked files
 * the counts under a per-machine source name (`claude_code.iris-hive-001`), because the corpus
 * rollup is a flat merge: two machines both writing `claude_code_hits` would overwrite each other.
 *
 * A node that could not answer is NOT zero. Online-but-failed nodes report every requested source
 * as unavailable, with the reason; offline nodes are named in the report and contribute nothing.
 */
import type { SourceSweep } from "./pulse-check-sweep"

/** Sources that live on a machine rather than in an account — the only ones worth asking a node for. */
export const FLEET_SOURCES = ["claude_code", "opencode", "iris_desktop"] as const

export interface FleetNode {
  id: string
  name: string
  connection_status: string
  last_heartbeat_at?: string | null
}

export interface FleetNodeOutcome {
  node: string
  state: "ok" | "offline" | "failed"
  reason?: string
  sources?: number
}

export interface FleetDeps {
  nodes: () => Promise<FleetNode[]>
  /** This machine's node id — its sessions are already in the local sweep. */
  selfNodeId?: string | null
  /** Run `script` on the node; resolve its stdout, or throw with why it could not run. */
  run: (node: FleetNode, script: string) => Promise<string>
}

/** Column width of signal_observations.source. */
const SOURCE_MAX = 32

/** `claude_code` on "Alex's MacBook Pro" → `claude_code.alexs-macbook-pro`, cut to fit the column. */
export function fleetSourceId(source: string, nodeName: string): string {
  const room = SOURCE_MAX - source.length - 1
  const slug = nodeName
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[-_]+/, "")
    .slice(0, Math.max(1, room))
    .replace(/[-_]+$/, "")
  return `${source}.${slug || "node"}`
}

/** POSIX single-quote, so the topic cannot break out of the command. */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

export function fleetScript(keyword: string, days: number, sources: readonly string[]): string {
  // `iris` is not on PATH for non-interactive shells on every node; ~/.iris/bin is where it installs.
  return [
    "#!/bin/bash",
    'IRIS="$(command -v iris || echo "$HOME/.iris/bin/iris")"',
    `"$IRIS" pulse check ${shq(keyword)} --days ${Math.round(days)} --sources ${sources.join(",")} --no-push --counts-only --json`,
  ].join("\n")
}

/** The node's `--counts-only --json` document, tolerating noise printed before it. */
export function parseCounts(stdout: string): Array<Record<string, any>> | null {
  const text = String(stdout ?? "")
  const start = text.indexOf("{")
  if (start < 0) return null
  try {
    const doc = JSON.parse(text.slice(start))
    return Array.isArray(doc?.counts) ? doc.counts : null
  } catch {
    return null
  }
}

function shut(source: string, reason: string): SourceSweep {
  return { source, searched: false, unavailableReason: reason, hits: 0, items: [] }
}

export async function sweepFleet(
  keyword: string,
  days: number,
  sources: readonly string[],
  deps: FleetDeps,
): Promise<{ sweeps: SourceSweep[]; nodes: FleetNodeOutcome[] }> {
  let all: FleetNode[]
  try {
    all = await deps.nodes()
  } catch (e: any) {
    return { sweeps: [], nodes: [{ node: "hive", state: "failed", reason: `could not list your nodes: ${String(e?.message ?? e).slice(0, 120)}` }] }
  }
  const others = all.filter((n) => n.id !== deps.selfNodeId)
  // One machine re-registered keeps its name; ask the live one, once.
  const byName = new Map<string, FleetNode>()
  for (const n of others) {
    const seen = byName.get(n.name)
    if (!seen || (n.connection_status === "online" && seen.connection_status !== "online")) byName.set(n.name, n)
  }

  const nodes: FleetNodeOutcome[] = []
  const sweeps: SourceSweep[] = []
  const script = fleetScript(keyword, days, sources)
  await Promise.all(
    [...byName.values()].map(async (node) => {
      if (node.connection_status !== "online") {
        nodes.push({ node: node.name, state: "offline", reason: `last heartbeat ${node.last_heartbeat_at ?? "never"}` })
        return
      }
      let counts: Array<Record<string, any>> | null = null
      let why = ""
      try {
        counts = parseCounts(await deps.run(node, script))
        if (!counts) why = "no counts came back — the node's iris may predate --counts-only (iris update)"
      } catch (e: any) {
        why = String(e?.message ?? e).slice(0, 160)
        if (/unknown argument/i.test(why)) why = "its iris predates --fleet — run `iris update` on that machine"
      }
      if (!counts) {
        nodes.push({ node: node.name, state: "failed", reason: why })
        for (const src of sources) sweeps.push(shut(fleetSourceId(src, node.name), `${node.name}: ${why}`))
        return
      }
      nodes.push({ node: node.name, state: "ok", sources: counts.length })
      for (const c of counts) {
        const id = fleetSourceId(String(c.source), node.name)
        if (c.searched !== true) {
          sweeps.push(shut(id, `${node.name}: ${String(c.unavailable_reason ?? "could not look")}`))
          continue
        }
        sweeps.push({
          source: id,
          searched: true,
          hits: Number(c.hits) || 0,
          ...(typeof c.hits_prior === "number" ? { hitsPrior: c.hits_prior } : {}),
          ...(typeof c.last_hit_epoch === "number" ? { lastHitEpoch: c.last_hit_epoch } : {}),
          ...(c.capped ? { capped: true } : {}),
          items: [],
        })
      }
    }),
  )
  nodes.sort((a, b) => a.node.localeCompare(b.node))
  sweeps.sort((a, b) => a.source.localeCompare(b.source))
  return { sweeps, nodes }
}

/** The counts-only document a node prints for `--counts-only`: numbers, never content. */
export function countsDocument(keyword: string, days: number, sweeps: SourceSweep[]) {
  return {
    keyword,
    window_days: days,
    counts: sweeps.map((s) => ({
      source: s.source,
      searched: s.searched,
      unavailable_reason: s.searched ? null : (s.unavailableReason ?? null),
      hits: s.hits,
      hits_prior: s.hitsPrior ?? null,
      last_hit_epoch: s.lastHitEpoch ?? null,
      capped: Boolean(s.capped),
    })),
  }
}
