/**
 * Give an existing Hive node a backup API host (#189649).
 *
 * Production daemons were never given a fallback, so when freelabel.net stopped answering on
 * 2026-10-14/15 every node failed cloud auth while heyiris.io was answering. Same node API, two
 * routes (origin vs Cloudflare). New daemons pick the pair themselves (iris-daemon
 * lib/api-fallback.js); EVERY daemon, old ones included, already reads `iris_api_url_fallback`
 * from ~/.iris/config.json. So writing that key on `iris update` protects customers' nodes
 * without a daemon update — from the daemon's next restart.
 *
 * Only adds the key. Never changes the primary, never overwrites a fallback someone set, and
 * never invents one for a custom host (a node key must not go somewhere unconfigured).
 */
import { existsSync, readFileSync, renameSync, statSync, writeFileSync, chmodSync } from "fs"
import { join } from "path"

const PAIRS: Record<string, string> = {
  "freelabel.net": "https://heyiris.io",
  "heyiris.io": "https://freelabel.net",
}

/** The paired host for a production API url, or null. */
export function pairedApiHost(apiUrl: unknown): string | null {
  try {
    const host = new URL(String(apiUrl)).hostname.toLowerCase().replace(/^www\./, "")
    return PAIRS[host] ?? null
  } catch {
    return null
  }
}

export type FallbackPlan = { change: false; reason: string } | { change: true; fallback: string; config: Record<string, unknown> }

/** Pure: what to do with this config. */
export function planApiFallback(config: Record<string, unknown> | null | undefined): FallbackPlan {
  if (!config || typeof config !== "object") return { change: false, reason: "no config" }
  if (!config.node_api_key) return { change: false, reason: "not a Hive node" }
  if (config.iris_api_url_fallback) return { change: false, reason: "fallback already set" }
  // The daemon reads api_url first, then iris_api_url, and uses freelabel.net when neither is set.
  const primary = (config.api_url as string) || (config.iris_api_url as string) || "https://freelabel.net"
  if (/local\.|localhost|127\.0\.0\.1/.test(primary)) return { change: false, reason: "local development node" }
  const fallback = pairedApiHost(primary)
  if (!fallback) return { change: false, reason: `custom API host (${primary}); no fallback invented` }
  return { change: true, fallback, config: { ...config, iris_api_url_fallback: fallback } }
}

/** Apply to ~/.iris/config.json. Returns a one-line message when it changed something, else null. Never throws. */
export function ensureApiFallback(home: string): string | null {
  try {
    if (!home) return null
    const p = join(home, ".iris", "config.json")
    if (!existsSync(p)) return null
    const plan = planApiFallback(JSON.parse(readFileSync(p, "utf8")))
    if (!plan.change) return null
    const mode = statSync(p).mode & 0o777
    const tmp = `${p}.tmp-${process.pid}`
    writeFileSync(tmp, JSON.stringify(plan.config, null, 2) + "\n", { mode })
    chmodSync(tmp, mode)
    renameSync(tmp, p)
    return `Hive node: added backup API host ${plan.fallback} (used if the main one stops answering; takes effect at the daemon's next restart)`
  } catch {
    return null
  }
}
