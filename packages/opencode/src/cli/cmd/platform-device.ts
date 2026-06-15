import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import {
  irisFetch,
  requireAuth,
  handleApiError,
  requireUserId,
  printDivider,
  printKV,
  dim,
  bold,
  success,
  highlight,
  isNonInteractive,
} from "./iris-api"
import * as device from "../lib/device"
import { homedir, hostname, platform } from "os"
import { join } from "path"
import { existsSync, mkdirSync, appendFileSync } from "fs"
import { execSync } from "child_process"

// ============================================================================
// iris device / iris storage — Phase 1: scan (read-only disk audit) + log
// (storage trend). NO deletion/clean here — that is a later phase.
// ============================================================================
//
// Productizes a real workflow: a Mac and iPhone were critically full. We need
// (a) an accurate Mac disk audit and (b) automatic tracking of storage readings
// over time.
//
// HARD-WON GOTCHA #1 — the purgeable-API lie (iPhone):
//   iPhone free space CANNOT be read reliably over USB. `ideviceinfo -q
//   com.apple.disk_usage`'s `TotalDataAvailable` reports frozen "purgeable"
//   space — it reported 216 GB free on a phone that was actually 254/256 GB
//   full. So iPhone readings MUST be typed by the user from
//   Settings -> General -> iPhone Storage. Mac auto-read via `df -k /` is accurate.
//
// HARD-WON GOTCHA #2 — Image Capture cable-delete failure (future phone-offload):
//   When the phone's photo library is iCloud-managed and full, deleting photos
//   over the cable via Image Capture fails with
//   `com.apple.ImageCaptureCore error -9934`. Any future "offload phone" phase
//   must account for this — cable deletion is not a reliable reclaim path.

// The repo's existing disk-cleaner engine. Reused when present + python3 is
// found; otherwise scan falls back to native shell (df/du via lib/device).
const DISK_CLEANER_SCRIPT = join(
  homedir(),
  "Sites",
  "freelabel",
  "disk-cleaner",
  "skills",
  "disk-cleaner",
  "scripts",
  "analyze_disk.py",
)

// Local audit trail that survives even when the user is not authenticated.
const LOCAL_LOG = join(homedir(), ".iris", "device-health.md")

const FIND_OR_CREATE_BLOQ_NAME = "Device Health"
const READINGS_LIST_NAME = "Readings"

// ============================================================================
// Types
// ============================================================================

type DiskUsage = { path: string; total_gb: number; used_gb: number; free_gb: number; usage_percent: number }
type SizeEntry = { path: string; name: string; size_gb: number; category: string; safe: boolean }
type ScanResult = {
  usage: DiskUsage
  entries: SizeEntry[]
  reclaimable_gb: number
  source: "disk-cleaner" | "native"
}

type Reading = {
  timestamp: string
  device: string
  used_gb: number
  capacity_gb: number
  free_gb: number
  delta_gb: number | null
}

// ============================================================================
// scan helpers
// ============================================================================

function detectPython(): string | null {
  for (const bin of ["python3", "python"]) {
    try {
      execSync(`command -v ${bin}`, { stdio: ["ignore", "pipe", "ignore"] })
      return bin
    } catch {}
  }
  return null
}

// Parse `du -sk` (KB) for a path into GB. 0 when missing/permission-denied.
function duGb(path: string): number {
  if (!existsSync(path)) return 0
  try {
    const out = execSync(`du -sk "${path}" 2>/dev/null`, { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim()
    const kb = parseInt(out.split(/\s+/)[0], 10)
    return isNaN(kb) ? 0 : kb / (1024 * 1024)
  } catch {
    return 0
  }
}

// Overall usage of the volume containing `path`, via `df -k`. macOS + Linux.
// On macOS, `/` is the read-only synthetic system snapshot — `df /` reports the
// container's shared free space but NOT the true used figure of the data volume.
// (This is the same class of illusion as the iPhone purgeable lie: `df /` showed
// ~9 GB "free" while the data volume was actually 99.98% full.) Read the real
// data volume instead. Falls back to "/" on non-macOS or if the path is absent.
function primaryVolume(): string {
  if (platform() === "darwin" && existsSync("/System/Volumes/Data")) return "/System/Volumes/Data"
  return "/"
}

function dfUsage(path: string): DiskUsage {
  const out = execSync(`df -k "${path}"`, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim()
  const lines = out.split("\n")
  const cols = lines[lines.length - 1].trim().split(/\s+/)
  const totalKb = parseInt(cols[1], 10) || 0
  const usedKb = parseInt(cols[2], 10) || 0
  const freeKb = parseInt(cols[3], 10) || 0
  const total = totalKb / (1024 * 1024)
  const used = usedKb / (1024 * 1024)
  return {
    path,
    total_gb: Math.round(total * 100) / 100,
    used_gb: Math.round(used * 100) / 100,
    free_gb: Math.round((freeKb / (1024 * 1024)) * 100) / 100,
    usage_percent: total > 0 ? Math.round((used / total) * 10000) / 100 : 0,
  }
}

// Label a path by category + whether it's safe to reclaim without review.
function categorize(path: string): { category: string; safe: boolean } {
  const p = path.toLowerCase()
  if (p.includes("/caches") || p.includes("/cache")) return { category: "cache", safe: true }
  if (p.includes("/.trash") || p.includes("/trash")) return { category: "trash", safe: true }
  if (p.endsWith(".dmg") || p.endsWith(".crdownload")) return { category: "installer", safe: true }
  if (p.includes("/node_modules")) return { category: "dev", safe: false }
  if (p.includes("/downloads")) return { category: "downloads", safe: false }
  if (p.includes("/movies") || p.endsWith(".mov") || p.endsWith(".mp4")) return { category: "media", safe: false }
  if (p.includes("/messages")) return { category: "messages", safe: false }
  return { category: "other", safe: false }
}

// Sum obviously-reclaimable Downloads cruft: app installers (*.dmg), aborted
// downloads (*.crdownload), and zips whose extracted folder already exists.
function downloadsCruftGb(downloads: string): number {
  if (!existsSync(downloads)) return 0
  let gb = 0
  try {
    const dmgCr = execSync(
      `find "${downloads}" -maxdepth 1 \\( -iname '*.dmg' -o -iname '*.crdownload' \\) 2>/dev/null`,
      { stdio: ["ignore", "pipe", "ignore"] },
    )
      .toString()
      .trim()
    if (dmgCr) for (const p of dmgCr.split("\n")) gb += duGb(p)

    const zips = execSync(`find "${downloads}" -maxdepth 1 -iname '*.zip' 2>/dev/null`, {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim()
    if (zips)
      for (const z of zips.split("\n")) {
        const folder = z.replace(/\.zip$/i, "")
        if (existsSync(folder)) gb += duGb(z)
      }
  } catch {}
  return Math.round(gb * 100) / 100
}

// Native macOS-first fallback. Reuses lib/device for df + top folders, then
// adds a node_modules sweep. Guarded so it does not crash on Linux.
function nativeScan(root: string): ScanResult {
  const usage = root === "/" || root === homedir() ? dfUsage(primaryVolume()) : dfUsage(root)
  const entries: SizeEntry[] = []

  // Reuse lib/device's curated Mac hotspot list when scanning the home dir;
  // otherwise size a smaller set under the requested root.
  const folders =
    platform() === "darwin" && root === homedir()
      ? device.getMacTopFolders().map((f) => ({ path: f.path.replace("~", homedir()), gb: f.size_bytes / (1024 ** 3) }))
      : [
          ["Downloads", join(root, "Downloads")],
          ["Library/Caches", join(root, "Library", "Caches")],
          ["Movies", join(root, "Movies")],
          [".Trash", join(root, ".Trash")],
        ].map(([, p]) => ({ path: p, gb: duGb(p) }))

  for (const f of folders) {
    if (f.gb <= 0.01) continue
    const cat = categorize(f.path)
    entries.push({ path: f.path, name: f.path.replace(homedir(), "~"), size_gb: Math.round(f.gb * 100) / 100, category: cat.category, safe: cat.safe })
  }

  // node_modules sweep (development cruft).
  try {
    const out = execSync(
      `find "${root}" -maxdepth 4 -type d -name node_modules -prune -print 2>/dev/null | head -200`,
      { stdio: ["ignore", "pipe", "ignore"] },
    )
      .toString()
      .trim()
    let nmGb = 0
    if (out) for (const p of out.split("\n")) nmGb += duGb(p)
    if (nmGb > 0.5)
      entries.push({
        path: `${root}/**/node_modules`,
        name: "node_modules (dev)",
        size_gb: Math.round(nmGb * 100) / 100,
        category: "dev",
        safe: false,
      })
  } catch {}

  let reclaimable = entries.filter((e) => e.safe).reduce((sum, e) => sum + e.size_gb, 0)
  reclaimable += downloadsCruftGb(join(root, "Downloads"))

  entries.sort((a, b) => b.size_gb - a.size_gb)
  return { usage, entries, reclaimable_gb: Math.round(reclaimable * 100) / 100, source: "native" }
}

// Drive the disk-cleaner python engine. Maps its report JSON onto ScanResult.
function diskCleanerScan(py: string, root: string): ScanResult {
  const out = execSync(`${py} "${DISK_CLEANER_SCRIPT}" --path "${root}" --json`, {
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 64 * 1024 * 1024,
  }).toString()
  // The script may print warnings before JSON — grab from the first "{".
  const report = JSON.parse(out.slice(out.indexOf("{"))) as {
    disk_usage: DiskUsage
    temp_analysis?: { temp_directories?: Array<{ size_gb: number }> }
    scan_results?: {
      directories?: Array<{ path: string; name: string; size_gb: number }>
      files?: Array<{ path: string; name: string; size_gb: number }>
    }
  }

  const entries: SizeEntry[] = []
  for (const d of [...(report.scan_results?.directories ?? []), ...(report.scan_results?.files ?? [])]) {
    const cat = categorize(d.path)
    entries.push({ path: d.path, name: d.name, size_gb: d.size_gb, category: cat.category, safe: cat.safe })
  }

  let reclaimable = (report.temp_analysis?.temp_directories ?? []).reduce((sum, t) => sum + t.size_gb, 0)
  reclaimable += downloadsCruftGb(join(root, "Downloads"))

  entries.sort((a, b) => b.size_gb - a.size_gb)
  return {
    usage: report.disk_usage,
    entries: entries.slice(0, 25),
    reclaimable_gb: Math.round(reclaimable * 100) / 100,
    source: "disk-cleaner",
  }
}

function gb(n: number): string {
  return `${n.toFixed(1)} GB`
}

// ============================================================================
// Subcommand: scan — read-only local disk audit (no auth, never deletes)
// ============================================================================

const ScanCommand = cmd({
  command: "scan",
  aliases: ["audit"],
  describe: "audit local disk usage (read-only — never deletes anything)",
  builder: (yargs) =>
    yargs
      .option("path", { describe: "directory to scope the scan (default: home dir)", type: "string" })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    const root = (args.path as string | undefined) ?? homedir()

    if (!args.json) {
      UI.empty()
      prompts.intro("◈  Device Scan")
    }

    const spinner = args.json ? null : prompts.spinner()
    if (spinner) spinner.start("Auditing disk…")

    let result: ScanResult | null = null
    const py = detectPython()
    if (py && existsSync(DISK_CLEANER_SCRIPT)) {
      try {
        result = diskCleanerScan(py, root)
      } catch {}
    }
    // Fall back to native shell when disk-cleaner is unavailable or errored.
    if (!result) {
      try {
        result = nativeScan(root)
      } catch (err) {
        if (spinner) spinner.stop("Failed", 1)
        const msg = err instanceof Error ? err.message : String(err)
        if (args.json) console.log(JSON.stringify({ success: false, error: msg }))
        else prompts.log.error(`Scan failed: ${msg}`)
        process.exitCode = 1
        return
      }
    }

    if (args.json) {
      console.log(JSON.stringify(result, null, 2))
      return
    }

    spinner!.stop(`${success("✓")} Scanned ${dim(root)} ${dim(`(via ${result.source})`)}`)

    const u = result.usage
    printDivider()
    printKV("Volume", u.path)
    printKV("Total", gb(u.total_gb))
    printKV("Used", `${gb(u.used_gb)} (${u.usage_percent}%)`)
    printKV("Free", gb(u.free_gb))
    if (u.usage_percent > 90) prompts.log.warn("Disk critically full")
    else if (u.usage_percent > 80) prompts.log.warn("Disk running low on space")
    console.log()

    console.log(`  ${bold("Biggest space consumers")}`)
    for (const e of result.entries.slice(0, 15)) {
      const tag = e.safe ? success("safe") : dim("review")
      console.log(`    ${gb(e.size_gb).padStart(9)}  ${e.name}  ${dim(`[${e.category}]`)}  ${tag}`)
    }
    console.log()

    printDivider()
    console.log(`  ${bold("Safely reclaimable (est.):")} ${highlight(gb(result.reclaimable_gb))}`)
    console.log(`  ${dim("caches · trash · *.dmg installers · *.crdownload · redundant zips")}`)
    printDivider()

    prompts.outro(`${dim("iris device log --device mac")}  Record a reading`)
  },
})

// ============================================================================
// Subcommand: log — record a storage reading + show the trend
// ============================================================================

const LogCommand = cmd({
  command: "log",
  aliases: ["record"],
  describe:
    "record a storage reading + show the trend. NOTE: iPhone free space CANNOT be read over USB " +
    "(ideviceinfo TotalDataAvailable reports frozen purgeable space and lies) — type the used-GB " +
    "from Settings -> General -> iPhone Storage. Mac auto-reads via df.",
  builder: (yargs) =>
    yargs
      .option("device", { describe: "device name (default: Mac hostname). e.g. iphone", type: "string" })
      .option("gb", { describe: "used space in GB (auto-read for Mac; required/prompted for iPhone)", type: "number" })
      .option("capacity", { describe: "total capacity in GB (default: 256 for iphone, auto for Mac)", type: "number" })
      .option("json", { describe: "JSON output", type: "boolean", default: false })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" }),
  async handler(args) {
    if (!args.json) {
      UI.empty()
      prompts.intro("◈  Device Storage Log")
    }

    const deviceName = (args.device as string | undefined) ?? hostname().replace(/\.local$/, "")
    const isPhone = /phone|ipad|ios/i.test(deviceName)

    let usedGb = args.gb as number | undefined
    let capacityGb = args.capacity as number | undefined
    let freeGbOverride: number | undefined

    // Mac: auto-read via df. Report TRUE free from df's available column — NOT
    // capacity-minus-used. On APFS the read-only system volume + purgeable space
    // sit between df's "used" and total, so `used = total - available` is the
    // honest "how full am I" figure and matches what `device scan` reports.
    if (!isPhone && usedGb === undefined) {
      try {
        const u = dfUsage(primaryVolume())
        if (capacityGb === undefined) capacityGb = u.total_gb
        freeGbOverride = u.free_gb
        usedGb = Math.round((u.total_gb - u.free_gb) * 100) / 100
      } catch {}
    }

    if (capacityGb === undefined) capacityGb = 256 // iPhone default; Mac falls through here only if df failed

    if (usedGb === undefined) {
      // CRITICAL: for iPhone the used figure MUST come from the user — the USB
      // API (ideviceinfo TotalDataAvailable) reports purgeable space and lied
      // (216 GB "free" on a 254/256 full phone). Prompt only in a TTY.
      if (isNonInteractive()) {
        const msg = "Missing --gb (used space). For iPhone, read it from Settings -> General -> iPhone Storage."
        if (args.json) console.log(JSON.stringify({ success: false, error: msg }))
        else prompts.log.error(msg)
        process.exitCode = 2
        return
      }
      if (isPhone)
        prompts.log.info(dim("Read the used figure from Settings -> General -> iPhone Storage (USB reads are unreliable)."))
      const typed = await prompts.text({
        message: `Used space on ${deviceName} (GB)`,
        placeholder: "e.g. 254",
        validate: (x) => (x && !isNaN(parseFloat(x)) ? undefined : "Enter a number"),
      })
      if (prompts.isCancel(typed)) {
        prompts.outro("Cancelled")
        return
      }
      usedGb = parseFloat(String(typed))
    }

    const reading: Reading = {
      timestamp: new Date().toISOString(),
      device: deviceName,
      used_gb: Math.round(usedGb * 100) / 100,
      capacity_gb: capacityGb,
      free_gb: freeGbOverride !== undefined ? freeGbOverride : Math.round((capacityGb - usedGb) * 100) / 100,
      delta_gb: null,
    }

    // Auth: persist to the Device Health bloq. Fall back to local file.
    const token = await requireAuth()
    if (!token) {
      writeLocal(reading)
      if (args.json) {
        console.log(JSON.stringify({ success: false, persisted: "local", reading }, null, 2))
        return
      }
      prompts.log.warn("Not authenticated — reading saved locally instead.")
      printReadingSummary(reading)
      prompts.outro(dim(`Appended to ${LOCAL_LOG}`))
      return
    }

    const userId = await requireUserId(args["user-id"] as number | undefined)
    if (!userId) {
      writeLocal(reading)
      if (args.json) console.log(JSON.stringify({ success: false, persisted: "local", reading }, null, 2))
      else prompts.log.warn(`Reading saved locally (${LOCAL_LOG}).`)
      return
    }

    const spinner = args.json ? null : prompts.spinner()
    if (spinner) spinner.start("Saving reading…")

    try {
      const target = await findOrCreateBloqList(userId)
      if (!target) {
        if (spinner) spinner.stop("Failed", 1)
        writeLocal(reading)
        const msg = "Could not find-or-create the Device Health bloq — saved locally."
        if (args.json) console.log(JSON.stringify({ success: false, persisted: "local", reading, error: msg }))
        else prompts.log.warn(msg)
        return
      }

      // Delta vs the most-recent prior reading for THIS device.
      const prior = await fetchReadings(userId, target.bloqId)
      const lastForDevice = prior
        .filter((r) => r.device === deviceName)
        .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
        .pop()
      reading.delta_gb = lastForDevice ? Math.round((reading.used_gb - lastForDevice.used_gb) * 100) / 100 : null

      const deltaStr = reading.delta_gb === null ? "" : ` (${reading.delta_gb >= 0 ? "+" : ""}${reading.delta_gb} GB)`
      const title = `${deviceName} — ${reading.used_gb} GB used, ${reading.free_gb} GB free${deltaStr}`

      // add-item: POST { title, content } to the list's /items route — same
      // shape as platform-bloqs BloqsAddItemCommand. content holds the JSON blob.
      const res = await irisFetch(
        `/api/v1/user/${userId}/bloqs/${target.bloqId}/lists/${target.listId}/items`,
        { method: "POST", body: JSON.stringify({ title, content: JSON.stringify(reading) }) },
      )
      if (!res.ok) {
        if (spinner) spinner.stop("Failed", 1)
        writeLocal(reading)
        await handleApiError(res, "Save reading")
        if (!args.json) prompts.log.warn(`Reading saved locally (${LOCAL_LOG}) as a fallback.`)
        return
      }

      if (spinner) spinner.stop(`${success("✓")} Reading saved to ${bold(FIND_OR_CREATE_BLOQ_NAME)}`)

      const all = [...prior, reading].sort((a, b) => a.timestamp.localeCompare(b.timestamp))
      if (args.json) {
        console.log(JSON.stringify({ success: true, reading, readings: all }, null, 2))
        return
      }
      printTrend(all)
      prompts.outro(`${dim("iris device scan")}  Audit local disk`)
    } catch (err) {
      if (spinner) spinner.stop("Error", 1)
      writeLocal(reading)
      const msg = err instanceof Error ? err.message : String(err)
      if (args.json) console.log(JSON.stringify({ success: false, persisted: "local", reading, error: msg }))
      else {
        prompts.log.error(msg)
        prompts.log.warn(`Reading saved locally (${LOCAL_LOG}).`)
      }
    }
  },
})

// ============================================================================
// Subcommand: clean — SAFE, reversible-by-default reclaim. Dry-run is DEFAULT.
// Nothing is deleted unless --apply is passed. Categories are restricted to
// regenerating/junk data only; user files are structurally protected.
// ============================================================================
//
// SAFETY MODEL (defense in depth):
//   1. PROTECTED_PATHS — an absolute deny-list (Documents, Desktop, Pictures,
//      Photos Library, Messages attachments, Movies-except-CapCut-cache, …).
//   2. isWithinHome() — every computed target must resolve INSIDE the user's
//      home dir. Anything escaping home is refused.
//   3. Allowlisted categories only — a target is eligible ONLY if it was
//      produced by one of the category enumerators below. There is no
//      free-form "delete this path" path.
//   4. Dry-run is the DEFAULT. --apply is required to delete; without --yes (or
//      in non-interactive mode) an interactive confirm is required first.

const CLEAN_CATEGORIES = ["caches", "trash", "installers", "dev"] as const
type CleanCategory = (typeof CLEAN_CATEGORIES)[number]
const DEFAULT_CATEGORIES: CleanCategory[] = ["caches", "trash", "installers"]

const HOME = homedir()

// The ONLY Movies path we ever touch — CapCut's regenerable render cache.
const CAPCUT_CACHE = join(HOME, "Movies", "CapCut", "User Data", "Cache")

// Absolute deny-list. If a computed target equals or sits under any of these,
// it is refused — even if a category enumerator somehow produced it. These are
// irreplaceable user data (or live app state we must not corrupt).
const PROTECTED_PATHS: string[] = [
  join(HOME, "Documents"),
  join(HOME, "Desktop"),
  join(HOME, "Pictures"),
  join(HOME, "Photos Library.photoslibrary"),
  join(HOME, "Pictures", "Photos Library.photoslibrary"),
  join(HOME, "Music"),
  join(HOME, "Movies"), // entire Movies tree is protected EXCEPT CAPCUT_CACHE (handled explicitly)
  join(HOME, "Library", "Messages"), // Messages attachments / chat.db
  join(HOME, "Library", "Mail"),
  join(HOME, "Library", "Application Support", "MobileSync"), // iOS device backups
  join(HOME, "Sites"), // user's work tree (our own repos live here)
  join(HOME, ".ssh"),
  join(HOME, ".gnupg"),
]

type CleanTarget = { path: string; name: string; category: CleanCategory; size_gb: number; needsConfirm?: boolean }
type CategoryPlan = { category: CleanCategory; targets: CleanTarget[]; size_gb: number; deleted_gb?: number; deleted_count?: number; skipped?: number }

// True only when `child` equals or is contained within `parent` (path-segment
// aware — avoids the "/foo" vs "/foobar" prefix trap).
function isWithin(child: string, parent: string): boolean {
  const c = child.replace(/\/+$/, "")
  const p = parent.replace(/\/+$/, "")
  return c === p || c.startsWith(p + "/")
}

function isWithinHome(path: string): boolean {
  return isWithin(path, HOME)
}

// A target is deletable ONLY if: inside home, AND not equal-to/under any
// protected path — with the single sanctioned exception of the CapCut cache,
// which lives under the (otherwise protected) Movies tree.
function isDeletable(path: string): { ok: boolean; reason?: string } {
  if (!isWithinHome(path)) return { ok: false, reason: "escapes home directory" }
  // Sanctioned exception: CapCut cache under Movies.
  if (isWithin(path, CAPCUT_CACHE)) return { ok: true }
  for (const prot of PROTECTED_PATHS) {
    if (isWithin(path, prot)) return { ok: false, reason: `protected path (${prot.replace(HOME, "~")})` }
  }
  return { ok: true }
}

// List immediate children of a dir (absolute paths). Empty on missing/denied.
function listChildren(dir: string): string[] {
  if (!existsSync(dir)) return []
  try {
    const out = execSync(`find "${dir}" -mindepth 1 -maxdepth 1 2>/dev/null`, {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim()
    return out ? out.split("\n") : []
  } catch {
    return []
  }
}

function mkTarget(path: string, category: CleanCategory, needsConfirm = false): CleanTarget | null {
  const guard = isDeletable(path)
  if (!guard.ok) return null
  const size = duGb(path)
  if (size <= 0) return null
  return { path, name: path.replace(HOME, "~"), category, size_gb: Math.round(size * 100) / 100, needsConfirm }
}

// ---- Category enumerators (each returns ALLOWLISTED, guarded targets only) --

// caches: ~/Library/Caches/*, ~/.npm, ms-playwright, browser caches. macOS-guarded
// where the path is macOS-specific.
function enumCaches(): CleanTarget[] {
  const targets: CleanTarget[] = []
  const isMac = platform() === "darwin"
  if (isMac) {
    // Each child of ~/Library/Caches individually (so a locked/in-use one we
    // fail to remove doesn't abort the rest — handled gracefully at delete time).
    for (const child of listChildren(join(HOME, "Library", "Caches"))) {
      const t = mkTarget(child, "caches")
      if (t) targets.push(t)
    }
  }
  // ~/.npm cache (cross-platform).
  const npm = join(HOME, ".npm", "_cacache")
  let t = mkTarget(existsSync(npm) ? npm : join(HOME, ".npm"), "caches")
  if (t) targets.push(t)
  // Playwright browsers cache (cross-platform location under ~/Library/Caches on mac;
  // already covered above on mac, but include explicitly for non-mac & clarity).
  if (!isMac) {
    t = mkTarget(join(HOME, ".cache", "ms-playwright"), "caches")
    if (t) targets.push(t)
    t = mkTarget(join(HOME, ".cache"), "caches")
    if (t) targets.push(t)
  }
  // De-dupe by path (npm/.cache may overlap).
  const seen = new Set<string>()
  return targets.filter((x) => (seen.has(x.path) ? false : (seen.add(x.path), true)))
}

// trash: ~/.Trash/*
function enumTrash(): CleanTarget[] {
  const targets: CleanTarget[] = []
  for (const child of listChildren(join(HOME, ".Trash"))) {
    const t = mkTarget(child, "trash")
    if (t) targets.push(t)
  }
  return targets
}

// installers: ~/Downloads/*.dmg, *.pkg, aborted *.crdownload, and redundant
// *.zip whose same-named extracted folder exists alongside it.
function enumInstallers(): CleanTarget[] {
  const downloads = join(HOME, "Downloads")
  const targets: CleanTarget[] = []
  if (!existsSync(downloads)) return targets
  try {
    const found = execSync(
      `find "${downloads}" -maxdepth 1 -type f \\( -iname '*.dmg' -o -iname '*.pkg' -o -iname '*.crdownload' \\) 2>/dev/null`,
      { stdio: ["ignore", "pipe", "ignore"] },
    )
      .toString()
      .trim()
    if (found) for (const p of found.split("\n")) { const t = mkTarget(p, "installers"); if (t) targets.push(t) }

    const zips = execSync(`find "${downloads}" -maxdepth 1 -type f -iname '*.zip' 2>/dev/null`, {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim()
    if (zips)
      for (const z of zips.split("\n")) {
        const folder = z.replace(/\.zip$/i, "")
        if (existsSync(folder)) { const t = mkTarget(z, "installers"); if (t) targets.push(t) }
      }
  } catch {}
  return targets
}

// dev: CapCut cache, stray node_modules under the scan root (REPORT, needsConfirm),
// Xcode DerivedData, Go build cache — only when present. Opt-in only.
function enumDev(root: string): CleanTarget[] {
  const targets: CleanTarget[] = []
  let t = mkTarget(CAPCUT_CACHE, "dev")
  if (t) targets.push(t)

  // Stray node_modules under the scan root — explicit confirm required.
  try {
    const out = execSync(
      `find "${root}" -maxdepth 4 -type d -name node_modules -prune -print 2>/dev/null | head -200`,
      { stdio: ["ignore", "pipe", "ignore"] },
    )
      .toString()
      .trim()
    if (out) for (const p of out.split("\n")) { const nm = mkTarget(p, "dev", true); if (nm) targets.push(nm) }
  } catch {}

  // Xcode DerivedData + Go build cache — regenerable dev caches, only if present.
  for (const p of [
    join(HOME, "Library", "Developer", "Xcode", "DerivedData"),
    join(HOME, "Library", "Caches", "go-build"),
    join(HOME, "go", "pkg", "mod", "cache"),
  ]) {
    const d = mkTarget(p, "dev")
    if (d) targets.push(d)
  }
  const seen = new Set<string>()
  return targets.filter((x) => (seen.has(x.path) ? false : (seen.add(x.path), true)))
}

function enumerate(category: CleanCategory, root: string): CleanTarget[] {
  switch (category) {
    case "caches":
      return enumCaches()
    case "trash":
      return enumTrash()
    case "installers":
      return enumInstallers()
    case "dev":
      return enumDev(root)
  }
}

// Delete one target. FINAL guard re-check (never trust the plan blindly), then
// rm -rf. Returns freed GB (the measured size) or 0 if it failed/was skipped.
function deleteTarget(t: CleanTarget): { freed: number; ok: boolean; error?: string } {
  const guard = isDeletable(t.path)
  if (!guard.ok) return { freed: 0, ok: false, error: `refused: ${guard.reason}` }
  if (!existsSync(t.path)) return { freed: 0, ok: false, error: "missing" }
  try {
    execSync(`rm -rf "${t.path}"`, { stdio: ["ignore", "ignore", "pipe"] })
    return { freed: t.size_gb, ok: true }
  } catch (err) {
    // Locked/in-use files (e.g. a cache held by a running app) — skip gracefully.
    return { freed: 0, ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

const CleanCommand = cmd({
  command: "clean",
  describe:
    "reclaim disk space from SAFE, regenerating junk (caches, trash, installers, dev caches). " +
    "DRY-RUN BY DEFAULT — nothing is deleted unless you pass --apply. User files are protected.",
  builder: (yargs) =>
    yargs
      .option("category", {
        describe: `categories to clean (${CLEAN_CATEGORIES.join(", ")}). Default: ${DEFAULT_CATEGORIES.join(",")}. 'dev' is opt-in.`,
        type: "string",
        array: true,
      })
      .option("apply", { describe: "actually delete (default: false = dry-run)", type: "boolean", default: false })
      .option("yes", { describe: "skip the confirmation prompt when applying", type: "boolean", default: false })
      .option("path", { describe: "directory to scope the scan (default: home dir)", type: "string" })
      .option("json", { describe: "JSON output", type: "boolean", default: false })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" }),
  async handler(args) {
    const root = (args.path as string | undefined) ?? HOME
    const apply = args.apply as boolean
    const json = args.json as boolean

    // Validate scope: refuse to scan outside home.
    if (!isWithinHome(root)) {
      const msg = `Refusing: --path "${root}" is outside the home directory (${HOME}).`
      if (json) console.log(JSON.stringify({ success: false, error: msg }))
      else prompts.log.error(msg)
      process.exitCode = 2
      return
    }

    // Resolve categories. Validate names; default to the low-risk set.
    let categories: CleanCategory[]
    const raw = (args.category as string[] | undefined)?.flatMap((c) => c.split(",")).map((c) => c.trim()).filter(Boolean)
    if (raw && raw.length) {
      const invalid = raw.filter((c) => !CLEAN_CATEGORIES.includes(c as CleanCategory))
      if (invalid.length) {
        const msg = `Unknown categor${invalid.length > 1 ? "ies" : "y"}: ${invalid.join(", ")}. Valid: ${CLEAN_CATEGORIES.join(", ")}.`
        if (json) console.log(JSON.stringify({ success: false, error: msg }))
        else prompts.log.error(msg)
        process.exitCode = 2
        return
      }
      categories = [...new Set(raw as CleanCategory[])]
    } else {
      categories = DEFAULT_CATEGORIES
    }

    if (!json) {
      UI.empty()
      prompts.intro(`◈  Device Clean ${apply ? bold("(APPLY)") : dim("(dry-run)")}`)
    }

    const spinner = json ? null : prompts.spinner()
    if (spinner) spinner.start("Computing plan…")

    const before = (() => {
      try {
        return dfUsage(primaryVolume())
      } catch {
        return null
      }
    })()

    // Build the plan (read-only enumeration + guards).
    const plans: CategoryPlan[] = []
    for (const category of categories) {
      const targets = enumerate(category, root)
      const size = targets.reduce((s, t) => s + t.size_gb, 0)
      plans.push({ category, targets, size_gb: Math.round(size * 100) / 100 })
    }

    const totalItems = plans.reduce((n, p) => n + p.targets.length, 0)
    const totalGb = Math.round(plans.reduce((s, p) => s + p.size_gb, 0) * 100) / 100
    const needsConfirmCount = plans.reduce((n, p) => n + p.targets.filter((t) => t.needsConfirm).length, 0)

    if (spinner) spinner.stop(`${success("✓")} Plan computed ${dim(`(via guards · ${root.replace(HOME, "~")})`)}`)

    // Render the per-category plan table.
    const renderPlan = (mode: "would" | "did") => {
      printDivider()
      if (before) {
        printKV("Volume", before.path)
        printKV("Free before", gb(before.free_gb))
      }
      console.log()
      console.log(`  ${bold(mode === "would" ? "Plan — what WOULD be freed" : "Result — what WAS freed")}`)
      for (const p of plans) {
        const n = p.targets.length
        const amt = mode === "did" ? (p.deleted_gb ?? 0) : p.size_gb
        const count = mode === "did" ? (p.deleted_count ?? 0) : n
        const skipNote = mode === "did" && p.skipped ? dim(`  (${p.skipped} skipped)`) : ""
        const confirmNote = p.targets.some((t) => t.needsConfirm) ? dim("  ⚠ needs confirm") : ""
        console.log(`    ${gb(amt).padStart(9)}  ${p.category.padEnd(11)} ${dim(`${count} item${count === 1 ? "" : "s"}`)}${confirmNote}${skipNote}`)
      }
      printDivider()
    }

    // No-op short circuit.
    if (totalItems === 0) {
      if (json) {
        console.log(JSON.stringify({ success: true, apply, dry_run: !apply, categories, total_items: 0, total_gb: 0, plans, before }, null, 2))
        return
      }
      renderPlan("would")
      console.log(`  ${bold("Nothing to reclaim")} ${dim("— already clean.")}`)
      printDivider()
      prompts.outro(dim("iris device scan  Audit local disk"))
      return
    }

    // ---- DRY-RUN (default): report the plan and stop. ----
    if (!apply) {
      if (json) {
        console.log(
          JSON.stringify(
            { success: true, apply: false, dry_run: true, categories, total_items: totalItems, total_gb: totalGb, plans, before },
            null,
            2,
          ),
        )
        return
      }
      renderPlan("would")
      console.log(`  ${bold("Would free (est.):")} ${highlight(gb(totalGb))} ${dim(`across ${totalItems} item${totalItems === 1 ? "" : "s"}`)}`)
      if (needsConfirmCount) console.log(`  ${dim(`${needsConfirmCount} item(s) flagged ⚠ need explicit confirm on --apply (e.g. node_modules).`)}`)
      printDivider()
      prompts.outro(`${dim("Re-run with")} ${bold("--apply")} ${dim("to delete (you'll be asked to confirm).")}`)
      return
    }

    // ---- APPLY: require confirmation (prompt in TTY, or --yes). ----
    const nonInteractive = isNonInteractive()
    if (!args.yes) {
      if (nonInteractive) {
        const msg = `Refusing to --apply without confirmation. Re-run with --yes to delete ${totalItems} item(s) (~${gb(totalGb)}).`
        if (json) console.log(JSON.stringify({ success: false, apply: true, error: msg, plans, total_gb: totalGb, total_items: totalItems }))
        else prompts.log.error(msg)
        process.exitCode = 2
        return
      }
      renderPlan("would")
      if (needsConfirmCount)
        prompts.log.warn(`${needsConfirmCount} item(s) are flagged for explicit review (e.g. node_modules). They are INCLUDED below.`)
      const ok = await prompts.confirm({
        message: `Delete ${totalItems} item${totalItems === 1 ? "" : "s"}, free ~${gb(totalGb)}? This cannot be undone.`,
        initialValue: false,
      })
      if (prompts.isCancel(ok) || !ok) {
        prompts.outro(dim("Cancelled — nothing deleted."))
        return
      }
    }

    // ---- Perform deletion (each target final-guarded again in deleteTarget). ----
    const delSpinner = json ? null : prompts.spinner()
    if (delSpinner) delSpinner.start("Reclaiming…")
    let freedTotal = 0
    let deletedCount = 0
    for (const p of plans) {
      let pf = 0
      let pc = 0
      let skipped = 0
      for (const t of p.targets) {
        const r = deleteTarget(t)
        if (r.ok) {
          pf += r.freed
          pc += 1
        } else {
          skipped += 1
        }
      }
      p.deleted_gb = Math.round(pf * 100) / 100
      p.deleted_count = pc
      p.skipped = skipped
      freedTotal += pf
      deletedCount += pc
    }
    freedTotal = Math.round(freedTotal * 100) / 100
    if (delSpinner) delSpinner.stop(`${success("✓")} Reclaimed ${gb(freedTotal)} across ${deletedCount} item(s)`)

    const after = (() => {
      try {
        return dfUsage(primaryVolume())
      } catch {
        return null
      }
    })()

    // Log a summary reading to the Device Health bloq (best-effort) — reuses the
    // SAME persistence helper that `log` uses.
    let persisted: "bloq" | "local" | "none" = "none"
    const token = await requireAuth()
    if (token) {
      const userId = await requireUserId(args["user-id"] as number | undefined)
      if (userId && after) {
        const reading: Reading = {
          timestamp: new Date().toISOString(),
          device: hostname().replace(/\.local$/, ""),
          used_gb: Math.round((after.total_gb - after.free_gb) * 100) / 100,
          capacity_gb: after.total_gb,
          free_gb: after.free_gb,
          delta_gb: null,
        }
        const title = `clean: freed ${gb(freedTotal)} (${categories.join("+")}) — now ${reading.free_gb} GB free`
        const saved = await saveReadingToBloq(userId, reading, title)
        persisted = saved ? "bloq" : "local"
        if (!saved) writeLocal(reading)
      }
    }

    if (json) {
      console.log(
        JSON.stringify(
          { success: true, apply: true, dry_run: false, categories, freed_gb: freedTotal, deleted_count: deletedCount, plans, before, after, persisted },
          null,
          2,
        ),
      )
      return
    }

    renderPlan("did")
    console.log(`  ${bold("Freed:")} ${highlight(gb(freedTotal))}`)
    if (before && after) console.log(`  ${dim(`Free space: ${gb(before.free_gb)} → ${gb(after.free_gb)}`)}`)
    if (persisted === "bloq") console.log(`  ${dim("Logged a reading to the Device Health bloq.")}`)
    else if (persisted === "local") console.log(`  ${dim(`Reading saved locally (${LOCAL_LOG}).`)}`)
    printDivider()
    prompts.outro(`${dim("iris device scan")}  Re-audit local disk`)
  },
})

// ============================================================================
// Bloq persistence helpers
// ============================================================================

// Find the user's "Device Health" bloq (creating it if missing) and ensure a
// "Readings" list exists on it. Returns { bloqId, listId } or null on failure.
async function findOrCreateBloqList(userId: number): Promise<{ bloqId: number; listId: number } | null> {
  // 1. Look for an existing bloq named exactly "Device Health".
  let bloqId: number | null = null
  const listRes = await irisFetch(`/api/v1/user/${userId}/bloqs?per_page=200&simplified=1`)
  if (listRes.ok) {
    const data = (await listRes.json()) as { data?: Array<{ id: number; name?: string }> }
    const match = (data.data ?? []).find((b) => (b.name ?? "") === FIND_OR_CREATE_BLOQ_NAME)
    if (match) bloqId = match.id
  }

  // 2. Create it if absent (same endpoint/payload as BloqsCreateCommand).
  if (!bloqId) {
    const createRes = await irisFetch(`/api/v1/user/${userId}/bloqs`, {
      method: "POST",
      body: JSON.stringify({
        name: FIND_OR_CREATE_BLOQ_NAME,
        description: "Device storage readings over time (iris device log)",
      }),
    })
    if (!createRes.ok) return null
    const created = (await createRes.json()) as { data?: { bloq?: { id: number }; id?: number } }
    bloqId = created.data?.bloq?.id ?? created.data?.id ?? null
  }
  if (!bloqId) return null

  // 3. Ensure a "Readings" list exists (create via the create-list route).
  let listId: number | null = null
  const listsRes = await irisFetch(`/api/v1/user/${userId}/bloqs/${bloqId}/lists`)
  if (listsRes.ok) {
    const data = (await listsRes.json()) as { data?: Array<{ id: number; name?: string }> }
    const match = (data.data ?? []).find((l) => (l.name ?? "") === READINGS_LIST_NAME)
    if (match) listId = match.id
  }
  if (!listId) {
    const createList = await irisFetch(`/api/v1/user/bloqs/${bloqId}/lists`, {
      method: "POST",
      body: JSON.stringify({ name: READINGS_LIST_NAME }),
    })
    if (createList.ok) {
      const data = (await createList.json()) as { data?: { id: number }; id?: number }
      listId = data.data?.id ?? data.id ?? null
    }
    // If list-create failed but the bloq has a default list, fall back to it.
    if (!listId) {
      const reRes = await irisFetch(`/api/v1/user/${userId}/bloqs/${bloqId}/lists`)
      if (reRes.ok) {
        const re = (await reRes.json()) as { data?: Array<{ id: number }> }
        listId = re.data?.[0]?.id ?? null
      }
    }
  }
  if (!listId) return null
  return { bloqId, listId }
}

// Read prior readings back out of the bloq, parsing the JSON blob from each
// item's content. Best-effort — malformed items are skipped.
async function fetchReadings(userId: number, bloqId: number): Promise<Reading[]> {
  const res = await irisFetch(`/api/v1/user/${userId}/bloqs/${bloqId}/items?per_page=500`)
  if (!res.ok) return []
  const data = (await res.json()) as { data?: unknown }
  const raw = data.data
  const items: Array<{ content?: unknown }> = Array.isArray(raw)
    ? (raw as Array<{ content?: unknown }>)
    : ((raw as { items?: Array<{ content?: unknown }> })?.items ?? [])
  const out: Reading[] = []
  for (const it of items) {
    // content comes back either as a JSON string OR already parsed into an
    // object (the API parses JSON-shaped content). Handle both.
    let parsed: Reading | null = null
    if (typeof it.content === "string") {
      try {
        parsed = JSON.parse(it.content) as Reading
      } catch {}
    } else if (it.content && typeof it.content === "object") {
      parsed = it.content as Reading
    }
    if (parsed?.timestamp && parsed?.device && typeof parsed.used_gb === "number") out.push(parsed)
  }
  return out
}

// Save a reading to the Device Health bloq: find-or-create the bloq+list, then
// POST it as an item with the given title. Computes the per-device delta vs the
// most-recent prior reading (mutating reading.delta_gb). Returns true on a
// confirmed save, false otherwise (caller falls back to local). Shared by both
// `log` and `clean` so there is ONE bloq-persistence path.
async function saveReadingToBloq(userId: number, reading: Reading, title: string): Promise<boolean> {
  try {
    const target = await findOrCreateBloqList(userId)
    if (!target) return false

    const prior = await fetchReadings(userId, target.bloqId)
    const lastForDevice = prior
      .filter((r) => r.device === reading.device)
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
      .pop()
    reading.delta_gb = lastForDevice ? Math.round((reading.used_gb - lastForDevice.used_gb) * 100) / 100 : null

    const res = await irisFetch(
      `/api/v1/user/${userId}/bloqs/${target.bloqId}/lists/${target.listId}/items`,
      { method: "POST", body: JSON.stringify({ title, content: JSON.stringify(reading) }) },
    )
    return res.ok
  } catch {
    return false
  }
}

// ============================================================================
// Local fallback + rendering
// ============================================================================

// Append a reading to ~/.iris/device-health.md so nothing is lost when offline
// or unauthenticated. Mirrors the markdown table the user already maintains.
function writeLocal(r: Reading): void {
  try {
    const dir = join(homedir(), ".iris")
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    let out = ""
    if (!existsSync(LOCAL_LOG)) {
      out += "# Device Health — storage readings\n\n"
      out += "| Time | Device | Used GB | Free GB | Δ Used | Note |\n"
      out += "| --- | --- | --- | --- | --- | --- |\n"
    }
    const delta = r.delta_gb === null ? "—" : `${r.delta_gb >= 0 ? "+" : ""}${r.delta_gb}`
    out += `| ${r.timestamp} | ${r.device} | ${r.used_gb} | ${r.free_gb} | ${delta} | ${r.capacity_gb} GB cap |\n`
    appendFileSync(LOCAL_LOG, out)
  } catch {}
}

function printReadingSummary(r: Reading): void {
  printDivider()
  printKV("Device", r.device)
  printKV("Used", gb(r.used_gb))
  printKV("Free", gb(r.free_gb))
  printKV("Capacity", gb(r.capacity_gb))
  printDivider()
}

// Render the trend table: Time | Device | Used GB | Free GB | Δ Used.
// Same shape as the markdown table the user likes, sorted chronologically.
function printTrend(readings: Reading[]): void {
  console.log()
  console.log(`  ${bold("Storage trend")}`)
  printDivider(78)
  console.log(
    `  ${dim("Time".padEnd(20))}${dim("Device".padEnd(16))}${dim("Used".padStart(10))}${dim("Free".padStart(11))}${dim("Δ Used".padStart(11))}`,
  )
  // Recompute deltas per-device across the sorted set for a consistent table.
  const lastByDevice: Record<string, number> = {}
  for (const r of readings) {
    const prev = lastByDevice[r.device]
    const delta = prev === undefined ? null : Math.round((r.used_gb - prev) * 100) / 100
    lastByDevice[r.device] = r.used_gb
    const time = r.timestamp.slice(0, 16).replace("T", " ")
    // Pad the PLAIN delta text first, then colorize — padding an ANSI-wrapped
    // string miscounts width (escape codes are non-printing) and breaks columns.
    const deltaStr = (delta === null ? "—" : `${delta >= 0 ? "+" : ""}${gb(delta)}`).padStart(11)
    const deltaColored = delta === null ? dim(deltaStr) : delta > 0 ? deltaStr : success(deltaStr)
    console.log(
      `  ${time.padEnd(20)}${r.device.slice(0, 15).padEnd(16)}${gb(r.used_gb).padStart(10)}${gb(r.free_gb).padStart(11)}${deltaColored}`,
    )
  }
  printDivider(78)
}

// ============================================================================
// Root command — Phase 1 (scan + log). `storage` is an alias for `device`.
// ============================================================================

export const DeviceCommand = cmd({
  command: ["device", "storage"],
  describe: "audit local disk + track storage readings over time",
  builder: (yargs) => yargs.command(ScanCommand).command(LogCommand).command(CleanCommand).demandCommand(),
  async handler() {},
})
