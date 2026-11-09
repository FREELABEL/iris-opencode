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
import { irisFetch, requireAuth, requireUserId, dim, warn } from "./iris-api"
import { listBloqFiles, uploadFileVerified } from "./platform-atlas-files"
import {
  STORE, walk, Rollup, manifestRow, TSV_HEADER, tsvRow, seal, unseal, manifestFileText, parseManifestFile,
  manifestTitle, storeDirName, parsePlist, diskFactsFromPlist, driveIdFromDisk, parseTsv, mostCommon,
  round, todayIso, splitRef,
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

function resolveBloq(flag: unknown): number | null {
  const v = flag ?? process.env.IRIS_DRIVES_BLOQ
  const n = Number(v)
  return v != null && v !== "" && Number.isFinite(n) && n > 0 ? n : null
}

function noBloq(): never {
  console.error("  No Drives bloq. Pass --bloq <id> or set IRIS_DRIVES_BLOQ (the board your drives catalog lives on).")
  process.exit(1)
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
async function uploadManifest(userId: number, bloq: number, driveId: string, tsvPath: string, today: string) {
  const { blob, keyHex } = await seal(new Uint8Array(fs.readFileSync(tsvPath)))
  const enc = tsvPath + ".enc.txt"
  fs.writeFileSync(enc, manifestFileText(blob))
  const title = manifestTitle(driveId)
  let fid: number
  try {
    const up = await uploadFileVerified(userId, bloq, enc, { title: `${title} ${today}` })
    if (!up.ok) {
      console.log(`  manifest upload failed: ${up.error}`)
      return { fid: null, key: null }
    }
    fid = up.id
  } finally {
    fs.rmSync(enc, { force: true })
  }
  const listed = await listBloqFiles(userId, bloq)
  if (listed.ok) {
    const old = listed.files.filter((f) => String(f.title ?? f.name ?? "").startsWith(title + " ") && f.id !== fid)
    for (const f of old) await irisFetch(`/api/v1/cloud-files/${f.id}`, { method: "DELETE" })
  }
  return { fid, key: keyHex }
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

const ScanCommand = cmd({
  command: "scan <path>",
  describe: "catalog a drive or folder into Atlas (encrypted per-file manifest + folder and finding rows)",
  builder: (y) =>
    y
      .positional("path", { type: "string", demandOption: true, describe: "mount point or folder" })
      .option("label", { type: "string", describe: "name for the drive (default: volume label or folder name)" })
      .option("kind", { type: "string", choices: KIND_CHOICES as unknown as string[], default: "media-drive" })
      .option("exclude", { type: "string", array: true, default: [] as string[], describe: "private folder (relative): never opened or indexed; remembered on the drive in Atlas" })
      .option("depth", { type: "number", default: 2, describe: "folder rollup depth" })
      .option("bloq", { type: "number", alias: "atlas-bloq", describe: "Drives bloq id (default: $IRIS_DRIVES_BLOQ)" })
      .option("dry-run", { type: "boolean", default: false, describe: "scan and write the local manifest, send nothing" }),
  async handler(args) {
    const root = fs.existsSync(String(args.path)) ? fs.realpathSync(String(args.path)) : path.resolve(String(args.path))
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
      console.error(`not a folder: ${root}`)
      process.exit(1)
    }
    const bloq = resolveBloq(args.bloq)
    if (!bloq && !args["dry-run"]) noBloq()
    const [driveId, facts] = identify(root, args.label as string | undefined)
    const out = path.join(STORE(), storeDirName(driveId))
    fs.mkdirSync(out, { recursive: true })
    const today = todayIso()

    // Private folders are remembered IN ATLAS on the drive's record, so a scan from any machine
    // inherits them. Unreadable Atlas = refuse; a privacy promise is not kept from a local guess.
    let userId: number | null = null
    let remembered: string[] = []
    if (bloq) {
      if (!(await requireAuth())) process.exit(1)
      userId = await requireUserId()
      if (!userId) process.exit(1)
      try {
        for (const d of await atlasDrives(bloq)) {
          if (d.external_id === driveId) remembered = String(d.private_excluded ?? "").split("\n").filter((x) => x.trim())
        }
      } catch (e: any) {
        console.error(`cannot read this drive's private-folder list from Atlas (${e?.message ?? e}) — refusing to scan blind`)
        process.exit(1)
      }
    } else {
      console.log(warn("  no Drives bloq: folders made private on another machine are NOT applied to this dry run"))
    }
    const exclude = [...new Set([...(args.exclude as string[]), ...remembered])].sort()
    console.log(`scanning ${root}\n  id ${driveId} · ${facts.label} · ${facts.filesystem} · encrypted=${facts.encrypted ? "True" : "False"}`)
    if (exclude.length) console.log(`  never opened (private): ${exclude.length} folder(s)`)

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

    console.log(
      `  ${rollup.files.toLocaleString("en-US")} files · ${(rollup.total / 1e9).toFixed(1)} GB · ${rollup.folders.size.toLocaleString("en-US")} folders · ${rollup.findings.length} sensitive (${status})`,
    )
    if (unreadable.length) {
      console.log(warn(`  ⚠ INCOMPLETE: ${unreadable.length} folder(s) could not be read — the catalog is missing them:`))
      for (const u of unreadable.slice(0, 8)) console.log(`     ${u}`)
      if (unreadable.length > 8) console.log(`     … and ${unreadable.length - 8} more (all listed in ${path.join(out, "drive.json")})`)
      console.log(`     ${unreadableHint()}`)
    }
    console.log("  " + mostCommon(rollup.kinds()).map(([k, c]) => `${k} ${c.toLocaleString("en-US")}`).join(" · "))
    console.log(`  manifest: ${tsvPath}`)

    if (args["dry-run"] || !bloq || !userId) {
      console.log("  (not sent to Atlas — pass --bloq and drop --dry-run)")
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
      if (gone.length) console.log(`  closed ${gone.length} finding(s) no longer on this drive`)
    } catch (e: any) {
      console.log(`  could not reconcile old findings: ${e?.message ?? e}`)
    }
    const { fid, key } = await uploadManifest(userId, bloq, driveId, tsvPath, today)
    driveRow.manifest = fid ? `atlas-file:${fid}` : ""
    driveRow.manifest_key = key ?? ""
    console.log(`  manifest in Atlas: ${driveRow.manifest || "UPLOAD FAILED"}`)
    for (const [schema, rows] of [["drives", [driveRow]], ["drive-folders", folderRows], ["drive-findings", findingRows]] as const) {
      if (!rows.length) { console.log(`  atlas ${schema}: nothing to send`); continue }
      try {
        const r = await importRows(schema, bloq, rows as any[])
        console.log(`  atlas ${schema}: ${rows.length} rows → created ${r.created} · updated ${r.updated} · failed ${r.failed}`)
      } catch (e: any) {
        console.log(`  atlas ${schema}: IMPORT FAILED — ${String(e?.message ?? e).slice(0, 300)}`)
        process.exitCode = 1
      }
    }
    if (!fid) process.exitCode = 1
  },
})

const FindCommand = cmd({
  command: "find <words..>",
  describe: "search every cataloged drive's file list (works with the drive unplugged, on any signed-in machine)",
  builder: (y) =>
    y
      .positional("words", { type: "string", array: true, demandOption: true })
      .option("limit", { type: "number", default: 8, describe: "matches shown per drive" })
      .option("bloq", { type: "number", alias: "atlas-bloq", describe: "Drives bloq id (default: $IRIS_DRIVES_BLOQ)" }),
  async handler(args) {
    const bloq = resolveBloq(args.bloq) ?? noBloq()
    if (!(await requireAuth())) process.exit(1)
    const userId = await requireUserId()
    if (!userId) process.exit(1)
    const words = (args.words as string[]).map((w) => String(w).toLowerCase())
    const limit = Number(args.limit)
    let hits = 0
    for (const drive of await atlasDrives(bloq)) {
      const text = await cachedManifest(userId, bloq, drive)
      if (!text) { console.log(`\n${drive.label}: no manifest in Atlas yet — scan it`); continue }
      const state = online(drive) ? "connected to this machine" : "not connected here — found from its Atlas manifest"
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
    if (!hits) console.log("nothing found on any cataloged drive")
  },
})

const PathCommand = cmd({
  command: "path <ref>",
  describe: "drive-id:relative/path → the real path on this machine, or exit 2 (not connected) / 3 (moved or deleted)",
  builder: (y) =>
    y
      .positional("ref", { type: "string", demandOption: true, describe: "drive-id:relative/path" })
      .option("bloq", { type: "number", alias: "atlas-bloq", describe: "Drives bloq id (default: $IRIS_DRIVES_BLOQ)" }),
  async handler(args) {
    const bloq = resolveBloq(args.bloq)
    let labels: Record<string, string> = {}
    if (bloq && (await requireAuth())) {
      try {
        for (const d of await atlasDrives(bloq)) labels[d.external_id] = d.label
      } catch {
        labels = {} // names are a nicety; resolving the path does not need Atlas
      }
    }
    const [driveId, rel] = splitRef(String(args.ref), Object.keys(labels))
    const mount = resolveMount(driveId)
    const name = labels[driveId] ?? driveId
    if (!mount) {
      console.log(`not a valid path right now: ${name} is not connected to this machine`)
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
  describe: "every drive cataloged in Atlas, and whether it is connected here",
  builder: (y) => y.option("bloq", { type: "number", alias: "atlas-bloq", describe: "Drives bloq id (default: $IRIS_DRIVES_BLOQ)" }),
  async handler(args) {
    const bloq = resolveBloq(args.bloq) ?? noBloq()
    if (!(await requireAuth())) process.exit(1)
    const drives = await atlasDrives(bloq)
    if (!drives.length) { console.log(dim(`  no drives cataloged on bloq ${bloq} yet — iris drives scan <mount>`)); return }
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
  describe: "catalog your drives in Atlas — scan, find a file on any drive, resolve its path, list",
  builder: (y) =>
    y
      .command(ScanCommand)
      .command(FindCommand)
      .command(PathCommand)
      .command(ListCommand)
      .demandCommand(1, "Specify: scan, find, path, list"),
  async handler() {},
})
