/**
 * IRIS Drives — the pure half of `iris drives` (#192927, epic #192914).
 *
 * This is a PORT of scripts/drives/drive_scan.py (freelabel repo), which is already in
 * production on Linux. The two tools must be interchangeable: a drive scanned by either is
 * found, resolved and rescanned by the other. So everything that reaches Atlas or the manifest
 * — classification, the TSV, the sealed blob, the drive id, the row shapes — follows the Python
 * byte for byte where it can and field for field where it cannot. Change one, change both.
 *
 * Nothing here talks to the network; platform-drives.ts does that.
 */

import fs from "fs"
import os from "os"
import path from "path"
import { gzipSync, gunzipSync } from "zlib"
import { createHash } from "crypto"

export const STORE = () => path.join(os.homedir(), ".iris", "drives")

export const SKIP_DIRS = new Set([
  ".Spotlight-V100", ".fseventsd", ".Trashes", ".TemporaryItems", "lost+found",
  "System Volume Information", "$RECYCLE.BIN", ".DocumentRevisions-V100", ".git", "node_modules",
])
/**
 * macOS leaves suffixed copies of its own system folders (".DocumentRevisions-V100-bad",
 * ".Spotlight-V100.old"), so these are skipped by PREFIX, as drive_scan.py does (#192974).
 */
export const SKIP_PREFIXES = [".DocumentRevisions-V100", ".Spotlight-V100", ".TemporaryItems", ".fseventsd"]
/**
 * An installed app, framework, plug-in or driver is ONE item, listed and never opened: the
 * certificates and keys inside Zoom.app are the vendor's, not ours, and are not findings (#192974).
 */
export const APP_BUNDLES = [".app", ".framework", ".plugin", ".bundle", ".kext"]
/** Bundles are ONE thing to a person (a Logic project is a folder of 2,000 files on disk). */
export const BUNDLES = [".logicx", ".fcpbundle", ".photoslibrary", ".band", ".dspproj", ".imovielibrary", ".prproj", ".aep"]

export const KINDS: Array<[string, RegExp]> = [
  ["credential", /(^|\/)(\.env(\..+)?|config\.php|database\.php|wp-config\.php|id_rsa|id_ed25519|credentials\.json|service-account.*\.json|.*\.(pem|key|p12|pfx|ppk))$/i],
  ["db-dump", /\.(sql|sql\.gz|sql\.bak|sql\.zip|dump|sqlite3?|db|mdb|accdb)$/i],
  ["project", /\.(logicx|fcpbundle|band|prproj|aep|drp|als|flp|ptx|psd|ai|indd|sketch|fig)$/i],
  ["video", /\.(mov|mp4|m4v|mxf|avi|mkv|mts|m2ts|braw|r3d|crm|insv|webm)$/i],
  ["audio", /\.(wav|aif|aiff|mp3|m4a|flac|aac|ogg|caf)$/i],
  ["image", /\.(jpe?g|png|gif|heic|tiff?|cr2|cr3|arw|nef|dng|raw|webp|svg|bmp)$/i],
  ["code", /\.(php|js|ts|jsx|tsx|py|rb|go|java|c|cpp|h|css|scss|less|html?|vue|json|ya?ml|sh|md)$/i],
  ["document", /\.(pdf|docx?|xlsx?|pptx?|pages|numbers|key|txt|rtf|csv)$/i],
  ["archive", /\.(zip|tar|gz|tgz|rar|7z|dmg|iso)$/i],
]
export const SENSITIVE = new Set(["credential", "db-dump"])
export const LIBRARY = /(^|\/)(vendor|node_modules|tests?|testdata|spec|system\/core|libs?)\//i
/** Framework classes; the real credentials were config.php / database.php (case matters). */
export const CLASSFILE = new Set(["Config.php", "Database.php", "Env.php", "Configuration.php"])
/**
 * #193365: the credential files that hide under another name (config.envr.php was copied without
 * --confirm). Same pattern as CREDENTIAL_VARIANTS in drive_scan.py; change one, change both.
 */
export const CREDENTIAL_VARIANTS = new RegExp(
  String.raw`(^|/)(config\.[^/]+\.php|([^/]*\.)?env\.php|configuration\.php|\.envrc` +
    String.raw`|settings\.local\.(php|py|ya?ml|toml|ini|conf|cfg|env)|local_settings\.py|settings_local\.py` +
    String.raw`|secrets\.(json|ya?ml|toml|env|ini|conf|cfg|properties|xml|txt)|[^/]+\.credentials|\.git-credentials` +
    String.raw`|\.aws/credentials|\.netrc|\.pgpass|\.htpasswd|local\.settings\.json)$`,
  "i",
)
/** A variant shipped as a template (phpMyAdmin's config.sample.inc.php, config.default.php) is not a secret. */
export const SAMPLE = /(^|[._-])(example|sample|dist|default|template|tpl|stub)([._-]|$)/i

export function kindOf(rel: string): string {
  for (const [k, rx] of KINDS) {
    if (rx.test(rel) || (k === "credential" && CREDENTIAL_VARIANTS.test(rel) && !SAMPLE.test(path.posix.basename(rel)))) {
      if (k === "credential" && (LIBRARY.test(rel) || CLASSFILE.has(path.posix.basename(rel)))) return "code"
      return k
    }
  }
  return "other"
}

// ── walk ──────────────────────────────────────────────────────────────────────

/** sha256 is "" (or absent) when the file was not checksummed — see shouldHash. */
export type Entry = { rel: string; bytes: number; mtime: number; kind: string; sha256?: string }

// ── checksums: copies counted by content (#192914) ─────────────────────────────────
//
// Hashing 5.5 TB over USB is ~10 hours, so by default only the small, high-value files are
// hashed: every sensitive file, and project/document/audio files up to 64 MB. `--checksums all`
// hashes everything, `--checksums none` nothing. drive_scan.py applies the same rule.

export type Checksums = "default" | "all" | "none"
export const CHECKSUM_CHOICES: Checksums[] = ["default", "all", "none"]
export const HASH_KINDS = new Set(["project", "document", "audio"])
export const HASH_MAX_BYTES = 64 * 1024 * 1024

/** An empty file is never hashed: every empty file on every drive would count as one "copy". */
export function shouldHash(kind: string, bytes: number, mode: Checksums): boolean {
  if (mode === "none" || !(bytes > 0)) return false
  if (mode === "all") return true
  return SENSITIVE.has(kind) || (HASH_KINDS.has(kind) && bytes <= HASH_MAX_BYTES)
}

export function sha256File(p: string): string {
  const h = createHash("sha256")
  const fd = fs.openSync(p, "r")
  try {
    const buf = Buffer.allocUnsafe(4 << 20)
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null)
      if (n <= 0) break
      h.update(buf.subarray(0, n))
    }
  } finally {
    fs.closeSync(fd)
  }
  return h.digest("hex")
}

/** UTF-8 byte order == Unicode code-point order == Python's sorted() on str. */
const byCodePoint = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b))

/**
 * A bundle's hash: sha256 of its members' `relpath\tsha256` lines, sorted, each ending in \n.
 * relpath is relative to the bundle, "/"-separated. Only regular files are members.
 */
export function bundleHashFromLines(members: Array<[string, string]>): string {
  const lines = members.map(([rel, h]) => `${rel}\t${h}`).sort(byCodePoint)
  return createHash("sha256").update(lines.map((l) => l + "\n").join("")).digest("hex")
}

/** Every regular file inside a bundle: [relpath ("/"-separated), absolute path]. Links are not followed. */
export function bundleMembers(dir: string, F: WalkFs = realFs): Array<[string, string]> {
  const out: Array<[string, string]> = []
  const stack = [""]
  while (stack.length) {
    const rel = stack.pop()!
    let items: fs.Dirent[]
    try {
      items = F.readdir(path.join(dir, rel))
    } catch {
      continue
    }
    for (const e of items) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) stack.push(r)
      else if (e.isFile()) out.push([r, path.join(dir, r)])
    }
  }
  return out
}

export function bundleHash(dir: string, hashFile: (p: string) => string = sha256File, F: WalkFs = realFs): string {
  return bundleHashFromLines(bundleMembers(dir, F).map(([rel, abs]) => [rel, hashFile(abs)]))
}

/** The filesystem calls the walk makes — injectable so a test can prove a folder is never opened. */
export type WalkFs = {
  readdir: (p: string) => fs.Dirent[]
  lstat: (p: string) => fs.Stats
}
export const realFs: WalkFs = {
  readdir: (p) => fs.readdirSync(p, { withFileTypes: true }),
  lstat: (p) => fs.lstatSync(p),
}

export function normalizeExcludes(excludes: readonly string[]): string[] {
  return excludes.map((e) => e.replace(/^\/+|\/+$/g, "").toLowerCase()).filter((e) => e !== "")
}

/**
 * Yield every file (rel path, bytes, mtime seconds, kind). A bundle is yielded once with its total
 * size. Excluded folders are skipped BEFORE they are entered: never listed, never opened, never
 * counted. Folders that cannot be opened are pushed onto `unreadable` — reported, never silent.
 */
export function* walk(
  root: string,
  opts: {
    excludes?: readonly string[]
    unreadable?: string[]
    fsImpl?: WalkFs
    store?: string
    /** default "none": nothing is read but names, sizes and dates. */
    checksums?: Checksums
    hashFile?: (abs: string) => string
  } = {},
): Generator<Entry> {
  const ex = normalizeExcludes(opts.excludes ?? [])
  const unreadable = opts.unreadable ?? []
  const F = opts.fsImpl ?? realFs
  const store = opts.store ?? STORE()
  const mode = opts.checksums ?? "none"
  const hashFile = opts.hashFile ?? sha256File
  // A file that cannot be read is "not checksummed", never a failed scan.
  const tryHash = (f: () => string) => {
    try {
      return f()
    } catch {
      return ""
    }
  }
  const stack = [""]
  while (stack.length) {
    const relDir = stack.pop()!
    let items: fs.Dirent[]
    try {
      items = F.readdir(path.join(root, relDir))
    } catch (e: any) {
      unreadable.push(`${relDir || "/"} (${e?.code ?? e?.name ?? "Error"})`)
      continue
    }
    for (const e of items) {
      const name = e.name
      if (name.startsWith("._") || SKIP_DIRS.has(name) || name === ".DS_Store" || SKIP_PREFIXES.some((p) => name.startsWith(p))) continue
      const rel = relDir ? `${relDir}/${name}` : name
      const rl = rel.toLowerCase()
      if (path.join(root, rel).startsWith(store)) continue // never catalog our own manifests
      if (ex.some((x) => rl === x || rl.startsWith(x + "/"))) continue
      try {
        if (e.isSymbolicLink()) continue
        if (e.isDirectory()) {
          const lower = name.toLowerCase()
          if (APP_BUNDLES.some((b) => lower.endsWith(b))) {
            // Listed, not opened — same row drive_scan.py writes (0 bytes, kind "other").
            yield { rel, bytes: 0, mtime: F.lstat(path.join(root, rel)).mtimeMs / 1000, kind: "other" }
          } else if (BUNDLES.some((b) => lower.endsWith(b))) {
            const { total, newest } = bundleSize(path.join(root, rel), F)
            const sha256 = shouldHash("project", total, mode) ? tryHash(() => bundleHash(path.join(root, rel), hashFile, F)) : ""
            yield { rel, bytes: total, mtime: newest, kind: "project", sha256 }
          } else {
            stack.push(rel)
          }
        } else if (e.isFile()) {
          const s = F.lstat(path.join(root, rel))
          const kind = kindOf(rel)
          const sha256 = shouldHash(kind, s.size, mode) ? tryHash(() => hashFile(path.join(root, rel))) : ""
          yield { rel, bytes: s.size, mtime: s.mtimeMs / 1000, kind, sha256 }
        }
      } catch {
        continue
      }
    }
  }
}

/** os.walk over a bundle: every regular file's lstat size, newest mtime. Errors are skipped, as in Python. */
function bundleSize(dir: string, F: WalkFs): { total: number; newest: number } {
  let total = 0
  let newest = 0
  const stack = [dir]
  while (stack.length) {
    const d = stack.pop()!
    let items: fs.Dirent[]
    try {
      items = F.readdir(d)
    } catch {
      continue
    }
    for (const e of items) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) {
        stack.push(p)
        continue
      }
      // os.walk lists a symlink to a folder under dirnames (not counted, not followed).
      if (e.isSymbolicLink()) {
        try {
          if (fs.statSync(p).isDirectory()) continue
        } catch {
          /* dangling link: os.walk lists it as a file and lstat counts it */
        }
      }
      try {
        const s = F.lstat(p)
        total += s.size
        newest = Math.max(newest, s.mtimeMs / 1000)
      } catch {
        /* skipped, as os.walk + lstat OSError is in Python */
      }
    }
  }
  return { total, newest }
}

export function folderOf(rel: string, depth: number): string {
  const parts = rel.split("/")
  return parts.slice(0, Math.min(depth, parts.length - 1)).join("/") || "(top level)"
}

/** Python's datetime.fromtimestamp(t).date().isoformat() — LOCAL date. */
export function isoDate(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000)
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function round(x: number, digits: number): number {
  const f = 10 ** digits
  return Math.round(x * f) / f
}

// ── TSV (python csv, delimiter \t, lineterminator \n, QUOTE_MINIMAL) ─────────────

export const TSV_HEADER = ["path", "bytes", "modified", "kind"]
/**
 * The optional 5th column (#192914). Readers take 4 or 5 columns: parseTsv maps by header, so
 * a 4-column manifest simply has no sha256, and older readers ignore the extra column.
 */
export const TSV_HEADER_SHA = [...TSV_HEADER, "sha256"]

export function tsvField(v: string | number): string {
  const s = String(v)
  return /[\t"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
export function tsvRow(cells: Array<string | number>): string {
  return cells.map(tsvField).join("\t") + "\n"
}
export function manifestRow(e: Entry, withSha = false): string {
  const cells: Array<string | number> = [e.rel, e.bytes, e.mtime ? isoDate(e.mtime) : "", e.kind]
  if (withSha) cells.push(e.sha256 ?? "")
  return tsvRow(cells)
}

/** Parse what python's csv.writer wrote (and csv.DictReader reads): quoted fields may hold tabs, quotes, newlines. */
export function parseTsv(text: string): Array<Record<string, string>> {
  const rows: string[][] = []
  let row: string[] = []
  let field = ""
  let i = 0
  let quoted = false
  let atStart = true
  while (i < text.length) {
    const c = text[i]
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue }
        quoted = false; i++; continue
      }
      field += c; i++; continue
    }
    if (c === '"' && atStart) { quoted = true; atStart = false; i++; continue }
    if (c === "\t") { row.push(field); field = ""; atStart = true; i++; continue }
    if (c === "\n" || c === "\r") {
      row.push(field); rows.push(row); row = []; field = ""; atStart = true
      i += c === "\r" && text[i + 1] === "\n" ? 2 : 1
      continue
    }
    field += c; atStart = false; i++
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row) }
  const [header, ...body] = rows
  if (!header) return []
  return body.filter((r) => r.length > 1 || r[0] !== "").map((r) => Object.fromEntries(header.map((h, j) => [h, r[j] ?? ""])))
}

// ── seal / unseal (must open with drive_scan.py's unseal, and vice versa) ─────────

export const MANIFEST_MAGIC = "iris-drive-manifest-v1"
const AAD = new TextEncoder().encode(MANIFEST_MAGIC)

/** gzip + AES-256-GCM. blob = 12-byte nonce || ciphertext+tag. Key: 32 random bytes, returned as hex. */
export async function seal(raw: Uint8Array): Promise<{ blob: Uint8Array; keyHex: string }> {
  const keyBytes = crypto.getRandomValues(new Uint8Array(32))
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["encrypt"])
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: AAD, tagLength: 128 }, key, new Uint8Array(gzipSync(raw, { level: 6 }))),
  )
  const blob = new Uint8Array(12 + ct.length)
  blob.set(nonce, 0)
  blob.set(ct, 12)
  return { blob, keyHex: Buffer.from(keyBytes).toString("hex") }
}

export async function unseal(blob: Uint8Array, keyHex: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", new Uint8Array(Buffer.from(keyHex, "hex")), { name: "AES-GCM" }, false, ["decrypt"])
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: blob.slice(0, 12), additionalData: AAD, tagLength: 128 },
    key,
    blob.slice(12),
  )
  return new Uint8Array(gunzipSync(new Uint8Array(pt)))
}

/** The attachment's text: magic line + base64 (Atlas refuses octet-stream, so ciphertext travels as text). */
export function manifestFileText(blob: Uint8Array): string {
  return `${MANIFEST_MAGIC}\n${Buffer.from(blob).toString("base64")}\n`
}
export function parseManifestFile(text: string): Uint8Array {
  const nl = text.indexOf("\n")
  const head = nl < 0 ? text : text.slice(0, nl)
  if (head !== MANIFEST_MAGIC) throw new Error(`unknown manifest format: ${head.slice(0, 40)}`)
  return new Uint8Array(Buffer.from(text.slice(nl + 1).replace(/\s+/g, ""), "base64"))
}

export function manifestTitle(driveId: string): string {
  return "drive-manifest " + driveId.replace(/[^A-Za-z0-9._:-]/g, "_")
}
export function storeDirName(driveId: string): string {
  return driveId.replace(/[^A-Za-z0-9._-]/g, "_")
}

// ── macOS diskutil -plist ───────────────────────────────────────────────────────

/** Minimal XML plist reader: dict, array, string, integer, real, true, false, date, data. */
export function parsePlist(xml: string): any {
  const re = /<(\/?)(dict|array|key|string|integer|real|true|false|date|data)(\s*\/)?>([^<]*)/g
  type Frame = { kind: "dict"; obj: Record<string, any>; key: string | null } | { kind: "array"; arr: any[] }
  const stack: Frame[] = []
  let root: any = undefined
  const put = (v: any) => {
    const top = stack[stack.length - 1]
    if (!top) { root = v; return }
    if (top.kind === "array") top.arr.push(v)
    else if (top.key != null) { top.obj[top.key] = v; top.key = null }
  }
  const unescape = (s: string) =>
    s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&")
  xml = xml.replace(/<!--[\s\S]*?-->/g, "")
  let m: RegExpExecArray | null
  while ((m = re.exec(xml))) {
    const [, close, tag, selfClose, text] = m
    if (tag === "dict" || tag === "array") {
      if (selfClose) { put(tag === "dict" ? {} : []); continue }
      if (!close) { stack.push(tag === "dict" ? { kind: "dict", obj: {}, key: null } : { kind: "array", arr: [] }); continue }
      const f = stack.pop()!
      put(f.kind === "dict" ? f.obj : f.arr)
      continue
    }
    if (close) continue
    if (tag === "true" || tag === "false") { put(tag === "true"); continue }
    if (tag === "key") {
      const top = stack[stack.length - 1]
      if (top?.kind === "dict") top.key = unescape(text)
      continue
    }
    if (selfClose) { put(tag === "string" ? "" : null); continue }
    if (tag === "integer") put(Number.parseInt(text.trim(), 10))
    else if (tag === "real") put(Number.parseFloat(text.trim()))
    else put(unescape(text))
  }
  return root
}

export type DiskFacts = {
  uuid: string | null
  filesystem: string
  label: string | null
  encrypted: boolean
  mountPoint: string | null
  device: string | null
}

/** What `diskutil info -plist <mount>` tells us about a volume. */
export function diskFactsFromPlist(p: any): DiskFacts {
  const uuid = p?.VolumeUUID || p?.DiskUUID || null
  return {
    // Linux's lsblk prints filesystem UUIDs lowercase and the existing Atlas ids are lowercase
    // (fs:abcd1234-…), while diskutil prints them uppercase. Same volume, same id.
    uuid: uuid ? String(uuid).toLowerCase() : null,
    filesystem: String(p?.FilesystemType || p?.FilesystemName || "?"),
    label: p?.VolumeName ? String(p.VolumeName) : null,
    // APFS: Encrypted (and FileVault on the boot volume). CoreStorage/HFS+: FileVault.
    encrypted: p?.Encrypted === true || p?.FileVault === true,
    mountPoint: p?.MountPoint ? String(p.MountPoint) : null,
    device: p?.DeviceNode ? String(p.DeviceNode) : null,
  }
}

export function driveIdFromDisk(f: DiskFacts): string {
  return "fs:" + (f.uuid || (f.device ?? "unknown").replace(/\//g, "_"))
}

// ── rows (shapes match drive_scan.py cmd_scan exactly) ───────────────────────────

type FolderAcc = { files: number; bytes: number; newest: number; kinds: Map<string, number>; sensitive: number }

/** Counter.most_common: by count desc, ties in first-seen order. */
export function mostCommon(m: Map<string, number>, n?: number): Array<[string, number]> {
  const all = [...m.entries()].sort((a, b) => b[1] - a[1])
  return n == null ? all : all.slice(0, n)
}

export class Rollup {
  folders = new Map<string, FolderAcc>()
  findings: Array<{ path: string; kind: string; size_kb: number }> = []
  files = 0
  total = 0
  constructor(public depth = 2) {}
  add(e: Entry) {
    this.files += 1
    this.total += e.bytes
    const name = folderOf(e.rel, this.depth)
    let f = this.folders.get(name)
    if (!f) { f = { files: 0, bytes: 0, newest: 0, kinds: new Map(), sensitive: 0 }; this.folders.set(name, f) }
    f.files += 1
    f.bytes += e.bytes
    f.newest = Math.max(f.newest, e.mtime)
    f.kinds.set(e.kind, (f.kinds.get(e.kind) ?? 0) + 1)
    if (SENSITIVE.has(e.kind)) {
      f.sensitive += 1
      this.findings.push({ path: e.rel, kind: e.kind, size_kb: round(e.bytes / 1024, 1) })
    }
  }
  kinds(): Map<string, number> {
    const k = new Map<string, number>()
    for (const f of this.folders.values()) for (const [kind, c] of f.kinds) k.set(kind, (k.get(kind) ?? 0) + c)
    return k
  }
  folderRows(driveId: string, label: string) {
    return [...this.folders.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([name, f]) => ({
        external_id: `${driveId}:${name}`, drive_id: driveId, drive_label: label, folder: name,
        main_kind: mostCommon(f.kinds, 1)[0][0], files: f.files, size_gb: round(f.bytes / 1e9, 2),
        kinds: mostCommon(f.kinds, 4).map(([k, c]) => `${k} ${c}`).join(", "),
        newest: f.newest ? isoDate(f.newest) : null,
        sensitive_files: f.sensitive,
      }))
  }
  /** encrypted null = could not tell (#193360): status left empty, never "exposed" on a guess */
  findingRows(driveId: string, label: string, encrypted: boolean | null, today: string) {
    const status = encrypted === true ? "contained" : encrypted === false ? "exposed" : null
    return this.findings.map((x) => ({
      external_id: `${driveId}:${x.path}`, drive_id: driveId, drive_label: label,
      path: x.path, kind: x.kind, size_kb: x.size_kb, drive_encrypted: encrypted,
      status, found: today,
    }))
  }
}

/** Stale findings as import rows: the stored row, status moved. Same rows drive_scan.py sends (moved_rows). */
export function movedRows(gone: ReadonlyArray<{ external_id: string; data?: Record<string, any> }>): Array<Record<string, any>> {
  return gone.map((r) => ({ ...(r.data ?? {}), external_id: String(r.external_id), status: "moved" }))
}

export function todayIso(): string {
  return isoDate(Date.now() / 1000)
}

/** `<drive-id>:<rel>` → [driveId, rel]. Known ids win (a dir: id contains colons); else drive_scan.py's rpartition rule. */
export function splitRef(ref: string, knownIds: readonly string[] = []): [string, string] {
  const hit = [...knownIds].sort((a, b) => b.length - a.length).find((id) => ref === id || ref.startsWith(id + ":"))
  if (hit) return [hit, ref.slice(hit.length + 1)]
  if ((ref.match(/:/g) ?? []).length >= 2) {
    const i = ref.lastIndexOf(":")
    return [ref.slice(0, i), ref.slice(i + 1)]
  }
  return [ref, ""]
}

// ── the board and its datasets (#192974) ─────────────────────────────────────────

/**
 * The board a client's drives live on, found by name so nobody types an id. "IRIS Drives" is
 * accepted for accounts that set up before the name settled.
 */
export const DRIVES_BOARD_NAMES = ["Drives", "IRIS Drives"]
export const DRIVES_BOARD_DESCRIPTION =
  "Catalog of my drives: one card per drive, rows for project folders and sensitive files, an encrypted file list per drive."

/**
 * The four datasets, field for field as the iris-drives playbook's `setup` step creates them
 * (copied verbatim from its heredocs). Change one, change both — the two must build the same board.
 */
export const DRIVES_DATASETS: Array<{ slug: string; name: string; fields: any[] }> = [
  { slug: "drives", name: "Drives", fields: JSON.parse(String.raw`[{"key":"external_id","type":"text","label":"Drive ID"},{"key":"label","type":"text","label":"Name"},{"key":"kind","type":"enum","label":"Kind","options":[{"label":"backup-drive","value":"backup-drive"},{"label":"media-drive","value":"media-drive"},{"label":"archive-folder","value":"archive-folder"},{"label":"other","value":"other"}]},{"key":"node","type":"text","label":"Machine"},{"key":"filesystem","type":"text","label":"Filesystem"},{"key":"encrypted","type":"boolean","label":"Encrypted"},{"key":"size_gb","type":"number","label":"Size (GB)"},{"key":"used_gb","type":"number","label":"Used (GB)"},{"key":"files","type":"number","label":"Files"},{"key":"folders","type":"number","label":"Project folders"},{"key":"sensitive_files","type":"number","label":"Sensitive files"},{"key":"unreadable_folders","type":"number","label":"Unreadable folders"},{"key":"last_scanned","type":"date","label":"Last scanned"},{"key":"manifest","type":"text","label":"Manifest on machine"},{"key":"manifest_key","type":"text","label":"Manifest key","visibility":"private"},{"key":"private_excluded","type":"text","label":"Private folders (never opened)"},{"key":"free_gb","type":"number","label":"Free (GB)"},{"key":"last_seen_on","type":"text","label":"Last seen on"},{"key":"last_seen_at","type":"datetime","label":"Last seen at"},{"key":"scan_count","type":"number","label":"Scans (all time)"},{"key":"scan_month","type":"text","label":"Scan month"},{"key":"scans_in_month","type":"number","label":"Scans that month"},{"key":"last_scan_ms","type":"number","label":"Last scan took (ms)"},{"key":"files_cataloged","type":"number","label":"Files cataloged"},{"key":"bytes_cataloged","type":"number","label":"Bytes cataloged"},{"key":"manifest_bytes","type":"number","label":"Encrypted file list (bytes)"},{"key":"scanned_by_version","type":"text","label":"Scanned by"}]`) },
  { slug: "drive-folders", name: "Drive folders", fields: JSON.parse(String.raw`[{"key":"external_id","type":"text","label":"Folder ID"},{"key":"drive_id","type":"text","label":"Drive ID"},{"key":"drive_label","type":"text","label":"Drive"},{"key":"folder","type":"text","label":"Folder"},{"key":"main_kind","type":"enum","label":"Mostly","options":[{"label":"video","value":"video"},{"label":"audio","value":"audio"},{"label":"image","value":"image"},{"label":"project","value":"project"},{"label":"code","value":"code"},{"label":"db-dump","value":"db-dump"},{"label":"credential","value":"credential"},{"label":"document","value":"document"},{"label":"archive","value":"archive"},{"label":"other","value":"other"}]},{"key":"files","type":"number","label":"Files"},{"key":"size_gb","type":"number","label":"Size (GB)"},{"key":"kinds","type":"text","label":"Kinds"},{"key":"newest","type":"date","label":"Newest file"},{"key":"sensitive_files","type":"number","label":"Sensitive files"}]`) },
  { slug: "drive-findings", name: "Drive findings", fields: JSON.parse(String.raw`[{"key":"external_id","type":"text","label":"Finding ID"},{"key":"drive_id","type":"text","label":"Drive ID"},{"key":"drive_label","type":"text","label":"Drive"},{"key":"path","type":"text","label":"Path"},{"key":"kind","type":"enum","label":"Kind","options":[{"label":"db-dump","value":"db-dump"},{"label":"credential","value":"credential"}]},{"key":"size_kb","type":"number","label":"Size (KB)"},{"key":"drive_encrypted","type":"boolean","label":"Drive encrypted"},{"key":"status","type":"enum","label":"Status","options":[{"label":"exposed","value":"exposed"},{"label":"contained","value":"contained"},{"label":"moved","value":"moved"}]},{"key":"found","type":"date","label":"Found"}]`) },
  // One row per `iris drives get`: who read which file, from which machine, why, and what it hashed to.
  { slug: "drive-reads", name: "Drive reads", fields: JSON.parse(String.raw`[{"key":"external_id","type":"text","label":"Read ID"},{"key":"drive_id","type":"text","label":"Drive ID"},{"key":"drive_label","type":"text","label":"Drive"},{"key":"path","type":"text","label":"Path"},{"key":"bytes","type":"number","label":"Bytes"},{"key":"sha256","type":"text","label":"SHA-256"},{"key":"read_by","type":"text","label":"Read by"},{"key":"read_on","type":"text","label":"Read on (machine)"},{"key":"purpose","type":"text","label":"Why"},{"key":"at","type":"datetime","label":"At"}]`) },
]

// ── copies (#192914) ─────────────────────────────────────────────────────────────

export type ManifestRow = { drive: string; path: string; bytes: number; sha256: string }

/** sha256 → every row with that content, across all drives. Rows with no hash are left out. */
export function copyIndex(all: readonly ManifestRow[]): Map<string, ManifestRow[]> {
  const idx = new Map<string, ManifestRow[]>()
  for (const r of all) {
    if (!r.sha256) continue
    const list = idx.get(r.sha256)
    if (list) list.push(r)
    else idx.set(r.sha256, [r])
  }
  return idx
}

export type CopiesReport = {
  /** one entry per file name; >1 version = same name, different content */
  known: Array<{ name: string; versions: Array<{ sha256: string; copies: ManifestRow[] }> }>
  /** matches with no checksum yet */
  unknown: ManifestRow[]
}

const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1)
const rowOrder = (a: ManifestRow, b: ManifestRow) => byCodePoint(a.drive, b.drive) || byCodePoint(a.path, b.path)

/**
 * The files whose path holds every word, grouped by content across ALL drives' manifests.
 * A version's copies include renamed copies (same content, other name) on any drive.
 */
export function copiesReport(all: readonly ManifestRow[], words: readonly string[]): CopiesReport {
  const w = words.map((x) => x.toLowerCase())
  const idx = copyIndex(all)
  const names = new Map<string, { name: string; shas: Set<string> }>()
  const seen = new Set<string>()
  const unknown: ManifestRow[] = []
  for (const r of all) {
    const p = r.path.toLowerCase()
    if (!w.every((x) => p.includes(x))) continue
    if (!r.sha256) { unknown.push(r); continue }
    if (seen.has(r.sha256)) continue
    seen.add(r.sha256)
    const name = baseName(r.path)
    const key = name.toLowerCase()
    const n = names.get(key) ?? { name, shas: new Set<string>() }
    n.shas.add(r.sha256)
    names.set(key, n)
  }
  const known = [...names.values()]
    .map(({ name, shas }) => ({
      name,
      versions: [...shas]
        .map((sha256) => ({ sha256, copies: [...(idx.get(sha256) ?? [])].sort(rowOrder) }))
        .sort((a, b) => b.copies.length - a.copies.length || byCodePoint(a.sha256, b.sha256)),
    }))
    .sort((a, b) => byCodePoint(a.name.toLowerCase(), b.name.toLowerCase()))
  return { known, unknown: unknown.sort(rowOrder) }
}

/** "3 identical copies on: A, B" · "only 1 copy, on: A" · "same name, different content: 2 versions" */
export function copiesLine(versions: CopiesReport["known"][number]["versions"]): string {
  if (versions.length > 1) return `same name, different content: ${versions.length} versions`
  const copies = versions[0]?.copies ?? []
  const drives = [...new Set(copies.map((c) => c.drive))].sort(byCodePoint).join(", ")
  return copies.length === 1 ? `only 1 copy, on: ${drives}` : `${copies.length} identical copies on: ${drives}`
}

// ── live drive fields (#192914) ───────────────────────────────────────────────────

/** "2026-11-09T18:04:05Z" — UTC, whole seconds; drive_scan.py writes the same shape. */
export function utcIso(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z")
}

/** What a scan says about the drive right now: free space, and which machine saw it when. */
export function liveDriveFields(st: { bavail: number; bsize: number }, host: string, now: Date) {
  return { free_gb: round((st.bavail * st.bsize) / 1e9, 1), last_seen_on: host, last_seen_at: utcIso(now) }
}

// ── the meter (#193356) ───────────────────────────────────────────────────────────
//
// What a client could be billed on lives on the drive's OWN record in Atlas, written by every
// scan. It does not depend on analytics consent (that can be switched off), and it is the
// client's data: they can see it on their Drives board and with `iris drives usage`.
//
// Import MERGES into an existing record, so a scanner that does not know these fields leaves
// them untouched rather than blanking them — drive_scan.py writes the same fields, the same way.

export const METER_FIELDS = [
  { key: "scan_count", type: "number", label: "Scans (all time)" },
  { key: "scan_month", type: "text", label: "Scan month" },
  { key: "scans_in_month", type: "number", label: "Scans that month" },
  { key: "last_scan_ms", type: "number", label: "Last scan took (ms)" },
  { key: "files_cataloged", type: "number", label: "Files cataloged" },
  { key: "bytes_cataloged", type: "number", label: "Bytes cataloged" },
  { key: "manifest_bytes", type: "number", label: "Encrypted file list (bytes)" },
  { key: "scanned_by_version", type: "text", label: "Scanned by" },
] as const

/** "2026-11" — UTC, so two machines in different zones agree which month a scan belongs to. */
export function meterMonth(d: Date): string {
  return d.toISOString().slice(0, 7)
}

const count = (v: unknown): number | null => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.floor(n) : null
}

/**
 * The meter fields one scan writes onto its drive record. `prev` is the record as Atlas holds it
 * (or undefined for a new drive). A drive scanned before the meter existed has a last_scanned date
 * but no scan_count: that earlier scan counts as one, so the total is never under the truth by more
 * than the scans before metering began.
 *
 * `manifestBytes` null = the upload failed and the drive keeps its previous list, so the previous
 * manifest_bytes is left as it is (merge keeps it).
 */
export function meterFields(
  prev: Record<string, any> | undefined,
  s: { files: number; bytes: number; manifestBytes: number | null; durationMs: number; version: string; now: Date },
): Record<string, number | string> {
  const month = meterMonth(s.now)
  const scannedBefore = !!prev?.last_scanned
  const total = count(prev?.scan_count) ?? (scannedBefore ? 1 : 0)
  const sameMonth = prev?.scan_month ? prev.scan_month === month : String(prev?.last_scanned ?? "").startsWith(month)
  const inMonth = sameMonth ? (count(prev?.scans_in_month) ?? (scannedBefore ? 1 : 0)) : 0
  return {
    scan_count: total + 1,
    scan_month: month,
    scans_in_month: inMonth + 1,
    last_scan_ms: Math.max(0, Math.round(s.durationMs)),
    files_cataloged: s.files,
    bytes_cataloged: s.bytes,
    ...(s.manifestBytes != null ? { manifest_bytes: s.manifestBytes } : {}),
    scanned_by_version: s.version,
  }
}

// ── usage: what this account would be metered on (#193356) ───────────────────────────

export type UsageReport = {
  month: string
  drives: number
  files: number
  bytes: number
  /** drives whose byte count is the disk's used space, not counted file by file (scanned before metering) */
  bytes_estimated_drives: number
  manifest_bytes: number
  scans_this_month: number
  scans_total: number
  gets_this_month: number | null
  get_bytes_this_month: number | null
  sensitive_contained: number
  sensitive_exposed: number
}

/**
 * Everything read from Atlas: drive records (the meter), drive-reads rows (one per `get`),
 * drive-findings rows, and the board's attachments (each drive's encrypted list, for drives
 * scanned before manifest_bytes existed). `reads` null = the reads could not be loaded.
 */
export function usageReport(i: {
  drives: any[]
  reads: any[] | null
  findings: any[]
  attachments: Array<{ id: number; size: number | null }>
  now: Date
}): UsageReport {
  const month = meterMonth(i.now)
  const sizeById = new Map(i.attachments.map((f) => [String(f.id), f.size]))
  let files = 0, bytes = 0, estimated = 0, manifest = 0, scansMonth = 0, scansTotal = 0
  for (const d of i.drives) {
    files += count(d.files_cataloged) ?? count(d.files) ?? 0
    const b = count(d.bytes_cataloged)
    if (b != null) bytes += b
    else {
      const gb = Number(d.used_gb)
      if (Number.isFinite(gb) && gb > 0) { bytes += Math.round(gb * 1e9); estimated++ }
    }
    const m = String(d.manifest ?? "")
    const att = m.startsWith("atlas-file:") ? sizeById.get(m.slice("atlas-file:".length)) : null
    manifest += count(att) ?? count(d.manifest_bytes) ?? 0
    const scanned = !!d.last_scanned
    scansTotal += count(d.scan_count) ?? (scanned ? 1 : 0)
    if (d.scan_month) { if (d.scan_month === month) scansMonth += count(d.scans_in_month) ?? 1 }
    else if (String(d.last_scanned ?? "").startsWith(month)) scansMonth += 1
  }
  let gets: number | null = null, getBytes: number | null = null
  if (i.reads) {
    const mine = i.reads.filter((r) => String(r?.at ?? "").startsWith(month))
    gets = mine.length
    getBytes = mine.reduce((n, r) => n + (count(r?.bytes) ?? 0), 0)
  }
  const live = i.findings.filter((f) => f?.status !== "moved")
  return {
    month, drives: i.drives.length, files, bytes, bytes_estimated_drives: estimated, manifest_bytes: manifest,
    scans_this_month: scansMonth, scans_total: scansTotal, gets_this_month: gets, get_bytes_this_month: getBytes,
    sensitive_contained: live.filter((f) => f?.status === "contained").length,
    sensitive_exposed: live.filter((f) => f?.status === "exposed").length,
  }
}
