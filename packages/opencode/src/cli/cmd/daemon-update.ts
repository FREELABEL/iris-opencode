// ============================================================================
// `iris daemon update` — install an exact iris-daemon commit, safely (#191614).
//
// WHY. Merging an iris-daemon fix reached no machine. Every node runs its own ~/.iris/bridge and
// on 2026-10-28 each had drifted differently: iris-hive-001/-002 were plain copies older than
// main; the MacBook was a git checkout 47 commits behind with 15 modified and 24 untracked files,
// and its daemon/index.js already required a lib/mail-compose.js that was MISSING — a plain
// restart would have crashed it. The rollout took per-machine forensics. This is that forensics,
// as one command:
//
//   resolve the commit → download that exact tarball → verify it IS that commit → refuse if the
//   current install has local changes → install deps only if the lockfile changed → pre-flight
//   (node --check, every relative require resolves) → carry over this machine's runtime files →
//   swap bridge→bridge.prev, bridge.next→bridge → restart → the RUNNING daemon must report the NEW
//   commit on /health → otherwise swap back, restart, verify the old one runs, report failure.
//
// THE VERSION IS THE COMMIT. package.json says 2.0.0 and is never bumped. The install writes
// .iris-daemon-version.json ({commit, installed_at, files: {path: sha256}}); the daemon reads it
// once at startup and reports daemon_commit / daemon_drift on /health and the heartbeat
// (iris-daemon lib/version-manifest.js — the two sides share the format, not code).
//
// Restarting is daemonctl's job (launchd on macOS, nohup / systemd on Linux — #191615 is changing
// that inside daemonctl). This calls `<bridge>/daemonctl restart` and treats its exit code as a
// hint only: the truth is what /health reports afterwards.
// ============================================================================

import {
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs"
import { createHash } from "crypto"
import { homedir, tmpdir } from "os"
import { dirname, join, resolve as resolvePath } from "path"
import { spawn, spawnSync } from "child_process"
import { archiveCommit, gitignoreMatcher } from "./platform-node"

export const MANIFEST_NAME = ".iris-daemon-version.json"
/** platform-node's archive install writes this; `iris hive doctor` reads it. Regenerated, never carried. */
export const COMMIT_FILE = ".iris-commit"
export const REPO = "FREELABEL/iris-daemon"

// ─── Paths and endpoints (every one overridable, so tests never touch the real install) ──────

export type UpdatePaths = { iris: string; bridge: string; next: string; prev: string; failed: string; stage: string; stateDir: string }

export function updatePaths(irisDir = process.env.IRIS_HOME || join(homedir(), ".iris")): UpdatePaths {
  return {
    iris: irisDir,
    bridge: join(irisDir, "bridge"),
    next: join(irisDir, "bridge.next"),
    prev: join(irisDir, "bridge.prev"),
    failed: join(irisDir, "bridge.failed"),
    stage: join(irisDir, "bridge.next.stage"),
    stateDir: join(irisDir, "daemon-update"),
  }
}

export function apiBase(): string {
  return process.env.IRIS_DAEMON_API_BASE || `https://api.github.com/repos/${REPO}`
}
export function tarballUrl(sha: string): string {
  return `${process.env.IRIS_DAEMON_CODELOAD_BASE || `https://codeload.github.com/${REPO}/tar.gz`}/${sha}`
}
export function healthUrl(): string {
  return process.env.IRIS_DAEMON_HEALTH_URL || `http://127.0.0.1:${process.env.BRIDGE_PORT || 3200}/health`
}
export function daemonCtlFor(bridge: string): string {
  return process.env.IRIS_DAEMONCTL || join(bridge, "daemonctl")
}

// ─── Pure helpers ───────────────────────────────────────────────────────────────────────────

export function isSha(s: unknown): s is string {
  return typeof s === "string" && /^[0-9a-f]{40}$/.test(s)
}
export const short = (s: string | null | undefined) => (isSha(s) ? s.slice(0, 7) : (s ?? "unknown"))

/**
 * The commit a node reports through the hub. The hub stores only whitelisted heartbeat keys and
 * `daemon_version` is one, so the daemon folds the commit in as semver build metadata:
 * "2.0.0+<sha>" or "2.0.0+<sha>.drift". Anything else (plain "2.0.0", null) is an old daemon.
 */
export function parseDaemonVersion(v: unknown): { commit: string; drift: boolean } | null {
  if (typeof v !== "string") return null
  const m = /\+([0-9a-f]{40})(\.drift)?$/.exec(v)
  return m ? { commit: m[1], drift: Boolean(m[2]) } : null
}

export function sha256(buf: Buffer | string): string {
  return createHash("sha256").update(buf).digest("hex")
}

/** Never part of a tree's identity: deps, VCS, and the two files the install writes itself. */
const NEVER_TRACKED = new Set(["node_modules", ".git", MANIFEST_NAME, COMMIT_FILE])

/** Every file under `dir` as a relative path → sha256, the same rules as the daemon's hashTree. */
export function hashTree(dir: string, skip: (rel: string) => boolean = () => false): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (abs: string, rel: string) => {
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (!rel && NEVER_TRACKED.has(e.name)) continue
      if (e.name === "node_modules" || e.name === ".git") continue
      if (skip(r)) continue
      const a = join(abs, e.name)
      if (e.isDirectory()) walk(a, r)
      else if (e.isFile()) out[r] = sha256(readFileSync(a))
    }
  }
  walk(dir, "")
  return out
}

/**
 * Runtime files the daemon writes INSIDE the bridge directory that its .gitignore does not (or,
 * in older installs, did not) name. Found by reading the code, not guessed — each entry says who
 * writes it. The union with both versions' .gitignore is what an update carries over.
 */
export const RUNTIME_ALWAYS = [
  ".env", //                         daemon.js:83, production.js:18, index.js BRIDGE_ENV_FILE — node secrets
  "*.log", //                        daemonctl LEGACY_DAEMON_LOG (daemon.log), bridgectl (bridge.log)
  "test-results/", //                Playwright runs with cwd = bridge (som specs, hive tasks)
  "som/test-results/",
  "som/instagram-auth-*.json", //    som/ig-fetch-post.js, save-session — Instagram logins
  "som/youtube-auth.json", //        som/youtube-feed-scraper.spec.ts
  "youtube-auth.json",
  "instagram-auth-*.json",
  "som/.som-campaigns-cache.json", // som/som-config.js cacheFile
  "native-imessage-state.json", //   drivers/native-imessage.js _statePath
  ".uptime-monitor-state.json", //   uptime-monitor.js STATE_FILE
  "r1-devices.json", //              lib/r1-devices.js REGISTRY_PATH — paired devices + token hashes
  "r1-frames.jsonl", //              drivers/r1-dialects.js CAPTURE_PATH (undecodable frames even with capture off)
  "ollama-sessions/", //             index.js OLLAMA_SESSIONS_DIR — local chat history
  "*-auth-backup.json", //           installers/connect-session.js fallback (cwd-relative)
  ".output/", //                     browser-agent/index.js fallback outputDir on manual runs
  "daemon-data/",
  "__pycache__/",
  "*.pyc",
]

/** A predicate over bridge-relative paths: is this a node-local runtime file (never code)? */
export function runtimeMatcher(...gitignores: string[]): (rel: string) => boolean {
  const m = gitignoreMatcher([...gitignores, RUNTIME_ALWAYS.join("\n")].join("\n"))
  return (rel) => {
    const top = rel.split("/")[0]
    if (top === "node_modules" || top === ".git" || rel === MANIFEST_NAME || rel === COMMIT_FILE) return false
    return m(rel)
  }
}

/** Every file under `dir`, relative, without descending into node_modules/.git. */
export function listFiles(dir: string): string[] {
  const out: string[] = []
  const walk = (abs: string, rel: string) => {
    let entries
    try {
      entries = readdirSync(abs, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === ".git") continue
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) walk(join(abs, e.name), r)
      else if (e.isFile() || e.isSymbolicLink()) out.push(r)
    }
  }
  walk(dir, "")
  return out.sort()
}

/**
 * What to copy from the live install into the new tree: this machine's runtime files. Never a
 * path the target commit ships (the commit wins — a file that became code is not "state").
 */
export function carryOverList(currentFiles: string[], targetFiles: Set<string>, isRuntime: (rel: string) => boolean): string[] {
  return currentFiles.filter((f) => isRuntime(f) && !targetFiles.has(f))
}

// ─── Local-change detection ─────────────────────────────────────────────────────────────────

export type LocalState = {
  /** git = a checkout; manifest = installed by this command; unknown = a plain copy we cannot audit */
  kind: "git" | "manifest" | "unknown" | "absent"
  commit: string | null
  modified: string[]
  untracked: string[]
  missing: string[]
  note?: string
}

export const hasLocalChanges = (s: LocalState) => s.modified.length + s.untracked.length + s.missing.length > 0

/** `git status --porcelain=v1 -z --untracked-files=all` → modified / untracked. Ignored files never appear. */
export function parseGitStatus(porcelainZ: string): { modified: string[]; untracked: string[]; missing: string[] } {
  const modified: string[] = []
  const untracked: string[] = []
  const missing: string[] = []
  const parts = porcelainZ.split("\0").filter(Boolean)
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]
    const xy = p.slice(0, 2)
    const file = p.slice(3)
    if (xy === "??") untracked.push(file)
    else if (xy.includes("D")) missing.push(file)
    else modified.push(file)
    if (xy[0] === "R" || xy[0] === "C") i++ // rename/copy: the next entry is the source path
  }
  return { modified, untracked, missing }
}

/** A manifest install: shipped files that changed or vanished, and non-runtime files it never shipped. */
export function manifestChanges(
  manifestFiles: Record<string, string>,
  onDisk: Record<string, string>,
  isRuntime: (rel: string) => boolean,
): { modified: string[]; untracked: string[]; missing: string[] } {
  const modified: string[] = []
  const missing: string[] = []
  for (const [f, want] of Object.entries(manifestFiles)) {
    if (!(f in onDisk)) missing.push(f)
    else if (onDisk[f] !== want) modified.push(f)
  }
  const untracked = Object.keys(onDisk).filter((f) => !(f in manifestFiles) && !isRuntime(f))
  return { modified: modified.sort(), untracked: untracked.sort(), missing: missing.sort() }
}

export function readManifest(dir: string): { commit: string; files: Record<string, string>; installed_at?: string } | null {
  try {
    const m = JSON.parse(readFileSync(join(dir, MANIFEST_NAME), "utf8"))
    if (!isSha(m?.commit) || !m.files || typeof m.files !== "object") return null
    return m
  } catch {
    return null
  }
}

export type GitRunner = (cwd: string, args: string[]) => { ok: boolean; out: string }
export const runGit: GitRunner = (cwd, args) => {
  const r = spawnSync("git", args, { cwd, env: process.env, stdio: "pipe", maxBuffer: 64 * 1024 * 1024 })
  return { ok: r.status === 0, out: r.stdout?.toString() ?? "" }
}

export function detectLocalState(bridge: string, git: GitRunner = runGit): LocalState {
  if (!existsSync(join(bridge, "daemon.js"))) return { kind: "absent", commit: null, modified: [], untracked: [], missing: [] }
  if (existsSync(join(bridge, ".git"))) {
    const head = git(bridge, ["rev-parse", "HEAD"])
    const st = git(bridge, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])
    if (!head.ok || !st.ok)
      return { kind: "git", commit: null, modified: [], untracked: [], missing: [], note: "git could not read this checkout — cannot tell what is local" }
    return { kind: "git", commit: head.out.trim(), ...parseGitStatus(st.out) }
  }
  const manifest = readManifest(bridge)
  if (manifest) {
    const isRuntime = runtimeMatcher(readText(join(bridge, ".gitignore")))
    return { kind: "manifest", commit: manifest.commit, ...manifestChanges(manifest.files, hashTree(bridge), isRuntime) }
  }
  return {
    kind: "unknown",
    commit: null,
    modified: [],
    untracked: [],
    missing: [],
    note: "a plain copy with no install manifest and no git — nothing records which commit it is, so local edits cannot be told apart from the version itself",
  }
}

/**
 * Files a PERSON added (untracked, not runtime) — which of them the update can simply keep.
 *
 * WHY (2026-10-28): rolling the daemon out by hand to three machines dropped a person's own
 * files every time — som/save-instagram-session.spec.ts on the MacBook, a send-approved-replies
 * spec and an Atlas note on iris-hive-001 — and each had to be restored from bridge.prev by hand.
 * A file the target commit does not ship cannot conflict with anything: it is carried into the
 * new tree and reported as "kept (yours)". Only an untracked file at a path the target DOES ship,
 * with different content, is a real conflict (the commit's version would replace it); that still
 * needs --force, and the person's copy stays in bridge.prev.
 */
export function classifyUntracked(
  untracked: string[],
  targetFiles: Record<string, string>,
  hashOf: (rel: string) => string | null,
): { kept: string[]; conflicts: string[] } {
  const kept: string[] = []
  const conflicts: string[] = []
  for (const f of untracked) {
    if (!(f in targetFiles)) kept.push(f)
    else if (hashOf(f) !== targetFiles[f]) conflicts.push(f)
    // same path, same bytes: the commit ships exactly this file — nothing to keep, nothing lost
  }
  return { kept: kept.sort(), conflicts: conflicts.sort() }
}

/**
 * Does this state stop an update? --force overrides every reason (the old tree is kept as
 * bridge.prev). `untrackedConflicts` is the subset of untracked files the target would replace
 * (classifyUntracked); untracked files it does not ship are kept, so they never block. Without it
 * every untracked file counts — the conservative answer when the target is not known.
 */
export function blockReason(s: LocalState, force: boolean, untrackedConflicts: string[] = s.untracked): string | null {
  if (force) return null
  if (s.kind === "unknown") return `${s.note}. Re-run with --force to replace it (the current copy is kept in bridge.prev).`
  if (s.kind === "git" && !s.commit) return `${s.note}. Re-run with --force to replace it.`
  if (s.modified.length + s.missing.length + untrackedConflicts.length > 0)
    return "the current install has local changes to files the update ships (listed above). Re-run with --force to replace them — your versions are kept in bridge.prev."
  return null
}

// ─── Pre-flight: does the new tree even load? ───────────────────────────────────────────────

const RESOLVE_EXTS = ["", ".js", ".cjs", ".mjs", ".json", ".node"]
const INDEX_FILES = ["index.js", "index.cjs", "index.json"]

/** Relative require() specifiers in one source file. Comments are stripped first. */
export function relativeRequires(src: string): string[] {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[\s;{}(),])\/\/[^\n]*/g, "$1")
  const out: string[] = []
  const re = /require\(\s*(['"])(\.\.?\/[^'"]+)\1\s*\)/g
  let m
  while ((m = re.exec(code))) out.push(m[2])
  return out
}

/**
 * `fs.existsSync(path.join(__dirname, 'x-core.js')) ? require('./x-core.js') : require('../daemon/x')`
 * — scripts that run from a copied location load an optional sibling only when it exists. A
 * require whose file the same source checks for with existsSync is optional, not broken.
 */
export function guardedRequire(src: string, spec: string): boolean {
  const name = spec.split("/").pop()!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`existsSync\\([^)]*['"]${name}['"]`).test(src)
}

/** Directories whose files read other files' SOURCE as text (tests) — a require in a string there is data. */
const PREFLIGHT_SKIP_TOP = new Set(["node_modules", ".git", "tests", "test"])

/** Every relative require in the tree that does not resolve to a file — the MacBook crash, caught before restart. */
export function unresolvedRequires(root: string, exists: (p: string) => boolean = (p) => existsSync(p) && lstatSync(p).isFile()): string[] {
  const failures: string[] = []
  for (const rel of listFiles(root)) {
    if (!/\.(c?js|mjs)$/.test(rel)) continue
    if (PREFLIGHT_SKIP_TOP.has(rel.split("/")[0])) continue
    let src: string
    try {
      src = readFileSync(join(root, rel), "utf8")
    } catch {
      continue
    }
    for (const spec of relativeRequires(src)) {
      if (guardedRequire(src, spec)) continue
      const base = resolvePath(join(root, dirname(rel)), spec)
      const ok = RESOLVE_EXTS.some((e) => exists(base + e)) || INDEX_FILES.some((i) => exists(join(base, i)))
      if (!ok) failures.push(`${rel} → require('${spec}')`)
    }
  }
  return failures
}

/** The node the daemon will run with: the pinned ~/.iris/daemon-node, the shipped runtime, then PATH. */
export function daemonNode(irisDir: string): string {
  try {
    const pinned = readFileSync(join(irisDir, "daemon-node"), "utf8").split("\n")[0].trim()
    if (pinned && existsSync(pinned)) return pinned
  } catch {}
  try {
    const rt = join(irisDir, "runtime")
    const v = readdirSync(rt).filter((n) => n.startsWith("node-")).sort().reverse()
    for (const n of v) if (existsSync(join(rt, n, "bin", "node"))) return join(rt, n, "bin", "node")
  } catch {}
  return "node"
}

export const ENTRY_FILES = ["daemon.js", "index.js", "daemon/index.js"]

export function preflight(dir: string, node: string): string[] {
  const errors: string[] = []
  if (!existsSync(join(dir, "daemon.js"))) errors.push("no daemon.js in the new tree")
  // A commit from before #191614 cannot report its commit on /health, so the post-restart check
  // could never pass and every update to it would roll back. Refuse it up front instead.
  if (!existsSync(join(dir, "lib", "version-manifest.js")))
    errors.push("this commit predates lib/version-manifest.js (#191614): its daemon cannot report which commit it runs, so the update could not be verified")
  for (const f of ENTRY_FILES) {
    if (!existsSync(join(dir, f))) continue
    const r = spawnSync(node, ["--check", join(dir, f)], { env: process.env, stdio: "pipe" })
    if (r.status !== 0) errors.push(`node --check ${f} failed: ${(r.stderr?.toString() || r.error?.message || "").trim().split("\n").slice(0, 4).join(" ")}`)
  }
  if (existsSync(join(dir, "daemonctl"))) {
    const r = spawnSync("bash", ["-n", join(dir, "daemonctl")], { env: process.env, stdio: "pipe" })
    if (r.status !== 0) errors.push(`bash -n daemonctl failed: ${r.stderr?.toString().trim()}`)
  }
  for (const u of unresolvedRequires(dir)) errors.push(`unresolved require: ${u}`)
  return errors
}

// ─── The plan ───────────────────────────────────────────────────────────────────────────────

export type Plan = {
  current: LocalState
  target: string
  upToDate: boolean
  filesChanged: { added: string[]; removed: string[]; modified: string[] }
  depsChanged: boolean
  depsReason: string
  carryOver: string[]
  /** Untracked files a person added that the target does not ship — carried into the new tree. */
  keptYours: string[]
  /** Untracked files at a path the target ships, with different content — these need --force. */
  untrackedConflicts: string[]
  blocked: string | null
}

export function computePlan(input: {
  current: LocalState
  target: string
  currentFiles: Record<string, string> // non-runtime files on disk now → sha256
  targetFiles: Record<string, string> // the commit's tree → sha256
  currentAll: string[] // every file on disk now (for carry-over)
  isRuntime: (rel: string) => boolean
  hasNodeModules: boolean
  force: boolean
}): Plan {
  const { current, target, currentFiles, targetFiles } = input
  const untracked = classifyUntracked(
    current.untracked.filter((f) => !input.isRuntime(f)),
    targetFiles,
    (f) => currentFiles[f] ?? null,
  )
  const kept = new Set(untracked.kept)
  const added = Object.keys(targetFiles).filter((f) => !(f in currentFiles)).sort()
  // A kept file is not "removed": it comes along into the new tree.
  const removed = Object.keys(currentFiles).filter((f) => !(f in targetFiles) && !kept.has(f)).sort()
  const modified = Object.keys(targetFiles).filter((f) => f in currentFiles && currentFiles[f] !== targetFiles[f]).sort()
  const lockNow = currentFiles["package-lock.json"]
  const lockNext = targetFiles["package-lock.json"]
  let depsChanged = false
  let depsReason = "package-lock.json unchanged — reusing node_modules"
  if (!input.hasNodeModules) {
    depsChanged = true
    depsReason = "no node_modules in the current install"
  } else if (lockNow !== lockNext) {
    depsChanged = true
    depsReason = "package-lock.json changed"
  }
  const upToDate =
    current.commit === target &&
    current.modified.length + current.missing.length + untracked.conflicts.length === 0 &&
    added.length + removed.length + modified.length === 0
  return {
    current,
    target,
    upToDate,
    filesChanged: { added, removed, modified },
    depsChanged,
    depsReason,
    carryOver: carryOverList(input.currentAll, new Set(Object.keys(targetFiles)), input.isRuntime),
    keptYours: untracked.kept,
    untrackedConflicts: untracked.conflicts,
    blocked: blockReason(current, input.force, untracked.conflicts),
  }
}

export function formatPlan(p: Plan): string[] {
  const L: string[] = []
  const cur = p.current
  L.push(`  current:  ${short(cur.commit)}  (${cur.kind === "unknown" ? "plain copy, no manifest" : cur.kind})`)
  L.push(`  target:   ${short(p.target)}  (${p.target})`)
  const fc = p.filesChanged
  L.push(`  files:    ${fc.modified.length} modified, ${fc.added.length} added, ${fc.removed.length} removed`)
  const show = (tag: string, xs: string[]) => xs.slice(0, 40).forEach((f) => L.push(`              ${tag} ${f}`))
  show("M", fc.modified)
  show("A", fc.added)
  show("D", fc.removed)
  const more = fc.modified.length + fc.added.length + fc.removed.length - Math.min(40, fc.modified.length) - Math.min(40, fc.added.length) - Math.min(40, fc.removed.length)
  if (more > 0) L.push(`              … and ${more} more`)
  L.push(`  deps:     ${p.depsChanged ? "YES — npm ci --omit=dev" : "no"}  (${p.depsReason})`)
  L.push(`  carry:    ${p.carryOver.length} runtime file(s) kept from this machine${p.carryOver.length ? ": " + p.carryOver.slice(0, 12).join(", ") + (p.carryOver.length > 12 ? ", …" : "") : ""}`)
  const kept = p.keptYours ?? []
  L.push(`  yours:    ${kept.length} file(s) you added, kept (untracked, not in the target)${kept.length ? ": " + kept.slice(0, 12).join(", ") + (kept.length > 12 ? ", …" : "") : ""}`)
  if (cur.note) L.push(`  note:     ${cur.note}`)
  const keptSet = new Set(kept)
  const conflicts = new Set(p.untrackedConflicts ?? cur.untracked)
  const lc = [
    ...cur.modified.map((f) => `M ${f}`),
    ...cur.missing.map((f) => `D ${f}`),
    ...cur.untracked.filter((f) => conflicts.has(f)).map((f) => `? ${f}  (the target ships a different file here — needs --force)`),
    ...cur.untracked.filter((f) => keptSet.has(f)).map((f) => `+ ${f}  (kept — yours)`),
  ]
  const blocking = cur.modified.length + cur.missing.length + cur.untracked.filter((f) => conflicts.has(f)).length
  L.push(`  local changes: ${lc.length ? `${blocking} that need --force, ${keptSet.size} kept` : cur.kind === "unknown" ? "unknown" : "none"}`)
  lc.slice(0, 60).forEach((x) => L.push(`              ${x}`))
  if (lc.length > 60) L.push(`              … and ${lc.length - 60} more`)
  return L
}

// ─── Rollback decision ──────────────────────────────────────────────────────────────────────

export type HealthObservation = { answered: boolean; commit: string | null }

/** After the restart: did the NEW code come up? Only an exact commit match counts. */
export function updateSucceeded(obs: HealthObservation, target: string): boolean {
  return obs.answered && obs.commit === target
}

/**
 * After rolling back: is the OLD daemon running? With a known old commit, it must report exactly
 * that. With an unknown one (a pre-manifest install reports no commit), the best evidence is a
 * daemon that answers and is NOT the commit that just failed.
 */
export function rollbackVerified(obs: HealthObservation, previous: string | null, failedTarget: string): boolean {
  if (!obs.answered) return false
  if (isSha(previous)) return obs.commit === previous
  return obs.commit !== failedTarget
}

// ─── Effects ────────────────────────────────────────────────────────────────────────────────

function readText(f: string): string {
  try {
    return readFileSync(f, "utf8")
  } catch {
    return ""
  }
}

export async function resolveRef(ref: string, fetcher: typeof fetch = fetch): Promise<string> {
  if (isSha(ref)) return ref
  const r = await fetcher(`${apiBase()}/commits/${encodeURIComponent(ref)}`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "iris-daemon-update" },
    signal: AbortSignal.timeout(20000),
  })
  if (!r.ok) throw new Error(`could not resolve "${ref}" on ${REPO}: HTTP ${r.status}`)
  const sha = ((await r.json()) as any)?.sha
  if (!isSha(sha)) throw new Error(`GitHub did not return a commit for "${ref}"`)
  return sha
}

/** Download the exact commit, prove the bytes ARE that commit, and unpack into `dest`. */
export async function downloadTree(sha: string, dest: string, stage: string, fetcher: typeof fetch = fetch): Promise<{ tarballSha256: string; url: string }> {
  const url = tarballUrl(sha)
  const r = await fetcher(url, { headers: { "User-Agent": "iris-daemon-update" }, signal: AbortSignal.timeout(180000) })
  if (!r.ok) throw new Error(`download failed: ${url} → HTTP ${r.status}`)
  const buf = Buffer.from(await r.arrayBuffer())
  // VERIFY. There is no published checksum; the archive carries its own commit in the pax header
  // (GitHub and `git archive` both write comment=<sha>). A redirect, a proxy error page or a
  // different ref is refused here, before anything is unpacked.
  const inside = archiveCommit(buf)
  if (inside !== sha) throw new Error(`the downloaded archive is ${inside ? `commit ${inside}` : "not a commit archive"}, not ${sha} — refusing it`)
  rmSync(stage, { recursive: true, force: true })
  mkdirSync(stage, { recursive: true })
  const tgz = join(stage, "daemon.tar.gz")
  writeFileSync(tgz, buf)
  const ex = spawnSync("tar", ["-xzf", tgz, "-C", stage], { env: process.env, stdio: "pipe" })
  if (ex.status !== 0) throw new Error(`the archive could not be extracted: ${ex.stderr?.toString().trim()}`)
  const roots = readdirSync(stage, { withFileTypes: true }).filter((e) => e.isDirectory())
  if (roots.length !== 1) throw new Error("the archive did not contain exactly one top-level directory")
  rmSync(dest, { recursive: true, force: true })
  renameSync(join(stage, roots[0].name), dest)
  rmSync(stage, { recursive: true, force: true })
  if (!existsSync(join(dest, "daemon.js"))) throw new Error("the archive has no daemon.js — not the daemon")
  return { tarballSha256: sha256(buf), url }
}

/** Hard-link a directory tree (falls back to copying across filesystems). node_modules reuse. */
export function linkTree(src: string, dst: string): void {
  mkdirSync(dst, { recursive: true })
  for (const e of readdirSync(src, { withFileTypes: true })) {
    const s = join(src, e.name)
    const d = join(dst, e.name)
    if (e.isSymbolicLink()) symlinkSync(readlinkSync(s), d)
    else if (e.isDirectory()) linkTree(s, d)
    else {
      try {
        linkSync(s, d)
      } catch {
        copyFileSync(s, d)
      }
    }
  }
}

export function copyInto(srcRoot: string, dstRoot: string, rels: string[]): void {
  for (const rel of rels) {
    const s = join(srcRoot, rel)
    const d = join(dstRoot, rel)
    mkdirSync(dirname(d), { recursive: true })
    try {
      const st = lstatSync(s)
      if (st.isSymbolicLink()) symlinkSync(readlinkSync(s), d)
      else copyFileSync(s, d)
    } catch {
      /* written and removed between listing and copying — runtime churn, not an error */
    }
  }
}

export function installDeps(dir: string, log: (s: string) => void): void {
  const npm = process.env.IRIS_NPM || "npm"
  log(`  installing dependencies: ${npm} ci --omit=dev`)
  const r = spawnSync(npm, ["ci", "--omit=dev", "--no-audit", "--no-fund"], { cwd: dir, env: process.env, stdio: "pipe", timeout: 15 * 60 * 1000 })
  if (r.status !== 0) throw new Error(`npm ci failed: ${(r.stderr?.toString() || r.error?.message || "").trim().split("\n").slice(-6).join("\n")}`)
}

export async function probeHealth(url = healthUrl()): Promise<HealthObservation> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(3000) })
    if (!r.ok) return { answered: false, commit: null }
    const j = (await r.json()) as any
    return { answered: true, commit: isSha(j?.daemon_commit) ? j.daemon_commit : null }
  } catch {
    return { answered: false, commit: null }
  }
}

/** Poll /health until `accept` says yes or the timeout passes. Returns the last observation. */
export async function waitHealth(accept: (o: HealthObservation) => boolean, timeoutMs: number, url = healthUrl()): Promise<HealthObservation> {
  const deadline = Date.now() + timeoutMs
  let last: HealthObservation = { answered: false, commit: null }
  while (Date.now() < deadline) {
    last = await probeHealth(url)
    if (accept(last)) return last
    await new Promise((r) => setTimeout(r, 1000))
  }
  return last
}

export function restartDaemon(bridge: string): { ok: boolean; out: string } {
  const ctl = daemonCtlFor(bridge)
  const r = spawnSync(ctl, ["restart"], { cwd: dirname(ctl), env: process.env, stdio: "pipe", timeout: 120000 })
  return { ok: r.status === 0, out: `${r.stdout?.toString() ?? ""}${r.stderr?.toString() ?? ""}${r.error ? r.error.message : ""}`.trim() }
}

/** bridge → bridge.prev, bridge.next → bridge. One previous version is kept. */
export function swapIn(p: UpdatePaths): void {
  rmSync(p.prev, { recursive: true, force: true })
  renameSync(p.bridge, p.prev)
  try {
    renameSync(p.next, p.bridge)
  } catch (e) {
    renameSync(p.prev, p.bridge) // never leave the machine without a bridge
    throw e
  }
}

/** The failed tree → bridge.failed (kept for a look), bridge.prev → bridge. */
export function swapBack(p: UpdatePaths): void {
  rmSync(p.failed, { recursive: true, force: true })
  renameSync(p.bridge, p.failed)
  renameSync(p.prev, p.bridge)
}

// ─── Orchestration ──────────────────────────────────────────────────────────────────────────

export type UpdateOptions = {
  ref: string
  dryRun?: boolean
  force?: boolean
  /** Run inside a Hive task: the restart happens in a detached process after `restartDelaySec`. */
  detachRestart?: boolean
  restartDelaySec?: number
  healthTimeoutSec?: number
  paths?: UpdatePaths
  log?: (s: string) => void
  fetcher?: typeof fetch
}

export type UpdateResult = {
  ok: boolean
  status: "dry-run" | "up-to-date" | "blocked" | "preflight-failed" | "updated" | "rolled-back" | "rollback-failed" | "restart-scheduled" | "error" | "refused"
  from: string | null
  to: string | null
  detail?: string
  plan?: Plan
  /** Files a person added that were carried into the new tree ("kept (yours)"). */
  kept?: string[]
}

type Pending = {
  target: string
  previous: string | null
  force: boolean
  healthTimeoutSec: number
  paths: UpdatePaths
  created_at: string
}

function writeResult(p: UpdatePaths, r: UpdateResult | Record<string, unknown>, extra: Record<string, unknown> = {}): void {
  try {
    mkdirSync(p.stateDir, { recursive: true })
    const { plan, ...rest } = r as any
    writeFileSync(join(p.stateDir, "last.json"), JSON.stringify({ ...rest, ...extra, pid: process.pid, at: new Date().toISOString() }, null, 2))
  } catch {}
}

export async function runUpdate(o: UpdateOptions): Promise<UpdateResult> {
  const p = o.paths ?? updatePaths()
  const log = o.log ?? ((s: string) => console.log(s))
  const force = Boolean(o.force)

  const current = detectLocalState(p.bridge)
  if (current.kind === "absent") return { ok: false, status: "error", from: null, to: null, detail: `no daemon installed at ${p.bridge} — use: iris node install` }

  // An update started from INSIDE the daemon's own service (a Hive task) must detach, whatever
  // the flag says: an inline restart would kill this very process mid-swap.
  const detach = Boolean(o.detachRestart) || insideDaemonService(readCgroup())
  let launch: LaunchPlan | null = null
  if (detach && !o.dryRun) {
    launch = launchPlanHere(`iris-daemon-update-${Date.now()}`)
    log(`  restart helper: ${launch.kind} — ${launch.reason}`)
    if (launch.kind === "refuse") {
      const r: UpdateResult = { ok: false, status: "refused", from: current.commit, to: null, detail: launch.reason }
      writeResult(p, r)
      return r
    }
  }

  const target = await resolveRef(o.ref, o.fetcher)
  log(`  resolved ${o.ref} → ${target}`)

  // Dry run unpacks to a temp dir; a real run to bridge.next.
  const workRoot = o.dryRun ? join(tmpdir(), `iris-daemon-update-${process.pid}-${Date.now()}`) : p.iris
  const next = o.dryRun ? join(workRoot, "bridge.next") : p.next
  const stage = o.dryRun ? join(workRoot, "stage") : p.stage
  try {
    const dl = await downloadTree(target, next, stage, o.fetcher)
    log(`  downloaded ${dl.url} (verified: archive is commit ${short(target)})`)

    const targetFiles = hashTree(next)
    const isRuntime = runtimeMatcher(readText(join(p.bridge, ".gitignore")), readText(join(next, ".gitignore")))
    const currentAll = listFiles(p.bridge)
    const currentFiles = hashTree(p.bridge, isRuntime)
    const plan = computePlan({
      current,
      target,
      currentFiles,
      targetFiles,
      currentAll,
      isRuntime,
      hasNodeModules: existsSync(join(p.bridge, "node_modules")),
      force,
    })
    for (const l of formatPlan(plan)) log(l)

    if (o.dryRun) return { ok: true, status: "dry-run", from: current.commit, to: target, plan }
    if (plan.upToDate && !force) {
      rmSync(next, { recursive: true, force: true })
      return { ok: true, status: "up-to-date", from: current.commit, to: target, plan }
    }
    if (plan.blocked) {
      rmSync(next, { recursive: true, force: true })
      return { ok: false, status: "blocked", from: current.commit, to: target, detail: plan.blocked, plan }
    }

    // Pre-flight BEFORE anything touches the live install.
    const errs = preflight(next, daemonNode(p.iris))
    if (errs.length) {
      rmSync(next, { recursive: true, force: true })
      return { ok: false, status: "preflight-failed", from: current.commit, to: target, detail: errs.join("\n"), plan }
    }
    log("  pre-flight ok: entry files parse, every relative require resolves")

    // The manifest describes the commit's tree only — written before deps and runtime files land.
    writeFileSync(
      join(next, MANIFEST_NAME),
      JSON.stringify({ schema: 1, commit: target, installed_at: new Date().toISOString(), source: dl.url, tarball_sha256: dl.tarballSha256, previous_commit: current.commit, files: targetFiles }, null, 2) + "\n",
    )
    writeFileSync(join(next, COMMIT_FILE), target + "\n")

    if (plan.depsChanged) installDeps(next, log)
    else {
      linkTree(join(p.bridge, "node_modules"), join(next, "node_modules"))
      log("  node_modules reused (hard-linked) — package-lock.json unchanged")
    }

    const pending: Pending = { target, previous: current.commit, force, healthTimeoutSec: o.healthTimeoutSec ?? 180, paths: p, created_at: new Date().toISOString() }
    mkdirSync(p.stateDir, { recursive: true })
    const pendingFile = join(p.stateDir, "pending.json")
    writeFileSync(pendingFile, JSON.stringify(pending, null, 2))

    if (detach && launch) {
      // INSIDE A HIVE TASK the task is a child of the daemon this restarts. Restarting inline
      // would kill the task mid-update. So: hand the swap+restart+verify to a process in its own
      // session, started after a delay long enough for this task to report back.
      const delay = o.restartDelaySec ?? 10
      // Written BEFORE the helper starts, with a deadline: if the helper never writes again, the
      // record itself says it died rather than looking like a pending success.
      const r: UpdateResult = { ok: true, status: "restart-scheduled", from: current.commit, to: target, detail: `swap + restart in ${delay}s via ${launch.kind}; outcome → ${join(p.stateDir, "last.json")}`, plan }
      writeResult(p, r, { deadline_s: delay + 60, launch: launch.kind })
      scheduleFinish(pendingFile, delay, p, launch)
      return r
    }
    const fin = await finishUpdate(pendingFile, log)
    return { ...fin, plan }
  } finally {
    if (o.dryRun) rmSync(workRoot, { recursive: true, force: true })
  }
}

/** How this CLI re-invokes itself (compiled binary: just the executable; dev: bun + entry). */
export function selfCommand(): string[] {
  if (process.env.IRIS_SELF_CMD) return JSON.parse(process.env.IRIS_SELF_CMD)
  const entry = process.argv[1]
  if (entry && /\.(ts|js)$/.test(entry) && existsSync(entry)) return [process.execPath, entry]
  return [process.execPath]
}

// ─── Where the detached helper runs (it must OUTLIVE the daemon's restart) ─────────────────
//
// setsid() is enough under launchd and nohup: the helper leaves the daemon's process group.
// It is NOT enough under systemd. iris-hive-001 runs the daemon as a system unit
// (/etc/systemd/system/iris-daemon.service, default KillMode=control-group), and #191615 adds a
// --user unit: `restart` kills every process in the service's CGROUP, setsid'd or not. The helper
// would die between the swap and the health check, and a broken new version would stay with no
// rollback — the outcome this command exists to prevent. So under systemd the helper is started
// in its own transient scope, outside the service's cgroup; and if no scope can be made, the
// update is REFUSED before anything is touched.

export type LaunchPlan =
  | { kind: "setsid"; prefix: string[]; reason: string }
  | { kind: "systemd-user-scope" | "systemd-sudo-scope"; prefix: string[]; reason: string }
  | { kind: "refuse"; prefix: []; reason: string }

/** The cgroup segments that say "this process belongs to a systemd service". */
export function systemdServiceOf(cgroup: string): string | null {
  for (const line of cgroup.split("\n")) {
    const path = line.split(":").slice(2).join(":")
    const segs = path.split("/").filter(Boolean)
    // user@1000.service is the user MANAGER, not a unit we would be killed with; anything below it is.
    const svc = [...segs].reverse().find((x) => x.endsWith(".service") && !/^user@\d+\.service$/.test(x))
    if (svc) return svc
  }
  return null
}

/** Is this process running inside the daemon's own systemd service (i.e. a task of that daemon)? */
export function insideDaemonService(cgroup: string): boolean {
  return /(^|\/)iris-daemon[^/]*\.service(\/|$)/m.test(cgroup)
}

export function decideLaunch(e: {
  platform: string
  cgroup: string
  invocationId?: string
  unit: string
  uid: number
  gid: number
  userScopeWorks: () => boolean
  sudoScopeWorks: () => boolean
}): LaunchPlan {
  if (e.platform !== "linux") return { kind: "setsid", prefix: [], reason: `${e.platform}: a setsid'd process leaves the daemon's process group` }
  const svc = systemdServiceOf(e.cgroup)
  if (!svc && !e.invocationId) return { kind: "setsid", prefix: [], reason: "not under systemd: setsid is enough (nohup daemon)" }
  const why = svc ? `running inside ${svc}` : "INVOCATION_ID is set (systemd)"
  if (e.userScopeWorks())
    return { kind: "systemd-user-scope", prefix: ["systemd-run", "--user", "--scope", "--collect", "--quiet", `--unit=${e.unit}`], reason: `${why}: helper runs in its own user scope, outside the service's cgroup` }
  if (e.sudoScopeWorks())
    return {
      kind: "systemd-sudo-scope",
      prefix: ["sudo", "-n", "--preserve-env", "systemd-run", "--scope", "--collect", "--quiet", `--unit=${e.unit}`, `--uid=${e.uid}`, `--gid=${e.gid}`],
      reason: `${why}: no user manager; helper runs in a system scope (sudo -n) as uid ${e.uid}`,
    }
  return {
    kind: "refuse",
    prefix: [],
    reason:
      `${why}, and no transient scope can be created (systemd-run --user --scope failed — no user manager / linger? — and sudo -n systemd-run --scope is not allowed). ` +
      "A restart would kill the update helper with the service, leaving nothing to verify or roll back. Fix: loginctl enable-linger $USER, or run the update from a shell on the node.",
  }
}

/** Environment the helper needs to reach the user manager from inside a system service. */
function scopeEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  const uid = typeof process.getuid === "function" ? process.getuid() : 0
  if (!env.XDG_RUNTIME_DIR && existsSync(`/run/user/${uid}`)) env.XDG_RUNTIME_DIR = `/run/user/${uid}`
  return env
}

function probe(argv: string[]): boolean {
  const r = spawnSync(argv[0], argv.slice(1), { env: scopeEnv(), stdio: "pipe", timeout: 15000 })
  return r.status === 0
}

export function launchPlanHere(unit: string): LaunchPlan {
  let cgroup = ""
  try {
    cgroup = readFileSync(process.env.IRIS_PROC_CGROUP || "/proc/self/cgroup", "utf8")
  } catch {}
  const uid = typeof process.getuid === "function" ? process.getuid() : 0
  const gid = typeof process.getgid === "function" ? process.getgid() : 0
  return decideLaunch({
    platform: process.env.IRIS_PLATFORM_OVERRIDE || process.platform,
    cgroup,
    invocationId: process.env.INVOCATION_ID,
    unit,
    uid,
    gid,
    userScopeWorks: () => probe(["systemd-run", "--user", "--scope", "--collect", "--quiet", "true"]),
    sudoScopeWorks: () => probe(["sudo", "-n", "systemd-run", "--scope", "--collect", "--quiet", `--uid=${uid}`, "true"]),
  })
}

function readCgroup(): string {
  try {
    return readFileSync(process.env.IRIS_PROC_CGROUP || "/proc/self/cgroup", "utf8")
  } catch {
    return ""
  }
}

/**
 * What last.json says, in words — so "rolled back" and "the helper died" read differently. A
 * non-final phase older than its deadline means the helper stopped writing: it died.
 */
export function describeLast(last: any, nowMs: number): { final: boolean; text: string } {
  if (!last || typeof last !== "object" || !last.status) return { final: false, text: "no outcome recorded (the update never got as far as scheduling a restart)" }
  const FINAL = new Set(["updated", "rolled-back", "rollback-failed", "blocked", "preflight-failed", "up-to-date", "error", "refused"])
  if (FINAL.has(last.status)) return { final: true, text: `${last.status}${last.detail ? ` — ${last.detail}` : ""}` }
  const age = Math.round((nowMs - Date.parse(last.at ?? "")) / 1000)
  const deadline = Number(last.deadline_s ?? 0)
  if (deadline && age > deadline)
    return { final: true, text: `HELPER DIED during "${last.status}" (${age}s ago, deadline ${deadline}s) — nothing verified the new code; check the node by hand: iris daemon status` }
  return { final: false, text: `in progress: ${last.status} (${age}s ago)` }
}

function scheduleFinish(pendingFile: string, delaySec: number, p: UpdatePaths, plan: LaunchPlan): void {
  const [cmd, ...pre] = selfCommand()
  mkdirSync(p.stateDir, { recursive: true })
  const logFile = join(p.stateDir, "finish.log")
  const out = openSync(logFile, "a")
  // detached → setsid(): the helper leaves the daemon's process group, so launchd's kickstart -k
  // and daemonctl's stop do not take it down with the daemon.
  const argv = [...plan.prefix, cmd, ...pre, "daemon", "update", "--finish", pendingFile, "--finish-delay", String(delaySec)]
  // detached (setsid) in every case: the task that starts this must be able to return at once.
  const child = spawn(argv[0], argv.slice(1), { detached: true, stdio: ["ignore", out, out], env: scopeEnv() })
  child.unref()
}

/** Phase 2: carry over, swap, restart, verify — and roll back if the new code is not what runs. */
export async function finishUpdate(pendingFile: string, log: (s: string) => void = (s) => console.log(s), delaySec = 0): Promise<UpdateResult> {
  if (delaySec > 0) await new Promise((r) => setTimeout(r, delaySec * 1000))
  let pending: Pending
  try {
    pending = JSON.parse(readFileSync(pendingFile, "utf8")) as Pending
  } catch {
    return { ok: false, status: "error", from: null, to: null, detail: `no pending update at ${pendingFile} — already finished, or never prepared` }
  }
  const p = pending.paths
  const done = (r: UpdateResult): UpdateResult => {
    writeResult(p, r)
    rmSync(pendingFile, { force: true })
    return r
  }
  // Progress, each with a deadline: a helper killed mid-way leaves a phase that ages past it, and
  // describeLast() then says "helper died" — never mistaken for a rollback or a success.
  const phase = (status: string, deadline_s: number) =>
    writeResult(p, { ok: false, status, from: pending.previous, to: pending.target }, { deadline_s })
  const H = pending.healthTimeoutSec
  phase("helper-started", 60)

  // The install may have changed since phase 1 (a person editing, another update). Re-check.
  const now = detectLocalState(p.bridge)
  if (now.commit !== pending.previous) return done({ ok: false, status: "error", from: now.commit, to: pending.target, detail: "the install changed between preparing and swapping — not touching it" })
  // Carry over at the last moment, so the freshest tokens/logs/caches go with it.
  const next = p.next
  const targetHashes = readManifest(next)?.files ?? {}
  const targetFiles = new Set(Object.keys(targetHashes))
  const isRuntime = runtimeMatcher(readText(join(p.bridge, ".gitignore")), readText(join(next, ".gitignore")))
  const yours = classifyUntracked(
    now.untracked.filter((f) => !isRuntime(f)),
    targetHashes,
    (f) => {
      try {
        return sha256(readFileSync(join(p.bridge, f)))
      } catch {
        return null
      }
    },
  )
  const why = blockReason(now, pending.force, yours.conflicts)
  if (why) return done({ ok: false, status: "blocked", from: now.commit, to: pending.target, detail: why })

  const carry = carryOverList(listFiles(p.bridge), targetFiles, isRuntime)
  copyInto(p.bridge, next, carry)
  log(`  carried over ${carry.length} runtime file(s)`)
  // A person's own files: carried, never dropped. They stay untracked in the new tree (not in its
  // manifest), so they never count as drift and the next update keeps them again.
  copyInto(p.bridge, next, yours.kept)
  if (yours.kept.length) log(`  kept ${yours.kept.length} file(s) of yours: ${yours.kept.join(", ")}`)
  const kept = yours.kept.length ? { kept: yours.kept } : {}

  phase("swapping", 60)
  swapIn(p)
  log(`  swapped: bridge → bridge.prev, bridge.next → bridge`)

  phase("restarting-new", 120 + H + 30)
  const rs = restartDaemon(p.bridge)
  log(`  daemonctl restart → ${rs.ok ? "exit 0" : "non-zero"}${rs.out ? `: ${rs.out.split("\n").slice(-2).join(" / ")}` : ""}`)
  const obs = await waitHealth((o) => updateSucceeded(o, pending.target), pending.healthTimeoutSec * 1000)
  if (updateSucceeded(obs, pending.target)) {
    log(`  ✓ the running daemon reports ${short(pending.target)}`)
    return done({ ok: true, status: "updated", from: pending.previous, to: pending.target, ...kept })
  }

  const saw = obs.answered ? `it reported ${obs.commit ? short(obs.commit) : "no commit"}` : "it never answered /health"
  log(`  ✗ new code is not running after ${pending.healthTimeoutSec}s (${saw}) — rolling back`)
  phase("rolling-back", 120 + H + 30)
  swapBack(p)
  const rs2 = restartDaemon(p.bridge)
  log(`  daemonctl restart (rollback) → ${rs2.ok ? "exit 0" : "non-zero"}`)
  const back = await waitHealth((o) => rollbackVerified(o, pending.previous, pending.target), pending.healthTimeoutSec * 1000)
  if (rollbackVerified(back, pending.previous, pending.target)) {
    return done({ ok: false, status: "rolled-back", from: pending.previous, to: pending.target, detail: `${saw}; the previous version is running again (failed tree kept in ${p.failed})`, ...kept })
  }
  return done({
    ok: false,
    status: "rollback-failed",
    from: pending.previous,
    to: pending.target,
    detail: `${saw}; after rolling back the old daemon ${back.answered ? `reports ${back.commit ? short(back.commit) : "no commit"}` : "does not answer /health"} — check: iris daemon status, iris daemon logs`,
  })
}
