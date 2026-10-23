/**
 * Put the signed-in account's IRIS agents in the agent picker, without anyone typing a command
 * (epic #189448, S1).
 *
 * The work is done by the IRIS CLI — `iris agents desktop-sync` — which writes one agent file per
 * IRIS agent into the config folder this engine reads. This module only decides whether to run
 * it and makes sure it can never stop the app from opening:
 *
 * - It runs in the BACKGROUND after the engine is listening. lib.rs gives the engine 7 seconds
 *   to come up and then shows "Startup Failed" and exits — a sync in front of listen() could
 *   spend that budget on a slow network. When the sync changes files, the caller reloads config.
 * - Switching IRIS accounts restarts the engine (lib.rs restart_engine), so this also runs on
 *   every sign-in and account switch, and the picker follows the active account.
 * - No CLI installed, no network, a slow API, a non-zero exit: all are a skipped sync, logged,
 *   never a failed start. A single bad agent file once stopped the Desktop from opening; this
 *   path must not add another way to do that.
 */
import path from "path"
import { existsSync } from "fs"

export type SyncOutcome =
  | { ran: false; reason: "disabled" | "no-cli" }
  | { ran: true; ok: boolean; reason?: "timeout" | "exit" | "spawn-error"; code?: number | null; ms: number; changed?: number }

export interface SyncDeps {
  home: string
  env: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  timeoutMs?: number
  /** Injected for tests. Defaults to Bun.spawn. */
  spawn?: (cmd: string[], env: NodeJS.ProcessEnv) => { exited: Promise<number | null>; kill(): void; stdout?: Promise<string> }
  exists?: (p: string) => boolean
}

/** The CLI the IRIS installer puts on every machine. Not the engine binary itself — that has no `agents` command. */
export function irisCliPath(home: string, platform: NodeJS.Platform = process.platform) {
  return path.join(home, ".iris", "bin", platform === "win32" ? "iris.exe" : "iris")
}

export async function syncDesktopAgents(deps: SyncDeps): Promise<SyncOutcome> {
  if (deps.env.IRIS_DESKTOP_AGENT_SYNC === "0") return { ran: false, reason: "disabled" }
  const exists = deps.exists ?? existsSync
  const bin = irisCliPath(deps.home, deps.platform)
  if (!exists(bin)) return { ran: false, reason: "no-cli" }

  const spawn =
    deps.spawn ??
    ((cmd: string[], env: NodeJS.ProcessEnv) => {
      const p = Bun.spawn(cmd, { env: env as Record<string, string>, stdout: "pipe", stderr: "ignore", stdin: "ignore" })
      return { exited: p.exited, kill: () => p.kill(), stdout: new Response(p.stdout).text() }
    })

  const started = Date.now()
  let child: ReturnType<NonNullable<SyncDeps["spawn"]>>
  try {
    child = spawn([bin, "agents", "desktop-sync", "--json"], deps.env)
  } catch {
    return { ran: true, ok: false, reason: "spawn-error", ms: Date.now() - started }
  }
  const timeout = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), deps.timeoutMs ?? 6000))
  const result = await Promise.race([child.exited, timeout])
  const ms = Date.now() - started
  if (result === "timeout") {
    try { child.kill() } catch {}
    return { ran: true, ok: false, reason: "timeout", ms }
  }
  if (result !== 0) return { ran: true, ok: false, reason: "exit", code: result, ms }
  return { ran: true, ok: true, code: 0, ms, changed: countChanges(await child.stdout?.catch(() => "")) }
}

/** Files written + removed, from the CLI's --json output. Unreadable output counts as no change. */
export function countChanges(stdout: string | undefined): number {
  const text = stdout ?? ""
  const start = text.indexOf("{")
  if (start < 0) return 0
  try {
    const d = JSON.parse(text.slice(start))
    return (Array.isArray(d.written) ? d.written.length : 0) + (Array.isArray(d.removed) ? d.removed.length : 0)
  } catch {
    return 0
  }
}
