/**
 * Device utilities — iOS device access via pymobiledevice3 AFC + Mac native commands.
 *
 * Used by: platform-device.ts
 */

import { execSync } from "child_process"
import { existsSync } from "fs"
import { join } from "path"
import { homedir } from "os"

// Script path resolution: check well-known locations
function getScriptPath(): string {
  const candidates = [
    join(__dirname, "../scripts/device-afc.py"),      // dev (source tree)
    join(__dirname, "../../src/cli/scripts/device-afc.py"), // dev alt
    join(homedir(), ".iris/scripts/device-afc.py"),   // installed location
  ]
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  return candidates[2] // default to ~/.iris/scripts/ (will fail with helpful error)
}

const SCRIPT_PATH = getScriptPath()

// ── Types ──

export interface DeviceInfo {
  udid: string
  model: string
  name: string
  ios_version: string
}

export interface StorageInfo {
  total_bytes: number
  free_bytes: number
  used_bytes: number
  model?: string
}

export interface AppInfo {
  bundle_id: string
  name: string
  static_size: number
  dynamic_size: number
  total_size: number
}

export interface DcimInfo {
  total_files: number
  total_est_bytes: number
  avg_file_bytes: number
  sample_count: number
  folders: { name: string; count: number }[]
}

export interface ICloudStatus {
  available_quota: number
  sync_up_stuck: number
  last_sync: string
  sync_budget: number
  last_quota_fetch: string
  is_deadlocked: boolean
}

export interface DiagnoseResult {
  phone_free: number
  phone_total: number
  icloud_free: number
  icloud_deadlocked: boolean
  sync_stuck: number
  dcim_est: number
  dcim_files: number
  verdict: "DEADLOCKED" | "PHONE_LOW" | "ICLOUD_FULL" | "HEALTHY"
  recommendations: string[]
}

export interface PrereqResult {
  ok: boolean
  error?: string
  hint?: string
}

// ── Prereq Checks ──

export function isPythonAvailable(): boolean {
  try {
    execSync("which python3", { encoding: "utf-8", timeout: 3000 })
    return true
  } catch {
    return false
  }
}

export function isPymobiledeviceAvailable(): boolean {
  try {
    execSync('python3 -c "import pymobiledevice3"', { encoding: "utf-8", timeout: 5000 })
    return true
  } catch {
    return false
  }
}

export function isScriptAvailable(): boolean {
  return existsSync(SCRIPT_PATH)
}

export function checkPrereqs(): PrereqResult {
  if (process.platform !== "darwin") {
    return { ok: false, error: "Requires macOS", hint: "This command only works on macOS." }
  }
  if (!isPythonAvailable()) {
    return { ok: false, error: "python3 not found", hint: "Install Python: brew install python" }
  }
  if (!isPymobiledeviceAvailable()) {
    return {
      ok: false,
      error: "pymobiledevice3 not installed",
      hint: "Install it: pip3 install --break-system-packages pymobiledevice3",
    }
  }
  if (!isScriptAvailable()) {
    return {
      ok: false,
      error: "device-afc.py script not found",
      hint: `Expected at: ${SCRIPT_PATH}`,
    }
  }
  return { ok: true }
}

// ── Python Script Runner ──

function runScript(action: string, args: string[] = [], timeout = 30000): any {
  const cmd = ["python3", SCRIPT_PATH, action, ...args].join(" ")
  try {
    const raw = execSync(cmd, { encoding: "utf-8", timeout })
    return JSON.parse(raw.trim())
  } catch (err: any) {
    // Try to parse JSON error from script
    if (err.stdout) {
      try {
        const parsed = JSON.parse(err.stdout.trim())
        if (parsed.error) return parsed
      } catch {}
    }
    return { error: err.message || "Script execution failed" }
  }
}

// ── iPhone Functions ──

export function detectDevice(): DeviceInfo | null {
  const result = runScript("detect")
  if (result.error) return null
  return result as DeviceInfo
}

export function getIPhoneStorage(): StorageInfo | null {
  const result = runScript("storage")
  if (result.error) return null
  return result as StorageInfo
}

export function getDcim(): DcimInfo | null {
  const result = runScript("dcim", [], 60000)
  if (result.error) return null
  return result as DcimInfo
}

export function getIPhoneApps(): AppInfo[] {
  const result = runScript("apps", [], 30000)
  if (result.error || !result.apps) return []
  return result.apps as AppInfo[]
}

export function offloadApp(bundleId: string): { success: boolean; error?: string } {
  const result = runScript("offload", [bundleId], 30000)
  if (result.error) return { success: false, error: result.error }
  return { success: true }
}

export function getICloudStatus(): ICloudStatus | null {
  const result = runScript("icloud", [], 90000)
  if (result.error) return null
  return result as ICloudStatus
}

// ── Mac Functions ──

export function getMacStorage(): StorageInfo {
  try {
    const raw = execSync("df -k /", { encoding: "utf-8", timeout: 5000 })
    const lines = raw.trim().split("\n")
    const parts = lines[1]?.split(/\s+/) || []
    const total = parseInt(parts[1] || "0") * 1024
    const used = parseInt(parts[2] || "0") * 1024
    const free = parseInt(parts[3] || "0") * 1024
    return { total_bytes: total, used_bytes: used, free_bytes: free }
  } catch {
    return { total_bytes: 0, used_bytes: 0, free_bytes: 0 }
  }
}

export function getMacModel(): string {
  try {
    const raw = execSync("system_profiler SPHardwareDataType", { encoding: "utf-8", timeout: 5000 })
    const match = raw.match(/Model Name:\s*(.+)/)
    return match?.[1]?.trim() || "Mac"
  } catch {
    return "Mac"
  }
}

export function getMacTopFolders(): { path: string; size_bytes: number }[] {
  const dirs = [
    "~/Downloads", "~/Sites", "~/Desktop", "~/Documents",
    "~/Movies", "~/Music", "~/Pictures",
    "~/Library/Application Support", "~/Library/Caches",
    "~/Library/Containers", "~/Library/Developer",
  ]
  const results: { path: string; size_bytes: number }[] = []
  for (const dir of dirs) {
    const expanded = dir.replace("~", homedir())
    try {
      const raw = execSync(`du -sk "${expanded}" 2>/dev/null`, { encoding: "utf-8", timeout: 15000 })
      const kb = parseInt(raw.split(/\s/)[0] || "0")
      results.push({ path: dir, size_bytes: kb * 1024 })
    } catch {
      // skip dirs that fail
    }
  }
  results.sort((a, b) => b.size_bytes - a.size_bytes)
  return results
}

// ── Diagnose ──

export function diagnose(): DiagnoseResult {
  const storage = getIPhoneStorage()
  const icloud = getICloudStatus()
  const dcim = getDcim()

  const phoneFree = storage?.free_bytes ?? -1
  const phoneTotal = storage?.total_bytes ?? -1
  const icloudFree = icloud?.available_quota ?? -1
  const syncStuck = icloud?.sync_up_stuck ?? 0
  const dcimEst = dcim?.total_est_bytes ?? 0
  const dcimFiles = dcim?.total_files ?? 0
  const icloudDead = icloud?.is_deadlocked ?? false

  const GB = 1024 * 1024 * 1024
  const recommendations: string[] = []
  let verdict: DiagnoseResult["verdict"] = "HEALTHY"

  if (phoneFree >= 0 && phoneFree < 500 * 1024 * 1024 && icloudFree === 0) {
    verdict = "DEADLOCKED"
    recommendations.push(
      "Offload unused apps immediately to free space: iris device clean",
      "Install Google Photos on iPhone, back up all photos, then disable iCloud Photos to free ~190 GB",
      "Clear iMessage attachments: Settings > General > iPhone Storage > Messages",
      "Clear Safari/Chrome cached data",
    )
  } else if (phoneFree >= 0 && phoneFree < 2 * GB) {
    verdict = "PHONE_LOW"
    recommendations.push(
      "Offload unused apps: iris device clean",
      "Clear app caches (Instagram, Chrome, TikTok)",
      "Delete old screenshots and screen recordings from Photos",
    )
  } else if (icloudFree === 0) {
    verdict = "ICLOUD_FULL"
    recommendations.push(
      "Back up photos to Google Photos, then disable iCloud Photos",
      "Delete old device backups: Settings > iCloud > Manage Storage > Backups",
      "Review iMessage attachments synced to iCloud",
    )
  }

  if (syncStuck > 0) {
    recommendations.push(`${syncStuck} items stuck waiting to sync — iCloud must have free space first`)
  }

  return {
    phone_free: phoneFree,
    phone_total: phoneTotal,
    icloud_free: icloudFree,
    icloud_deadlocked: icloudDead,
    sync_stuck: syncStuck,
    dcim_est: dcimEst,
    dcim_files: dcimFiles,
    verdict,
    recommendations,
  }
}

// ── Formatting Helpers ──

export function formatBytes(bytes: number): string {
  if (bytes < 0) return "?"
  const GB = 1024 * 1024 * 1024
  const MB = 1024 * 1024
  const KB = 1024
  if (bytes >= GB) return `${(bytes / GB).toFixed(1)} GB`
  if (bytes >= MB) return `${(bytes / MB).toFixed(0)} MB`
  if (bytes >= KB) return `${(bytes / KB).toFixed(0)} KB`
  return `${bytes} B`
}

export function formatBar(used: number, total: number, width = 40): string {
  if (total <= 0) return "░".repeat(width)
  const pct = Math.min(used / total, 1)
  const filled = Math.round(width * pct)
  const bar = "█".repeat(filled) + "░".repeat(width - filled)
  return `[${bar}] ${Math.round(pct * 100)}%`
}
