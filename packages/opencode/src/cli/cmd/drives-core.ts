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

export const STORE = () => path.join(os.homedir(), ".iris", "drives")

export const SKIP_DIRS = new Set([
  ".Spotlight-V100", ".fseventsd", ".Trashes", ".TemporaryItems", "lost+found",
  "System Volume Information", "$RECYCLE.BIN", ".DocumentRevisions-V100", ".git", "node_modules",
])
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
export const CLASSFILE = new Set(["Config.php", "Database.php"])

export function kindOf(rel: string): string {
  for (const [k, rx] of KINDS) {
    if (rx.test(rel)) {
      if (k === "credential" && (LIBRARY.test(rel) || CLASSFILE.has(path.posix.basename(rel)))) return "code"
      return k
    }
  }
  return "other"
}

// ── walk ──────────────────────────────────────────────────────────────────────

export type Entry = { rel: string; bytes: number; mtime: number; kind: string }

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
  opts: { excludes?: readonly string[]; unreadable?: string[]; fsImpl?: WalkFs; store?: string } = {},
): Generator<Entry> {
  const ex = normalizeExcludes(opts.excludes ?? [])
  const unreadable = opts.unreadable ?? []
  const F = opts.fsImpl ?? realFs
  const store = opts.store ?? STORE()
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
      if (name.startsWith("._") || SKIP_DIRS.has(name) || name === ".DS_Store") continue
      const rel = relDir ? `${relDir}/${name}` : name
      const rl = rel.toLowerCase()
      if (path.join(root, rel).startsWith(store)) continue // never catalog our own manifests
      if (ex.some((x) => rl === x || rl.startsWith(x + "/"))) continue
      try {
        if (e.isSymbolicLink()) continue
        if (e.isDirectory()) {
          const lower = name.toLowerCase()
          if (BUNDLES.some((b) => lower.endsWith(b))) {
            const { total, newest } = bundleSize(path.join(root, rel), F)
            yield { rel, bytes: total, mtime: newest, kind: "project" }
          } else {
            stack.push(rel)
          }
        } else if (e.isFile()) {
          const s = F.lstat(path.join(root, rel))
          yield { rel, bytes: s.size, mtime: s.mtimeMs / 1000, kind: kindOf(rel) }
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

export function tsvField(v: string | number): string {
  const s = String(v)
  return /[\t"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
export function tsvRow(cells: Array<string | number>): string {
  return cells.map(tsvField).join("\t") + "\n"
}
export function manifestRow(e: Entry): string {
  return tsvRow([e.rel, e.bytes, e.mtime ? isoDate(e.mtime) : "", e.kind])
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
    // (fs:e6a91d1f-…), while diskutil prints them uppercase. Same volume, same id.
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
  findingRows(driveId: string, label: string, encrypted: boolean, today: string) {
    const status = encrypted ? "contained" : "exposed"
    return this.findings.map((x) => ({
      external_id: `${driveId}:${x.path}`, drive_id: driveId, drive_label: label,
      path: x.path, kind: x.kind, size_kb: x.size_kb, drive_encrypted: encrypted,
      status, found: today,
    }))
  }
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
