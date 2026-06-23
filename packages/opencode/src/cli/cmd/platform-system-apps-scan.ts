import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, dim, bold, success } from "./iris-api"
import { execSync } from "child_process"
import { hostname, platform, arch, userInfo, release } from "os"

// ============================================================================
// iris system:apps-scan — cross-platform installed-software inventory (#1073)
//
// Enumerates installed applications on the local machine (Windows via the
// registry uninstall keys, macOS via system_profiler) plus machine identity,
// and optionally pushes them to bloq-scoped Atlas datasets so software/license
// spend can be accounted for centrally.
//
// Delivery note: the hive cannot enroll Windows hosts (bash-only), so on Windows
// install iris via heyiris.io/install-code.ps1 and run this command on-machine.
// ============================================================================

interface ScannedApp {
  name: string
  version: string
  vendor: string
  source: string
  installDate: string
}

function printDivider() { console.log(dim("  " + "─".repeat(72))) }

/** Stable, deterministic per-machine id (no MAC/serial harvesting). */
function machineId(): string {
  const slug = hostname().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
  return `${slug}-${platform()}`
}

// ── Platform scanners ───────────────────────────────────────────────────────

function scanMacApps(): ScannedApp[] {
  const raw = execSync("system_profiler SPApplicationsDataType -json", {
    encoding: "utf-8",
    timeout: 120_000,
    maxBuffer: 128 * 1024 * 1024,
  })
  const parsed = JSON.parse(raw)
  const items: any[] = parsed?.SPApplicationsDataType ?? []
  return items.map((a) => ({
    name: a._name ?? "",
    version: a.version ?? "",
    vendor: a.obtained_from === "apple" ? "Apple" : (a.signed_by?.[0] ?? ""),
    source: a.obtained_from ?? "",
    installDate: (a.lastModified ?? "").slice(0, 10),
  }))
}

function scanWindowsApps(): ScannedApp[] {
  // Registry uninstall keys — fast + complete (unlike `wmic product`).
  const ps = [
    "$ErrorActionPreference='SilentlyContinue';",
    "$keys=@('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',",
    "'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',",
    "'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*');",
    "Get-ItemProperty $keys | Where-Object {$_.DisplayName} |",
    "Select-Object DisplayName,DisplayVersion,Publisher,InstallDate |",
    "ConvertTo-Json -Compress",
  ].join(" ")
  const raw = execSync(`powershell -NoProfile -ExecutionPolicy Bypass -Command "${ps}"`, {
    encoding: "utf-8",
    timeout: 120_000,
    maxBuffer: 64 * 1024 * 1024,
  })
  if (!raw.trim()) return []
  const parsed = JSON.parse(raw)
  const items: any[] = Array.isArray(parsed) ? parsed : [parsed] // single result isn't wrapped in an array
  return items
    .filter((a) => a?.DisplayName)
    .map((a) => ({
      name: a.DisplayName ?? "",
      version: a.DisplayVersion ?? "",
      vendor: a.Publisher ?? "",
      source: "registry",
      // Registry InstallDate is "YYYYMMDD" → "YYYY-MM-DD".
      installDate: /^\d{8}$/.test(a.InstallDate ?? "")
        ? `${a.InstallDate.slice(0, 4)}-${a.InstallDate.slice(4, 6)}-${a.InstallDate.slice(6, 8)}`
        : "",
    }))
}

function scanLinuxApps(): ScannedApp[] {
  // Best-effort; primary targets are Windows/macOS.
  try {
    const raw = execSync("dpkg-query -W -f='${Package}\\t${Version}\\n'", { encoding: "utf-8", timeout: 60_000, maxBuffer: 32 * 1024 * 1024 })
    return raw.split("\n").filter(Boolean).map((l) => {
      const [name, version] = l.split("\t")
      return { name: name ?? "", version: version ?? "", vendor: "", source: "dpkg", installDate: "" }
    })
  } catch {
    try {
      const raw = execSync("rpm -qa --qf '%{NAME}\\t%{VERSION}\\n'", { encoding: "utf-8", timeout: 60_000, maxBuffer: 32 * 1024 * 1024 })
      return raw.split("\n").filter(Boolean).map((l) => {
        const [name, version] = l.split("\t")
        return { name: name ?? "", version: version ?? "", vendor: "", source: "rpm", installDate: "" }
      })
    } catch {
      return []
    }
  }
}

function scanApps(): ScannedApp[] {
  let apps: ScannedApp[]
  switch (platform()) {
    case "darwin": apps = scanMacApps(); break
    case "win32": apps = scanWindowsApps(); break
    case "linux": apps = scanLinuxApps(); break
    default: throw new Error(`Unsupported platform: ${platform()}`)
  }
  // Normalize: drop nameless, dedupe by name+version, sort by name.
  const seen = new Set<string>()
  return apps
    .filter((a) => a.name && a.name.trim())
    .filter((a) => { const k = `${a.name}::${a.version}`; if (seen.has(k)) return false; seen.add(k); return true })
    .sort((a, b) => a.name.localeCompare(b.name))
}

// ── Atlas push ────────────────────────────────────────────────────────────────

const MACHINE_SCHEMA = "system-machines"
const APPS_SCHEMA = "system-apps"

/** Create a dataset schema if it doesn't already exist (idempotent). */
async function ensureSchema(slug: string, name: string, fields: Array<{ key: string; label: string; type: string }>, bloq?: number): Promise<boolean> {
  const existing = await irisFetch(`/api/v1/atlas/schemas/${slug}`)
  if (existing.ok) return true
  const body: Record<string, any> = { name, slug, fields: { fields } }
  if (bloq != null) body.bloq_id = bloq
  const res = await irisFetch("/api/v1/atlas/schemas", { method: "POST", body: JSON.stringify(body) })
  return handleApiError(res, `Create schema ${slug}`)
}

async function upsert(slug: string, externalId: string, data: Record<string, any>, bloq?: number): Promise<boolean> {
  const body: Record<string, any> = { external_id: externalId, data }
  if (bloq != null) body.bloq_id = bloq
  const res = await irisFetch(`/api/v1/atlas/datasets/${slug}/upsert`, { method: "POST", body: JSON.stringify(body) })
  return handleApiError(res, `Upsert ${externalId}`)
}

// ── Command ─────────────────────────────────────────────────────────────────

export const PlatformSystemAppsScanCommand = cmd({
  command: "system:apps-scan",
  aliases: ["apps-scan"],
  describe: "scan installed applications on this machine (software/license inventory)",
  builder: (y) =>
    y
      .option("push", { type: "boolean", default: false, describe: "push results to bloq-scoped Atlas datasets" })
      .option("bloq", { type: "number", describe: "bloq ID to scope the inventory to (required with --push)" })
      .option("filter", { type: "string", describe: "only include apps whose name contains this substring" })
      .option("json", { type: "boolean", default: false, describe: "JSON output" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  System Apps Scan")

    const mid = machineId()
    const meta = { machine_id: mid, hostname: hostname(), platform: platform(), arch: arch(), username: safeUser(), os_release: release() }

    const spinner = prompts.spinner()
    spinner.start(`Scanning installed apps on ${meta.hostname} (${meta.platform})…`)
    let apps: ScannedApp[]
    try {
      apps = scanApps()
    } catch (err) {
      spinner.stop("Scan failed", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
      return
    }
    if (args.filter) {
      const f = args.filter.toLowerCase()
      apps = apps.filter((a) => a.name.toLowerCase().includes(f))
    }
    spinner.stop(`${apps.length} apps found`)

    if (args.json) {
      console.log(JSON.stringify({ machine: meta, apps }, null, 2))
    } else {
      printDivider()
      console.log(`  ${dim("machine:")} ${bold(meta.hostname)}  ${dim(`${meta.platform}/${meta.arch} · ${meta.username}`)}`)
      printDivider()
      for (const a of apps.slice(0, 200)) {
        console.log(`  ${bold(a.name.slice(0, 40).padEnd(40))} ${dim((a.version || "—").padEnd(16))} ${dim(a.vendor || a.source)}`)
      }
      if (apps.length > 200) console.log(dim(`  …and ${apps.length - 200} more`))
      printDivider()
    }

    if (!args.push) {
      prompts.outro(`${apps.length} apps. Re-run with --push --bloq <id> to store in Atlas.`)
      return
    }

    // ── push path ──
    if (args.bloq == null) {
      prompts.log.error("--bloq <id> is required with --push (scopes the inventory to a workspace).")
      prompts.outro("Done")
      return
    }
    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const push = prompts.spinner()
    push.start("Ensuring schemas…")
    const okM = await ensureSchema(MACHINE_SCHEMA, "System Machines", [
      { key: "machine_id", label: "Machine ID", type: "text" },
      { key: "hostname", label: "Hostname", type: "text" },
      { key: "platform", label: "Platform", type: "text" },
      { key: "arch", label: "Arch", type: "text" },
      { key: "username", label: "User", type: "text" },
      { key: "os_release", label: "OS Release", type: "text" },
      { key: "app_count", label: "App Count", type: "number" },
      { key: "scanned_at", label: "Scanned At", type: "text" },
    ], args.bloq)
    const okA = await ensureSchema(APPS_SCHEMA, "System Apps", [
      { key: "machine_id", label: "Machine ID", type: "text" },
      { key: "hostname", label: "Hostname", type: "text" },
      { key: "name", label: "App", type: "text" },
      { key: "version", label: "Version", type: "text" },
      { key: "vendor", label: "Vendor", type: "text" },
      { key: "source", label: "Source", type: "text" },
      { key: "install_date", label: "Installed", type: "text" },
      { key: "scanned_at", label: "Scanned At", type: "text" },
    ], args.bloq)
    if (!okM || !okA) { push.stop("Schema setup failed", 1); prompts.outro("Done"); return }

    const scannedAt = new Date().toISOString()
    push.message("Pushing machine record…")
    await upsert(MACHINE_SCHEMA, mid, { ...meta, app_count: apps.length, scanned_at: scannedAt }, args.bloq)

    let pushed = 0
    for (const a of apps) {
      const ok = await upsert(APPS_SCHEMA, `${mid}::${a.name}`, {
        machine_id: mid, hostname: meta.hostname,
        name: a.name, version: a.version, vendor: a.vendor, source: a.source,
        install_date: a.installDate, scanned_at: scannedAt,
      }, args.bloq)
      if (ok) pushed++
      if (pushed % 25 === 0) push.message(`Pushing apps… ${pushed}/${apps.length}`)
    }
    push.stop(success(`pushed ${pushed} apps for ${mid} → bloq ${args.bloq}`))
    prompts.outro("Done")
  },
})

function safeUser(): string {
  try { return userInfo().username } catch { return "" }
}
