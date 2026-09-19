/**
 * Where `iris playbook install` puts a playbook, and how it writes it.
 *
 * WHY THIS EXISTS (2026-09-18): install used to write `<cwd>/.iris/playbooks/<name>` and sync to
 * `<cwd>/.claude/skills/`. On a client's Windows machine the terminal was sitting in
 * `C:\WINDOWS\system32`, so the playbook landed in a folder that neither the IRIS Desktop app nor
 * Claude Code ever looks in. Both of them scan `~/.claude/skills/**\/SKILL.md` from ANY project,
 * and the CLI loader scans `~/.iris/playbooks/**\/PLAYBOOK.md` from any directory — so the home
 * directory is the one place all three agree on. That is now the default.
 *
 * A project keeps its own copies when it has opted in: the cwd is inside a git repo that already
 * has `.iris/playbooks` somewhere between the cwd and the repo root, or `--project` was passed.
 * The loader scans project copies before global ones, so a project copy wins on a name clash.
 *
 * Everything here takes its filesystem and path API as parameters so the resolution can be
 * tested against a Windows-shaped home on any OS.
 */
import nodePath from "path"
import os from "os"
import { createHash } from "crypto"
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "fs"

export type InstallScope = "global" | "project"
export type InstallMode = "auto" | "global" | "project"

export interface InstallRoot {
  scope: InstallScope
  /** The directory that holds `.iris/` and `.claude/` — the home dir, or a project root. */
  root: string
  /** `<root>/.iris/playbooks` */
  playbooksDir: string
  /** `<root>/.claude/skills` — read by Claude Code AND the IRIS Desktop app. */
  skillsDir: string
  /** One line saying why this root was chosen, printed by install. */
  reason: string
}

type PathApi = Pick<typeof nodePath, "join" | "dirname" | "resolve" | "basename">

export interface ResolveOptions {
  cwd: string
  home: string
  mode?: InstallMode
  exists?: (p: string) => boolean
  path?: PathApi
}

/** The home dir the loader uses (`Global.Path.home`): OPENCODE_TEST_HOME, else os.homedir() (USERPROFILE on Windows). */
export function installHome(): string {
  return process.env.OPENCODE_TEST_HOME || os.homedir()
}

function rootFor(scope: InstallScope, root: string, reason: string, p: PathApi): InstallRoot {
  return {
    scope,
    root,
    playbooksDir: p.join(root, ".iris", "playbooks"),
    skillsDir: p.join(root, ".claude", "skills"),
    reason,
  }
}

function samePath(a: string, b: string, p: PathApi): boolean {
  const norm = (x: string) => {
    const r = p.resolve(x)
    // Windows paths are case-insensitive; a trailing separator must not make two paths differ.
    return (p === nodePath.win32 ? r.toLowerCase() : r).replace(/[\\/]+$/, "")
  }
  return norm(a) === norm(b)
}

/** Walk up from `start` to the filesystem root, never including `home` or anything above it. */
function ancestorsBelowHome(start: string, home: string, p: PathApi): string[] {
  const out: string[] = []
  let cur = p.resolve(start)
  while (true) {
    if (samePath(cur, home, p)) break
    out.push(cur)
    const parent = p.dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  return out
}

/** The nearest git root at or above `cwd`, stopping below `home` (a dotfiles repo in home is not a project). */
export function findGitRoot(cwd: string, home: string, exists: (p: string) => boolean, p: PathApi = nodePath): string | null {
  for (const dir of ancestorsBelowHome(cwd, home, p)) {
    if (exists(p.join(dir, ".git"))) return dir
  }
  return null
}

export function resolveInstallRoot(opts: ResolveOptions): InstallRoot {
  const p = opts.path ?? nodePath
  const exists = opts.exists ?? existsSync
  const mode = opts.mode ?? "auto"
  const home = opts.home

  if (mode === "global") return rootFor("global", home, "--global", p)

  const gitRoot = findGitRoot(opts.cwd, home, exists, p)

  if (mode === "project") {
    const root = gitRoot ?? p.resolve(opts.cwd)
    return rootFor("project", root, gitRoot ? "--project (git root)" : "--project (no git repo — current directory)", p)
  }

  // auto: project-local only when a git project has already opted in with .iris/playbooks.
  // Outside a git repo (system32, Desktop, /tmp) there is no project to keep copies in.
  if (gitRoot) {
    for (const dir of ancestorsBelowHome(opts.cwd, home, p)) {
      if (exists(p.join(dir, ".iris", "playbooks"))) {
        return rootFor("project", dir, `this project already keeps playbooks in ${p.join(dir, ".iris", "playbooks")}`, p)
      }
      if (samePath(dir, gitRoot, p)) break
    }
  }
  return rootFor("global", home, "default — found by the IRIS app and Claude Code from any folder", p)
}

export function playbookFile(root: InstallRoot, name: string, p: PathApi = nodePath): { dir: string; file: string } {
  const dir = p.join(root.playbooksDir, name)
  return { dir, file: p.join(dir, "PLAYBOOK.md") }
}

/**
 * The `.claude/skills` dir that sits beside the `.iris/playbooks` a PLAYBOOK.md lives in —
 * so a global playbook syncs to `~/.claude/skills` and a project one to `<project>/.claude/skills`.
 * Null when the file is not under an `.iris/playbooks` tree.
 */
export function skillsDirForPlaybook(location: string, p: PathApi = nodePath): string | null {
  let cur = p.dirname(p.resolve(location))
  while (true) {
    const parent = p.dirname(cur)
    if (parent === cur) return null
    if (p.basename(cur) === "playbooks" && p.basename(parent) === ".iris") {
      return p.join(p.dirname(parent), ".claude", "skills")
    }
    cur = parent
  }
}

/**
 * Other copies of `name` the CLI loader would pick BEFORE `installedFile` when run from `cwd`:
 * any `.iris/playbooks/<name>/PLAYBOOK.md` walking up from cwd (the loader scans those first).
 * An old cwd-local install on Windows is exactly this, and it silently shadows the new global one.
 */
export function shadowingCopies(
  name: string,
  cwd: string,
  installedFile: string,
  home: string,
  exists: (p: string) => boolean = existsSync,
  p: PathApi = nodePath,
): string[] {
  const out: string[] = []
  for (const dir of ancestorsBelowHome(cwd, home, p)) {
    const f = p.join(dir, ".iris", "playbooks", name, "PLAYBOOK.md")
    if (samePath(f, installedFile, p)) break // anything above the installed copy loses to it
    if (exists(f)) out.push(f)
  }
  return out
}

// ---------------------------------------------------------------------------
// Writing — #185996. `install --force` and `sync` both died with EEXIST on Windows (OneDrive
// folders), creating a directory that already existed. mkdir is skipped when the dir is there,
// EEXIST is tolerated when it is, and the file is written to a temp name and renamed over the
// old one, falling back to an in-place overwrite when Windows refuses the rename (a lock).
// ---------------------------------------------------------------------------

export interface FsOps {
  mkdir: (dir: string, opts: { recursive: true }) => unknown
  rename: (from: string, to: string) => void
  write: (file: string, data: string) => void
  unlink: (file: string) => void
  isDir: (p: string) => boolean
}

const realFs: FsOps = {
  mkdir: (d, o) => mkdirSync(d, o),
  rename: (a, b) => renameSync(a, b),
  write: (f, d) => writeFileSync(f, d, "utf8"),
  unlink: (f) => unlinkSync(f),
  isDir: (p) => {
    try {
      return statSync(p).isDirectory()
    } catch {
      return false
    }
  },
}

export function ensureDir(dir: string, fs: FsOps = realFs): void {
  if (fs.isDir(dir)) return
  try {
    fs.mkdir(dir, { recursive: true })
  } catch (e: any) {
    // Windows/OneDrive can report EEXIST for a directory even with recursive: true.
    if (e?.code === "EEXIST" && fs.isDir(dir)) return
    if (e?.code === "EEXIST" && existsSync(dir)) return // a placeholder stat cannot read; the write will tell
    throw e
  }
}

export function writeFileAtomic(file: string, data: string, fs: FsOps = realFs): void {
  ensureDir(nodePath.dirname(file), fs)
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.write(tmp, data)
  try {
    fs.rename(tmp, file)
  } catch {
    try {
      fs.unlink(tmp)
    } catch {
      /* best effort */
    }
    fs.write(file, data) // truncating overwrite
  }
}

export function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Installed-version sidecar — #185995. What was installed, measured, so install can say a newer
// registry version exists and whether the local copy was edited, instead of guessing.
// ---------------------------------------------------------------------------

export const SIDECAR = ".installed.json"

export interface InstalledRecord {
  name: string
  version: string | null
  sha256: string
  installed_at: string
}

export function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex")
}

export function readInstalled(dir: string): InstalledRecord | null {
  try {
    const r = JSON.parse(readFileSync(nodePath.join(dir, SIDECAR), "utf8"))
    return r && typeof r.sha256 === "string" ? r : null
  } catch {
    return null
  }
}

export function writeInstalled(dir: string, rec: InstalledRecord, fs: FsOps = realFs): void {
  writeFileAtomic(nodePath.join(dir, SIDECAR), JSON.stringify(rec, null, 2) + "\n", fs)
}

export type Staleness = "current" | "newer" | "differs" | "edited"

/** Compare two registry versions: 1 if a > b, -1 if a < b, 0 if equal, null if not comparable. */
export function compareVersions(a: string | null | undefined, b: string | null | undefined): number | null {
  if (a == null || b == null || a === "" || b === "") return null
  if (a === b) return 0
  const pa = String(a).split(".").map(Number)
  const pb = String(b).split(".").map(Number)
  if (pa.some(Number.isNaN) || pb.some(Number.isNaN)) return null
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d) return d > 0 ? 1 : -1
  }
  return 0
}

/**
 * What `install` (without --force) says about an existing copy.
 * - newer:   the registry version is higher than the one recorded at install.
 * - differs: no record, or no comparable versions, and the published text is not what is on disk.
 * - edited:  the registry is not newer, but the file no longer matches what was installed.
 * - current: nothing to do.
 */
export function assessInstalled(input: {
  name: string
  localContent: string
  record: InstalledRecord | null
  registryVersion: string | null
  registryContent: string
}): { state: Staleness; localEdits: boolean; message: string } {
  const { name, record } = input
  const localSha = sha256(input.localContent)
  const registrySha = sha256(input.registryContent)
  const localEdits = record ? localSha !== record.sha256 : false
  const fix = `run iris playbook install ${name} --force`
  const editsNote = localEdits ? " (--force discards your local edits)" : ""

  const cmp = record ? compareVersions(input.registryVersion, record.version) : null
  if (cmp === 1) {
    return {
      state: "newer",
      localEdits,
      message: `v${input.registryVersion} available (you have v${record!.version}) — ${fix}${editsNote}`,
    }
  }
  if (localSha === registrySha) {
    return { state: "current", localEdits: false, message: `Up to date${input.registryVersion ? ` (v${input.registryVersion})` : ""}` }
  }
  if (localEdits && (cmp === 0 || cmp === -1 || registrySha === record!.sha256)) {
    return { state: "edited", localEdits, message: `Your copy has local edits; the published copy is unchanged since you installed it. To discard your edits, ${fix}` }
  }
  const pub = input.registryVersion ? `v${input.registryVersion}` : "The published copy"
  const why = record ? "" : ", and this copy was installed before versions were recorded"
  return {
    state: "differs",
    localEdits,
    message: `${pub} differs from your copy${why} — ${fix}${editsNote}`,
  }
}

/** The first line `iris playbook sync` writes into every SKILL.md it generates. */
export const SKILL_GENERATED_MARKER = "AUTO-GENERATED by iris playbook sync"

export type SkillWriteDecision = { write: true; via: string | null } | { write: false; reason: string }

/**
 * May a generated skill replica be written into `targetDir` (a folder under a skills dir)?
 *
 * In the HOME skills dir (~/.claude/skills) a hand-written SKILL.md is never overwritten.
 * A symlinked skill folder is the subtle case (#186155): `install --force` used to leave it alone
 * and still report "Installed", so the playbook updated while the skill Claude Code actually reads
 * stayed stale — with nothing on screen but a dim line. With `followSymlink` (install, which names
 * one playbook on purpose) the replica is written THROUGH the link when the file behind it was
 * generated by sync anyway — it is a copy of this playbook, not someone's own work. `via` is the
 * resolved folder, so the caller can say where it wrote. A dangling link is refused.
 */
export function decideSkillWrite(targetDir: string, opts: { home: boolean; followSymlink: boolean }): SkillWriteDecision {
  if (!opts.home) return { write: true, via: null }
  let via: string | null = null
  if (isSymlink(targetDir)) {
    if (!opts.followSymlink) return { write: false, reason: "a symlinked folder — left alone" }
    try {
      via = realpathSync(targetDir)
    } catch {
      return { write: false, reason: "a symlink to a folder that no longer exists — left alone" }
    }
  }
  const targetFile = nodePath.join(targetDir, "SKILL.md")
  if (existsSync(targetFile)) {
    let existing = ""
    try {
      existing = readFileSync(targetFile, "utf8")
    } catch {
      /* unreadable → treat as not ours */
    }
    if (!existing.includes(SKILL_GENERATED_MARKER)) {
      return { write: false, reason: "a hand-written skill of the same name — left alone" }
    }
  }
  return { write: true, via }
}
