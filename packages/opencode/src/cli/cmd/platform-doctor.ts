import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, dim, bold, success, highlight, IRIS_API, FL_API } from "./iris-api"
import { runChannelHealthChecks } from "./platform-leads"
import { execSync } from "child_process"
import { existsSync } from "fs"
import { join } from "path"
import { homedir } from "os"

// ============================================================================
// iris doctor — Full system health check (#57678)
//
// Checks: SDK auth, fl-api, iris-api, integrations, macOS permissions,
//         bridge/daemon, Stripe, AI providers
// ============================================================================

function printDivider() { console.log(dim("  " + "─".repeat(72))) }

interface CheckResult {
  name: string
  ok: boolean
  detail?: string
  hint?: string
}

async function checkEndpoint(name: string, url: string, base?: string): Promise<CheckResult> {
  try {
    const res = base
      ? await irisFetch(url, {}, base)
      : await fetch(url, { signal: AbortSignal.timeout(5000) })
    if (res.ok) return { name, ok: true, detail: `${res.status} OK` }
    return { name, ok: false, detail: `HTTP ${res.status}` }
  } catch (e: any) {
    return { name, ok: false, detail: e.message?.slice(0, 60) ?? "unreachable" }
  }
}

export const PlatformDoctorCommand = cmd({
  command: "doctor",
  aliases: ["health", "checkup"],
  describe: "full system health check — integrations, tokens, macOS permissions, daemon, SDK",
  builder: (y) =>
    y.option("json", { type: "boolean", default: false, describe: "JSON output" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  IRIS Doctor")

    const allResults: CheckResult[] = []

    // ── 1. SDK Authentication ──
    const sp = prompts.spinner()
    sp.start("Checking SDK auth…")
    const token = await requireAuth()
    if (!token) {
      allResults.push({ name: "SDK Auth", ok: false, hint: "run: iris auth login" })
      sp.stop("Auth failed")
    } else {
      allResults.push({ name: "SDK Auth", ok: true, detail: "token present" })
      sp.stop("Authenticated")
    }

    // ── 2. Platform APIs ──
    sp.start("Checking platform APIs…")
    const [flApi, irisApi, irisHealth] = await Promise.all([
      checkEndpoint("fl-api (raichu)", "/api/health", FL_API),
      checkEndpoint("iris-api", "/api/health", IRIS_API),
      checkEndpoint("iris-api deep health", "/api/health?deep=true", IRIS_API),
    ])
    allResults.push(flApi, irisApi, irisHealth)

    // Parse AI provider status from deep health
    if (irisHealth.ok) {
      try {
        const res = await irisFetch("/api/health?deep=true", {}, IRIS_API)
        if (res.ok) {
          const data = (await res.json()) as any
          for (const [key, val] of Object.entries(data)) {
            if (key.startsWith("ai_")) {
              const providerName = key.replace("ai_", "").toUpperCase()
              const status = (val as any)?.status ?? "unknown"
              allResults.push({
                name: `AI: ${providerName}`,
                ok: status === "key_valid" || status === "ok",
                detail: status,
                hint: status !== "key_valid" ? "check API key" : undefined,
              })
            }
          }
        }
      } catch {}
    }
    sp.stop("APIs checked")

    // ── 3. Bridge / Daemon ──
    sp.start("Checking bridge + daemon…")
    const bridgeHealth = await checkEndpoint("IRIS Bridge", "http://localhost:3200/health")
    allResults.push(bridgeHealth)

    // Check daemon PID
    const daemonPid = join(homedir(), ".iris", "daemon.pid")
    if (existsSync(daemonPid)) {
      try {
        const pid = execSync(`cat "${daemonPid}"`, { encoding: "utf-8" }).trim()
        execSync(`kill -0 ${pid} 2>/dev/null`)
        allResults.push({ name: "IRIS Daemon", ok: true, detail: `PID ${pid}` })
      } catch {
        allResults.push({ name: "IRIS Daemon", ok: false, detail: "PID file exists but process dead", hint: "run: iris hive start" })
      }
    } else {
      allResults.push({ name: "IRIS Daemon", ok: false, detail: "not running", hint: "run: iris hive start" })
    }
    sp.stop("Bridge checked")

    // ── 4. Channel Integrations (#57677) ──
    sp.start("Verifying integrations…")
    const channelChecks = await runChannelHealthChecks()
    for (const ch of channelChecks) {
      allResults.push({
        name: ch.name,
        ok: ch.ok,
        detail: ch.ok ? "connected + verified" : ch.error,
        hint: ch.hint,
      })
    }
    sp.stop("Integrations verified")

    // ── 5. macOS Permissions ──
    sp.start("Checking macOS permissions…")
    // Full Disk Access (needed for iMessage SQLite)
    try {
      const db = `${homedir()}/Library/Messages/chat.db`
      execSync(`sqlite3 "${db}" "SELECT 1 FROM message LIMIT 1" 2>&1`, { encoding: "utf-8", timeout: 3000 })
      allResults.push({ name: "Full Disk Access", ok: true, detail: "Messages.app readable" })
    } catch {
      allResults.push({ name: "Full Disk Access", ok: false, detail: "cannot read Messages.app", hint: "System Settings → Privacy → Full Disk Access" })
    }

    // Contacts access (needed for address book matching)
    try {
      execSync(`sqlite3 "${homedir()}/Library/Application Support/AddressBook/AddressBook-v22.abcddb" "SELECT count(*) FROM ZABCDRECORD LIMIT 1" 2>&1`, { encoding: "utf-8", timeout: 3000 })
      allResults.push({ name: "Contacts Access", ok: true, detail: "AddressBook readable" })
    } catch {
      allResults.push({ name: "Contacts Access", ok: false, detail: "cannot read AddressBook", hint: "may need Contacts permission for terminal" })
    }
    sp.stop("Permissions checked")

    // ── 6. Local Tools ──
    const localTools = ["node", "git", "sqlite3", "curl"]
    for (const tool of localTools) {
      try {
        execSync(`which ${tool}`, { encoding: "utf-8", timeout: 2000 })
        allResults.push({ name: `Tool: ${tool}`, ok: true })
      } catch {
        allResults.push({ name: `Tool: ${tool}`, ok: false, hint: `install ${tool}` })
      }
    }

    // ── Render Results ──
    if (args.json) {
      console.log(JSON.stringify(allResults, null, 2))
      prompts.outro("Done")
      return
    }

    const passing = allResults.filter((r) => r.ok).length
    const failing = allResults.filter((r) => !r.ok).length

    console.log()
    printDivider()
    for (const r of allResults) {
      const icon = r.ok ? success("✓") : `${UI.Style.TEXT_DANGER}✗${UI.Style.TEXT_NORMAL}`
      const detail = r.detail ? dim(` (${r.detail})`) : ""
      const hint = (!r.ok && r.hint) ? `  ${dim(`→ ${r.hint}`)}` : ""
      console.log(`  ${icon} ${r.name.padEnd(22)}${detail}${hint}`)
    }
    printDivider()

    console.log()
    if (failing === 0) {
      console.log(`  ${success(`All ${passing} checks passing`)}`)
    } else {
      console.log(`  ${success(`${passing} passing`)}  ${UI.Style.TEXT_DANGER}${failing} failing${UI.Style.TEXT_NORMAL}`)
    }

    prompts.outro("Done")
  },
})
