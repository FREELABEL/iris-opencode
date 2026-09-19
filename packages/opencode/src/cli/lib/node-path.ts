import { existsSync, readdirSync } from "fs"
import { homedir, platform } from "os"
import { delimiter, join } from "path"

// The IRIS desktop app runs the CLI with the PATH a GUI process gets (/usr/bin:/bin:/usr/sbin:/sbin
// on macOS) — no node, no npm. Hive setup shelled out to bare `node`/`npm`, so from the app it
// reported "Node.js is not installed" on a machine that had it (2026-09-18). Mirror of the resolver
// in iris-daemon's daemonctl: prefer the runtime the installer ships, then the package managers.

/** Directories that may hold a usable `node`, most preferred first. Pure, for tests. */
export function nodeDirCandidates(home: string, os: string, list: (dir: string) => string[]): string[] {
  const runtime = join(home, ".iris", "runtime")
  const shipped = list(runtime)
    .filter((n) => n.startsWith("node-"))
    .sort()
    .reverse()
    .map((n) => (os === "win32" ? join(runtime, n) : join(runtime, n, "bin")))
  const system = os === "win32" ? [join(process.env.ProgramFiles ?? "C:\\Program Files", "nodejs")] : ["/opt/homebrew/bin", "/usr/local/bin"]
  return [...shipped, ...system]
}

/**
 * Put the first directory that has a `node` at the front of PATH. Idempotent; returns it.
 *
 * BUN TRAP: under Bun, changing process.env.PATH does NOT change how a child is looked up unless
 * the spawn is given `env: process.env` explicitly — default spawns keep the startup PATH
 * (measured: ENOENT without it, v22 with it). Every caller must pass `env: process.env`.
 */
export function ensureNodeOnPath(): string | undefined {
  const os = platform()
  const exe = os === "win32" ? "node.exe" : "node"
  const list = (d: string) => {
    try {
      return readdirSync(d)
    } catch {
      return []
    }
  }
  const dir = nodeDirCandidates(homedir(), os, list).find((d) => existsSync(join(d, exe)))
  if (!dir) return undefined
  const parts = (process.env.PATH ?? "").split(delimiter)
  if (parts[0] !== dir) process.env.PATH = [dir, ...parts.filter((p) => p !== dir)].join(delimiter)
  return dir
}
