import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { printDivider, dim, bold, success } from "./iris-api"
import * as device from "../lib/device"

// ── status ─────────────────────────────────────────────────

const DeviceStatusCommand = cmd({
  command: "status",
  aliases: ["info"],
  describe: "quick overview — model, iOS, REAL free space, iCloud quota",
  builder: (yargs) =>
    yargs
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    const target = (args as any).target || "iphone"
    UI.empty()
    prompts.intro(`◈  Device Status`)

    if (target === "mac") {
      const storage = device.getMacStorage()
      const model = device.getMacModel()
      if ((args as any).json) {
        console.log(JSON.stringify({ model, storage }))
        return
      }
      printDivider()
      console.log(`  ${bold("Device")}:    ${model}`)
      console.log(`  ${bold("Total")}:     ${device.formatBytes(storage.total_bytes)}`)
      console.log(`  ${bold("Used")}:      ${device.formatBytes(storage.used_bytes)}`)
      console.log(`  ${bold("Free")}:      ${device.formatBytes(storage.free_bytes)}`)
      console.log(`  ${device.formatBar(storage.used_bytes, storage.total_bytes)}`)
      printDivider()
      prompts.outro(`${success("✓")} Mac storage`)
      return
    }

    // iPhone target
    const prereq = device.checkPrereqs()
    if (!prereq.ok) {
      prompts.log.error(`${prereq.error}`)
      if (prereq.hint) prompts.log.info(dim(prereq.hint))
      prompts.outro("Done")
      return
    }

    const sp = prompts.spinner()
    sp.start("Detecting device...")
    const dev = device.detectDevice()
    if (!dev) {
      sp.stop("No iPhone connected", 1)
      prompts.log.info(dim("Plug in via USB, unlock, and tap 'Trust This Computer'"))
      prompts.outro("Done")
      return
    }
    sp.stop(`${dev.name}`)

    sp.start("Reading storage (AFC)...")
    const storage = device.getIPhoneStorage()
    sp.stop("Storage read")

    sp.start("Checking iCloud...")
    const icloud = device.getICloudStatus()
    sp.stop("iCloud checked")

    if ((args as any).json) {
      console.log(JSON.stringify({ device: dev, storage, icloud }))
      prompts.outro("Done")
      return
    }

    printDivider()
    console.log(`  ${bold("Device")}:    ${dev.name}`)
    console.log(`  ${bold("Model")}:     ${dev.model}`)
    console.log(`  ${bold("iOS")}:       ${dev.ios_version}`)
    console.log("")
    if (storage) {
      console.log(`  ${bold("Total")}:     ${device.formatBytes(storage.total_bytes)}`)
      console.log(`  ${bold("Used")}:      ${device.formatBytes(storage.used_bytes)}`)
      console.log(`  ${bold("Free")}:      ${device.formatBytes(storage.free_bytes)}`)
      console.log(`  ${device.formatBar(storage.used_bytes, storage.total_bytes)}`)
      if (storage.free_bytes < 500 * 1024 * 1024) {
        console.log(`  ${bold("⚠️  CRITICALLY LOW")}`)
      }
    }
    console.log("")
    if (icloud) {
      const quotaStr = icloud.available_quota === 0 ? "⚠️  0 bytes — FULL" : device.formatBytes(icloud.available_quota)
      console.log(`  ${bold("iCloud")}:    ${quotaStr}`)
      if (icloud.sync_up_stuck > 0) {
        console.log(`  ${bold("Stuck")}:     ${icloud.sync_up_stuck} items waiting to sync`)
      }
    }
    printDivider()
    prompts.outro(`${success("✓")} Device status`)
  },
})

// ── storage ────────────────────────────────────────────────

const DeviceStorageCommand = cmd({
  command: "storage",
  aliases: ["audit"],
  describe: "full breakdown — real space, DCIM estimate, top apps, iCloud",
  builder: (yargs) =>
    yargs
      .option("json", { type: "boolean", default: false })
      .option("limit", { type: "number", default: 15, describe: "max apps to show" }),
  async handler(args) {
    const target = (args as any).target || "iphone"
    UI.empty()
    prompts.intro(`◈  Storage Audit`)

    if (target === "mac") {
      const storage = device.getMacStorage()
      const folders = device.getMacTopFolders()
      if ((args as any).json) {
        console.log(JSON.stringify({ storage, folders }))
        return
      }
      printDivider()
      console.log(`  ${bold("Mac Disk")}`)
      console.log(`  Total: ${device.formatBytes(storage.total_bytes)} | Used: ${device.formatBytes(storage.used_bytes)} | Free: ${device.formatBytes(storage.free_bytes)}`)
      console.log(`  ${device.formatBar(storage.used_bytes, storage.total_bytes)}`)
      console.log("")
      console.log(`  ${bold("Top Folders")}`)
      for (const f of folders) {
        console.log(`  ${device.formatBytes(f.size_bytes).padStart(10)}  ${f.path}`)
      }
      printDivider()
      prompts.outro(`${success("✓")} Mac audit`)
      return
    }

    const prereq = device.checkPrereqs()
    if (!prereq.ok) {
      prompts.log.error(`${prereq.error}`)
      if (prereq.hint) prompts.log.info(dim(prereq.hint))
      prompts.outro("Done")
      return
    }

    const sp = prompts.spinner()

    sp.start("Detecting device...")
    const dev = device.detectDevice()
    if (!dev) {
      sp.stop("No iPhone connected", 1)
      prompts.outro("Done")
      return
    }
    sp.stop(`${dev.name} (${dev.model}, iOS ${dev.ios_version})`)

    sp.start("Reading real storage via AFC...")
    const storage = device.getIPhoneStorage()
    sp.stop("Storage read")

    sp.start("Scanning photos (DCIM)...")
    const dcimInfo = device.getDcim()
    sp.stop("DCIM scanned")

    sp.start("Loading app sizes...")
    const appList = device.getIPhoneApps()
    sp.stop(`${appList.length} apps loaded`)

    sp.start("Checking iCloud...")
    const icloud = device.getICloudStatus()
    sp.stop("iCloud checked")

    if ((args as any).json) {
      console.log(JSON.stringify({ device: dev, storage, dcim: dcimInfo, apps: appList, icloud }))
      prompts.outro("Done")
      return
    }

    // Display
    printDivider()
    console.log(`  ${bold("iPhone Storage")} — ${dev.name}`)
    if (storage) {
      console.log(`  Total: ${device.formatBytes(storage.total_bytes)} | Used: ${device.formatBytes(storage.used_bytes)} | Free: ${device.formatBytes(storage.free_bytes)}`)
      console.log(`  ${device.formatBar(storage.used_bytes, storage.total_bytes)}`)
      if (storage.free_bytes < 500 * 1024 * 1024) console.log(`  ${bold("🚨 CRITICALLY LOW STORAGE")}`)
    }

    if (dcimInfo) {
      console.log("")
      console.log(`  ${bold("Photos/Videos (DCIM)")}`)
      console.log(`  Files: ${dcimInfo.total_files.toLocaleString()} | Est size: ${device.formatBytes(dcimInfo.total_est_bytes)} | Avg: ${device.formatBytes(dcimInfo.avg_file_bytes)}/file`)
    }

    if (appList.length > 0) {
      console.log("")
      console.log(`  ${bold("Top Apps by Size")}`)
      const limit = (args as any).limit || 15
      const MB = 1024 * 1024
      console.log(`  ${"#".padStart(4)}  ${"App".padEnd(28)} ${"App".padStart(8)} ${"Data".padStart(8)} ${"Total".padStart(8)}`)
      console.log(`  ${"─".repeat(4)}  ${"─".repeat(28)} ${"─".repeat(8)} ${"─".repeat(8)} ${"─".repeat(8)}`)
      for (let i = 0; i < Math.min(appList.length, limit); i++) {
        const app = appList[i]
        if (app.total_size < MB) continue
        const marker = app.total_size > 1024 * MB ? " ⚠️" : ""
        console.log(
          `  ${String(i + 1).padStart(4)}  ${app.name.slice(0, 28).padEnd(28)} ${device.formatBytes(app.static_size).padStart(8)} ${device.formatBytes(app.dynamic_size).padStart(8)} ${device.formatBytes(app.total_size).padStart(8)}${marker}`
        )
      }
      const totalApps = appList.reduce((s, a) => s + a.total_size, 0)
      console.log(`  ${"─".repeat(62)}`)
      console.log(`  ${"".padStart(4)}  ${"TOTAL".padEnd(28)} ${"".padStart(8)} ${"".padStart(8)} ${device.formatBytes(totalApps).padStart(8)}`)
    }

    if (icloud) {
      console.log("")
      console.log(`  ${bold("iCloud")}`)
      const quotaStr = icloud.available_quota === 0 ? "⚠️  0 bytes — FULL" : device.formatBytes(icloud.available_quota)
      console.log(`  Quota available: ${quotaStr}`)
      if (icloud.sync_up_stuck > 0) console.log(`  Stuck items: ${icloud.sync_up_stuck}`)
      console.log(`  Last sync: ${icloud.last_sync}`)
    }

    printDivider()
    prompts.outro(`${success("✓")} Storage audit complete`)
  },
})

// ── diagnose ───────────────────────────────────────────────

const DeviceDiagnoseCommand = cmd({
  command: "diagnose",
  aliases: ["doctor", "check"],
  describe: "detect iCloud deadlock, stuck syncs, and provide fix recommendations",
  builder: (yargs) =>
    yargs.option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Device Diagnosis`)

    const prereq = device.checkPrereqs()
    if (!prereq.ok) {
      prompts.log.error(`${prereq.error}`)
      if (prereq.hint) prompts.log.info(dim(prereq.hint))
      prompts.outro("Done")
      return
    }

    const sp = prompts.spinner()
    sp.start("Running full diagnosis (storage + iCloud + photos)...")
    const result = device.diagnose()
    sp.stop("Diagnosis complete")

    if ((args as any).json) {
      console.log(JSON.stringify(result))
      prompts.outro("Done")
      return
    }

    printDivider()

    // Verdict
    const verdictMap: Record<string, string> = {
      DEADLOCKED: "🚨 DEADLOCKED — Phone full + iCloud full. Nothing can sync.",
      PHONE_LOW: "⚠️  PHONE LOW — Running out of local storage.",
      ICLOUD_FULL: "⚠️  iCLOUD FULL — Can't upload new data to cloud.",
      HEALTHY: "✅ HEALTHY — Storage looks fine.",
    }
    console.log(`  ${bold("Verdict")}: ${verdictMap[result.verdict] || result.verdict}`)
    console.log("")

    // Stats
    console.log(`  Phone free:    ${device.formatBytes(result.phone_free)}`)
    if (result.phone_total > 0) {
      console.log(`  Phone total:   ${device.formatBytes(result.phone_total)}`)
      console.log(`  ${device.formatBar(result.phone_total - result.phone_free, result.phone_total)}`)
    }
    console.log(`  iCloud quota:  ${result.icloud_free === 0 ? "⚠️  0 bytes" : device.formatBytes(result.icloud_free)}`)
    if (result.sync_stuck > 0) console.log(`  Sync stuck:    ${result.sync_stuck} items`)
    if (result.dcim_files > 0) console.log(`  Photos/videos: ${result.dcim_files.toLocaleString()} files (~${device.formatBytes(result.dcim_est)})`)

    // Recommendations
    if (result.recommendations.length > 0) {
      console.log("")
      console.log(`  ${bold("Recommendations")}:`)
      result.recommendations.forEach((r, i) => {
        console.log(`  ${i + 1}. ${r}`)
      })
    }

    printDivider()
    prompts.outro(`${success("✓")} Diagnosis complete`)
  },
})

// ── icloud ─────────────────────────────────────────────────

const DeviceICloudCommand = cmd({
  command: "icloud",
  aliases: ["cloud"],
  describe: "deep iCloud status — quota, sync budget, throttle, stuck items",
  builder: (yargs) =>
    yargs.option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  iCloud Status`)

    const sp = prompts.spinner()
    sp.start("Parsing iCloud sync state (brctl dump)...")
    const icloud = device.getICloudStatus()
    sp.stop("iCloud parsed")

    if (!icloud) {
      prompts.log.error("Could not read iCloud status")
      prompts.outro("Done")
      return
    }

    if ((args as any).json) {
      console.log(JSON.stringify(icloud))
      prompts.outro("Done")
      return
    }

    printDivider()
    const quotaStr = icloud.available_quota === 0 ? "🚨 0 bytes — COMPLETELY FULL" : device.formatBytes(icloud.available_quota)
    console.log(`  ${bold("Available Quota")}:  ${quotaStr}`)
    console.log(`  ${bold("Stuck Uploads")}:    ${icloud.sync_up_stuck} items`)
    console.log(`  ${bold("Last Sync")}:        ${icloud.last_sync}`)
    console.log(`  ${bold("Quota Fetched")}:    ${icloud.last_quota_fetch}`)
    if (icloud.sync_budget >= 0) {
      console.log(`  ${bold("Sync Budget")}:      ${icloud.sync_budget}`)
    }
    console.log("")
    if (icloud.is_deadlocked) {
      console.log(`  ${bold("⚠️  DEADLOCK DETECTED")}: iCloud full + items stuck.`)
      console.log(`  ${dim("Nothing can upload until space is freed in iCloud.")}`)
      console.log(`  ${dim("Run: iris device diagnose — for fix recommendations")}`)
    }
    printDivider()
    prompts.outro(`${success("✓")} iCloud status`)
  },
})

// ── clean ──────────────────────────────────────────────────

const DeviceCleanCommand = cmd({
  command: "clean",
  aliases: ["cleanup"],
  describe: "interactive — pick apps to offload, see savings estimate",
  builder: (yargs) =>
    yargs.option("limit", { type: "number", default: 20, describe: "max apps to show" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Device Cleanup`)

    const prereq = device.checkPrereqs()
    if (!prereq.ok) {
      prompts.log.error(`${prereq.error}`)
      if (prereq.hint) prompts.log.info(dim(prereq.hint))
      prompts.outro("Done")
      return
    }

    const sp = prompts.spinner()

    sp.start("Reading free space...")
    const beforeStorage = device.getIPhoneStorage()
    sp.stop(beforeStorage ? `Free: ${device.formatBytes(beforeStorage.free_bytes)}` : "Storage read")

    sp.start("Loading app sizes...")
    const appList = device.getIPhoneApps()
    sp.stop(`${appList.length} apps`)

    if (appList.length === 0) {
      prompts.log.error("No apps found")
      prompts.outro("Done")
      return
    }

    const MB = 1024 * 1024
    const limit = (args as any).limit || 20
    const candidates = appList.filter((a) => a.total_size > 50 * MB).slice(0, limit)

    if (candidates.length === 0) {
      prompts.log.info("No apps large enough to offload")
      prompts.outro("Done")
      return
    }

    const selected = await prompts.multiselect({
      message: "Select apps to offload (removes app binary, keeps your data):",
      options: candidates.map((app) => ({
        value: app.bundle_id,
        label: `${app.name} (${device.formatBytes(app.total_size)})`,
        hint: `app: ${device.formatBytes(app.static_size)}, data: ${device.formatBytes(app.dynamic_size)}`,
      })),
    })

    if (prompts.isCancel(selected) || !Array.isArray(selected) || selected.length === 0) {
      prompts.outro("Cancelled")
      return
    }

    const toOffload = candidates.filter((a) => (selected as string[]).includes(a.bundle_id))
    const totalSavings = toOffload.reduce((s, a) => s + a.static_size, 0)

    const confirmed = await prompts.confirm({
      message: `Offload ${toOffload.length} app(s)? Estimated savings: ${device.formatBytes(totalSavings)}`,
    })

    if (!confirmed || prompts.isCancel(confirmed)) {
      prompts.outro("Cancelled")
      return
    }

    for (const app of toOffload) {
      sp.start(`Offloading ${app.name}...`)
      const result = device.offloadApp(app.bundle_id)
      if (result.success) {
        sp.stop(`${success("✓")} ${app.name} offloaded (${device.formatBytes(app.static_size)})`)
      } else {
        sp.stop(`✗ ${app.name}: ${result.error}`)
      }
    }

    // Check new free space
    sp.start("Checking new free space...")
    const afterStorage = device.getIPhoneStorage()
    sp.stop("Done")

    if (beforeStorage && afterStorage) {
      const delta = afterStorage.free_bytes - beforeStorage.free_bytes
      console.log("")
      console.log(`  Before: ${device.formatBytes(beforeStorage.free_bytes)} free`)
      console.log(`  After:  ${device.formatBytes(afterStorage.free_bytes)} free`)
      console.log(`  Freed:  ${device.formatBytes(delta)}`)
    }

    prompts.outro(`${success("✓")} Cleanup complete`)
  },
})

// ── offload ────────────────────────────────────────────────

const DeviceOffloadCommand = cmd({
  command: "offload <bundle-id>",
  describe: "offload a specific app (removes binary, keeps data)",
  builder: (yargs) =>
    yargs
      .positional("bundle-id", { type: "string", demandOption: true, describe: "app bundle identifier (e.g. com.google.chrome.ios)" })
      .option("force", { type: "boolean", default: false, describe: "skip confirmation" }),
  async handler(args) {
    const bundleId = args["bundle-id"] as string
    UI.empty()
    prompts.intro(`◈  Offload ${bundleId}`)

    const prereq = device.checkPrereqs()
    if (!prereq.ok) {
      prompts.log.error(`${prereq.error}`)
      prompts.outro("Done")
      return
    }

    const sp = prompts.spinner()

    // Get app info
    sp.start("Looking up app...")
    const appList = device.getIPhoneApps()
    const app = appList.find((a) => a.bundle_id === bundleId)
    sp.stop(app ? `${app.name} — ${device.formatBytes(app.total_size)}` : bundleId)

    if (app) {
      console.log(`  App binary:  ${device.formatBytes(app.static_size)}`)
      console.log(`  User data:   ${device.formatBytes(app.dynamic_size)}`)
    }

    if (!(args as any).force) {
      const confirmed = await prompts.confirm({
        message: `Offload ${app?.name || bundleId}? Binary removed, data preserved.`,
      })
      if (!confirmed || prompts.isCancel(confirmed)) {
        prompts.outro("Cancelled")
        return
      }
    }

    sp.start("Reading current free space...")
    const before = device.getIPhoneStorage()
    sp.stop(before ? `Free: ${device.formatBytes(before.free_bytes)}` : "read")

    sp.start(`Offloading ${app?.name || bundleId}...`)
    const result = device.offloadApp(bundleId)
    if (result.success) {
      sp.stop(`${success("✓")} Offloaded`)
    } else {
      sp.stop(`Failed: ${result.error}`)
      prompts.outro("Done")
      return
    }

    sp.start("Checking new free space...")
    const after = device.getIPhoneStorage()
    sp.stop("Done")

    if (before && after) {
      const delta = after.free_bytes - before.free_bytes
      console.log(`  Freed: ${device.formatBytes(delta)}`)
      console.log(`  Now:   ${device.formatBytes(after.free_bytes)} free`)
    }

    prompts.outro(`${success("✓")} ${app?.name || bundleId} offloaded`)
  },
})

// ── Export ──────────────────────────────────────────────────

export const PlatformDeviceCommand = cmd({
  command: "device",
  aliases: ["ios", "iphone"],
  describe: "audit and manage device storage — real numbers via AFC, iCloud diagnosis, app offloading",
  builder: (yargs) =>
    yargs
      .option("target", {
        type: "string",
        choices: ["iphone", "mac"] as const,
        describe: "target device (default: auto-detect iPhone, fall back to Mac)",
      })
      .command(DeviceStatusCommand)
      .command(DeviceStorageCommand)
      .command(DeviceDiagnoseCommand)
      .command(DeviceICloudCommand)
      .command(DeviceCleanCommand)
      .command(DeviceOffloadCommand)
      .demandCommand(),
  async handler() {},
})
