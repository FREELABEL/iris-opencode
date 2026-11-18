import { execFile } from "child_process"
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs"
import { homedir } from "os"
import path from "path"
import { irisCliPath } from "./playbook-install"

/**
 * Settings → Hive → "Allow access to this computer" (epic #192964, W2).
 *
 * ONE FILE, READ BY THE DAEMON. `~/.iris/remote-access.json` = `{ "allow": boolean }`. Absent means
 * ON, matching the CLI, where signing in brings the machine online (#185896). The daemon
 * (iris-bridge `daemon/remote-access.js`) reads it on every heartbeat and watches it:
 *   ON  — the machine is a Hive node: listed, sessions routed, `send-input`/`answer` accepted.
 *         Turning it on also runs `iris hive connect`, the same path `iris auth login` takes
 *         (`wakeHiveNode`), so a machine whose daemon was down comes online too.
 *   OFF — the daemon says goodbye on every beat (the hub lists it offline within seconds) and
 *         refuses inbound control. Its own scheduled work keeps running. Whether OFF should stop
 *         the daemon outright is an open question on the epic; this is the proposal.
 *
 * Nothing here talks to the hub. What another machine sees is the daemon's report, not this file.
 */

export interface RemoteAccessState {
  measured: boolean
  reason?: string
  /** The switch. */
  allow: boolean
  /** False when nobody has touched the switch yet, so `allow` is the default. */
  explicit: boolean
  /** What this machine's daemon says right now. */
  daemon: "online" | "not-enrolled" | "not-running"
  nodeId: string | null
}

type Exec = (file: string, args: string[], opts: { timeoutMs: number }) => Promise<{ code: number; stdout: string; stderr: string }>

export interface RemoteAccessDeps {
  home: string
  cli: string | null
  exec: Exec
  /** This machine's daemon /health, or null when nothing answers. */
  health: () => Promise<{ node_id?: string | null } | null>
  now: () => Date
}

const realExec: Exec = (file, args, opts) =>
  new Promise((resolve) => {
    execFile(file, args, { timeout: opts.timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as any).code === "number" ? (err as any).code : 1) : 0
      resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") || (err ? String(err.message) : "") })
    })
  })

async function realHealth() {
  try {
    const res = await fetch("http://localhost:3200/health", { signal: AbortSignal.timeout(2000) })
    return res.ok ? ((await res.json()) as { node_id?: string | null }) : null
  } catch {
    return null
  }
}

function defaults(): RemoteAccessDeps {
  return { home: homedir(), cli: irisCliPath(), exec: realExec, health: realHealth, now: () => new Date() }
}

export function remoteAccessFile(home: string) {
  return path.join(home, ".iris", "remote-access.json")
}

/** The switch as the daemon reads it: only an explicit `"allow": false` is OFF. */
export function readSwitch(home: string): { allow: boolean; explicit: boolean } {
  const file = remoteAccessFile(home)
  if (!existsSync(file)) return { allow: true, explicit: false }
  try {
    const d = JSON.parse(readFileSync(file, "utf8"))
    return { allow: d?.allow !== false, explicit: typeof d?.allow === "boolean" }
  } catch {
    return { allow: true, explicit: false }
  }
}

async function daemonState(deps: RemoteAccessDeps): Promise<Pick<RemoteAccessState, "daemon" | "nodeId">> {
  const h = await deps.health()
  if (!h) return { daemon: "not-running", nodeId: null }
  const id = typeof h.node_id === "string" && h.node_id ? h.node_id : null
  return { daemon: id ? "online" : "not-enrolled", nodeId: id }
}

export async function readRemoteAccess(over: Partial<RemoteAccessDeps> = {}): Promise<RemoteAccessState> {
  const deps = { ...defaults(), ...over }
  return { measured: true, ...readSwitch(deps.home), ...(await daemonState(deps)) }
}

/** `iris hive connect --json` prints its JSON last. */
export function parseConnect(stdout: string): { node_id: string | null; online: boolean } | null {
  const lines = stdout.trim().split("\n").reverse()
  for (const l of lines) {
    const t = l.trim()
    if (!t.startsWith("{")) continue
    try {
      const d = JSON.parse(t)
      if ("online" in d) return { node_id: typeof d.node_id === "string" ? d.node_id : null, online: d.online === true }
    } catch {}
  }
  return null
}

export async function setRemoteAccess(allow: boolean, over: Partial<RemoteAccessDeps> = {}): Promise<RemoteAccessState> {
  const deps = { ...defaults(), ...over }
  const file = remoteAccessFile(deps.home)
  // Written whole, then renamed: the daemon polls this file, and must never read half of it.
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify({ allow, updated_at: deps.now().toISOString(), by: "desktop" }, null, 2) + "\n")
  renameSync(tmp, file)

  if (!allow) return { measured: true, allow, explicit: true, ...(await daemonState(deps)) }

  // ON = `iris hive connect`: wake the daemon (or install it) and wait for it to enroll.
  if (!deps.cli) {
    return {
      measured: true,
      allow,
      explicit: true,
      ...(await daemonState(deps)),
      reason: "Allowed. The iris CLI is not installed on this computer, so IRIS could not start its Hive daemon.",
    }
  }
  const r = await deps.exec(deps.cli, ["hive", "connect", "--json"], { timeoutMs: 120_000 })
  const out = parseConnect(r.stdout)
  const now = await daemonState(deps)
  if (out?.online || now.daemon === "online") return { measured: true, allow, explicit: true, ...now, nodeId: now.nodeId ?? out?.node_id ?? null }
  const last = (r.stderr || r.stdout).trim().split("\n").filter(Boolean).pop()
  return {
    measured: true,
    allow,
    explicit: true,
    ...now,
    reason: `Allowed, but this computer did not come online${last ? `: ${last.slice(0, 200)}` : ""}. Check it with: iris hive doctor`,
  }
}
