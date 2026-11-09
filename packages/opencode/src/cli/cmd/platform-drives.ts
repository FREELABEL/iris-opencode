/**
 * `iris drives` — catalog a drive from your own machine, no server (#192927, epic #192914).
 *
 *   iris drives scan <mount-or-folder> [--label NAME] [--kind …] [--exclude FOLDER]… [--depth 2] [--bloq N] [--dry-run]
 *   iris drives find <words…>        search every cataloged drive's manifest, plugged in or not
 *   iris drives path <drive-id>:<rel> where that file is on THIS machine right now
 *   iris drives list                 every cataloged drive
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
import { cmd } from "./cmd"
import { irisFetch, requireAuth, requireUserId, resolveToken, warn } from "./iris-api"
import { listBloqFiles, uploadFileVerified } from "./platform-atlas-files"
import {
  STORE, walk, Rollup, manifestRow, TSV_HEADER, tsvRow, seal, unseal, manifestFileText, parseManifestFile,
  manifestTitle, storeDirName, parsePlist, diskFactsFromPlist, driveIdFromDisk, parseTsv, mostCommon,
  round, todayIso, splitRef, DRIVES_BOARD_NAMES, DRIVES_BOARD_DESCRIPTION, DRIVES_DATASETS,
} from "./drives-core"

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
  if (opts.create) for (const d of DRIVES_DATASETS) await api.createDataset(d.slug, d.name, d.fields, id)
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
    return process.exit(1)
  }
  if (!board) {
    console.error(`  ${NO_DRIVES_YET}`)
    return process.exit(1)
  }
  if (board.created) console.log("  Set up your Drives catalog in Atlas — every drive you scan is listed there.")
  return board.id
}

async function signedIn(): Promise<number> {
  if (!(await requireAuth())) process.exit(1)
  const userId = await requireUserId()
  if (!userId) process.exit(1)
  return userId
}

// ── identity ─────────────────────────────────────────────────────────────────

export type Facts = {
  node: string
  filesystem: string
  encrypted: boolean
  label: string
  size_gb: number | null
  used_gb: number | null
}

function isMountPoint(p: string): boolean {
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

/** (drive id, facts) — UUID for a real filesystem, dir:<host>:<path> for a plain folder. */
export function identify(p: string, label?: string): [string, Facts] {
  const host = os.hostname()
  const mount = isMountPoint(p)
  let driveId: string
  const facts: Facts = { node: host, filesystem: "?", encrypted: false, label: "", size_gb: null, used_gb: null }

  if (process.platform === "darwin") {
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
    const st = fs.statfsSync(p)
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
    if (process.platform === "darwin") {
      // diskutil prints UUIDs uppercase; Atlas holds them lowercase (see diskFactsFromPlist).
      const d = diskFactsFromPlist(diskutilPlist(uuid.toUpperCase()) ?? diskutilPlist(uuid) ?? {})
      return d.mountPoint || null
    }
    const dev = sh("blkid", "-U", uuid)
    let mp = sh("findmnt", "-no", "TARGET", "-S", `UUID=${uuid}`).split("\n").filter(Boolean)
    if (!mp.length && dev) mp = sh("findmnt", "-no", "TARGET", dev).split("\n").filter(Boolean)
    return mp[0] ?? null
  }
  return null
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
 * the second reads back as the first, and deleting either deletes both. That destroyed BK-03's
 * manifest. So: a random filename per upload, and anything short of `verified === true` is a
 * failed upload — no record points at it and nothing older is removed.
 */
export async function uploadManifest(deps: ManifestDeps, driveId: string, tsvPath: string, today: string) {
  const { blob, keyHex } = await seal(new Uint8Array(fs.readFileSync(tsvPath)))
  const enc = path.join(path.dirname(tsvPath), `manifest-${Buffer.from(crypto.getRandomValues(new Uint8Array(8))).toString("hex")}.enc.txt`)
  fs.writeFileSync(enc, manifestFileText(blob))
  const title = manifestTitle(driveId)
  let fid: number
  try {
    const up = await deps.upload(enc, `${title} ${today}`)
    if (up.ok !== true || up.verified !== true || !up.id) {
      console.log(`  manifest upload failed: ${up.error ?? `not verified (${JSON.stringify(up).slice(0, 160)})`}`)
      return { fid: null, key: null }
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
  return { fid, key: keyHex as string }
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

function unreadableHint(): string {
  return process.platform === "darwin"
    ? "macOS refused access. The usual cause: the app running this command (Terminal, iTerm, VS Code or IRIS) does not have Full Disk Access.\n" +
        "     Open System Settings → Privacy & Security → Full Disk Access, switch it on for that app, quit and reopen the app, then scan again."
    : "re-run as a user that can read them (sudo for a drive formatted on a Mac)"
}

/** "3.0 TB" / "512.4 GB" — decimal units, as the drive's own box says. */
export function formatSize(bytes: number): string {
  if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(1)} TB`
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`
  return bytes >= 1e6 ? `${Math.round(bytes / 1e6)} MB` : "under 1 MB"
}

const plural = (n: number, one: string, many = one + "s") => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`

/** The one line a client reads after a scan (#192974). Developer detail is behind --verbose. */
export function scanSummary(s: { label: string; files: number; bytes: number; folders: number; sensitive: number; encrypted: boolean }): string {
  const head = `Cataloged '${s.label}': ${plural(s.files, "file")} · ${formatSize(s.bytes)} · ${plural(s.folders, "project folder")}`
  if (!s.sensitive) return `${head} · no sensitive files`
  return `${head} · ${plural(s.sensitive, "sensitive file")} ` +
    (s.encrypted ? "(drive encrypted — contained)" : "(drive NOT encrypted — run: iris drives list to review)")
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
      .option("dry-run", { type: "boolean", default: false, describe: "scan and show the result, send nothing to your account" })
      .option("verbose", { type: "boolean", default: false, describe: "also print the drive id, the local file list's path and each Atlas write" })
      .example("$0 drives scan /Volumes/Footage", "catalog a drive on a Mac (see your drives with: ls /Volumes)")
      .example('$0 drives scan "E:\\"', "catalog a drive on Windows")
      .example('$0 drives scan ~/Projects --label "Client projects" --kind archive-folder', "catalog a folder on this computer")
      .example('$0 drives scan /Volumes/Backup --exclude Personal/Family --exclude Taxes', "keep private folders out — never opened, remembered next time")
      .epilogue(HOWTO),
  async handler(args) {
    const verbose = args.verbose === true
    const detail = (line: string) => { if (verbose) console.log(line) }
    const dryRun = args["dry-run"] === true
    const root = fs.existsSync(String(args.path)) ? fs.realpathSync(String(args.path)) : path.resolve(String(args.path))
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
      console.error(`  Cannot see ${root} — is the drive plugged in?` + (process.platform === "darwin" ? " Your drives are listed by: ls /Volumes" : ""))
      process.exit(1)
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
    const [driveId, facts] = identify(root, args.label as string | undefined)
    const out = path.join(STORE(), storeDirName(driveId))
    fs.mkdirSync(out, { recursive: true })
    const today = todayIso()

    let remembered: string[] = []
    if (bloq) {
      try {
        for (const d of await atlasDrives(bloq)) {
          if (d.external_id === driveId) remembered = String(d.private_excluded ?? "").split("\n").filter((x) => x.trim())
        }
      } catch (e: any) {
        console.error(`  Could not read this drive's private-folder list from your account (${e?.message ?? e}).`)
        console.error("  Not scanning, so a folder you made private is never read by mistake. Check your connection and run it again.")
        process.exit(1)
      }
    } else if (dryRun) {
      console.log(warn("  Not checked against your account: folders made private from another computer are not applied to this dry run."))
    }
    const exclude = [...new Set([...(args.exclude as string[]), ...remembered])].sort()
    console.log(`Scanning ${facts.label} (${root})`)
    detail(`  id ${driveId} · ${facts.label} · ${facts.filesystem} · encrypted=${facts.encrypted ? "True" : "False"}`)
    if (exclude.length) console.log(`  Private folders skipped, never opened: ${exclude.length}`)

    const rollup = new Rollup(Number(args.depth))
    const unreadable: string[] = []
    const tmp = path.join(out, "files.tsv.part")
    const fd = fs.openSync(tmp, "w")
    let buf = tsvRow(TSV_HEADER)
    for (const e of walk(root, { excludes: exclude, unreadable })) {
      rollup.add(e)
      buf += manifestRow(e)
      if (buf.length > 1 << 20) { fs.writeSync(fd, buf); buf = "" }
      if (rollup.files % 20000 === 0) console.log(`  … ${rollup.files.toLocaleString("en-US")} files`)
    }
    fs.writeSync(fd, buf)
    fs.closeSync(fd)
    const tsvPath = path.join(out, "files.tsv")
    fs.renameSync(tmp, tsvPath)
    if (facts.size_gb == null) facts.size_gb = facts.used_gb = round(rollup.total / 1e9, 1)

    const status = facts.encrypted ? "contained" : "exposed"
    const driveRow: Record<string, any> = {
      external_id: driveId, label: facts.label, kind: args.kind, node: facts.node,
      filesystem: facts.filesystem, encrypted: facts.encrypted, size_gb: facts.size_gb,
      used_gb: facts.used_gb, files: rollup.files, folders: rollup.folders.size, sensitive_files: rollup.findings.length,
      last_scanned: today, manifest: "", private_excluded: exclude.join("\n"),
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
    const summary = scanSummary({
      label: facts.label, files: rollup.files, bytes: rollup.total, folders: rollup.folders.size,
      sensitive: rollup.findings.length, encrypted: facts.encrypted,
    })

    if (dryRun || !bloq || !userId) {
      console.log(`Dry run — nothing was sent to your account. ${summary.replace(/^Cataloged/, "Would catalog").replace(" — run: iris drives list to review", "")}`)
      return
    }
    // Findings no longer on the drive are CLOSED (status moved), not left saying "exposed".
    try {
      const cur = new Set(findingRows.map((r) => r.external_id))
      const old = await atlasRecords("drive-findings", bloq, { drive_id: driveId })
      const gone = old.filter((r) => !cur.has(r.external_id) && r?.data?.status !== "moved")
      for (const r of gone) {
        await irisFetch(`/api/v1/atlas/datasets/drive-findings/${r.id}`, { method: "PATCH", body: JSON.stringify({ data: { status: "moved" } }) })
      }
      if (gone.length) console.log(`  ${plural(gone.length, "sensitive file")} from the last scan ${gone.length === 1 ? "is" : "are"} no longer on this drive — marked moved`)
    } catch (e: any) {
      console.log(warn(`  Could not update the sensitive files found by the last scan: ${e?.message ?? e}`))
      process.exitCode = 1
    }
    const { fid, key } = await uploadManifest(liveDeps(userId, bloq), driveId, tsvPath, today)
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
  },
})

/** Every cataloged drive, or a plain sentence and a non-zero exit. */
async function drivesOrExit(bloq: number): Promise<any[]> {
  try {
    return await atlasDrives(bloq)
  } catch (e: any) {
    console.error(`  Could not read your drives from your account (${e?.message ?? e}). Check your connection and try again.`)
    return process.exit(1)
  }
}

const FindCommand = cmd({
  command: "find <words..>",
  describe: "search every cataloged drive for a file — works with the drive unplugged, on any computer you sign in to",
  builder: (y) =>
    y
      .positional("words", { type: "string", array: true, demandOption: true })
      .option("limit", { type: "number", default: 8, describe: "matches shown per drive" })
      .option("bloq", BLOQ_OPTION)
      .example("$0 drives find freetrap stems", "every file whose path has both words, on every drive")
      .example("$0 drives find A001 .mov --limit 50", "more matches per drive")
      .epilogue(HOWTO),
  async handler(args) {
    const userId = await signedIn()
    const bloq = await requireDrivesBoard(liveBoardApi(userId), overrideBloq(args.bloq), { create: false })
    const words = (args.words as string[]).map((w) => String(w).toLowerCase())
    const limit = Number(args.limit)
    let hits = 0
    const drives = await drivesOrExit(bloq)
    if (!drives.length) {
      console.error(`  ${NO_DRIVES_YET}`)
      process.exit(1)
    }
    for (const drive of drives) {
      const text = await cachedManifest(userId, bloq, drive).catch(() => null)
      if (!text) { console.log(`\n${drive.label}: not searchable yet — scan it again`); continue }
      const state = online(drive) ? "connected to this computer" : "not connected here — found from its catalog"
      let shown = 0
      for (const row of parseTsv(text)) {
        const p = row.path.toLowerCase()
        if (!words.every((w) => p.includes(w))) continue
        if (shown === 0) console.log(`\n${drive.label} · ${state}`)
        if (shown < limit) console.log(`  ${row.path}  · ${(Number(row.bytes) / 1e9).toFixed(2)} GB · ${row.kind} · ${row.modified}`)
        shown++
        hits++
      }
      if (shown > limit) console.log(`  … and ${shown - limit} more on ${drive.label}`)
    }
    if (!hits) console.log("Nothing found on any cataloged drive.")
    else console.log(`\nWhere a file is on this computer right now: iris drives path <drive>:<path>   (iris drives list shows each drive)`)
  },
})

const PathCommand = cmd({
  command: "path <ref>",
  describe: "where a cataloged file is on this computer right now — or exit 2 (drive not connected) / 3 (moved or deleted)",
  builder: (y) =>
    y
      .positional("ref", { type: "string", demandOption: true, describe: "<drive>:<path inside the drive>, the drive as shown by iris drives list" })
      .option("bloq", BLOQ_OPTION)
      .example('$0 drives path "Studio footage:Shoot 12/A001.mov"', "the full path, if that drive is plugged into this computer")
      .epilogue(HOWTO),
  async handler(args) {
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
          process.exit(1)
        }
        for (const d of await atlasDrives(bloq)) labels[d.external_id] = d.label
      } catch {
        labels = {} // names are a nicety; resolving the path does not need Atlas
      }
    }
    // A drive can be named by its label as well as its id.
    const byLabel = Object.fromEntries(Object.entries(labels).map(([id, l]) => [String(l), id]))
    let ref = String(args.ref)
    const label = Object.keys(byLabel).sort((a, b) => b.length - a.length).find((l) => ref.startsWith(l + ":"))
    if (label) ref = byLabel[label] + ref.slice(label.length)
    const [driveId, rel] = splitRef(ref, Object.keys(labels))
    const mount = resolveMount(driveId)
    const name = labels[driveId] ?? driveId
    if (!mount) {
      console.log(`Not a valid path right now: ${name} is not connected to this computer`)
      process.exit(2)
    }
    const full = path.join(mount, rel)
    if (!fs.existsSync(full)) {
      console.log(`${name} is connected at ${mount}, but ${rel} is not there (moved or deleted since the last scan)`)
      process.exit(3)
    }
    console.log(full)
  },
})

const ListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "every cataloged drive: encrypted or not, sensitive files, connected here or not, last scanned",
  builder: (y) => y.option("bloq", BLOQ_OPTION).example("$0 drives list", "your drives at a glance").epilogue(HOWTO),
  async handler(args) {
    const userId = await signedIn()
    const bloq = await requireDrivesBoard(liveBoardApi(userId), overrideBloq(args.bloq), { create: false })
    const drives = await drivesOrExit(bloq)
    if (!drives.length) {
      console.error(`  ${NO_DRIVES_YET}`)
      process.exit(1)
    }
    for (const d of drives) {
      console.log(
        `${String(d.label).padEnd(24)} ${Number(d.files ?? 0).toLocaleString("en-US").padStart(9)} files  ${String(d.used_gb).padStart(8)} GB  ` +
          `${(d.encrypted ? "encrypted" : "NOT encrypted").padEnd(13)} ${String(d.sensitive_files ?? 0).padStart(4)} sensitive  ` +
          `${online(d) ? "online" : "offline"}  scanned ${d.last_scanned}` +
          (Number(d.unreadable_folders) > 0 ? `  ${warn(`(${d.unreadable_folders} unreadable folder(s))`)}` : ""),
      )
    }
  },
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
      .demandCommand(1, "Specify: scan, find, path, list")
      .example("$0 drives scan /Volumes/Footage", "catalog a drive on a Mac")
      .example('$0 drives scan "E:\\"', "catalog a drive on Windows")
      .example("$0 drives scan ~/Projects --label \"Client projects\"", "catalog a folder")
      .example("$0 drives scan /Volumes/Backup --exclude Personal", "a private folder: never opened, remembered next time")
      .example("$0 drives find freetrap stems", "which drive has it — plugged in or not")
      .example('$0 drives path "Studio footage:Shoot 12/A001.mov"', "the real path, if that drive is plugged in here")
      .example("$0 drives list", "every drive: encrypted?, sensitive files, connected here?")
      .epilogue(HOWTO),
  async handler() {},
})
