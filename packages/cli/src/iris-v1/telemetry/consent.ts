import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { homedir } from "os"
import { join } from "path"

/**
 * Whether this machine sends telemetry, and why (#186171).
 *
 * Three ways to say no, any one of which wins:
 *   - IRIS_TELEMETRY=0 | off | false   (per process)
 *   - DO_NOT_TRACK=1 | true            (the cross-tool convention, consoledonottrack.com)
 *   - `iris telemetry off`             (persisted in ~/.iris/telemetry.json)
 *
 * What is sent when it is on: event names and counts — the command WORD (`leads`, never its
 * arguments), whether it finished, how long it took, the app version and OS. Never prompts,
 * file paths, message or document content. The server forwards a subset of that to product
 * analytics; no analytics token ships in the app.
 */
export namespace Consent {
  export type Reason = "env:IRIS_TELEMETRY" | "env:DO_NOT_TRACK" | "iris telemetry off" | "default"

  const irisDir = (home = homedir()) => join(home, ".iris")
  const settingsPath = (home?: string) => join(irisDir(home), "telemetry.json")
  const noticePath = (home?: string) => join(irisDir(home), "telemetry-notice")

  const falsy = (v: string | undefined) => v !== undefined && ["0", "off", "false", "no"].includes(v.trim().toLowerCase())
  const truthy = (v: string | undefined) => v !== undefined && ["1", "true", "yes", "on"].includes(v.trim().toLowerCase())

  export function status(env: NodeJS.ProcessEnv = process.env, home?: string): { enabled: boolean; reason: Reason } {
    if (falsy(env.IRIS_TELEMETRY)) return { enabled: false, reason: "env:IRIS_TELEMETRY" }
    if (truthy(env.DO_NOT_TRACK)) return { enabled: false, reason: "env:DO_NOT_TRACK" }
    try {
      const p = settingsPath(home)
      if (existsSync(p) && JSON.parse(readFileSync(p, "utf8"))?.enabled === false) {
        return { enabled: false, reason: "iris telemetry off" }
      }
    } catch {
      // An unreadable settings file is not consent to turn telemetry back on silently — but it is
      // also not a reason to break the CLI. It reads as the default; `iris telemetry status` shows it.
    }
    return { enabled: true, reason: "default" }
  }

  export function setEnabled(enabled: boolean, home?: string): void {
    mkdirSync(irisDir(home), { recursive: true })
    writeFileSync(settingsPath(home), JSON.stringify({ enabled, updated_at: new Date().toISOString() }, null, 2) + "\n", { mode: 0o600 })
  }

  export const NOTICE =
    "IRIS records which commands you run and whether they worked — never arguments, files or content —\n" +
    "to help us fix what breaks. Turn it off: iris telemetry off  ·  or IRIS_TELEMETRY=0 / DO_NOT_TRACK=1"

  /**
   * The first-run notice: once per machine, on stderr, only to a person at a terminal and only
   * when telemetry is on. Returns the text it printed (for tests), or null.
   */
  export function noticeOnce(opts: { isTTY?: boolean; env?: NodeJS.ProcessEnv; home?: string; write?: (s: string) => void } = {}): string | null {
    try {
      const env = opts.env ?? process.env
      if (!(opts.isTTY ?? process.stderr.isTTY)) return null
      if (!status(env, opts.home).enabled) return null
      const marker = noticePath(opts.home)
      if (existsSync(marker)) return null
      mkdirSync(irisDir(opts.home), { recursive: true })
      writeFileSync(marker, new Date().toISOString() + "\n", { mode: 0o600 })
      ;(opts.write ?? ((s) => process.stderr.write(s)))("\x1b[2m" + NOTICE + "\x1b[0m\n")
      return NOTICE
    } catch {
      return null
    }
  }
}
