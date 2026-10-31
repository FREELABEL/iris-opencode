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
/**
 * The oldest Node a relay tunnel may run on (#191176). Node 18 crashes the runner: TLS layered
 * over a JS stream (relay/tunnel.js) throws ERR_INTERNAL_ASSERTION in JSStreamSocket.doWrite on
 * the first real request. Measured 2026-10-26 on iris-hive-001 (Node 18.19.1): GET /healthz
 * worked, the first POST killed the tunnel, and the machine's models went unreachable. The
 * same runner on Node 22 served streamed answers with no crash.
 */
export const RELAY_MIN_NODE = 20

const probeNode = (bin: string): number | null => {
  const r = spawnSync(bin, ["-p", "process.versions.node"], { encoding: "utf8", timeout: 5000 })
  return r.status === 0 ? Number(String(r.stdout).split(".")[0]) : null
}

/**
 * A Node that can run the relay runner: IRIS_NODE, then the installer's own runtime
 * (~/.iris/runtime/node-*, the same place daemonctl looks), then nvm's newest, then PATH and the
 * usual locations. The first at RELAY_MIN_NODE or newer wins; an older one is skipped, not used.
 */
export function findNode(
  home: string,
  env: Record<string, string | undefined> = process.env,
  probe: (bin: string) => number | null = probeNode,
): string | null {
  const candidates: string[] = []
  if (env.IRIS_NODE) candidates.push(env.IRIS_NODE)
  const newestFirst = (dir: string, re: RegExp, bin: (v: string) => string) => {
    try {
      const vs = readdirSync(dir).filter((v) => re.test(v)).sort((a, b) => cmpVersion(b.replace(/^node-/, ""), a.replace(/^node-/, "")))
      for (const v of vs) candidates.push(bin(v))
    } catch {}
  }
  newestFirst(join(home, ".iris", "runtime"), /^node-v?\d+/, (v) => join(home, ".iris", "runtime", v, "bin", "node"))
  newestFirst(join(home, ".nvm", "versions", "node"), /^v\d+/, (v) => join(home, ".nvm", "versions", "node", v, "bin", "node"))
  candidates.push("node", "/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node")
  for (const c of candidates) {
    const major = probe(c)
    if (major !== null && major >= RELAY_MIN_NODE) return c
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
