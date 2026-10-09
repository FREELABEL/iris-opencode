import { existsSync, readdirSync, readFileSync } from "fs"
import { join } from "path"
import { spawnSync } from "child_process"

/**
 * The Hive relay provider for `iris hive tunnel` (#188585) — pure helpers, tested in
 * platform-hive-relay.test.ts.
 *
 * The URL is https://<name>.t.heyiris.io. The relay (iris-hive-001, ours) routes by hostname and
 * never holds the certificate: this machine gets its own from Let's Encrypt THROUGH the relay and
 * keeps the key in ~/.iris/tunnels/<name>/. The runner is the Hive bridge's relay/tunnel.js, run
 * with Node — Bun cannot build a TLS server over an existing socket (measured: the handshake never
 * completes), and every Hive machine has Node for its bridge anyway.
 */

export const RELAY_ZONE = process.env.HIVE_RELAY_ZONE || "t.heyiris.io"

/**
 * A stable default name, so a second run reuses the certificate instead of asking Let's Encrypt
 * for a new one (new names are rate-limited across ALL tunnels; renewals are not).
 */
export function defaultTunnelName(hostname: string, port: number): string {
  const host = String(hostname || "node")
    .toLowerCase()
    .replace(/\.local$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "")
  return `${host || "node"}-${port}`
}

export function validTunnelName(name: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name)
}

export type RunnerEvent =
  | { event: "ready"; url: string; certificate?: "saved" | "requesting" }
  | { event: "cert"; notAfter: string; issuer?: string }
  | { event: "down" }
  | { event: "closed" }
  | { event: "error"; message: string; final?: boolean; retryInMinutes?: number }

/** One line of the runner's stdout → an event, or null for anything that is not one. */
export function parseRunnerLine(line: string): RunnerEvent | null {
  const t = String(line || "").trim()
  if (!t.startsWith("{")) return null
  try {
    const o = JSON.parse(t)
    return o && typeof o.event === "string" ? (o as RunnerEvent) : null
  } catch {
    return null
  }
}

/** Where the bridge keeps the runner. HIVE_RELAY_DIR overrides (a checkout of iris-daemon). */
export function findRunner(home: string, env: Record<string, string | undefined> = process.env, exists = existsSync): string | null {
  const dirs = [env.HIVE_RELAY_DIR && join(env.HIVE_RELAY_DIR, "relay"), join(home, ".iris", "bridge", "relay")].filter(Boolean) as string[]
  for (const d of dirs) if (exists(join(d, "tunnel.js")) && exists(join(d, "acme.js"))) return join(d, "tunnel.js")
  return null
}

/** Node ≥ 18 (global fetch, X509Certificate.checkHost). Newest nvm install wins over older PATH ones. */
export function findNode(home: string, env: Record<string, string | undefined> = process.env): string | null {
  const candidates: string[] = []
  if (env.IRIS_NODE) candidates.push(env.IRIS_NODE)
  const nvm = join(home, ".nvm", "versions", "node")
  try {
    const vs = readdirSync(nvm).filter((v) => /^v\d+/.test(v)).sort((a, b) => cmpVersion(b, a))
    for (const v of vs) candidates.push(join(nvm, v, "bin", "node"))
  } catch {}
  candidates.push("node", "/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node")
  for (const c of candidates) {
    const r = spawnSync(c, ["-p", "process.versions.node"], { encoding: "utf8", timeout: 5000 })
    if (r.status === 0 && Number(String(r.stdout).split(".")[0]) >= 18) return c
  }
  return null
}

function cmpVersion(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(".").map(Number)
  const pb = b.replace(/^v/, "").split(".").map(Number)
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0)
  return 0
}

/** The pid of a background tunnel for `name`, if one is still alive. */
export function runningPid(home: string, name: string): number | null {
  try {
    const pid = Number(readFileSync(join(home, ".iris", "tunnels", name, "tunnel.pid"), "utf8").trim())
    if (!Number.isInteger(pid) || pid <= 1) return null
    process.kill(pid, 0)
    return pid
  } catch {
    return null
  }
}

/** What an API refusal means for the person typing — the server's own words when it has them. */
export function explainTunnelApiError(status: number, body: any): string {
  const said = body?.error || body?.message
  if (status === 401) return "Sign in to IRIS first: iris auth login"
  if (status === 503) return said || "Hive tunnels are not switched on for this server yet."
  return said || `IRIS refused the tunnel (HTTP ${status})`
}
