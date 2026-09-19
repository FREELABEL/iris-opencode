import { execFile } from "child_process"
import { createHash } from "crypto"
import { existsSync, readFileSync } from "fs"
import { homedir } from "os"
import path from "path"

/**
 * Install / Update from the Marketplace card (#186274).
 *
 * The install itself is the real `iris playbook install` — never a second implementation. The
 * desktop app now keeps the platform CLI installed (cli.rs `sync_cli`), so the sidecar runs that
 * binary directly (execFile, no shell) and reads its `--json` result.
 *
 * "Update" needs evidence, not a guess: `iris playbook install` writes `.installed.json` next to
 * the PLAYBOOK.md ({name, version, sha256, installed_at}). The frontmatter `version:` is the
 * playbook FORMAT version (2), not the published one (18) — comparing that would offer an update
 * forever. A copy with no install record was written or synced locally: it is the user's source,
 * so it never gets an Update button.
 */

const SLUG = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/

export interface InstallState {
  /** The published version this copy was installed at, when it came from the Marketplace. */
  installedVersion: number | undefined
  /** The file no longer matches what was installed — an update would discard those edits. */
  edited: boolean
}

export function installState(playbookFile: string): InstallState {
  try {
    const rec = JSON.parse(readFileSync(path.join(path.dirname(playbookFile), ".installed.json"), "utf-8"))
    const v = Number(rec?.version)
    const installedVersion = Number.isFinite(v) ? v : undefined
    let edited = false
    if (typeof rec?.sha256 === "string" && existsSync(playbookFile)) {
      edited = createHash("sha256").update(readFileSync(playbookFile)).digest("hex") !== rec.sha256
    }
    return { installedVersion, edited }
  } catch {
    return { installedVersion: undefined, edited: false }
  }
}

export type PlaybookAction = "install" | "update" | "run"

export function playbookAction(r: { hasLocal: boolean; installedVersion?: number; version?: number }): PlaybookAction {
  if (!r.hasLocal) return "install"
  if (r.installedVersion !== undefined && r.version !== undefined && r.version > r.installedVersion) return "update"
  return "run"
}

export function installArgs(name: string, o: { project?: boolean; force?: boolean }): string[] {
  if (!SLUG.test(name) || name.includes("..")) throw new Error(`"${name}" is not a playbook name`)
  return ["playbook", "install", name, "--json", ...(o.project ? ["--project"] : []), ...(o.force ? ["--force"] : [])]
}

/** The platform CLI the desktop app installs, or null when this machine has none. */
export function irisCliPath(home = homedir()): string | null {
  const file = path.join(home, ".iris", "bin", process.platform === "win32" ? "iris.exe" : "iris")
  return existsSync(file) ? file : null
}

type Exec = (file: string, args: string[], opts: { cwd?: string; timeoutMs: number }) => Promise<{ code: number; stdout: string; stderr: string }>

const realExec: Exec = (file, args, opts) =>
  new Promise((resolve) => {
    execFile(file, args, { cwd: opts.cwd, timeout: opts.timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as any).code === "number" ? (err as any).code : 1) : 0
      resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") || (err ? String(err.message) : "") })
    })
  })

export interface InstallResult {
  ok: boolean
  message: string
  version?: number
  location?: string
  path?: string
}

/** Run `iris playbook install` for the card. `project` is the session's directory, when known. */
export async function runPlaybookInstall(
  o: { name: string; project?: string; force?: boolean },
  deps: { cli?: string | null; exec?: Exec } = {},
): Promise<InstallResult> {
  let args: string[]
  try {
    args = installArgs(o.name, { project: !!o.project, force: o.force })
  } catch (e: any) {
    return { ok: false, message: e.message }
  }
  const cli = deps.cli === undefined ? irisCliPath() : deps.cli
  if (!cli)
    return {
      ok: false,
      message: "The IRIS CLI is not installed on this machine, so nothing can be installed from here. Restart the app to install it, or run the command in a terminal.",
    }
  const r = await (deps.exec ?? realExec)(cli, args, { cwd: o.project, timeoutMs: 120_000 })
  // The CLI prints a banner around its JSON; take the JSON object it printed.
  const start = r.stdout.indexOf("{")
  let json: any = null
  try {
    json = start >= 0 ? JSON.parse(r.stdout.slice(start, r.stdout.lastIndexOf("}") + 1)) : null
  } catch {
    json = null
  }
  if (r.code !== 0 || !json?.installed) {
    const said = (r.stderr || r.stdout).replace(/\x1b\[[0-9;]*m/g, "").trim().split("\n").filter(Boolean).slice(-3).join(" ")
    return { ok: false, message: said || `iris playbook install exited ${r.code}` }
  }
  const v = Number(json.version)
  return {
    ok: true,
    message: `Installed ${json.installed}${json.location ? ` (${json.location})` : ""}`,
    version: Number.isFinite(v) ? v : undefined,
    location: json.location,
    path: json.path,
  }
}

/**
 * A small time-limited cache for the account's playbook list (#186279): the list changes rarely,
 * and re-fetching it for every search query cost ~3 s a keystroke-batch. A failed load is never
 * cached; an install invalidates it.
 */
export function ttlCache<K, V>(ttlMs: number, now: () => number = Date.now) {
  const entries = new Map<K, { at: number; value: V }>()
  return {
    async get(key: K, load: () => Promise<V>): Promise<V> {
      const hit = entries.get(key)
      if (hit && now() - hit.at < ttlMs) return hit.value
      const value = await load()
      entries.set(key, { at: now(), value })
      return value
    },
    invalidate() {
      entries.clear()
    },
  }
}
