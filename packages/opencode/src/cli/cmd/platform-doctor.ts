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

// ── SEO & Bot Protection Checks ──
// Tests that search engine bots aren't being blocked, robots.txt is valid,
// and profile/event pages return correct responses.

async function runSEOChecks(): Promise<CheckResult[]> {
  const results: CheckResult[] = []
  const prodUrl = "https://freelabel.net"
  const flApiUrl = FL_API || "https://raichu.heyiris.io"

  // 1. Googlebot isn't blocked — simulate Googlebot UA against production
  const botUAs: Array<{ name: string; ua: string; expectOk: boolean }> = [
    {
      name: "SEO: Googlebot",
      ua: "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
      expectOk: true,
    },
    {
      name: "SEO: Googlebot Render",
      ua: "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
      expectOk: true,
    },
    {
      name: "SEO: Bingbot",
      ua: "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
      expectOk: true,
    },
    {
      name: "SEO: Storebot-Google",
      ua: "Mozilla/5.0 (Linux; Android 8.0; Pixel 2 Build/OPD3.170816.012; Storebot-Google/1.0)",
      expectOk: true,
    },
  ]

  for (const bot of botUAs) {
    try {
      const res = await fetch(`${prodUrl}/`, {
        headers: { "User-Agent": bot.ua },
        signal: AbortSignal.timeout(8000),
        redirect: "follow",
      })
      const ok = bot.expectOk ? res.status !== 403 : res.status === 403
      results.push({
        name: bot.name,
        ok,
        detail: `HTTP ${res.status}`,
        hint: !ok ? (bot.expectOk ? "bot is being BLOCKED — check ThrottleBots" : undefined) : undefined,
      })
    } catch (e: any) {
      results.push({
        name: bot.name,
        ok: false,
        detail: e.message?.slice(0, 50) ?? "unreachable",
        hint: "could not reach production",
      })
    }
  }

  // 2. robots.txt is accessible and allows Googlebot
  try {
    const res = await fetch(`${prodUrl}/robots.txt`, { signal: AbortSignal.timeout(5000) })
    if (res.ok) {
      const body = await res.text()
      const allowsGoogle = !body.includes("User-agent: Googlebot\nDisallow: /")
      const hasSitemap = body.toLowerCase().includes("sitemap:")
      results.push({
        name: "SEO: robots.txt",
        ok: allowsGoogle,
        detail: allowsGoogle ? "Googlebot allowed" : "Googlebot BLOCKED",
        hint: !allowsGoogle ? "robots.txt is blocking Googlebot crawling" : undefined,
      })
      results.push({
        name: "SEO: Sitemap ref",
        ok: hasSitemap,
        detail: hasSitemap ? "sitemap declared" : "no sitemap in robots.txt",
        hint: !hasSitemap ? "add Sitemap: directive to robots.txt" : undefined,
      })
    } else {
      results.push({ name: "SEO: robots.txt", ok: false, detail: `HTTP ${res.status}` })
    }
  } catch (e: any) {
    results.push({ name: "SEO: robots.txt", ok: false, detail: e.message?.slice(0, 50) ?? "unreachable" })
  }

  // 3. Profile pages resolve (test /@slug routing)
  try {
    const res = await fetch(`${flApiUrl}/api/v1/events?limit=1`, {
      headers: { "Accept": "application/json" },
      signal: AbortSignal.timeout(5000),
    })
    if (res.ok) {
      const data = (await res.json()) as any
      const events = data?.data ?? []
      if (events.length > 0) {
        const ev = events[0]
        const hasStages = ev.stages?.length > 0 || ev.eventStages?.length > 0
        results.push({
          name: "SEO: Event API",
          ok: true,
          detail: `${ev.name?.slice(0, 30)} — ${hasStages ? "has stages" : "no stages"}`,
        })
      } else {
        results.push({ name: "SEO: Event API", ok: true, detail: "no events yet" })
      }
    } else {
      results.push({ name: "SEO: Event API", ok: false, detail: `HTTP ${res.status}` })
    }
  } catch (e: any) {
    results.push({ name: "SEO: Event API", ok: false, detail: e.message?.slice(0, 50) ?? "unreachable" })
  }

  return results
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
    {
      const { isAvailable } = await import("../lib/imessage")
      const ok = isAvailable()
      allResults.push({
        name: "Full Disk Access",
        ok,
        detail: ok ? "Messages.app readable" : "cannot read Messages.app",
        hint: ok ? undefined : "System Settings → Privacy → Full Disk Access",
      })
    }

    // Contacts access (needed for address book matching)
    try {
      execSync(`sqlite3 "${homedir()}/Library/Application Support/AddressBook/AddressBook-v22.abcddb" "SELECT count(*) FROM ZABCDRECORD LIMIT 1" 2>&1`, { encoding: "utf-8", timeout: 3000 })
      allResults.push({ name: "Contacts Access", ok: true, detail: "AddressBook readable" })
    } catch {
      allResults.push({ name: "Contacts Access", ok: false, detail: "cannot read AddressBook", hint: "may need Contacts permission for terminal" })
    }
    sp.stop("Permissions checked")

    // ── 6. SEO & Bot Protection ──
    sp.start("Testing SEO health…")
    const seoResults = await runSEOChecks()
    allResults.push(...seoResults)
    sp.stop("SEO checked")

    // ── 7. Local Tools ──
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
