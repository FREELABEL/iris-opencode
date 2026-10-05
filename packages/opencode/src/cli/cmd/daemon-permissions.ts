/**
 * Full Disk Access for the IRIS daemon — read it, name it, fix it.
 *
 * Apple Mail search runs inside the launchd daemon, not inside this CLI. macOS grants Full
 * Disk Access per EXECUTABLE, so the grant that matters is the daemon's node binary — your
 * terminal's grant does nothing for it. Before this module, `iris pulse check` and
 * `iris mail search` printed the daemon's raw 503 ("No permission to read Mail …") and
 * stopped: the reader was told what was wrong and not what to do about it.
 *
 * The daemon (iris-daemon PR #10) answers `GET /daemon/permissions` with which binary it
 * runs as, whether the RUNNING process can read protected files, and whether a FRESH process
 * of the same binary can (that is the one that reflects a grant made a minute ago — TCC is
 * resolved at process start, so a running daemon keeps its old answer until restarted).
 *
 * Everything here is best-effort and never throws: a permissions check that crashes the
 * command it was meant to explain is worse than the raw 503 it replaced.
 */

import { execFileSync } from "child_process"
import { existsSync, readFileSync } from "fs"
import { homedir } from "os"
import { join } from "path"

export const GRANT_COMMAND = "iris-daemon grant-access"
export const RESTART_COMMAND = "iris-daemon restart"
/** The real way to update an installed daemon — `iris node install` re-fetches it in place. */
export const UPDATE_COMMAND = "iris node install"
export const FDA_SETTINGS_URL = "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"

export type PermissionState =
  | "granted"
  | "denied"
  | "restart_needed"
  | "unknown"
  | "old_daemon"
  | "daemon_starting"
  | "daemon_down"

export interface DaemonPermissions {
  state: PermissionState
  /** The executable macOS must approve. From the endpoint, or found locally for an old daemon. */
  binary: string | null
  /** Plain-language reason for the state. */
  reason: string
  /** The command that fixes it on THIS daemon — null when there is nothing to fix. */
  command: string | null
  settingsUrl: string
  /** Whether the installed daemonctl knows `grant-access` (false on daemons before PR #10). */
  grantAccessSupported: boolean
  /** The endpoint body, when there was one. */
  raw?: any
}

export interface FetchOptions {
  bridgeUrl?: string
  bridgeKey?: string | null
  timeoutMs?: number
  fetchImpl?: typeof fetch
  /** Overrides for tests — what the local fallbacks would find. */
  locateBinary?: () => string | null
  grantAccessSupported?: () => boolean
  /**
   * How long to keep asking while the daemon is still starting (its /daemon/* routes mount a
   * few seconds after the bridge starts serving). 0 = ask once. Interactive commands pass ~10s.
   */
  waitForStartMs?: number
  /** Test seam for the retry pause. */
  sleep?: (ms: number) => Promise<void>
}

/** A TCC refusal, as the daemon and sqlite3 phrase it — not "Mail is not installed". */
/**
 * Operator mode: the people who run IRIS (IRIS_OPERATOR=1). They get the exact file, the
 * grant-access command and the offer to fix it. Clients do not, because the fix today means approving
 * a stock `node` binary, which gives every Node program on the Mac Full Disk Access. That is
 * an operator's call to make, not a prompt to put in front of a client (client-ready gate,
 * 2026-10-04; the client path is epic #187965, a signed "IRIS" approval).
 */
export function operatorMode(env: Record<string, string | undefined> = process.env): boolean {
  const v = (env.IRIS_OPERATOR ?? "").toLowerCase()
  return v === "1" || v === "true" || v === "yes"
}

export function isTccDenial(message: string | null | undefined): boolean {
  if (!message) return false
  return /no permission to read|full disk access|operation not permitted|authorization denied/i.test(message)
}

function daemonCtlPath(): string {
  return join(homedir(), ".iris", "bin", process.platform === "win32" ? "iris-daemon.cmd" : "iris-daemon")
}

export function daemonCtl(): string | null {
  const p = daemonCtlPath()
  return existsSync(p) ? p : null
}

/** Does the installed daemonctl have the `grant-access` verb? Read off the script itself. */
export function daemonSupportsGrantAccess(): boolean {
  try {
    const p = daemonCtl()
    return !!p && readFileSync(p, "utf8").includes("grant-access")
  } catch {
    return false
  }
}

/**
 * Which binary is the daemon running as, without its help — for daemons that predate
 * `/daemon/permissions`. The process listening on the bridge port is the daemon; its argv is
 * `node daemon.js` (relative), so matching on a path in argv finds nothing. Fall back to the
 * pinned binary the installer records.
 */
export function locateDaemonBinary(bridgeUrl?: string): string | null {
  if (process.platform !== "darwin") return null
  const port = (() => {
    try {
      return new URL(bridgeUrl ?? "http://127.0.0.1:3200").port || "3200"
    } catch {
      return "3200"
    }
  })()
  try {
    const pid = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
      encoding: "utf8",
      timeout: 1500,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .trim()
      .split("\n")[0]
    if (pid) {
      const comm = execFileSync("ps", ["-o", "comm=", "-p", pid], {
        encoding: "utf8",
        timeout: 1500,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim()
      if (comm.startsWith("/")) return comm
    }
  } catch {
    /* fall through to the pinned path */
  }
  try {
    const pinned = readFileSync(join(homedir(), ".iris", "daemon-node"), "utf8").trim()
    return pinned || null
  } catch {
    return null
  }
}

/** Turn the endpoint's body into one state. Exported so the rules can be tested directly. */
export function classifyPermissions(body: any): { state: PermissionState; reason: string } {
  if (!body || typeof body !== "object")
    return { state: "unknown", reason: "the daemon answered with no permissions object" }
  if (body.platform && body.platform !== "darwin")
    return { state: "granted", reason: "Full Disk Access is a macOS concept" }
  const proc = body.process?.available
  const fresh = body.fresh?.available
  if (proc === true)
    return { state: "granted", reason: body.process?.reason ?? "the running daemon can read protected files" }
  if (body.restart_needed === true || (proc === false && fresh === true))
    return { state: "restart_needed", reason: "granted — the running daemon still has the answer it started with" }
  if (proc === false) return { state: "denied", reason: body.process?.reason ?? "the daemon has no Full Disk Access" }
  return { state: "unknown", reason: body.process?.reason ?? "the daemon could not tell" }
}

/** Ask the daemon. 1.5s, never throws. */
export async function fetchDaemonPermissions(opts: FetchOptions = {}): Promise<DaemonPermissions> {
  let bridgeUrl = opts.bridgeUrl
  let bridgeKey = opts.bridgeKey
  if (bridgeUrl === undefined || bridgeKey === undefined) {
    const api = await import("./iris-api").catch(() => null)
    bridgeUrl ??= api?.BRIDGE_URL ?? "http://127.0.0.1:3200"
    if (bridgeKey === undefined) bridgeKey = api?.getBridgeToken() ?? null
  }
  const base = bridgeUrl!.replace(/\/$/, "")
  const doFetch = opts.fetchImpl ?? fetch
  const locate = opts.locateBinary ?? (() => locateDaemonBinary(base))
  const supported = (opts.grantAccessSupported ?? daemonSupportsGrantAccess)()

  const make = (state: PermissionState, reason: string, binary: string | null, raw?: any): DaemonPermissions => ({
    state,
    reason,
    binary,
    settingsUrl: raw?.fix?.settings_url ?? FDA_SETTINGS_URL,
    grantAccessSupported: supported,
    command:
      state === "granted"
        ? null
        : state === "restart_needed"
          ? RESTART_COMMAND
          : state === "daemon_down"
            ? "iris daemon start"
            : state === "daemon_starting"
              ? null
              : state === "old_daemon"
                ? UPDATE_COMMAND
                : (raw?.fix?.command ?? GRANT_COMMAND),
    raw,
  })

  const headers: Record<string, string> = { Accept: "application/json" }
  if (bridgeKey) headers["X-Bridge-Key"] = bridgeKey
  const timeoutMs = opts.timeoutMs ?? 1500
  const get = (path: string) => doFetch(`${base}${path}`, { headers, signal: AbortSignal.timeout(timeoutMs) })

  const once = async (): Promise<DaemonPermissions> => {
    let res: Response
    try {
      res = await get("/daemon/permissions")
    } catch (e: any) {
      const name = String(e?.name ?? "")
      if (name === "TimeoutError" || name === "AbortError")
        return make("unknown", `the daemon did not answer within ${timeoutMs}ms`, locate())
      return make("daemon_down", `the IRIS daemon is not running at ${base}`, null)
    }

    // A 404 is NOT proof of an old daemon: the embedded daemon mounts /daemon/* a few
    // seconds after the bridge starts serving, so a just-restarted daemon 404s here too.
    // /daemon/health tells them apart — answered means the routes are up and this one
    // genuinely does not exist.
    if (res.status === 404) {
      const health = await get("/daemon/health").catch(() => null)
      if (health && health.status !== 404)
        return make(
          "old_daemon",
          "this daemon predates the permissions check — update it to get `iris-daemon grant-access`",
          locate(),
        )
      return make("daemon_starting", "the daemon is still starting — try again in a moment", locate())
    }
    return finish(res)
  }

  const deadline = Date.now() + (opts.waitForStartMs ?? 0)
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  let result = await once()
  while (result.state === "daemon_starting" && Date.now() < deadline) {
    await sleep(1000)
    result = await once()
  }
  return result

  async function finish(res: Response): Promise<DaemonPermissions> {
    if (res.status === 401 || res.status === 403)
      return make("unknown", "the daemon rejected the bridge token (~/.iris/bridge-token missing or stale)", locate())
    if (!res.ok) return make("unknown", `the permissions check returned ${res.status}`, locate())

    const body = await res.json().catch(() => null)
    const { state, reason } = classifyPermissions(body)
    return make(state, reason, (typeof body?.binary === "string" && body.binary) || locate(), body)
  }
}

/**
 * Two or three plain lines: what to run, and the exact file macOS will be asked to approve.
 * The binary is the whole point — "grant Full Disk Access to iris-daemon" names nothing you
 * can find in the panel, and people add their terminal instead, which cannot work.
 */
export function fdaFixLines(p: DaemonPermissions): string[] {
  const file = p.binary ? `(approves ${p.binary})` : ""
  switch (p.state) {
    case "granted":
      return []
    case "restart_needed":
      return [`granted — restart pending: ${RESTART_COMMAND}`]
    case "daemon_down":
      return ["start the daemon: iris daemon start"]
    case "daemon_starting":
      return ["the daemon is still starting — try again in a moment"]
    case "old_daemon":
      if (p.grantAccessSupported) return [`fix once: ${GRANT_COMMAND}   ${file}`.trimEnd()]
      // This daemon has no grant-access verb, so naming it would name a command that fails.
      if (!p.binary) return [`fix once: update the daemon (${UPDATE_COMMAND}), then ${GRANT_COMMAND}`]
      return [
        `fix once: add ${p.binary}`,
        `to System Settings › Privacy & Security › Full Disk Access, then ${RESTART_COMMAND}`,
        `(or update the daemon — ${UPDATE_COMMAND} — and run ${GRANT_COMMAND})`,
      ]
    default:
      return [`fix once: ${p.command ?? GRANT_COMMAND}   ${file}`.trimEnd()]
  }
}

/** Machine-readable form of the fix, for --json consumers. */
export function fdaFixJson(p: DaemonPermissions) {
  return {
    process: "daemon" as const,
    state: p.state,
    binary: p.binary,
    command: p.state === "old_daemon" && p.grantAccessSupported ? GRANT_COMMAND : p.command,
    settings_url: p.settingsUrl,
    restart_needed: p.state === "restart_needed",
    reason: p.reason,
  }
}

/**
 * Whether a command may stop and ask. Never in a pipe, never under --json, never in CI —
 * an unattended run that waits on a prompt is a hung run.
 */
export function mayPromptForFix(o: {
  json?: boolean
  stdinTTY?: boolean
  stdoutTTY?: boolean
  env?: Record<string, string | undefined>
}): boolean {
  const env = o.env ?? process.env
  if (!operatorMode(env)) return false
  if (o.json) return false
  if (!o.stdinTTY || !o.stdoutTTY) return false
  if (env.CI && env.CI !== "false" && env.CI !== "0") return false
  return true
}

/** Run `iris-daemon grant-access` with the terminal attached. Resolves to its exit code. */
export async function runGrantAccess(extra: string[] = []): Promise<number> {
  const ctl = daemonCtl()
  if (!ctl) return 127
  const { spawn } = await import("child_process")
  return await new Promise<number>((resolve) => {
    const child = spawn(ctl, ["grant-access", ...extra], { stdio: "inherit" })
    child.on("close", (code) => resolve(code ?? 1))
    child.on("error", () => resolve(127))
  })
}

/**
 * For a daemon without `grant-access`: do the parts that need no daemon help — put the path
 * on the clipboard, open the pane, show the file in Finder. The restart stays with the user.
 */
export function openFdaPaneFor(binary: string | null, settingsUrl = FDA_SETTINGS_URL): void {
  const quiet = { stdio: "ignore" as const, timeout: 3000 }
  try {
    if (binary) execFileSync("pbcopy", [], { ...quiet, input: binary, stdio: ["pipe", "ignore", "ignore"] })
  } catch {}
  try {
    execFileSync("open", [settingsUrl], quiet)
  } catch {}
  try {
    if (binary) execFileSync("open", ["-R", binary], quiet)
  } catch {}
}

// ── rendering a blind spot ────────────────────────────────────────────────────

/** The app a terminal-side grant has to go to. TERM_PROGRAM is what the terminal sets. */
export function terminalAppName(env: Record<string, string | undefined> = process.env): string {
  const t = env.TERM_PROGRAM ?? ""
  const known: Record<string, string> = {
    Apple_Terminal: "Terminal",
    "iTerm.app": "iTerm",
    vscode: "your editor (VS Code / Cursor)",
    ghostty: "Ghostty",
    WarpTerminal: "Warp",
    WezTerm: "WezTerm",
    Hyper: "Hyper",
  }
  return known[t] ?? "your terminal app"
}

export interface BlindSpotRender {
  /** Text after the source label on the first line. */
  headline: string
  /** Continuation lines, to be indented under the headline. */
  fix: string[]
}

/**
 * How a TCC blind spot reads. Mail is read by the DAEMON; Messages is read by sqlite3 run
 * from THIS process, so it needs the terminal's grant — two different fixes, and offering
 * the daemon's for Messages would send someone to approve the wrong program.
 */
export function renderTccBlindSpot(
  what: "Mail" | "Messages",
  via: "daemon" | "terminal",
  perms: DaemonPermissions | null,
  env: Record<string, string | undefined> = process.env,
): BlindSpotRender {
  if (!operatorMode(env)) {
    // One calm line, no paths and no program names. The source is skipped, not "failing".
    return {
      headline: `skipped — ${what} isn't connected to IRIS on this Mac yet`,
      fix: [],
    }
  }
  if (via === "terminal") {
    const app = terminalAppName(env)
    return {
      headline: `blind — this terminal isn't allowed to read ${what} (Full Disk Access)`,
      fix: [`fix once: add ${app} to System Settings › Privacy & Security › Full Disk Access, then reopen it`],
    }
  }
  if (perms?.state === "granted")
    return {
      headline: `not searched — ${what} was refused, but the daemon reports access now`,
      fix: ["run the check again"],
    }
  if (perms?.state === "restart_needed")
    return { headline: `blind — Full Disk Access granted, not yet in effect`, fix: fdaFixLines(perms) }
  return {
    headline: `blind — this Mac's IRIS daemon isn't allowed to read ${what} (Full Disk Access)`,
    fix: perms ? fdaFixLines(perms) : [`fix once: ${GRANT_COMMAND}`],
  }
}
