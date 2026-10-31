/**
 * The app-neutral half of `iris app-config` (#191960): bundle format, integrity, refusals,
 * backup, atomic writes and read-back. Everything that knows what OBS is lives behind
 * AppConfigAdapter, so another app is one new adapter and no change here (#191869).
 *
 * A bundle is one JSON file, not a zip: every byte is text, so the secret scan and a person
 * with `less` see exactly what would leave the machine, and it fits `atlas files upload`.
 */

import { createHash, randomBytes } from "crypto"
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs"
import { dirname, join, relative, resolve } from "path"

/** Exit 5 is the house code for "refused, and not because it broke". */
export const EXIT_REFUSED = 5
/** The write happened, but the result does not fully work on this machine. */
export const EXIT_PROBLEMS = 3

export type DropReason = "secret" | "machine-bound" | "unmapped-path" | "not-portable"

/** Names only. A value must never reach this record: it is printed and stored in the bundle. */
export interface Dropped {
  file: string
  path: string
  reason: DropReason
}

export interface Manifest {
  schema: 1
  app: string
  createdAt: string
  host: { fingerprint: string; platform: string; arch: string }
  containsSecrets: boolean
  files: Record<string, { sha256: string; bytes: number }>
  dropped: Dropped[]
  info: Record<string, unknown>
}

export interface Bundle {
  manifest: Manifest
  files: Record<string, string>
}

/** Everything that reads the machine, injected so no test can reach a real setup. */
export interface Host {
  platform: string
  arch: string
  hostname: string
  home: string
  env: Record<string, string | undefined>
  /** Names of running processes, or null when they could not be listed. */
  processNames(): string[] | null
}

export interface Problem {
  kind: "missing-path" | "missing-plugin" | "read-back"
  message: string
}

export interface PathMap {
  from: string
  to: string
}

export interface PlanContext {
  configDir: string
  host: Host
  maps: PathMap[]
}

export interface AppConfigAdapter {
  id: string
  label: string
  defaultConfigDir(host: Host): string
  /** The name of the app's running process, if any is in `names`. */
  runningProcess(names: string[]): string | null
  /** Why a running app blocks a write, shown in the refusal. */
  runningReason: string
  collect(configDir: string, host: Host, opts: { includeSecrets: boolean }): {
    files: Record<string, string>
    dropped: Dropped[]
    info: Record<string, unknown>
  }
  /** Bundles can come from elsewhere: only paths this accepts are ever written. */
  isBundlePath(rel: string): boolean
  /** True when the target holds nothing a person made, so no --force is needed. */
  isPristine(configDir: string): boolean
  plan(bundle: Bundle, ctx: PlanContext): { files: Record<string, string>; dropped: Dropped[]; notes: string[] }
  /** Objective checks that do not need the app running. `read` sees the resulting bytes. */
  verify(read: (rel: string) => string | null, bundle: Bundle, ctx: PlanContext): Problem[]
}

export function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex")
}

export function exportBundle(
  adapter: AppConfigAdapter,
  opts: { configDir: string; host: Host; includeSecrets: boolean; now?: Date },
): Bundle {
  if (!existsSync(opts.configDir)) throw new Error(`no ${adapter.label} config at ${opts.configDir}`)
  const { files, dropped, info } = adapter.collect(opts.configDir, opts.host, { includeSecrets: opts.includeSecrets })
  const sums: Manifest["files"] = {}
  for (const [rel, text] of Object.entries(files)) {
    sums[rel] = { sha256: sha256(text), bytes: Buffer.byteLength(text) }
  }
  return {
    manifest: {
      schema: 1,
      app: adapter.id,
      createdAt: (opts.now ?? new Date()).toISOString(),
      host: { fingerprint: sha256(opts.host.hostname).slice(0, 12), platform: opts.host.platform, arch: opts.host.arch },
      containsSecrets: opts.includeSecrets,
      files: sums,
      dropped,
      info,
    },
    files,
  }
}

/** Writes owner-only, reads the bytes back, and never replaces an existing bundle. */
export function writeBundle(path: string, bundle: Bundle): { sha256: string; bytes: number } {
  if (existsSync(path)) throw new Error(`${path} already exists; choose another path`)
  const text = JSON.stringify(bundle, null, 2) + "\n"
  mkdirSync(dirname(resolve(path)), { recursive: true })
  writeFileSync(path, text, { mode: 0o600, flag: "wx" })
  const expected = sha256(text)
  if (sha256(readFileSync(path)) !== expected) throw new Error(`read-back of ${path} did not match what was written`)
  return { sha256: expected, bytes: Buffer.byteLength(text) }
}

/** A bundle is untrusted input: check shape, app, every path and every checksum before use. */
export function parseBundle(adapter: AppConfigAdapter, text: string): Bundle {
  let raw: any
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error("the bundle is not valid JSON")
  }
  const m = raw?.manifest
  if (!m || typeof raw.files !== "object" || raw.files === null) throw new Error("the bundle has no manifest or files")
  if (m.schema !== 1) throw new Error(`unsupported bundle schema ${m.schema}; update iris`)
  if (m.app !== adapter.id) throw new Error(`this bundle is for "${m.app}", not "${adapter.id}"`)
  const listed = Object.keys(m.files ?? {}).sort()
  const present = Object.keys(raw.files).sort()
  if (listed.join("\n") !== present.join("\n")) throw new Error("the bundle's files do not match its manifest")
  for (const rel of present) {
    if (!adapter.isBundlePath(rel)) throw new Error(`the bundle names a path it may not write: ${rel}`)
    if (typeof raw.files[rel] !== "string" || sha256(raw.files[rel]) !== m.files[rel].sha256) {
      throw new Error(`checksum mismatch in the bundle: ${rel}`)
    }
  }
  if (!Array.isArray(m.dropped)) throw new Error("the bundle manifest has no dropped list")
  return raw as Bundle
}

export type ApplyStatus = "applied" | "unchanged" | "dry-run" | "refused" | "failed"

export interface ApplyResult {
  status: ApplyStatus
  reason?: string
  exitCode: number
  written: string[]
  backup: string | null
  dropped: Dropped[]
  notes: string[]
  problems: Problem[]
}

function readIfExists(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null
}

function atomicWrite(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.iris-tmp-${randomBytes(4).toString("hex")}`
  writeFileSync(tmp, text, { flag: "wx" })
  renameSync(tmp, path)
}

/** Copies only what is about to be replaced, outside the config dir so the app never loads it. */
function backUp(configDir: string, rels: string[], now: Date): string | null {
  const replaced = rels.filter((rel) => existsSync(join(configDir, rel)))
  if (replaced.length === 0) return null
  const stamp = now.toISOString().replace(/[-:.]/g, "")
  const dir = `${resolve(configDir)}.iris-backup-${stamp}-${randomBytes(3).toString("hex")}`
  mkdirSync(dir, { mode: 0o700 })
  for (const rel of replaced) {
    const dest = join(dir, rel)
    mkdirSync(dirname(dest), { recursive: true })
    copyFileSync(join(configDir, rel), dest)
  }
  return dir
}

export function applyBundle(
  adapter: AppConfigAdapter,
  bundle: Bundle,
  opts: { configDir: string; host: Host; force: boolean; maps: PathMap[]; dryRun?: boolean; now?: Date },
): ApplyResult {
  const configDir = resolve(opts.configDir)
  const ctx: PlanContext = { configDir, host: opts.host, maps: opts.maps }
  const plan = adapter.plan(bundle, ctx)

  for (const rel of Object.keys(plan.files)) {
    const inside = relative(configDir, join(configDir, rel))
    if (inside.startsWith("..")) throw new Error(`refusing to write outside the config dir: ${rel}`)
  }

  const changed = Object.keys(plan.files).filter((rel) => readIfExists(join(configDir, rel)) !== plan.files[rel])
  const planned = (rel: string) => plan.files[rel] ?? readIfExists(join(configDir, rel))
  const base = { backup: null as string | null, dropped: plan.dropped, notes: plan.notes }
  const finish = (status: ApplyStatus, problems: Problem[], written: string[]): ApplyResult => ({
    ...base,
    status,
    written,
    problems,
    exitCode: problems.length ? EXIT_PROBLEMS : 0,
  })
  const refuse = (reason: string): ApplyResult => ({
    ...base,
    status: "refused",
    reason,
    written: [],
    problems: [],
    exitCode: EXIT_REFUSED,
  })

  if (opts.dryRun) return finish("dry-run", adapter.verify(planned, bundle, ctx), changed)
  if (changed.length === 0) return finish("unchanged", adapter.verify(planned, bundle, ctx), [])

  if (!opts.force && !adapter.isPristine(configDir)) {
    return refuse(`${configDir} already holds a ${adapter.label} setup; nothing was written. Pass --force to replace it (a backup is taken first).`)
  }
  // Checked last and never overridden by --force: an app that rewrites its config on exit
  // would silently undo this apply. If we cannot tell, we do not write.
  const names = opts.host.processNames()
  if (names === null) return refuse(`could not list running processes, so ${adapter.label} may be running; nothing was written.`)
  const running = adapter.runningProcess(names)
  if (running) return refuse(`${adapter.label} is running (${running}). ${adapter.runningReason} Quit it and run this again; nothing was written.`)

  base.backup = backUp(configDir, changed, opts.now ?? new Date())
  const written: string[] = []
  try {
    for (const rel of changed) {
      atomicWrite(join(configDir, rel), plan.files[rel])
      written.push(rel)
    }
  } catch (e: any) {
    return {
      ...base,
      status: "failed",
      reason: `write failed after ${written.length} of ${changed.length} file(s): ${e?.message ?? e}. Replaced files are in ${base.backup ?? "(nothing had been replaced)"}.`,
      written,
      problems: [],
      exitCode: 1,
    }
  }

  const fromDisk = (rel: string) => readIfExists(join(configDir, rel))
  const problems = adapter.verify(fromDisk, bundle, ctx)
  for (const rel of written) {
    if (fromDisk(rel) !== plan.files[rel]) problems.push({ kind: "read-back", message: `${rel} does not match what was written` })
  }
  return finish("applied", problems, written)
}

/** `--map-media <old>=<new>`. The first `=` splits, so a new path may itself contain one. */
export function parseMapMedia(values: string[]): PathMap[] {
  return values.map((v) => {
    const i = v.indexOf("=")
    if (i <= 0 || i === v.length - 1) throw new Error(`--map-media needs <old>=<new>, got: ${v}`)
    return { from: v.slice(0, i), to: v.slice(i + 1) }
  })
}

/** Rewrites a path prefix, on whole segments only: `/Users/a` never matches `/Users/alex`. */
export function mapPath(value: string, maps: PathMap[]): string | null {
  const url = value.match(/^file:\/\/\/?/i)?.[0]
  let path = url ? value.slice(url.length) : value
  if (url) {
    try {
      path = decodeURI(path)
    } catch {
      /* keep it as written */
    }
    if (!/^[A-Za-z]:/.test(path)) path = "/" + path
  }
  const norm = path.replace(/\\/g, "/")
  const ordered = [...maps].sort((a, b) => b.from.length - a.from.length)
  for (const m of ordered) {
    const from = m.from.replace(/\\/g, "/").replace(/\/+$/, "")
    if (!from) continue
    const windows = /^[A-Za-z]:/.test(from)
    const head = norm.slice(0, from.length)
    const same = windows ? head.toLowerCase() === from.toLowerCase() : head === from
    const next = norm[from.length]
    if (!same || (next !== undefined && next !== "/")) continue
    const out = m.to.replace(/\\/g, "/").replace(/\/+$/, "") + norm.slice(from.length)
    return url ? "file://" + encodeURI(out.startsWith("/") ? out : "/" + out) : out
  }
  return null
}
