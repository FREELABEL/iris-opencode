// A playbook is a folder, not a file (#188688, epic #179315).
//
// PLAYBOOK.md travels as `content`. Everything else in the folder — templates, scripts,
// reference media, example outputs — travels as ONE gzipped ustar archive: packed here on
// publish, verified and unpacked here on install. Before this, publish sent the markdown and
// nothing else, so `${{playbook.assets}}` was an empty folder on every machine but the author's
// and a playbook that worked for its author failed for everyone who installed it.
//
// Hand-rolled ustar rather than a dependency: the format needed is tiny (regular files only),
// and extraction is the security boundary — every path is checked here, by code we own,
// before a byte is written to someone else's disk.

import { createHash } from "crypto"
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "fs"
import nodePath from "path"
import { gunzipSync, gzipSync } from "zlib"

export interface BundleFile {
  path: string
  bytes: number
  sha256: string
}

export interface CollectedFile extends BundleFile {
  abs: string
  executable: boolean
}

/** Matched against every path SEGMENT, so `node_modules` is skipped at any depth. */
const SKIP_SEGMENTS = new Set([".git", "node_modules", "__pycache__", ".DS_Store", ".venv", "venv", ".cache"])

/**
 * Names that are secrets far more often than they are assets. A public publish puts these on
 * the internet, so they are never bundled — a playbook that needs a key asks for it at run time.
 */
const SECRET_NAME = /^(\.env(\..*)?|.*\.pem|.*\.key|.*\.p12|.*\.pfx|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|\.npmrc|\.netrc|credentials(\.json)?)$/i

/** Top-level files that are the playbook itself or local bookkeeping, not its contents. */
const SKIP_TOP = new Set(["PLAYBOOK.md", "SKILL.md", ".installed.json"])

export const DEFAULT_MAX_BYTES = 50 * 1024 * 1024
export const MAX_FILES = 2000

export function sha256Bytes(b: Uint8Array): string {
  return createHash("sha256").update(b).digest("hex")
}

/**
 * Why `p` may not be written inside a playbook folder, or null if it may.
 * Mirrors fl-iris-api PlaybookController::manifestError — the server refuses these on upload,
 * and this refuses them again on extraction, because the installer must not trust the server.
 */
export function unsafePathReason(p: string): string | null {
  if (typeof p !== "string" || p === "") return "empty path"
  if (p.length > 512) return "path too long"
  if (p.startsWith("/") || p.includes("\\") || /^[A-Za-z]:/.test(p)) return "absolute path"
  if (p.includes("\0")) return "NUL in path"
  const segs = p.split("/")
  if (segs.some((s) => s === ".." || s === "." || s === "")) return "`..`, `.` or empty segment"
  return null
}

/** Why a file is left out of the bundle, or null if it goes in. Exported for tests. */
export function skipReason(rel: string): string | null {
  const segs = rel.split("/")
  if (segs.length === 1 && SKIP_TOP.has(segs[0])) return "the playbook itself"
  if (segs.some((s) => SKIP_SEGMENTS.has(s))) return "build/VCS folder"
  if (SECRET_NAME.test(segs[segs.length - 1])) return "looks like a secret"
  if (segs[0] === "runs" || /\.log$/.test(rel)) return "run output"
  return null
}

/**
 * Every file in the playbook folder that should travel, sorted, with sizes and hashes.
 * Symlinks are skipped, never followed: a link to ~/.ssh inside a playbook folder must not
 * turn into a copy of ~/.ssh on the marketplace.
 */
export function collectBundle(root: string): { files: CollectedFile[]; skipped: { path: string; reason: string }[] } {
  const files: CollectedFile[] = []
  const skipped: { path: string; reason: string }[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const abs = nodePath.join(dir, name)
      const rel = nodePath.relative(root, abs).split(nodePath.sep).join("/")
      const st = lstatSync(abs)
      if (st.isSymbolicLink()) {
        skipped.push({ path: rel, reason: "symlink (not followed)" })
        continue
      }
      const why = skipReason(rel)
      if (why) {
        if (why !== "the playbook itself") skipped.push({ path: rel, reason: why })
        continue
      }
      if (st.isDirectory()) {
        walk(abs)
        continue
      }
      if (!st.isFile()) continue
      const data = readFileSync(abs)
      files.push({ path: rel, abs, bytes: data.length, sha256: sha256Bytes(data), executable: (st.mode & 0o111) !== 0 })
    }
  }
  if (existsSync(root)) walk(root)
  return { files, skipped }
}

// ── ustar ────────────────────────────────────────────────────────────────────

function octal(n: number, width: number): string {
  return n.toString(8).padStart(width - 1, "0") + "\0"
}

function header(path: string, size: number, mode: number): Buffer {
  const h = Buffer.alloc(512)
  let name = path
  let prefix = ""
  if (Buffer.byteLength(name) > 100) {
    // ustar splits a long path at a "/" into prefix (≤155) + name (≤100).
    const cut = path.lastIndexOf("/", 155)
    if (cut <= 0 || Buffer.byteLength(path.slice(cut + 1)) > 100) throw new Error(`path too long for a bundle: ${path}`)
    prefix = path.slice(0, cut)
    name = path.slice(cut + 1)
  }
  h.write(name, 0, 100, "utf8")
  h.write(octal(mode, 8), 100, "ascii")
  h.write(octal(0, 8), 108, "ascii") // uid
  h.write(octal(0, 8), 116, "ascii") // gid
  h.write(octal(size, 12), 124, "ascii")
  h.write(octal(0, 12), 136, "ascii") // mtime 0: same files → same bytes → same sha
  h.write("        ", 148, "ascii") // checksum placeholder
  h.write("0", 156, "ascii") // regular file
  h.write("ustar\0", 257, "ascii")
  h.write("00", 263, "ascii")
  h.write(prefix, 345, 155, "utf8")
  let sum = 0
  for (const b of h) sum += b
  h.write(octal(sum, 7) + " ", 148, "ascii")
  return h
}

/** Pack files into a gzipped ustar archive. Deterministic: same inputs, same bytes. */
export function packBundle(files: { path: string; data: Uint8Array; executable?: boolean }[]): Buffer {
  const parts: Buffer[] = []
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    const bad = unsafePathReason(f.path)
    if (bad) throw new Error(`refusing to bundle ${f.path}: ${bad}`)
    parts.push(header(f.path, f.data.length, f.executable ? 0o755 : 0o644))
    parts.push(Buffer.from(f.data))
    const pad = (512 - (f.data.length % 512)) % 512
    if (pad) parts.push(Buffer.alloc(pad))
  }
  parts.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(parts), { level: 9 })
}

/**
 * Read a bundle. Throws on anything but regular files and directories, and on any path that
 * would land outside the folder — before anything is written.
 */
export function unpackBundle(gz: Uint8Array, maxBytes = DEFAULT_MAX_BYTES * 4): { path: string; data: Buffer; executable: boolean }[] {
  const tar = gunzipSync(gz, { maxOutputLength: maxBytes })
  const out: { path: string; data: Buffer; executable: boolean }[] = []
  let off = 0
  while (off + 512 <= tar.length) {
    const h = tar.subarray(off, off + 512)
    if (h.every((b) => b === 0)) break
    const str = (a: number, n: number) => h.subarray(a, a + n).toString("utf8").replace(/\0.*$/s, "")
    const name = str(0, 100)
    const prefix = str(345, 155)
    const path = prefix ? `${prefix}/${name}` : name
    const size = parseInt(str(124, 12).trim() || "0", 8)
    const mode = parseInt(str(100, 8).trim() || "644", 8)
    const type = String.fromCharCode(h[156] || 48)
    if (Number.isNaN(size) || size < 0) throw new Error(`corrupt bundle header at ${path}`)
    off += 512
    if (type === "5") {
      off += Math.ceil(size / 512) * 512
      continue
    }
    if (type !== "0" && type !== "\0") throw new Error(`bundle entry ${path} is not a regular file (type ${type}) — refused`)
    const bad = unsafePathReason(path)
    if (bad) throw new Error(`bundle entry ${path} refused: ${bad}`)
    if (off + size > tar.length) throw new Error(`bundle truncated at ${path}`)
    out.push({ path, data: Buffer.from(tar.subarray(off, off + size)), executable: (mode & 0o111) !== 0 })
    off += Math.ceil(size / 512) * 512
  }
  return out
}

/**
 * Write a bundle into a playbook folder, verifying every file against the manifest the
 * registry published. Nothing is written unless EVERYTHING verifies.
 *
 * `previous` is the file list recorded at the last install: files it named that the new
 * bundle no longer has are removed, so a renamed script does not linger and get run. Files
 * the author never shipped are never touched.
 */
export function extractBundle(
  root: string,
  gz: Uint8Array,
  manifest: BundleFile[],
  previous: string[] = [],
): { written: string[]; removed: string[] } {
  const entries = unpackBundle(gz)
  const want = new Map(manifest.map((f) => [f.path, f]))
  if (entries.length !== want.size) throw new Error(`bundle has ${entries.length} files, the registry lists ${want.size}`)
  for (const e of entries) {
    const m = want.get(e.path)
    if (!m) throw new Error(`bundle file ${e.path} is not in the registry's list`)
    const sha = sha256Bytes(e.data)
    if (sha !== m.sha256 || e.data.length !== m.bytes) throw new Error(`bundle file ${e.path} does not match its published hash`)
  }
  const rootAbs = nodePath.resolve(root)
  const target = (p: string) => {
    const abs = nodePath.resolve(rootAbs, ...p.split("/"))
    if (abs !== rootAbs && !abs.startsWith(rootAbs + nodePath.sep)) throw new Error(`bundle path escapes the folder: ${p}`)
    return abs
  }
  const written: string[] = []
  for (const e of entries) {
    const abs = target(e.path)
    mkdirSync(nodePath.dirname(abs), { recursive: true })
    writeBytesAtomic(abs, e.data)
    if (e.executable && process.platform !== "win32") chmodSync(abs, 0o755)
    written.push(e.path)
  }
  const removed = removeBundleFiles(root, previous.filter((p) => !want.has(p)))
  return { written, removed }
}

/**
 * Remove files a previous bundle installed. Only paths from the install record are ever passed
 * here, so a file the user created in the folder is never touched.
 */
export function removeBundleFiles(root: string, paths: string[]): string[] {
  const rootAbs = nodePath.resolve(root)
  const removed: string[] = []
  for (const p of paths) {
    if (unsafePathReason(p)) continue
    const abs = nodePath.resolve(rootAbs, ...p.split("/"))
    if (!abs.startsWith(rootAbs + nodePath.sep)) continue
    if (existsSync(abs) && statSync(abs).isFile()) {
      rmSync(abs)
      removed.push(p)
    }
  }
  return removed
}

/** Temp file + rename, so an interrupted install never leaves a half-written script behind. */
function writeBytesAtomic(file: string, data: Uint8Array): void {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, data)
  try {
    renameSync(tmp, file)
  } catch {
    rmSync(tmp, { force: true })
    writeFileSync(file, data)
  }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
