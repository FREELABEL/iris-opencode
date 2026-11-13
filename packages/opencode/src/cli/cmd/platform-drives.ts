/**
 * `iris drives` — catalog a drive from your own machine, no server (#192927, epic #192914).
 *
 *   iris drives scan <mount-or-folder> [--label NAME] [--kind …] [--exclude FOLDER]… [--depth 2] [--bloq N] [--dry-run]
 *   iris drives find <words…>        search every cataloged drive's manifest, plugged in or not
 *   iris drives path <drive-id>:<rel> where that file is on THIS machine right now
 *   iris drives list                 every cataloged drive
 *   iris drives copies <words…>      how many identical copies of a file exist, across every drive
 *   iris drives get <drive>:<rel> --to DIR --why TEXT [--confirm]
 *                                    copy ONE file (or one bundle as .zip) off a connected drive, on the record
 *   iris drives usage [--json]       what this account would be metered on, read from Atlas
 *
 * TypeScript port of scripts/drives/drive_scan.py (freelabel repo). The two are
 * interchangeable on purpose — same Atlas datasets (`drives`, `drive-folders`,
 * `drive-findings` on the owner's Drives bloq), same drive ids, same encrypted manifest.
 * See drives-core.ts for the contract.
 *
 * EVERYTHING the catalog knows lives in Atlas. ~/.iris/drives is only a cache of what Atlas
 * holds (the CIPHERTEXT of each manifest); delete it and `find` re-downloads.
 */

import fs from "fs"
import os from "os"
import path from "path"
import { spawnSync } from "child_process"
import { createHash } from "crypto"
import { cmd } from "./cmd"
import { irisFetch, requireAuth, requireUserId, resolveToken, warn } from "./iris-api"
import { listBloqFiles, uploadFileVerified } from "./platform-atlas-files"
import {
  STORE, walk, Rollup, manifestRow, TSV_HEADER, tsvRow, seal, unseal, manifestFileText, parseManifestFile,
  manifestTitle, storeDirName, parsePlist, diskFactsFromPlist, driveIdFromDisk, parseTsv, mostCommon,
  round, todayIso, splitRef, DRIVES_BOARD_NAMES, DRIVES_BOARD_DESCRIPTION, DRIVES_DATASETS,
  TSV_HEADER_SHA, CHECKSUM_CHOICES, type Checksums, liveDriveFields, copyIndex, copiesReport, copiesLine,
  type ManifestRow, normalizeExcludes, kindOf, SENSITIVE, BUNDLES, APP_BUNDLES, sha256File, bundleMembers,
  bundleHashFromLines, utcIso, meterFields, usageReport, type UsageReport, movedRows,
} from "./drives-core"
import { runRemoteGet, liveRemoteDeps, SERVE_MARK, type ServeReply } from "./drives-remote"
import {
  driveLetterOf, isDriveRoot, normalizeScanArg, windowsDisk, windowsMountOf, findDriveRecord, encryptionState,
  encryptionWord, unreadableHint, serialKey, lsblkMountsFor,
} from "./drives-windows"
import { nameMatches } from "./hive-tailscale"
import { fetchNodes } from "./platform-hive-nodes"
import { metered, exitDrives, type DrivesRun } from "./drives-telemetry"
import { Installation } from "../../installation"
import { type VaultCatalog, driveAlertRows, statfsOf } from "./vault-replicas"
import { runKeep, vaultCopiesBySha, type KeepDeps } from "./drives-keep"
import { keepVault, putToTargets } from "./platform-vault"
import { keptAlerts, missingDays, type ReplicaRow } from "./vault-drives"

const KIND_CHOICES = ["backup-drive", "media-drive", "archive-folder", "other"] as const
const IMPORT_CHUNK = 500

function sh(...cmdline: string[]): string {
  try {
    const r = spawnSync(cmdline[0], cmdline.slice(1), { encoding: "utf8", timeout: 30_000 })
    return (r.stdout ?? "").trim()
  } catch {
    return ""
  }
}

/** --bloq / IRIS_DRIVES_BLOQ: an override for people who keep the catalog on another board. */
function overrideBloq(flag: unknown): number | undefined {
  const v = flag ?? process.env.IRIS_DRIVES_BLOQ
  const n = Number(v)
  return v != null && v !== "" && Number.isFinite(n) && n > 0 ? n : undefined
}

// ── the user's Drives board, found by name (#192974) ─────────────────────────────
//
// A client never types an internal id. The board is the one they own named "Drives" (or
// "IRIS Drives", for accounts that set up early). The first `scan` creates it and its three
// datasets exactly as the iris-drives playbook's setup step does. It is one API call to find,
// so it is resolved on every run rather than cached somewhere that could go stale.

export const NO_DRIVES_YET = "No drives cataloged yet — run: iris drives scan <drive or folder>"

export type BoardApi = {
  list: () => Promise<Array<{ id: number; name: string; is_owner?: boolean }>>
  createBoard: (name: string, description: string) => Promise<number>
  /** "exists" = the dataset is already on this board ("already exists for this bloq"): success. */
  createDataset: (slug: string, name: string, fields: any[], bloq: number) => Promise<"created" | "exists">
}

function liveBoardApi(userId: number): BoardApi {
  const failure = async (res: Response) => {
    const t = (await res.text()).trim()
    let msg = t
    try {
      const j = JSON.parse(t)
      msg = j?.message ?? j?.error ?? t
    } catch {}
    return `HTTP ${res.status} ${String(msg).slice(0, 200)}`
  }
  return {
    list: async () => {
      const res = await irisFetch(`/api/v1/user/${userId}/bloqs?simplified=1&per_page=500`)
      if (!res.ok) throw new Error(await failure(res))
      const body = (await res.json()) as any
      return Array.isArray(body?.data) ? body.data : Array.isArray(body?.data?.data) ? body.data.data : []
    },
    createBoard: async (name, description) => {
      const res = await irisFetch(`/api/v1/user/${userId}/bloqs`, { method: "POST", body: JSON.stringify({ name, description }) })
      if (!res.ok) throw new Error(await failure(res))
      const body = (await res.json()) as any
      const id = Number((body?.data?.bloq ?? body?.data ?? body)?.id)
      if (!(id > 0)) throw new Error("the new board came back without an id")
      return id
    },
    createDataset: async (slug, name, fields, bloq) => {
      const res = await irisFetch("/api/v1/atlas/schemas", {
        method: "POST",
        body: JSON.stringify({ name, slug, bloq_id: bloq, fields: { fields } }),
      })
      if (res.ok) return "created"
      const why = await failure(res)
      if (/already exists/i.test(why)) return "exists"
      throw new Error(why)
    },
  }
}

export function pickDrivesBoard(boards: Array<{ id: number; name: string; is_owner?: boolean }>): number | null {
  for (const want of DRIVES_BOARD_NAMES) {
    const mine = boards
      .filter((b) => b?.is_owner === true && String(b.name ?? "").trim().toLowerCase() === want.toLowerCase())
      .map((b) => Number(b.id))
      .sort((a, b) => a - b)
    if (mine.length) return mine[0]
  }
  return null
}

/**
 * The board this account's drives live on. `create` (scan only): make the board if there is none,
 * and make sure its three datasets exist — "already exists" counts as done.
 */
export const VAULT_DATASETS = new Set(["drive-vaults", "drive-kept"])

export async function resolveDrivesBoard(
  api: BoardApi,
  opts: { override?: number; create: boolean },
): Promise<{ id: number; created: boolean } | null> {
  if (opts.override) return { id: opts.override, created: false }
  let id = pickDrivesBoard(await api.list())
  let created = false
  if (id == null) {
    if (!opts.create) return null
    id = await api.createBoard(DRIVES_BOARD_NAMES[0], DRIVES_BOARD_DESCRIPTION)
    created = true
  }
  // The vault datasets (#193363) are made the first time a vault records a copy, not by a scan.
  if (opts.create) for (const d of DRIVES_DATASETS) if (!VAULT_DATASETS.has(d.slug)) await api.createDataset(d.slug, d.name, d.fields, id)
  return { id, created }
}

/** resolveDrivesBoard, or a plain sentence and a non-zero exit. */
export async function requireDrivesBoard(api: BoardApi, override: number | undefined, opts: { create: boolean }): Promise<number> {
  let board: { id: number; created: boolean } | null
  try {
    board = await resolveDrivesBoard(api, { override, create: opts.create })
  } catch (e: any) {
    console.error(
      opts.create
        ? `  Could not set up your Drives catalog in Atlas (${e?.message ?? e}). Check your connection and run the scan again.`
        : `  Could not reach your IRIS account to find your drives (${e?.message ?? e}). Check your connection and try again.`,
    )
    return exitDrives(1)
  }
  if (!board) {
    console.error(`  ${NO_DRIVES_YET}`)
    return exitDrives(1)
  }
  if (board.created) console.log("  Set up your Drives catalog in Atlas — every drive you scan is listed there.")
  return board.id
}

async function signedIn(): Promise<number> {
  if (!(await requireAuth())) await exitDrives(1)
  const userId = await requireUserId()
  if (!userId) return exitDrives(1)
  return userId
}

// ── identity ─────────────────────────────────────────────────────────────────

export type Facts = {
  node: string
  filesystem: string
  /** null = could not tell (Windows without a BitLocker answer); never reported as "not encrypted" */
  encrypted: boolean | null
  label: string
  size_gb: number | null
  used_gb: number | null
}

function isMountPoint(p: string): boolean {
  if (process.platform === "win32") return isDriveRoot(p)
  if (process.platform === "linux") return sh("findmnt", "-no", "TARGET", "--target", p) === p
  if (p === "/") return true
  try {
    return fs.statSync(p).dev !== fs.statSync(path.dirname(p)).dev
  } catch {
    return false
  }
}

function diskutilPlist(target: string): any | null {
  const out = sh("diskutil", "info", "-plist", target)
  if (!out.includes("<plist")) return null
  try {
    return parsePlist(out)
  } catch {
    return null
  }
}

/** The mount point holding `p` on macOS (df's last column). */
function macMountOf(p: string): string | null {
  const lines = sh("df", "-P", p).split("\n")
  const last = lines[lines.length - 1] ?? ""
  const m = last.match(/\s(\/.*)$/)
  return m ? m[1] : null
}

/** (drive id, facts) — UUID (Windows: volume serial) for a real filesystem, dir:<host>:<path> for a plain folder. */
export function identify(p: string, label?: string): [string, Facts] {
  const host = os.hostname()
  const mount = isMountPoint(p)
  let driveId: string
  const facts: Facts = { node: host, filesystem: "?", encrypted: false, label: "", size_gb: null, used_gb: null }

  if (process.platform === "win32") {
    // #193360: id = the volume serial, so a new drive letter is still the same drive (drives-windows.ts).
    const letter = driveLetterOf(p)
    const d = letter ? windowsDisk(letter, sh) : null
    facts.filesystem = d?.filesystem ?? "?"
    facts.encrypted = d?.bitlocker ?? null // a folder inherits its volume's BitLocker state
    if (mount && d?.serial) {
      driveId = `fs:${d.serial}`
      facts.label = label || d.label || p
    } else {
      driveId = `dir:${host}:${p}`
      facts.label = label || path.basename(p) || p
    }
  } else if (process.platform === "darwin") {
    if (mount) {
      const d = diskFactsFromPlist(diskutilPlist(p) ?? {})
      driveId = driveIdFromDisk(d)
      facts.filesystem = d.filesystem
      facts.encrypted = d.encrypted
      facts.label = label || d.label || path.basename(p)
    } else {
      driveId = `dir:${host}:${p}`
      // A folder inherits its volume's encryption (FileVault on the Mac's own disk).
      const vol = macMountOf(p)
      const d = vol ? diskFactsFromPlist(diskutilPlist(vol) ?? {}) : null
      facts.filesystem = d?.filesystem ?? "?"
      facts.encrypted = d?.encrypted ?? false
      facts.label = label || path.basename(p)
    }
  } else {
    facts.filesystem = sh("findmnt", "-no", "FSTYPE", "--target", p) || "?"
    if (mount) {
      const src = sh("findmnt", "-no", "SOURCE", "--target", p)
      const uuid = sh("lsblk", "-no", "UUID", src).split("\n")[0] ?? ""
      facts.encrypted = (sh("lsblk", "-no", "TYPE", src).split("\n")[0] ?? "") === "crypt"
      driveId = "fs:" + (uuid || src.replace(/\//g, "_"))
      facts.label = label || sh("lsblk", "-no", "LABEL", src) || path.basename(p)
    } else {
      driveId = `dir:${host}:${p}`
      facts.encrypted = false // a folder on this machine's disk; the host disk is not LUKS here
      facts.label = label || path.basename(p)
    }
  }
  if (mount) {
    // df, not fs.statfsSync: Bun's statfs is wrong on macOS (#193363, see statfsOf).
    const st = statfsCompat(p)
    facts.size_gb = round((st.blocks * st.bsize) / 1e9, 1)
    facts.used_gb = round(((st.blocks - st.bfree) * st.bsize) / 1e9, 1)
  }
  // A folder's size/used is its own total, filled in after the walk.
  return [driveId, facts]
}

/** Where is this drive mounted on THIS machine right now? null = not connected here. */
export function resolveMount(driveId: string): string | null {
  if (driveId.startsWith("dir:")) {
    const rest = driveId.slice(4)
    const i = rest.indexOf(":")
    const host = rest.slice(0, i)
    const p = rest.slice(i + 1)
    return host === os.hostname() && fs.existsSync(p) && fs.statSync(p).isDirectory() ? p : null
  }
  if (driveId.startsWith("fs:")) {
    const uuid = driveId.slice(3)
    if (process.platform === "win32") return windowsMountOf(driveId, sh)
    if (process.platform === "darwin") {
      // diskutil prints UUIDs uppercase; Atlas holds them lowercase (see diskFactsFromPlist).
      const d = diskFactsFromPlist(diskutilPlist(uuid.toUpperCase()) ?? diskutilPlist(uuid) ?? {})
      return d.mountPoint || null
    }
    const dev = sh("blkid", "-U", uuid)
    let mp = sh("findmnt", "-no", "TARGET", "-S", `UUID=${uuid}`).split("\n").filter(Boolean)
    if (!mp.length && dev) mp = sh("findmnt", "-no", "TARGET", dev).split("\n").filter(Boolean)
    if (!mp.length && serialKey(driveId)) mp = lsblkMountsFor(driveId, sh("lsblk", "-rno", "UUID,MOUNTPOINT"))
    return mp[0] ?? null
  }
  return null
}

/** statfs numbers; where Bun's statfs is broken (macOS: bsize 0), df's, so a Mac drive does not read as full. */
export function statfsCompat(p: string, statfs: (p: string) => fs.StatsFs = (x) => fs.statfsSync(x), df = statfsOf): { bavail: number; bsize: number; blocks: number; bfree: number } {
  const st = statfs(p)
  if (Number(st.bsize) > 0) return { bavail: Number(st.bavail), bsize: Number(st.bsize), blocks: Number(st.blocks), bfree: Number(st.bfree) }
  const s = df(p)
  if (s) return { bavail: s.free, bsize: 1, blocks: s.size, bfree: s.free }
  return { bavail: 0, bsize: 0, blocks: 0, bfree: 0 }
}

const online = (d: any) => resolveMount(String(d.external_id)) != null

// ── Atlas ────────────────────────────────────────────────────────────────────

async function atlasRecords(schema: string, bloq: number, filters: Record<string, string> = {}): Promise<any[]> {
  const out: any[] = []
  for (let page = 1; ; page++) {
    const p = new URLSearchParams({ per_page: "200", page: String(page), bloq_id: String(bloq) })
    for (const [k, v] of Object.entries(filters)) p.set(`filter[${k}]`, v)
    const res = await irisFetch(`/api/v1/atlas/datasets/${schema}?${p}`)
    if (!res.ok) throw new Error(`reading ${schema} on bloq ${bloq}: HTTP ${res.status} ${(await res.text()).trim().slice(0, 160)}`)
    const body = (await res.json()) as any
    const recs = body?.data?.records
    const batch: any[] = Array.isArray(recs?.data) ? recs.data : Array.isArray(recs) ? recs : []
    out.push(...batch)
    const total = recs?.total ?? out.length
    if (batch.length === 0 || out.length >= total) return out
  }
}

export async function atlasDrives(bloq: number): Promise<any[]> {
  return (await atlasRecords("drives", bloq)).filter((r) => r?.status === "active").map((r) => r.data ?? {})
}

async function importRows(schema: string, bloq: number, rows: any[]) {
  let created = 0, updated = 0, failed = 0
  for (let i = 0; i < rows.length; i += IMPORT_CHUNK) {
    const slice = rows.slice(i, i + IMPORT_CHUNK).map((r) => ({ external_id: String(r.external_id), data: r }))
    const res = await irisFetch(`/api/v1/atlas/datasets/${schema}/import`, {
      method: "POST",
      body: JSON.stringify({ records: slice, validate: true, bloq_id: bloq }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).trim().slice(0, 300)}`)
    const d = ((await res.json()) as any)?.data ?? {}
    created += d.created ?? 0
    updated += d.updated ?? 0
    failed += d.failed_count ?? 0
  }
  return { created, updated, failed }
}

/** Encrypt the per-file list, attach it to the board, remove this drive's older manifests. */
export type UploadResult = { ok: boolean; id?: number; verified?: boolean; error?: string }
export type ManifestDeps = {
  upload: (path: string, title: string) => Promise<UploadResult>
  list: () => Promise<{ ok: true; files: Array<{ id: number; name: string; title?: string | null }> } | { ok: false; error: string }>
  remove: (id: number) => Promise<unknown>
}

function liveDeps(userId: number, bloq: number): ManifestDeps {
  return {
    // uploadFileVerified is ok ONLY when the stored bytes were read back and matched.
    upload: async (p, title) => {
      const r = await uploadFileVerified(userId, bloq, p, { title })
      return r.ok ? { ok: true, id: r.id, verified: true } : { ok: false, verified: false, error: r.error }
    },
    list: () => listBloqFiles(userId, bloq),
    remove: (id) => irisFetch(`/api/v1/cloud-files/${id}`, { method: "DELETE" }),
  }
}

/**
 * Encrypt the per-file list, attach it to the board, remove this drive's older manifests.
 *
 * Platform bug (2026-11-09): attachments are stored at cloud-files/<unix-second>_<filename> with
 * no owner or random part, so two uploads of one filename in the same second share ONE object —
 * the second reads back as the first, and deleting either deletes both. That destroyed a real drive's
 * manifest. So: a random filename per upload, and anything short of `verified === true` is a
 * failed upload — no record points at it and nothing older is removed.
 */
export async function uploadManifest(deps: ManifestDeps, driveId: string, tsvPath: string, today: string) {
  const { blob, keyHex } = await seal(new Uint8Array(fs.readFileSync(tsvPath)))
  const enc = path.join(path.dirname(tsvPath), `manifest-${Buffer.from(crypto.getRandomValues(new Uint8Array(8))).toString("hex")}.enc.txt`)
  fs.writeFileSync(enc, manifestFileText(blob))
  // What Atlas stores for this drive's list: the meter's manifest_bytes (#193356).
  const bytes = fs.statSync(enc).size
  const title = manifestTitle(driveId)
  let fid: number
  try {
    const up = await deps.upload(enc, `${title} ${today}`)
    if (up.ok !== true || up.verified !== true || !up.id) {
      console.log(`  manifest upload failed: ${up.error ?? `not verified (${JSON.stringify(up).slice(0, 160)})`}`)
      return { fid: null, key: null, bytes: null }
    }
    fid = up.id
  } finally {
    fs.rmSync(enc, { force: true })
  }
  const listed = await deps.list()
  if (listed.ok) {
    const old = listed.files.filter((f) => String(f.title ?? f.name ?? "").startsWith(title + " ") && f.id !== fid)
    for (const f of old) await deps.remove(f.id)
  }
  return { fid, key: keyHex as string, bytes: bytes as number | null }
}

/** Atlas is the truth; this machine caches only the CIPHERTEXT. Returns the decrypted TSV text, or null. */
async function cachedManifest(userId: number, bloq: number, drive: any): Promise<string | null> {
  const m = String(drive.manifest ?? "")
  const key = String(drive.manifest_key ?? "")
  if (!m.startsWith("atlas-file:") || !key) return null
  const fid = m.slice("atlas-file:".length)
  const cache = path.join(STORE(), "cache", fid)
  const hit = () => (fs.existsSync(cache) ? fs.readdirSync(cache).filter((f) => f.endsWith(".txt")) : [])
  if (!hit().length) {
    const listed = await listBloqFiles(userId, bloq)
    const f = listed.ok ? listed.files.find((x) => String(x.id) === fid) : undefined
    if (!f?.url) return null
    const dl = await fetch(f.url)
    if (!dl.ok) return null
    fs.mkdirSync(cache, { recursive: true })
    // Same name `iris bloqs files download` writes, so drive_scan.py shares this cache.
    fs.writeFileSync(path.join(cache, `${f.id}-${f.name}`), Buffer.from(await dl.arrayBuffer()))
  }
  const files = hit()
  if (!files.length) return null
  const blob = parseManifestFile(fs.readFileSync(path.join(cache, files[0]), "utf8"))
  return new TextDecoder().decode(await unseal(blob, key))
}

// ── commands ─────────────────────────────────────────────────────────────────

/** "3.0 TB" / "512.4 GB" — decimal units, as the drive's own box says. */
export function formatSize(bytes: number): string {
  if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(1)} TB`
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`
  return bytes >= 1e6 ? `${Math.round(bytes / 1e6)} MB` : "under 1 MB"
}

const plural = (n: number, one: string, many = one + "s") => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`

/** The one line a client reads after a scan (#192974). Developer detail is behind --verbose. */
export function scanSummary(s: { label: string; files: number; bytes: number; folders: number; sensitive: number; encrypted: boolean | null }): string {
  const head = `Cataloged '${s.label}': ${plural(s.files, "file")} · ${formatSize(s.bytes)} · ${plural(s.folders, "project folder")}`
  if (!s.sensitive) return `${head} · no sensitive files`
  return `${head} · ${plural(s.sensitive, "sensitive file")} ` +
    (s.encrypted === true ? "(drive encrypted — contained)"
      : s.encrypted === false ? "(drive NOT encrypted — run: iris drives list to review)"
      : "(could not tell whether the drive is encrypted — run: iris drives list to review)")
}

const HOWTO = "Step by step, including how to encrypt a drive: iris how-to view iris-drives"
const BLOQ_OPTION = { type: "number", alias: "atlas-bloq", describe: "advanced: use this board id instead of your Drives board (or set IRIS_DRIVES_BLOQ)" } as const

const ScanCommand = cmd({
  command: "scan <path>",
  describe: "catalog a drive or folder: a searchable, encrypted list of what is on it, and any sensitive files",
  builder: (y) =>
    y
      .positional("path", { type: "string", demandOption: true, describe: "the drive or folder, e.g. /Volumes/Footage (Mac), E:\\ (Windows)" })
      .option("label", { type: "string", describe: "a name for the drive (default: its volume name or folder name)" })
      .option("kind", { type: "string", choices: KIND_CHOICES as unknown as string[], default: "media-drive" })
      .option("exclude", { type: "string", array: true, default: [] as string[], describe: "a private folder on the drive (relative): never opened or listed; remembered for every later scan" })
      .option("depth", { type: "number", default: 2, describe: "how many folder levels count as a project folder" })
      .option("bloq", BLOQ_OPTION)
      .option("checksums", {
        type: "string",
        choices: CHECKSUM_CHOICES as unknown as string[],
        default: "default",
        describe: "which files get a sha256, so copies are counted by content: default = sensitive files + project/document/audio up to 64 MB; all; none",
      })
      .option("dry-run", { type: "boolean", default: false, describe: "scan and show the result, send nothing to your account" })
      .option("verbose", { type: "boolean", default: false, describe: "also print the drive id, the local file list's path and each Atlas write" })
      .example("$0 drives scan /Volumes/Footage", "catalog a drive on a Mac (see your drives with: ls /Volumes)")
      .example("$0 drives scan E:\\", "catalog a drive on Windows (type it without quotes)")
      .example('$0 drives scan ~/Projects --label "Client projects" --kind archive-folder', "catalog a folder on this computer")
      .example('$0 drives scan /Volumes/Backup --exclude Personal/Family --exclude Taxes', "keep private folders out — never opened, remembered next time")
      .example("$0 drives scan /Volumes/Backup --checksums all", "hash every file, so every copy is counted by content (slow on big drives)")
      .epilogue(HOWTO),
  handler: metered("scan", async (args: any, run: DrivesRun) => {
    const started = Date.now()
    const verbose = args.verbose === true
    const detail = (line: string) => { if (verbose) console.log(line) }
    const dryRun = args["dry-run"] === true
    const arg = normalizeScanArg(String(args.path)) // #193360: `"E:\"` reaches us as `E:"` from Command Prompt
    const root = fs.existsSync(arg) ? fs.realpathSync(arg) : path.resolve(arg)
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
      console.error(`  Cannot see ${root} — is the drive plugged in?` + (process.platform === "darwin" ? " Your drives are listed by: ls /Volumes" : ""))
      return exitDrives(1)
    }
    const override = overrideBloq(args.bloq)

    // Private folders are remembered IN ATLAS on the drive's record, so a scan from any machine
    // inherits them. Unreadable Atlas = refuse; a privacy promise is not kept from a local guess.
    let bloq: number | null = null
    let userId: number | null = null
    if (!dryRun) {
      userId = await signedIn()
      bloq = await requireDrivesBoard(liveBoardApi(userId), override, { create: true })
    } else if (await resolveToken()) {
      userId = await signedIn()
      bloq = (await resolveDrivesBoard(liveBoardApi(userId), { override, create: false }).catch(() => null))?.id ?? null
    }
    let [driveId, facts] = identify(root, args.label as string | undefined)
    const today = todayIso()

    let remembered: string[] = []
    let previous: Record<string, any> | undefined
    if (bloq) {
      try {
        // #193360: the same serial written by another OS (NTFS: 64-bit on Linux, 32-bit on Windows)
        // is the same drive — keep its record and id rather than open a second card.
        const records = await atlasDrives(bloq)
        previous = findDriveRecord(records, driveId)
        if (previous) driveId = String(previous.external_id)
        // A drive scanned on Windows before #193360 was keyed by PC + letter: keep its private folders.
        const legacy = records.find((d) => d.external_id === `dir:${facts.node}:${root}` && d.external_id !== driveId)
        for (const d of [previous, legacy]) {
          if (d) remembered.push(...String(d.private_excluded ?? "").split("\n").filter((x) => x.trim()))
        }
      } catch (e: any) {
        console.error(`  Could not read this drive's private-folder list from your account (${e?.message ?? e}).`)
        console.error("  Not scanning, so a folder you made private is never read by mistake. Check your connection and run it again.")
        return exitDrives(1)
      }
    } else if (dryRun) {
      console.log(warn("  Not checked against your account: folders made private from another computer are not applied to this dry run."))
    }
    const out = path.join(STORE(), storeDirName(driveId))
    fs.mkdirSync(out, { recursive: true })
    const exclude = [...new Set([...(args.exclude as string[]), ...remembered])].sort()
    console.log(`Scanning ${facts.label} (${root})`)
    detail(`  id ${driveId} · ${facts.label} · ${facts.filesystem} · encrypted=${facts.encrypted == null ? "Unknown" : facts.encrypted ? "True" : "False"}`)
    if (exclude.length) console.log(`  Private folders skipped, never opened: ${exclude.length}`)

    const rollup = new Rollup(Number(args.depth))
    const unreadable: string[] = []
    const tmp = path.join(out, "files.tsv.part")
    const fd = fs.openSync(tmp, "w")
    const checksums = String(args.checksums ?? "default") as Checksums
    const withSha = checksums !== "none"
    let buf = tsvRow(withSha ? TSV_HEADER_SHA : TSV_HEADER)
    let hashed = 0
    for (const e of walk(root, { excludes: exclude, unreadable, checksums })) {
      rollup.add(e)
      if (e.sha256) hashed++
      buf += manifestRow(e, withSha)
      if (buf.length > 1 << 20) { fs.writeSync(fd, buf); buf = "" }
      if (rollup.files % 20000 === 0) console.log(`  … ${rollup.files.toLocaleString("en-US")} files`)
    }
    fs.writeSync(fd, buf)
    fs.closeSync(fd)
    const tsvPath = path.join(out, "files.tsv")
    fs.renameSync(tmp, tsvPath)
    if (facts.size_gb == null) facts.size_gb = facts.used_gb = round(rollup.total / 1e9, 1)
    detail(`  checksums (${checksums}): ${hashed.toLocaleString("en-US")} file(s) hashed`)

    const status = facts.encrypted === true ? "contained" : facts.encrypted === false ? "exposed" : "unknown"
    const driveRow: Record<string, any> = {
      external_id: driveId, label: facts.label, kind: args.kind, node: facts.node,
      filesystem: facts.filesystem, encrypted: facts.encrypted, size_gb: facts.size_gb,
      used_gb: facts.used_gb, files: rollup.files, folders: rollup.folders.size, sensitive_files: rollup.findings.length,
      last_scanned: today, manifest: "", private_excluded: exclude.join("\n"),
      ...liveDriveFields(statfsCompat(root), facts.node, new Date()),
    }
    const folderRows = rollup.folderRows(driveId, facts.label)
    const findingRows = rollup.findingRows(driveId, facts.label, facts.encrypted, today)
    fs.writeFileSync(
      path.join(out, "drive.json"),
      JSON.stringify({ drive: driveRow, private_excluded: exclude, unreadable, scanned: new Date().toISOString().slice(0, 19) }, null, 1),
    )
    driveRow.unreadable_folders = unreadable.length

    detail(
      `  ${rollup.files.toLocaleString("en-US")} files · ${(rollup.total / 1e9).toFixed(1)} GB · ${rollup.folders.size.toLocaleString("en-US")} folders · ${rollup.findings.length} sensitive (${status})`,
    )
    if (unreadable.length) {
      console.log(warn(`  ⚠ INCOMPLETE: ${unreadable.length} folder(s) could not be read — the catalog is missing them:`))
      for (const u of unreadable.slice(0, 8)) console.log(`     ${u}`)
      if (unreadable.length > 8) console.log(`     … and ${unreadable.length - 8} more` + (verbose ? ` (all listed in ${path.join(out, "drive.json")})` : ""))
      console.log(`     ${unreadableHint()}`)
    }
    if (rollup.files) console.log("  Mostly: " + mostCommon(rollup.kinds()).map(([k, c]) => `${k} ${c.toLocaleString("en-US")}`).join(" · "))
    detail(`  manifest: ${tsvPath}`)
    run.set({
      files_count: rollup.files, bytes_cataloged: rollup.total, folders_rows: folderRows.length,
      findings_count: findingRows.length, sensitive_count: rollup.findings.length, encrypted: facts.encrypted ?? undefined,
      unreadable_folders_count: unreadable.length, dry_run: dryRun, checksums, kind: String(args.kind),
    })
    const summary = scanSummary({
      label: facts.label, files: rollup.files, bytes: rollup.total, folders: rollup.folders.size,
      sensitive: rollup.findings.length, encrypted: facts.encrypted,
    })

    if (dryRun || !bloq || !userId) {
      console.log(`Dry run — nothing was sent to your account. ${summary.replace(/^Cataloged/, "Would catalog").replace(" — run: iris drives list to review", "")}`)
      return
    }
    // Findings no longer on the drive are CLOSED (status moved), not left saying "exposed".
    // One import (upsert by external_id) per chunk, not one PATCH per row (#193368).
    try {
      const cur = new Set(findingRows.map((r) => r.external_id))
      const old = await atlasRecords("drive-findings", bloq, { drive_id: driveId })
      const gone = old.filter((r) => !cur.has(r.external_id) && r?.data?.status !== "moved")
      if (gone.length) {
        const r = await importRows("drive-findings", bloq, movedRows(gone))
        if (r.failed) {
          console.log(warn(`  ${plural(r.failed, "sensitive file")} no longer on this drive could not be marked moved`))
          process.exitCode = 1
        }
        const closed = gone.length - r.failed
        if (closed) console.log(`  ${plural(closed, "sensitive file")} from the last scan ${closed === 1 ? "is" : "are"} no longer on this drive — marked moved`)
      }
    } catch (e: any) {
      console.log(warn(`  Could not update the sensitive files found by the last scan: ${e?.message ?? e}`))
      process.exitCode = 1
    }
    const { fid, key, bytes: manifestBytes } = await uploadManifest(liveDeps(userId, bloq), driveId, tsvPath, today)
    run.set({ manifest_saved: !!(fid && key), ...(fid && key && manifestBytes != null ? { manifest_bytes: manifestBytes } : {}) })
    if (fid && key) {
      driveRow.manifest = `atlas-file:${fid}`
      driveRow.manifest_key = key
    } else {
      // Do not point the record at an unverified upload; keep whatever manifest it had.
      delete driveRow.manifest
      delete driveRow.manifest_key
      console.log(warn("  Could not save the encrypted file list — this drive keeps its previous one. Run the scan again."))
      process.exitCode = 1
    }
    detail(`  manifest in Atlas: ${fid ? driveRow.manifest : "UPLOAD FAILED — the drive keeps its previous manifest"}`)
    // The meter (#193356): billing facts on the drive's own record, independent of analytics consent.
    Object.assign(driveRow, meterFields(previous, {
      files: rollup.files, bytes: rollup.total, manifestBytes: fid && key ? manifestBytes : null,
      durationMs: Date.now() - started, version: `iris-cli/${Installation.VERSION}`, now: new Date(),
    }))
    detail(`  meter: scan ${driveRow.scan_count} · ${driveRow.scans_in_month} this month · ${driveRow.last_scan_ms} ms`)
    const what: Record<string, string> = { drives: "the drive's card", "drive-folders": "the folder list", "drive-findings": "the sensitive-file list" }
    for (const [schema, rows] of [["drives", [driveRow]], ["drive-folders", folderRows], ["drive-findings", findingRows]] as const) {
      if (!rows.length) { detail(`  atlas ${schema}: nothing to send`); continue }
      try {
        const r = await importRows(schema, bloq, rows as any[])
        detail(`  atlas ${schema}: ${rows.length} rows → created ${r.created} · updated ${r.updated} · failed ${r.failed}`)
        if (r.failed) {
          console.log(warn(`  ${plural(r.failed, "row")} of ${what[schema]} could not be saved`))
          process.exitCode = 1
        }
      } catch (e: any) {
        console.log(warn(`  Could not save ${what[schema]}: ${String(e?.message ?? e).slice(0, 300)}`))
        process.exitCode = 1
      }
    }
    console.log(process.exitCode ? `Scanned '${facts.label}', but not everything was saved (see above). Run the scan again.` : summary)
  }),
})

/** Every cataloged drive, or a plain sentence and a non-zero exit. */
async function drivesOrExit(bloq: number): Promise<any[]> {
  try {
    return await atlasDrives(bloq)
  } catch (e: any) {
    console.error(`  Could not read your drives from your account (${e?.message ?? e}). Check your connection and try again.`)
    return exitDrives(1)
  }
}

type LoadedRow = ManifestRow & { kind: string; modified: string }

/** Every drive with its decrypted manifest rows (null = not searchable yet). Exits plainly on no drives. */
async function loadManifests(userId: number, bloq: number): Promise<Array<{ drive: any; rows: LoadedRow[] | null }>> {
  const drives = await drivesOrExit(bloq)
  if (!drives.length) {
    console.error(`  ${NO_DRIVES_YET}`)
    return exitDrives(1)
  }
  const out: Array<{ drive: any; rows: LoadedRow[] | null }> = []
  for (const drive of drives) {
    const text = await cachedManifest(userId, bloq, drive).catch(() => null)
    const rows = text
      ? parseTsv(text).map((r) => ({
          drive: String(drive.label ?? drive.external_id), path: r.path, bytes: Number(r.bytes), sha256: r.sha256 ?? "",
          kind: r.kind, modified: r.modified,
        }))
      : null
    out.push({ drive, rows })
  }
  return out
}

const FindCommand = cmd({
  command: "find <words..>",
  describe: "search every cataloged drive for a file — works with the drive unplugged, on any computer you sign in to",
  builder: (y) =>
    y
      .positional("words", { type: "string", array: true, demandOption: true })
      .option("limit", { type: "number", default: 8, describe: "matches shown per drive" })
      .option("bloq", BLOQ_OPTION)
      .example("$0 drives find mix stems", "every file whose path has both words, on every drive")
      .example("$0 drives find A001 .mov --limit 50", "more matches per drive")
      .epilogue(HOWTO),
  handler: metered("find", async (args: any, run: DrivesRun) => {
    const userId = await signedIn()
    const bloq = await requireDrivesBoard(liveBoardApi(userId), overrideBloq(args.bloq), { create: false })
    const words = (args.words as string[]).map((w) => String(w).toLowerCase())
    const limit = Number(args.limit)
    let hits = 0
    const loaded = await loadManifests(userId, bloq)
    let connected = 0
    // Copies are counted by content across ALL drives (needs the sha256 column; see --checksums).
    const idx = copyIndex(loaded.flatMap((m) => m.rows ?? []))
    for (const { drive, rows } of loaded) {
      if (!rows) { console.log(`\n${drive.label}: not searchable yet — scan it again`); continue }
      const isOnline = online(drive)
      if (isOnline) connected++
      const state = isOnline ? "connected to this computer" : "not connected here — found from its catalog"
      let shown = 0
      for (const row of rows) {
        const p = row.path.toLowerCase()
        if (!words.every((w) => p.includes(w))) continue
        const n = row.sha256 ? (idx.get(row.sha256)?.length ?? 0) : 0
        if (shown === 0) console.log(`\n${drive.label} · ${state}`)
        if (shown < limit) console.log(`  ${row.path}  · ${(Number(row.bytes) / 1e9).toFixed(2)} GB · ${row.kind} · ${row.modified}` + (n >= 2 ? ` · ${n} identical copies` : ""))
        shown++
        hits++
      }
      if (shown > limit) console.log(`  … and ${shown - limit} more on ${drive.label}`)
    }
    run.set({ results_count: hits, drives_count: loaded.length, connected_count: connected, words_count: words.length })
    if (!hits) console.log("Nothing found on any cataloged drive.")
    else console.log(`\nWhere a file is on this computer right now: iris drives path <drive>:<path>   (iris drives list shows each drive)`)
  }),
})

/** `<drive name or id>:<rel>` → [drive id, rel]. A drive can be named by its label as well as its id. */
export function resolveRef(refIn: string, labels: Record<string, string>): [string, string] {
  const byLabel = Object.fromEntries(Object.entries(labels).map(([id, l]) => [String(l), id]))
  let ref = refIn
  const label = Object.keys(byLabel).sort((a, b) => b.length - a.length).find((l) => ref.startsWith(l + ":"))
  if (label) ref = byLabel[label] + ref.slice(label.length)
  return splitRef(ref, Object.keys(labels))
}

/** The one sentence `path` and `get` print (exit 2) when the drive is not plugged in here. */
export const notConnected = (name: string) => `Not a valid path right now: ${name} is not connected to this computer`

const PathCommand = cmd({
  command: "path <ref>",
  describe: "where a cataloged file is on this computer right now — or exit 2 (drive not connected) / 3 (moved or deleted)",
  builder: (y) =>
    y
      .positional("ref", { type: "string", demandOption: true, describe: "<drive>:<path inside the drive>, the drive as shown by iris drives list" })
      .option("bloq", BLOQ_OPTION)
      .example('$0 drives path "Studio footage:Shoot 12/A001.mov"', "the full path, if that drive is plugged into this computer")
      .epilogue(HOWTO),
  handler: metered("path", async (args: any, run: DrivesRun) => {
    // Resolving the path needs only this computer; the catalog adds drive names. So an
    // unreachable account is not fatal — but an account with no drives cataloged is.
    let labels: Record<string, string> = {}
    if (await resolveToken()) {
      const userId = await signedIn()
      let bloq: number | null = null
      try {
        bloq = (await resolveDrivesBoard(liveBoardApi(userId), { override: overrideBloq(args.bloq), create: false }))?.id ?? null
        if (bloq == null) {
          console.error(`  ${NO_DRIVES_YET}`)
          return exitDrives(1)
        }
        for (const d of await atlasDrives(bloq)) labels[d.external_id] = d.label
      } catch {
        labels = {} // names are a nicety; resolving the path does not need Atlas
      }
    }
    const [driveId, rel] = resolveRef(String(args.ref), labels)
    const mount = resolveMount(driveId)
    const name = labels[driveId] ?? driveId
    run.set({ drives_count: Object.keys(labels).length, connected_count: mount ? 1 : 0 })
    if (!mount) {
      console.log(notConnected(name))
      return exitDrives(2)
    }
    const full = path.join(mount, rel)
    if (!fs.existsSync(full)) {
      console.log(`${name} is connected at ${mount}, but ${rel} is not there (moved or deleted since the last scan)`)
      return exitDrives(3)
    }
    run.set({ results_count: 1 })
    console.log(full)
  }),
})

const ListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "every cataloged drive: encrypted or not, sensitive files, free space, connected here or not, last scanned",
  builder: (y) => y.option("bloq", BLOQ_OPTION).example("$0 drives list", "your drives at a glance").epilogue(HOWTO),
  handler: metered("list", async (args: any, run: DrivesRun) => {
    const userId = await signedIn()
    const bloq = await requireDrivesBoard(liveBoardApi(userId), overrideBloq(args.bloq), { create: false })
    const drives = await drivesOrExit(bloq)
    if (!drives.length) {
      console.error(`  ${NO_DRIVES_YET}`)
      return exitDrives(1)
    }
    let connected = 0, unreadableFolders = 0
    // #193363: kept files and vault copies, from the catalog. A board with neither has no such rows.
    const cat = liveVaultCatalog(userId, bloq)
    const [kept, reps] = await Promise.all([
      cat.keptRows().then((r) => r.map((x: any) => x?.data ?? x)).catch(() => [] as any[]),
      cat.replicaRows().then((r) => r.map((x: any) => x?.data ?? x)).catch(() => [] as any[]),
    ])
    const now = new Date()
    const alerts = keptAlerts(kept, reps as ReplicaRow[], now)
    for (const d of drives) {
      const isOnline = online(d)
      if (isOnline) connected++
      unreadableFolders += Number(d.unreadable_folders) > 0 ? Number(d.unreadable_folders) : 0
      console.log(
        `${String(d.label).padEnd(24)} ${Number(d.files ?? 0).toLocaleString("en-US").padStart(9)} files  ${String(d.used_gb).padStart(8)} GB  ` +
          `${encryptionWord(d.encrypted).padEnd(13)} ${String(d.sensitive_files ?? 0).padStart(4)} sensitive  ` +
          `${(d.free_gb != null && d.free_gb !== "" ? `${d.free_gb} GB free` : "free ?").padStart(13)}  ` +
          `${isOnline ? "online" : "offline"}  scanned ${d.last_scanned}` +
          (d.last_seen_on ? ` · last seen on ${d.last_seen_on}` : "") +
          (Number(d.unreadable_folders) > 0 ? `  ${warn(`(${d.unreadable_folders} unreadable folder(s))`)}` : ""),
      )
      for (const l of keptLines(d, alerts.get(String(d.external_id)), reps, now)) console.log(l)
    }
    // The alert lives on the drive's own record too; written here only when it changed (a copy goes
    // stale with time alone, so looking is when it is noticed).
    const changed = driveAlertRows(drives, kept, reps as ReplicaRow[], now)
    if (changed.length) await importRows("drives", bloq, changed).catch(() => {})
    run.set({ drives_count: drives.length, connected_count: connected, unreadable_folders_count: unreadableFolders })
  }),
})

/** Under a drive's line in `list`: its vault copies, and its kept files that are short of copies. */
export function keptLines(d: any, a: ReturnType<typeof keptAlerts> extends Map<string, infer V> ? V | undefined : never, reps: any[], now: Date): string[] {
  const out: string[] = []
  const id = String(d.external_id)
  const mine = reps.filter((r) => r.drive_id === id || r.target === `drive:${id}`)
  if (mine.length) {
    out.push(`  vault copies on it: ` + mine.map((r) => {
      const at = r.last_verified_at ? Date.parse(String(r.last_verified_at)) : NaN
      const fresh = Number.isFinite(at) && now.getTime() - at <= missingDays() * 86_400_000
      const word = r.status === "ok" && !fresh ? `missing — not verified for ${missingDays()}+ days` : r.status
      return `${r.vault_name ?? r.vault_id} ${word}${r.last_verified_at ? ` (verified ${String(r.last_verified_at).slice(0, 10)})` : ""}`
    }).join(" · "))
  }
  if (a) {
    if (!a.below.length) out.push(`  kept: ${a.kept} file(s), every one at its minimum copies`)
    else {
      out.push(warn(`  ⚠ kept: ${a.below.length} of ${a.kept} file(s) BELOW their minimum copies`))
      for (const b of a.below.slice(0, 5)) {
        const why = [...b.stale.map((k) => `${label(reps, k)} not verified recently`), ...b.failing.map((k) => `${label(reps, k)} failing`)]
        out.push(`     ${b.path} — ${b.copies}/${b.target} in vault ${b.vault}${why.length ? ` (${why.join(", ")})` : ""}`)
      }
      if (a.below.length > 5) out.push(`     … and ${a.below.length - 5} more`)
      out.push(`     Plug the missing drive in and run: iris vault sync · or check: iris vault status <vault>`)
    }
  }
  return out
}

const label = (reps: any[], k: string) => reps.find((r) => r.target === k)?.target_label ?? k.replace(/^(drive|machine):/, "")

// ── copies: counted by content, across every drive (#192914) ──────────────────────

const CopiesCommand = cmd({
  command: "copies <words..>",
  describe: "how many identical copies of a file exist, and on which drives — counted by content, not by name",
  builder: (y) =>
    y
      .positional("words", { type: "string", array: true, demandOption: true })
      .option("limit", { type: "number", default: 8, describe: "copies listed per file" })
      .option("bloq", BLOQ_OPTION)
      .example("$0 drives copies final mix", "every file whose path has both words: its identical copies on every drive")
      .example("$0 drives copies brief.pdf", "same name on two drives — the same file, or two different versions?")
      .epilogue(HOWTO),
  handler: metered("copies", async (args: any, run: DrivesRun) => {
    const userId = await signedIn()
    const bloq = await requireDrivesBoard(liveBoardApi(userId), overrideBloq(args.bloq), { create: false })
    const loaded = await loadManifests(userId, bloq)
    const limit = Number(args.limit)
    for (const { drive, rows } of loaded) if (!rows) console.log(`${drive.label}: not searchable yet — scan it again`)
    const report = copiesReport(loaded.flatMap((m) => m.rows ?? []), (args.words as string[]).map(String))
    run.set({
      results_count: report.known.length + report.unknown.length, drives_count: loaded.length,
      words_count: (args.words as string[]).length,
    })
    // #193363: encrypted copies in vaults count too — by content, as the kept files record them.
    const cat = liveVaultCatalog(userId, bloq)
    const [kept, reps] = await Promise.all([
      cat.keptRows().then((r) => r.map((x: any) => x?.data ?? x)).catch(() => [] as any[]),
      cat.replicaRows().then((r) => r.map((x: any) => x?.data ?? x)).catch(() => [] as any[]),
    ])
    console.log(formatCopies(report, limit, vaultCopiesBySha(kept, reps as ReplicaRow[], new Date())).join("\n"))
  }),
})

export function formatCopies(report: ReturnType<typeof copiesReport>, limit = 8, vaults?: ReturnType<typeof vaultCopiesBySha>): string[] {
  const out: string[] = []
  const list = (rows: ManifestRow[], indent: string) => {
    for (const r of rows.slice(0, limit)) out.push(`${indent}${r.drive}: ${r.path}`)
    if (rows.length > limit) out.push(`${indent}… and ${rows.length - limit} more`)
  }
  const kept = (sha: string, indent: string) => {
    for (const v of vaults?.get(sha) ?? []) {
      const flag = v.copies < v.target ? warn(` BELOW its minimum of ${v.target}`) : ` (minimum ${v.target})`
      out.push(`${indent}+ ${plural(v.copies, "encrypted copy", "encrypted copies")} in vault ${v.vault}${flag}` +
        (v.held.length ? `: ${v.held.join(", ")}` : "") + (v.stale.length ? ` · not counted: ${v.stale.join(", ")}` : ""))
    }
  }
  for (const k of report.known) {
    out.push(`${k.name} — ${copiesLine(k.versions)}`)
    if (k.versions.length === 1) { list(k.versions[0].copies, "  "); kept(k.versions[0].sha256, "  ") }
    else
      k.versions.forEach((v, i) => {
        out.push(`  version ${i + 1} (sha256 ${v.sha256.slice(0, 12)}…): ${plural(v.copies.length, "copy", "copies")}`)
        list(v.copies, "    ")
        kept(v.sha256, "    ")
      })
  }
  if (report.unknown.length) {
    out.push(`Not checksummed yet: ${plural(report.unknown.length, "file")} — scan the drive with --checksums all to compare them`)
    list(report.unknown, "  ")
  }
  if (!out.length) out.push("Nothing found on any cataloged drive.")
  return out
}

// ── get: read ONE file, on the record (#192914) ──────────────────────────────────
//
// Copies one file (or one bundle, zipped) off a drive that is connected to THIS computer, checks
// the copy's sha256 against the original, and writes one row to the board's `drive-reads`
// dataset: who, which machine, why, what it hashed to. A private folder is never opened; a
// sensitive file needs --confirm. No unlocking: an encrypted drive that is not mounted is simply
// "not connected" (unlocking is the machine's business, not the CLI's).

export type GetArgs = {
  ref: string; to: string; why?: string; confirm?: boolean
  /** Serving another of the user's machines (#193362): same checks, nothing recorded here — the
   *  asking machine records the read once the copy has arrived and checked out. A plain file is
   *  hashed in place (dest = the original); a bundle is zipped into `to`, a fresh stage folder. */
  serve?: boolean
}
export type GetDeps = {
  drives: () => Promise<any[]>
  /** drive-findings rows (their data) for one drive */
  findings: (driveId: string) => Promise<any[]>
  /** make sure the drive-reads dataset exists ("already exists" is fine) */
  ensureReadsDataset: () => Promise<void>
  writeAudit: (rows: any[]) => Promise<{ created: number; updated: number; failed: number }>
  account: () => Promise<string>
  host: string
  now: () => Date
  hashFile?: (p: string) => string
  resolveMount?: (driveId: string) => string | null
}
export type GetResult = { code: number; out: string[]; err: string[]; dest?: string; row?: any; bundle?: boolean; sensitive?: boolean }

export function insidePrivate(rel: string, excludes: readonly string[]): boolean {
  const rl = rel.toLowerCase()
  return normalizeExcludes(excludes).some((x) => rl === x || rl.startsWith(x + "/"))
}

async function zipBundle(dest: string, members: Array<[string, string]>, totalBytes: number) {
  const { ZipWriter, BlobReader, configure } = await import("@zip.js/zip.js")
  configure({ useWebWorkers: false })
  const fd = fs.openSync(dest, "wx")
  try {
    const writable = new WritableStream<Uint8Array>({ write: (c) => { fs.writeSync(fd, c) } })
    // Stored, not compressed: media does not shrink, and the bytes stay byte-identical.
    const zw = new ZipWriter(writable, { level: 0, zip64: totalBytes > 0xf0000000 || members.length > 65000 })
    for (const [rel, abs] of members) await zw.add(rel, new BlobReader(Bun.file(abs)), { level: 0 })
    await zw.close()
  } finally {
    fs.closeSync(fd)
  }
}

/** The bundle hash of what is INSIDE a zip — so the copy is checked, not the original twice. */
export async function zipBundleHash(zipPath: string): Promise<{ sha256: string; members: number }> {
  const { ZipReader, BlobReader, configure } = await import("@zip.js/zip.js")
  configure({ useWebWorkers: false })
  const zr = new ZipReader(new BlobReader(Bun.file(zipPath)))
  const lines: Array<[string, string]> = []
  try {
    for (const e of await zr.getEntries()) {
      if (e.directory || !e.getData) continue
      const h = createHash("sha256")
      await e.getData(new WritableStream<Uint8Array>({ write: (c) => { h.update(c) } }))
      lines.push([e.filename, h.digest("hex")])
    }
  } finally {
    await zr.close()
  }
  return { sha256: bundleHashFromLines(lines), members: lines.length }
}

export async function runGet(a: GetArgs, deps: GetDeps): Promise<GetResult> {
  const out: string[] = []
  const err: string[] = []
  const fail = (code: number, msg: string, to: "out" | "err" = "err"): GetResult => {
    ;(to === "out" ? out : err).push(msg)
    return { code, out, err }
  }
  const why = String(a.why ?? "").trim()
  if (!why) return fail(1, '--why is required: say why you are reading this file, e.g. --why "send the brief to the client". It goes on the record.')
  const hash = deps.hashFile ?? sha256File

  let drives: any[]
  try {
    drives = await deps.drives()
  } catch (e: any) {
    return fail(1, `Could not read your drives from your account (${e?.message ?? e}). Nothing was read.`)
  }
  const labels: Record<string, string> = Object.fromEntries(drives.map((d) => [String(d.external_id), String(d.label ?? d.external_id)]))
  const [driveId, rawRel] = resolveRef(String(a.ref), labels)
  const drive = drives.find((d) => String(d.external_id) === driveId)
  if (!drive) return fail(1, `${driveId} is not a cataloged drive. See your drives with: iris drives list`)
  const name = labels[driveId]
  const excludes = String(drive.private_excluded ?? "").split("\n").filter((x) => x.trim())

  // The privacy check comes before anything on the drive is touched.
  const rel = path.posix.normalize(rawRel.replace(/^\/+/, ""))
  if (!rawRel || rel === "." || rel === ".." || rel.startsWith("../")) return fail(1, `Give a file inside the drive: iris drives get "${name}:<path>" (paths come from iris drives find)`)
  const privateMsg = `${rel} is inside a private folder on ${name}. Private folders are never opened, so it cannot be read.`
  if (insidePrivate(rel, excludes)) return fail(1, privateMsg)

  const mount = (deps.resolveMount ?? resolveMount)(driveId)
  if (!mount) return fail(2, notConnected(name), "out")
  let real: string
  try {
    real = fs.realpathSync(path.join(mount, rel))
  } catch {
    return fail(3, `${name} is connected at ${mount}, but ${rel} is not there (moved or deleted since the last scan)`, "out")
  }
  // A link must not lead out of the drive, or into a private folder by another name.
  const relReal = path.relative(fs.realpathSync(mount), real).split(path.sep).join("/")
  if (!relReal || relReal.startsWith("..") || path.isAbsolute(relReal)) return fail(1, `${rel} leads outside ${name}; not read.`)
  if (insidePrivate(relReal, excludes)) return fail(1, privateMsg)

  const st = fs.statSync(real)
  const lower = relReal.toLowerCase()
  const isBundle = st.isDirectory() && BUNDLES.some((b) => lower.endsWith(b))
  if (st.isDirectory() && !isBundle)
    return fail(1, `${rel} is a folder. get copies ONE file, or one project bundle (${BUNDLES.slice(0, 3).join(", ")}…) as a .zip.`)
  if (!st.isDirectory() && !st.isFile()) return fail(1, `${rel} is not a regular file; not read.`)
  if (APP_BUNDLES.some((b) => lower.endsWith(b))) return fail(1, `${rel} is an installed app; apps are listed, never opened.`)

  // Sensitive = the drive's finding says so, or the name alone would make it one.
  let findings: any[]
  try {
    findings = await deps.findings(driveId)
  } catch (e: any) {
    return fail(1, `Could not check whether ${rel} is a sensitive file (${e?.message ?? e}). Nothing was read.`)
  }
  const finding = findings.find((f) => (f?.path === relReal || f?.path === rel) && f?.status !== "moved")
  const sensitiveKind = finding?.kind ?? (SENSITIVE.has(kindOf(relReal)) ? kindOf(relReal) : null)
  if (sensitiveKind && !a.confirm)
    return fail(
      1,
      `${rel} is a sensitive file (${sensitiveKind}) on ${name}${encryptionState(drive.encrypted) === true ? "" : encryptionState(drive.encrypted) === false ? ", and that drive is NOT encrypted" : ", and it is not known whether that drive is encrypted"}.\n` +
        `Copying it puts a second copy on this computer. If you mean to, add --confirm. The read is recorded either way.`,
    )
  if (a.serve && !isBundle) {
    const sha256 = hash(real)
    return { code: 0, out, err, dest: real, row: { drive_id: driveId, drive_label: name, path: relReal, bytes: st.size, sha256, file_sha256: sha256, bundle: false } }
  }

  const to = path.resolve(a.to)
  fs.mkdirSync(to, { recursive: true })
  const dest = path.join(to, path.posix.basename(relReal) + (isBundle ? ".zip" : ""))
  if (fs.existsSync(dest)) return fail(1, `${dest} already exists — not overwritten. Choose another --to.`)

  let sha256: string
  let bytes: number
  try {
    if (isBundle) {
      const members = bundleMembers(real)
      const hashed = members.map(([r, p]) => [r, hash(p)] as [string, string])
      sha256 = bundleHashFromLines(hashed)
      bytes = members.reduce((n, [, p]) => n + fs.statSync(p).size, 0)
      await zipBundle(dest, members, bytes)
      const back = await zipBundleHash(dest)
      if (back.sha256 !== sha256 || back.members !== members.length) throw new MismatchError()
    } else {
      sha256 = hash(real)
      bytes = st.size
      fs.copyFileSync(real, dest, fs.constants.COPYFILE_EXCL)
      if (hash(dest) !== sha256) throw new MismatchError()
    }
  } catch (e: any) {
    fs.rmSync(dest, { force: true })
    if (e instanceof MismatchError) return fail(GET_EXIT.mismatch, `The copy of ${rel} did not match the original (sha256). It was removed; nothing was recorded. Try again.`)
    return fail(1, `Could not copy ${rel}: ${e?.message ?? e}. Nothing was recorded.`)
  }

  if (a.serve) return { code: 0, out, err, dest, row: { drive_id: driveId, drive_label: name, path: relReal, bytes, sha256, file_sha256: hash(dest), bundle: true } }

  const at = utcIso(deps.now())
  const row = {
    external_id: `${driveId}:${relReal}:${at}`, drive_id: driveId, drive_label: name, path: relReal, bytes, sha256,
    read_by: await deps.account().catch(() => "unknown"), read_on: deps.host, purpose: why, at,
  }
  try {
    await deps.ensureReadsDataset()
    const r = await deps.writeAudit([row])
    if (r.failed || r.created + r.updated !== 1) throw new Error(`created ${r.created} · updated ${r.updated} · failed ${r.failed}`)
  } catch (e: any) {
    // Not on the record → not kept.
    fs.rmSync(dest, { force: true })
    return fail(1, `Could not record this read in your account (${e?.message ?? e}). The copy was removed. Check your connection and try again.`)
  }
  out.push(`Copied ${relReal} from ${name} → ${dest}`)
  out.push(`  ${formatSize(bytes)} · sha256 ${sha256.slice(0, 16)}… verified · recorded in your Drives board (Drive reads)`)
  return { code: 0, out, err, dest, row, bundle: isBundle, sensitive: !!sensitiveKind }
}

class MismatchError extends Error {}

/** `get` exit codes. 2 and 3 mean what they mean for `path`; 4 and 5 are the remote ones (#193362). */
export const GET_EXIT = { refused: 1, notConnected: 2, moved: 3, nodeOffline: 4, mismatch: 5 } as const

/** The Atlas side of `get` and `serve`, for the signed-in account's board. */
function liveGetDeps(userId: number, bloq: number): GetDeps {
  const reads = DRIVES_DATASETS.find((d) => d.slug === "drive-reads")!
  return {
    drives: () => atlasDrives(bloq),
    findings: async (driveId) => (await atlasRecords("drive-findings", bloq, { drive_id: driveId })).map((x) => x?.data ?? {}),
    ensureReadsDataset: async () => { await liveBoardApi(userId).createDataset(reads.slug, reads.name, reads.fields, bloq) },
    writeAudit: (rows) => importRows("drive-reads", bloq, rows),
    account: async () => {
      const res = await irisFetch("/api/user")
      const b = res.ok ? ((await res.json()) as any) : {}
      const u = b?.data ?? b
      return String(u?.email || u?.name || `user ${userId}`)
    },
    host: os.hostname(),
    now: () => new Date(),
  }
}

/**
 * The Drives catalog as a vault sees it (#193363): which drives exist, which vault copy is where,
 * which kept file is held by whom. null when this account has no Drives board yet.
 */
export async function openVaultCatalog(userId: number, bloqFlag?: unknown): Promise<{ bloq: number; cat: VaultCatalog } | null> {
  const board = await resolveDrivesBoard(liveBoardApi(userId), { override: overrideBloq(bloqFlag), create: false })
  if (!board) return null
  return { bloq: board.id, cat: liveVaultCatalog(userId, board.id) }
}

export function liveVaultCatalog(userId: number, bloq: number): VaultCatalog {
  const ensured = new Set<string>()
  const optional404 = (e: any) => { if (/HTTP 404/.test(String(e?.message))) return []; throw e }
  return {
    drives: () => atlasDrives(bloq),
    replicaRows: () => atlasRecords("drive-vaults", bloq).catch(optional404),
    keptRows: () => atlasRecords("drive-kept", bloq).catch(optional404),
    upsert: (schema, rows) => importRows(schema, bloq, rows),
    ensure: async (slug) => {
      if (ensured.has(slug)) return
      const d = DRIVES_DATASETS.find((x) => x.slug === slug)
      if (d) await liveBoardApi(userId).createDataset(d.slug, d.name, d.fields, bloq)
      ensured.add(slug)
    },
  }
}

const GetCommand = cmd({
  command: "get <ref>",
  describe: "copy ONE file (or one project bundle, as .zip) off a drive — plugged into this computer or into another of your machines — checked, and recorded with your reason",
  builder: (y) =>
    y
      .positional("ref", { type: "string", demandOption: true, describe: "<drive>:<path inside the drive>, as iris drives find shows it" })
      .option("to", { type: "string", demandOption: true, describe: "the folder to copy it into" })
      .option("why", { type: "string", describe: "REQUIRED: why you are reading it — saved with the record" })
      .option("confirm", { type: "boolean", default: false, describe: "needed for a sensitive file (passwords, keys, database dumps)" })
      .option("from", { type: "string", describe: "the machine (Hive node) the drive is plugged into — default: found for you" })
      .option("json", { type: "boolean", default: false, describe: "one JSON result, for scripts and agents" })
      .option("bloq", BLOQ_OPTION)
      .example('$0 drives get "Client projects:Acme/brief.pdf" --to ~/Desktop --why "send to client"', "one file, checked and recorded")
      .example('$0 drives get "Studio:Stems/kick.wav" --to ~/Desktop --why "mixdown" --json', "the drive is plugged in at another of your machines: found, sent over your Hive, JSON result")
      .example('$0 drives get "Studio:Stems/kick.wav" --to ~/Desktop --why "mixdown" --from studio-mac', "say which machine has the drive")
      .example('$0 drives get "Studio:Songs/Demo.logicx" --to ~/Desktop --why "mixdown"', "a project bundle arrives as Demo.logicx.zip")
      .example('$0 drives get "Old site:app/.env" --to ~/secure --why "rotate the key" --confirm', "a sensitive file needs --confirm")
      .epilogue(
        "Exit codes: 0 copied · 1 refused or failed · 2 drive not connected (here, or on any of your machines) · " +
          "3 file moved or deleted since the last scan · 4 the machine with the drive is not answering · 5 the copy did not match (sha256). " +
          "From another machine the file travels over ssh on Tailscale, never through IRIS servers. " + HOWTO,
      ),
  handler: metered("get", async (args: any, run: DrivesRun) => {
    const json = args.json === true
    const report = async (r: GetResult & { served_by?: string }) => {
      // A remote result carries bundle/sensitive on its read row; the event takes only the counts (#193356).
      run.set(getFacts({ ...r, bundle: r.bundle ?? r.row?.bundle === true, sensitive: r.sensitive ?? r.row?.sensitive === true }))
      if (json) {
        const error = [...r.err, ...(r.code ? r.out : [])].join("\n") || undefined
        console.log(JSON.stringify({ ok: r.code === 0, code: r.code, ...(error ? { error } : {}), dest: r.dest ?? null, served_by: r.served_by ?? null, read: r.row ?? null }, null, 2))
      } else {
        for (const l of r.out) console.log(l)
        for (const l of r.err) console.error(`  ${l}`)
      }
      if (r.code) return exitDrives(r.code)
    }
    if (!String(args.why ?? "").trim())
      return report({ code: 1, out: [], err: ['--why is required: say why you are reading this file, e.g. --why "send the brief to the client". It goes on the record.'] })
    const userId = await signedIn()
    const bloq = await requireDrivesBoard(liveBoardApi(userId), overrideBloq(args.bloq), { create: false })
    const deps = liveGetDeps(userId, bloq)
    const a = { ref: String(args.ref), to: String(args.to), why: args.why as string | undefined, confirm: args.confirm === true }
    const from = args.from ? String(args.from) : undefined
    // This computer first (unless --from names another machine); then whichever machine has it (#193362).
    if (!from || nameMatches(from, deps.host)) {
      const r = await runGet(a, deps)
      if (r.code !== GET_EXIT.notConnected || from) return report(r)
    }
    const remote = liveRemoteDeps(async () => (await fetchNodes(userId)) as any)
    return report(await runRemoteGet({ ...a, from, bloq }, { ...deps, ...remote }))
  }),
})

const KeepCommand = cmd({
  command: "keep <ref>",
  describe: "keep a cataloged file or project folder safe: encrypted copies in a vault on your own drives and machines — counted, and flagged when too few are left",
  builder: (y) =>
    y
      .positional("ref", { type: "string", demandOption: true, describe: "<drive>:<file or folder>, as iris drives find shows it" })
      .option("vault", { type: "string", demandOption: true, describe: 'the vault to keep it in (made with: iris vault create <name> --on "<drive>,<drive>,this-machine")' })
      .option("why", { type: "string", describe: "REQUIRED: why you are keeping it — saved with the record" })
      .option("confirm", { type: "boolean", default: false, describe: "needed when it is, or a folder holds, a sensitive file (passwords, keys, database dumps)" })
      .option("from", { type: "string", describe: "the machine the drive is plugged into — default: this one, else found for you" })
      .option("json", { type: "boolean", default: false, describe: "one JSON result, for scripts and agents" })
      .option("bloq", BLOQ_OPTION)
      .example('$0 drives keep "Studio:Masters/Album 2025" --vault masters --why "only copy of the masters"', "a project folder: every file encrypted into the vault's copies")
      .example('$0 drives keep "Client projects:Acme/contract.pdf" --vault clients --why "signed contract"', "one file")
      .example('$0 drives keep "Old site:app/.env" --vault clients --why "rotate later" --confirm', "a sensitive file needs --confirm")
      .epilogue("Exit codes: 0 kept · 1 refused or failed · 2 drive not connected anywhere · 3 moved since the last scan · 4 the machine with the drive is not answering · 5 a copy did not match (sha256). " + HOWTO),
  handler: metered("keep", async (args: any, run: DrivesRun) => {
    const json = args.json === true
    const report = async (r: { code: number; out: string[]; err: string[]; kept?: any[] }) => {
      run.set({ results_count: r.kept?.length ?? 0, bytes_copied: (r.kept ?? []).reduce((n, k) => n + Number(k.bytes ?? 0), 0) })
      if (json) console.log(JSON.stringify({ ok: r.code === 0, code: r.code, ...(r.err.length ? { error: r.err.join("\n") } : {}), kept: r.kept ?? [] }, null, 2))
      else {
        for (const l of r.out) console.log(l)
        for (const l of r.err) console.error(`  ${l}`)
      }
      if (r.code) return exitDrives(r.code)
    }
    if (!String(args.why ?? "").trim())
      return report({ code: 1, out: [], err: ['--why is required: say why you are keeping this, e.g. --why "the only copy of the master". It goes on the record.'] })
    const userId = await signedIn()
    const bloq = await requireDrivesBoard(liveBoardApi(userId), overrideBloq(args.bloq), { create: false })
    const get = liveGetDeps(userId, bloq)
    const remote = liveRemoteDeps(async () => (await fetchNodes(userId)) as any)
    const deps: KeepDeps = {
      ...get,
      resolveMount,
      vault: async (name) => (await keepVault(name)) as any,
      put: async (v, files) => putToTargets(v as any, files, { bloq, "user-id": userId }) as any,
      remoteGet: (a) => runRemoteGet(a, { ...get, ...remote }),
      catalogFiles: async (driveId) => {
        const drive = (await atlasDrives(bloq)).find((d) => String(d.external_id) === driveId)
        const text = drive ? await cachedManifest(userId, bloq, drive) : null
        return text ? parseTsv(text).map((r) => ({ path: r.path, bytes: Number(r.bytes), sha256: r.sha256 })) : null
      },
      catalog: liveVaultCatalog(userId, bloq),
    }
    return report(await runKeep({ ref: String(args.ref), vault: String(args.vault), why: args.why, confirm: args.confirm === true, from: args.from ? String(args.from) : undefined, bloq }, deps))
  }),
})

// `serve`: the other half of a remote get, run over ssh on the machine that has the drive. Not for
// people: it prints one machine-readable line, and the ASKING machine writes the audit row.
const ServeCommand = cmd({
  command: "serve <ref>",
  describe: false as unknown as string,
  builder: (y) =>
    y
      .positional("ref", { type: "string", demandOption: true })
      .option("why", { type: "string", demandOption: true })
      .option("confirm", { type: "boolean", default: false })
      .option("for", { type: "string" }) // the machine asking, for the serving side's logs
      .option("bloq", BLOQ_OPTION),
  async handler(args) {
    const userId = await signedIn()
    const bloq = await requireDrivesBoard(liveBoardApi(userId), overrideBloq(args.bloq), { create: false })
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), "iris-drives-serve-"))
    let r: GetResult
    try {
      r = await runGet({ ref: String(args.ref), to: stage, why: String(args.why), confirm: args.confirm === true, serve: true }, liveGetDeps(userId, bloq))
    } catch (e: any) {
      r = { code: 1, out: [], err: [`could not read it: ${e?.message ?? e}`] }
    }
    const bundle = r.code === 0 && r.row?.bundle === true
    if (!bundle) fs.rmSync(stage, { recursive: true, force: true })
    const reply: ServeReply = {
      ok: r.code === 0, code: r.code, ...(r.code ? { error: [...r.err, ...r.out].join("\n") } : {}),
      ...(r.code === 0 ? { file: r.dest, stage: bundle ? stage : null, ...r.row } : {}), host: os.hostname(),
    }
    console.log(SERVE_MARK + JSON.stringify(reply))
    if (r.code) process.exit(r.code)
  },
})

/** The numbers a `get` event carries — never the path, drive name or reason (those stay in drive-reads). */
export function getFacts(r: GetResult) {
  return {
    results_count: r.code === 0 ? 1 : 0,
    bytes_copied: r.code === 0 && r.row ? Number(r.row.bytes) : 0,
    bundle: r.bundle === true,
    sensitive: r.sensitive === true,
  }
}


// ── usage: what this account would be metered on (#193356) ───────────────────────────
//
// Read from Atlas, never from this machine: the drive records carry the meter (scans, files, bytes,
// encrypted list size), drive-reads holds one row per `get`, drive-findings the sensitive files.

export function formatUsage(u: UsageReport): string[] {
  const monthName = new Date(`${u.month}-01T00:00:00Z`).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" })
  const pad = (s: string) => s.padEnd(31)
  const out = [`IRIS Drives usage — ${monthName}`]
  out.push(`  ${pad("Drives cataloged")}${u.drives.toLocaleString("en-US")}`)
  out.push(`  ${pad("Files cataloged")}${plural(u.files, "file")} · ${formatSize(u.bytes)}` +
    (u.bytes_estimated_drives ? ` (${plural(u.bytes_estimated_drives, "drive")} counted by used space until the next scan)` : ""))
  out.push(`  ${pad("Encrypted file lists stored")}${u.manifest_bytes ? formatBytes(u.manifest_bytes) : "none yet"}`)
  out.push(`  ${pad("Scans this month")}${u.scans_this_month.toLocaleString("en-US")}  (${u.scans_total.toLocaleString("en-US")} in all)`)
  out.push(`  ${pad("Files copied (get) this month")}` +
    (u.gets_this_month == null ? "could not read your Drive reads" : `${u.gets_this_month.toLocaleString("en-US")}` + (u.gets_this_month ? ` · ${formatBytes(u.get_bytes_this_month ?? 0)}` : "")))
  out.push(`  ${pad("Sensitive files protected")}${plural(u.sensitive_contained, "file")} on encrypted drives` +
    (u.sensitive_exposed ? ` · ${warn(`${plural(u.sensitive_exposed, "file")} on drives that are NOT encrypted`)}` : ""))
  return out
}

/** Like formatSize, but small sizes still say something: an encrypted file list is often under 1 MB. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1e6) return formatSize(bytes)
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(1)} KB`
  return `${bytes} bytes`
}

const UsageCommand = cmd({
  command: "usage",
  describe: "what your drives catalog adds up to: drives, files and TB cataloged, encrypted storage, scans and copies this month",
  builder: (y) =>
    y
      .option("json", { type: "boolean", default: false, describe: "the same numbers as JSON" })
      .option("bloq", BLOQ_OPTION)
      .example("$0 drives usage", "this month's drives usage, read from your account")
      .example("$0 drives usage --json", "the same, for a script")
      .epilogue(HOWTO),
  handler: metered("usage", async (args: any, run: DrivesRun) => {
    const userId = await signedIn()
    const bloq = await requireDrivesBoard(liveBoardApi(userId), overrideBloq(args.bloq), { create: false })
    const drives = await drivesOrExit(bloq)
    let findings: any[]
    try {
      findings = (await atlasRecords("drive-findings", bloq)).map((r) => r?.data ?? {})
    } catch (e: any) {
      console.error(`  Could not read your sensitive-file list from your account (${e?.message ?? e}). Check your connection and try again.`)
      return exitDrives(1)
    }
    // No `get` yet = no drive-reads dataset yet, which is zero copies, not an error.
    const reads = await atlasRecords("drive-reads", bloq).then((rs) => rs.map((r) => r?.data ?? {})).catch((e: any) =>
      /HTTP 404/.test(String(e?.message)) ? [] : null)
    const files = await listBloqFiles(userId, bloq)
    const report = usageReport({ drives, reads, findings, attachments: files.ok ? files.files : [], now: new Date() })
    run.set({ drives_count: report.drives })
    if (args.json) {
      console.log(JSON.stringify(report, null, 2))
      return
    }
    if (!drives.length) {
      console.log(NO_DRIVES_YET)
      return
    }
    for (const l of formatUsage(report)) console.log(l)
  }),
})

export const PlatformDrivesCommand = cmd({
  command: "drives",
  describe: "catalog your drives — find any file without plugging the drive in, and catch sensitive files on unencrypted drives",
  builder: (y) =>
    y
      .command(ScanCommand)
      .command(FindCommand)
      .command(PathCommand)
      .command(ListCommand)
      .command(CopiesCommand)
      .command(GetCommand)
      .command(KeepCommand)
      .command(ServeCommand)
      .command(UsageCommand)
      .demandCommand(1, "Specify: scan, find, path, list, copies, get, keep, usage")
      .example("$0 drives scan /Volumes/Footage", "catalog a drive on a Mac")
      .example("$0 drives scan E:\\", "catalog a drive on Windows")
      .example("$0 drives scan ~/Projects --label \"Client projects\"", "catalog a folder")
      .example("$0 drives scan /Volumes/Backup --exclude Personal", "a private folder: never opened, remembered next time")
      .example("$0 drives find mix stems", "which drive has it — plugged in or not")
      .example('$0 drives path "Studio footage:Shoot 12/A001.mov"', "the real path, if that drive is plugged in here")
      .example("$0 drives list", "every drive: encrypted?, sensitive files, free space, connected here?")
      .example("$0 drives copies final mix", "how many identical copies exist, and on which drives")
      .example('$0 drives get "Client projects:Acme/brief.pdf" --to ~/Desktop --why "send to client"', "copy one file off a plugged-in drive — recorded in your Drives board")
      .example('$0 drives get "Studio:Stems/kick.wav" --to ~/Desktop --why "mixdown"', "the drive is plugged in at another of your machines: fetched over your Hive")
      .example('$0 drives keep "Studio:Masters" --vault masters --why "only copy"', "encrypted copies on your own drives and machines, counted and flagged when too few")
      .example("$0 drives usage", "drives, files and TB cataloged, encrypted storage, scans and copies this month")
      .epilogue(HOWTO),
  async handler() {},
})
