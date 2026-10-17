/**
 * THIS computer's Hive daemon, for the machines dialog (#189763): is it running, which code does it
 * run, and the one repair a person can do without a terminal — restart it.
 *
 * Why the sidecar and not the hub: the hub only knows what the daemon last reported. Every
 * failure on 2026-10-17 was invisible from there — a daemon 14 commits behind still heartbeats,
 * and a launch agent loaded from /tmp works perfectly until the next reboot. Only this machine
 * can read its own launchd job and its own checkout.
 *
 * execFile (async), never execFileSync: this module runs inside the sidecar's HTTP server, and a
 * synchronous child process blocks every other request until it returns.
 */
import { execFile } from "child_process"
import { existsSync, readFileSync, statSync } from "fs"
import { homedir } from "os"
import path from "path"

type Result<T> = { measured: boolean; reason?: string; data: T }

export const DAEMON_LABEL = "io.heyiris.daemon"

export interface LocalDaemon {
  /** False on systems where this app cannot inspect the daemon yet (Linux, Windows). */
  supported: boolean
  /** This machine's Hive node id, from ~/.iris/config.json — how the dialog finds its card. */
  nodeId: string | null
  running: boolean
  pid: number | null
  /** What launchd actually runs — not what the plist on disk says. */
  program: string | null
  /** The job runs from ~/.iris. False = it would not survive a reboot (#189762: /tmp/iris-fresh). */
  programOk: boolean | null
  /** Short commit of ~/.iris/bridge. */
  version: string | null
  /** Commits behind origin/main AS OF THE LAST FETCH — see fetchedAt. Null = could not tell. */
  behind: number | null
  fetchedAt: string | null
  /** Tracked files changed by hand in ~/.iris/bridge (an update must not discard them). */
  localEdits: number | null
}

const run = (cmd: string, args: string[], timeout = 8000) =>
  new Promise<{ ok: boolean; out: string }>((resolve) =>
    execFile(cmd, args, { timeout, maxBuffer: 1 << 20 }, (err, stdout) => resolve({ ok: !err, out: String(stdout ?? "") })),
  )

const BRIDGE = () => path.join(homedir(), ".iris", "bridge")
const PLIST = () => path.join(homedir(), "Library", "LaunchAgents", `${DAEMON_LABEL}.plist`)
const target = () => `gui/${process.getuid?.() ?? 501}/${DAEMON_LABEL}`

/** Pure: read pid and program out of `launchctl print`. Exported for tests. */
export function parseLaunchctl(out: string): { pid: number | null; program: string | null } {
  const pid = /^\s*pid = (\d+)/m.exec(out)?.[1]
  const program = /^\s*program = (.+)$/m.exec(out)?.[1]?.trim()
  return { pid: pid ? Number(pid) : null, program: program ?? null }
}

/** Pure: does launchd run the daemon from the user's ~/.iris? Exported for tests. */
export function programIsHome(program: string | null, home: string): boolean | null {
  if (!program) return null
  return program.startsWith(path.join(home, ".iris") + path.sep)
}

function nodeIdOf(): string | null {
  try {
    const c = JSON.parse(readFileSync(path.join(homedir(), ".iris", "config.json"), "utf-8"))
    return typeof c.node_id === "string" ? c.node_id : null
  } catch {
    return null
  }
}

async function launchd(): Promise<{ pid: number | null; program: string | null; loaded: boolean }> {
  const r = await run("launchctl", ["print", target()])
  if (!r.ok) return { pid: null, program: null, loaded: false }
  return { ...parseLaunchctl(r.out), loaded: true }
}

async function checkout(): Promise<Pick<LocalDaemon, "version" | "behind" | "fetchedAt" | "localEdits">> {
  const dir = BRIDGE()
  if (!existsSync(path.join(dir, ".git"))) return { version: null, behind: null, fetchedAt: null, localEdits: null }
  const [head, behind, edits] = await Promise.all([
    run("git", ["-C", dir, "rev-parse", "--short", "HEAD"]),
    run("git", ["-C", dir, "rev-list", "--count", "HEAD..origin/main"]),
    run("git", ["-C", dir, "status", "--porcelain", "--untracked-files=no"]),
  ])
  let fetchedAt: string | null = null
  try {
    fetchedAt = statSync(path.join(dir, ".git", "FETCH_HEAD")).mtime.toISOString()
  } catch {}
  return {
    version: head.ok ? head.out.trim() : null,
    behind: behind.ok && /^\d+$/.test(behind.out.trim()) ? Number(behind.out.trim()) : null,
    fetchedAt,
    localEdits: edits.ok ? edits.out.split("\n").filter((l) => l.trim()).length : null,
  }
}

export async function fetchLocalDaemon(): Promise<Result<LocalDaemon>> {
  const nodeId = nodeIdOf()
  const empty: LocalDaemon = {
    supported: process.platform === "darwin",
    nodeId,
    running: false,
    pid: null,
    program: null,
    programOk: null,
    version: null,
    behind: null,
    fetchedAt: null,
    localEdits: null,
  }
  if (process.platform !== "darwin")
    return { measured: false, reason: "checking the daemon from the app is Mac-only for now", data: empty }
  try {
    // A fetch so "behind" is today's answer, bounded: offline must not hang the dialog.
    await run("git", ["-C", BRIDGE(), "fetch", "-q", "origin", "main"], 6000)
    const [ld, co] = await Promise.all([launchd(), checkout()])
    return {
      measured: true,
      reason: ld.loaded ? undefined : "the Hive daemon is not loaded on this Mac",
      data: { ...empty, ...co, running: ld.pid !== null, pid: ld.pid, program: ld.program, programOk: programIsHome(ld.program, homedir()) },
    }
  } catch (e) {
    return { measured: false, reason: e instanceof Error ? e.message : String(e), data: empty }
  }
}

export interface RestartResult {
  before: number | null
  after: number | null
  /** The launch agent was re-loaded from ~/Library/LaunchAgents because it ran from elsewhere. */
  repaired: boolean
}

/**
 * Restart this Mac's daemon, and say whether it actually came back — by PID, not by exit code
 * (`kickstart` exits 0 before the new process exists). If launchd runs it from outside ~/.iris,
 * re-load the real plist instead, which is the repair for the /tmp case.
 */
export async function restartLocalDaemon(): Promise<Result<RestartResult>> {
  const none: RestartResult = { before: null, after: null, repaired: false }
  if (process.platform !== "darwin") return { measured: false, reason: "restarting from the app is Mac-only for now", data: none }
  const before = await launchd()
  const repair = before.loaded && programIsHome(before.program, homedir()) === false && existsSync(PLIST())
  if (repair) {
    await run("launchctl", ["bootout", target()], 15000)
    const b = await run("launchctl", ["bootstrap", `gui/${process.getuid?.() ?? 501}`, PLIST()], 15000)
    if (!b.ok) return { measured: false, reason: "could not re-load the launch agent", data: { ...none, before: before.pid } }
  } else if (before.loaded) {
    const k = await run("launchctl", ["kickstart", "-k", target()], 15000)
    if (!k.ok) return { measured: false, reason: "launchd refused the restart", data: { ...none, before: before.pid } }
  } else if (existsSync(PLIST())) {
    const b = await run("launchctl", ["bootstrap", `gui/${process.getuid?.() ?? 501}`, PLIST()], 15000)
    if (!b.ok) return { measured: false, reason: "could not load the launch agent", data: none }
  } else {
    return { measured: false, reason: "no Hive daemon is installed on this Mac — run: iris hive start", data: none }
  }
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500))
    const now = await launchd()
    if (now.pid && now.pid !== before.pid) return { measured: true, data: { before: before.pid, after: now.pid, repaired: repair } }
  }
  return {
    measured: false,
    reason: "launchd accepted the restart but no new daemon process appeared within 15 s",
    data: { before: before.pid, after: null, repaired: repair },
  }
}
