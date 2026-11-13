/**
 * `iris drives` usage events (#193356, epic #192914).
 *
 * Two different things are measured, on purpose in two different places:
 *
 *   1. ANALYTICS (this file): one usage event per drives command — drives_scan, drives_find,
 *      drives_path, drives_list, drives_copies, drives_get, drives_keep, drives_usage. It goes through the
 *      Beacon, so it obeys every opt-out (IRIS_TELEMETRY=0, DO_NOT_TRACK, `iris telemetry off`)
 *      and is fire-and-forget: it never blocks, never throws.
 *
 *   2. THE METER (drives-core.ts meterFields): what a client could be billed on is written onto
 *      the drive's own record in Atlas on every scan, and every `get` is already one row in
 *      drive-reads. That is the client's data and does not depend on analytics consent — an
 *      opt-out can switch analytics off, so analytics can never be what we bill from.
 *
 * WHAT AN EVENT MAY CARRY: numbers, booleans and words from a fixed list. Never a path, a drive
 * label, a file or folder name, a search word, or the reason given to `get`. drivesUsageContext
 * enforces that by allowlist — an unknown key, a non-finite number or a free-text string is dropped,
 * whatever the caller passed.
 */

import { Beacon } from "../../telemetry/beacon"

export type DrivesOp = "scan" | "find" | "path" | "list" | "copies" | "get" | "keep" | "usage"

/** Counts and sizes. Non-negative integers only. */
export const DRIVES_NUMBER_KEYS = [
  "files_count",
  "bytes_cataloged",
  "manifest_bytes",
  "folders_rows",
  "findings_count",
  "sensitive_count",
  "unreadable_folders_count",
  "results_count",
  "bytes_copied",
  "drives_count",
  "connected_count",
  "words_count",
  "exit_code",
] as const

export const DRIVES_BOOLEAN_KEYS = ["encrypted", "dry_run", "sensitive", "bundle", "manifest_saved"] as const

/** Words from a closed list. Anything else is dropped, so a free-text value cannot get through. */
export const DRIVES_ENUM_KEYS = {
  platform: ["darwin", "linux", "win32", "other"],
  checksums: ["default", "all", "none"],
  kind: ["backup-drive", "media-drive", "archive-folder", "other"],
} as const satisfies Record<string, readonly string[]>

type NumberKey = (typeof DRIVES_NUMBER_KEYS)[number]
type BooleanKey = (typeof DRIVES_BOOLEAN_KEYS)[number]
type EnumKey = keyof typeof DRIVES_ENUM_KEYS

export type DrivesFacts = Partial<Record<NumberKey, number>> &
  Partial<Record<BooleanKey, boolean>> &
  Partial<Record<EnumKey, string>>

export function platformWord(p: string = process.platform): string {
  return (DRIVES_ENUM_KEYS.platform as readonly string[]).includes(p) ? p : "other"
}

/** The only shape a drives event's context can take. Allowlist, not blocklist. */
export function drivesUsageContext(facts: Record<string, unknown>): Record<string, number | boolean | string> {
  const out: Record<string, number | boolean | string> = {}
  for (const k of DRIVES_NUMBER_KEYS) {
    const v = facts[k]
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) out[k] = Math.round(v)
  }
  for (const k of DRIVES_BOOLEAN_KEYS) {
    const v = facts[k]
    if (typeof v === "boolean") out[k] = v
  }
  for (const [k, allowed] of Object.entries(DRIVES_ENUM_KEYS)) {
    const v = facts[k]
    if (typeof v === "string" && (allowed as readonly string[]).includes(v)) out[k] = v
  }
  return out
}

export type UsageEmitter = (type: Beacon.UsageType, event: Beacon.Usage) => void

/** One drives command, from start to its one event. finish() is idempotent. */
export class DrivesRun {
  readonly facts: DrivesFacts = {}
  private done = false
  constructor(
    readonly op: DrivesOp,
    private readonly emit: UsageEmitter = Beacon.usage,
    private readonly now: () => number = Date.now,
    private readonly started: number = now(),
  ) {}

  set(f: DrivesFacts): void {
    Object.assign(this.facts, f)
  }

  finish(outcome: Beacon.Outcome, exitCode?: number): void {
    if (this.done) return
    this.done = true
    try {
      this.emit(`drives_${this.op}` as Beacon.UsageType, {
        command: "drives",
        outcome,
        duration_ms: Math.max(0, Math.round(this.now() - this.started)),
        context: drivesUsageContext({
          ...this.facts,
          platform: platformWord(),
          ...(exitCode != null ? { exit_code: exitCode } : {}),
        }),
      })
    } catch {
      // telemetry never breaks the command
    }
  }
}

let current: DrivesRun | null = null

/** The run in progress, if any — for code paths that exit from inside a helper. */
export function currentRun(): DrivesRun | null {
  return current
}

/**
 * Wrap a drives handler so it emits exactly one event: on return (ok, or error when it set
 * process.exitCode), on a throw (error), or on exitDrives().
 */
export function metered<A>(op: DrivesOp, handler: (args: A, run: DrivesRun) => Promise<void>, emit?: UsageEmitter) {
  return async (args: A) => {
    const run = new DrivesRun(op, emit)
    current = run
    try {
      await handler(args, run)
      run.finish(process.exitCode ? "error" : "ok", process.exitCode ? Number(process.exitCode) : undefined)
    } catch (e) {
      run.finish("error")
      throw e
    } finally {
      if (current === run) current = null
    }
  }
}

/**
 * process.exit() for drives commands. process.exit skips the CLI's own exit flush, so the event
 * is recorded and flushed first (capped at 800 ms, the same budget index.ts gives every command).
 */
export async function exitDrives(code: number): Promise<never> {
  current?.finish(code === 0 ? "ok" : "error", code)
  await Beacon.flush(800).catch(() => false)
  return process.exit(code)
}
