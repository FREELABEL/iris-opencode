import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, dim, bold, success, highlight, IRIS_API, FL_API, writeJson } from "./iris-api"
import { runChannelHealthChecks } from "./platform-leads"
import { execSync } from "child_process"
import { existsSync, readFileSync } from "fs"
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

/**
 * Interpret an ai_* status from /api/health?deep=true (#178281).
 *
 * The doctor used to accept only "key_valid" or "ok" and label everything else
 * "check API key". That is backwards for the healthiest state there is:
 * `billing_active` is what the server returns when the DEEP probe — a real
 * 1-token completion — SUCCEEDS (routes/api.php:218). It is strictly stronger
 * than key_valid, which only means the models endpoint answered.
 *
 * So `iris doctor` reported working OpenAI and XAI keys as broken, and running
 * the more thorough check made the result look worse. That is not a cosmetic
 * bug: this output is what led to a wrong root cause on #178291 — "billing_active
 * (check API key)" was read as bad credentials when the real fault was a 429
 * from a different provider entirely.
 *
 * Exported so the mapping is testable without a live server.
 */
export function aiProviderHealth(status: string, message?: string): CheckResult {
  const detail = message ? `${status} — ${message}` : status

  switch (status) {
    // Healthy. billing_active is the BEST case, not a warning.
    case "billing_active":
      return { name: "", ok: true, detail: "billing active (live completion succeeded)" }
    case "key_valid":
      return { name: "", ok: true, detail: "key valid" }
    case "ok":
      return { name: "", ok: true, detail: "ok" }

    // Real problems, each with the action that actually fixes it — "check API
    // key" is wrong for most of these.
    case "quota_exceeded":
      return { name: "", ok: false, detail, hint: "quota exhausted — add credits or raise the limit" }
    case "payment_required":
      return { name: "", ok: false, detail, hint: "billing needs payment on the provider account" }
    case "billing_blocked":
      return { name: "", ok: false, detail, hint: "provider blocked this account — check billing status" }
    case "rate_limited":
      // Billing is fine; the key is fine. Transient, but calls ARE failing now.
      return { name: "", ok: false, detail, hint: "rate limited — transient, retry shortly" }
    case "missing":
    case "not_configured":
      return { name: "", ok: false, detail, hint: "no API key configured for this provider" }
    case "error":
      return { name: "", ok: false, detail, hint: "provider probe failed — see message" }
  }

  if (/^http_4\d\d$/.test(status)) {
    const code = status.slice(5)
    return {
      name: "",
      ok: false,
      detail,
      hint: code === "401" || code === "403" ? "check API key" : `provider rejected the request (HTTP ${code})`,
    }
  }
  if (/^http_5\d\d$/.test(status)) {
    return { name: "", ok: false, detail, hint: "provider outage — not your key" }
  }

  return { name: "", ok: false, detail, hint: "unrecognised provider status" }
}

/**
 * Timeout for platform API probes (#178279).
 *
 * raichu.heyiris.io/api/health measures 7-9s in production. The previous 5s
 * budget produced a false "The operation timed out", which was then reported
 * as a client-side firewall problem. Reproduced from a second machine:
 * 7.19s / 9.05s / 8.68s. Connection-refused still fails fast, so a generous
 * ceiling costs nothing when a service is genuinely down.
 */
export const PLATFORM_PROBE_TIMEOUT_MS = 20000

async function checkEndpoint(name: string, url: string, base?: string): Promise<CheckResult> {
  try {
    const res = base
      ? await irisFetch(url, {}, base)
      : await fetch(url, { signal: AbortSignal.timeout(PLATFORM_PROBE_TIMEOUT_MS) })
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

    // ── 1b. Credential sanity (#120000) ──
    // Catch a stale/shared sdk/.env that authenticates you as someone else
    // (e.g. a pre-seeded dev token left over from a non-interactive install).
    try {
      const sdkEnvPath = join(homedir(), ".iris", "sdk", ".env")
      if (existsSync(sdkEnvPath)) {
        const envText = readFileSync(sdkEnvPath, "utf-8")
        const envUser = envText.match(/^IRIS_USER_ID=(.*)$/m)?.[1]?.trim()
        let nodeUser: string | undefined
        const cfgPath = join(homedir(), ".iris", "config.json")
        if (existsSync(cfgPath)) {
          try { nodeUser = String((JSON.parse(readFileSync(cfgPath, "utf-8")) as { user_id?: number | string }).user_id ?? "").trim() } catch {}
        }
        if (envUser && nodeUser && envUser !== nodeUser) {
          allResults.push({
            name: "Credentials",
            ok: false,
            detail: `sdk/.env user (${envUser}) ≠ this node's user (${nodeUser})`,
            hint: "sdk/.env may hold another account's token — rm ~/.iris/sdk/.env then: iris auth login",
          })
        } else if (/pre-seeded/i.test(envText)) {
          allResults.push({
            name: "Credentials",
            ok: false,
            detail: "sdk/.env holds a pre-seeded token (not self-authenticated)",
            hint: "confirm it's your own account, or rm ~/.iris/sdk/.env then: iris auth login",
          })
        } else {
          allResults.push({ name: "Credentials", ok: true, detail: "sdk/.env scoped to this user" })
        }
      }
    } catch {}

    // ── 2. Platform APIs ──
    sp.start("Checking platform APIs…")
    const [flApi, irisApi, irisHealth] = await Promise.all([
      // fl-api health is a public endpoint — do NOT send auth token (causes 503 on fl-api)
      checkEndpoint("fl-api (raichu)", `${FL_API}/api/health`),
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
              const health = aiProviderHealth(status, (val as any)?.message)
              allResults.push({
                name: `AI: ${providerName}`,
                ok: health.ok,
                detail: health.detail,
                hint: health.hint,
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
        const pid = readFileSync(daemonPid, "utf-8").trim()
        if (process.platform === "win32") {
          execSync(`tasklist /FI "PID eq ${pid}" | findstr ${pid}`, { encoding: "utf-8", timeout: 3000 })
        } else {
          execSync(`kill -0 ${pid} 2>/dev/null`)
        }
        allResults.push({ name: "IRIS Daemon", ok: true, detail: `PID ${pid}` })
      } catch {
        allResults.push({ name: "IRIS Daemon", ok: false, detail: "PID file exists but process dead", hint: "run: iris-daemon start" })
      }
    } else {
      allResults.push({ name: "IRIS Daemon", ok: false, detail: "not running", hint: "run: iris-daemon start" })
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

    // ── 5. macOS Permissions (skip on non-macOS) ──
    if (process.platform === "darwin") {
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
    } else {
      allResults.push({ name: "macOS Permissions", ok: true, detail: "skipped (not macOS)" })
    }

    // ── 6. SEO & Bot Protection ──
    sp.start("Testing SEO health…")
    const seoResults = await runSEOChecks()
    allResults.push(...seoResults)
    sp.stop("SEO checked")

    // ── 7. Local Tools ──
    const localTools = ["node", "git", "sqlite3", "curl"]
    const whichCmd = process.platform === "win32" ? "where" : "which"
    for (const tool of localTools) {
      try {
        execSync(`${whichCmd} ${tool}`, { encoding: "utf-8", timeout: 2000, stdio: "pipe" })
        allResults.push({ name: `Tool: ${tool}`, ok: true })
      } catch {
        allResults.push({ name: `Tool: ${tool}`, ok: false, hint: `install ${tool}` })
      }
    }

    // ── Render Results ──
    if (args.json) {
      await writeJson(allResults)
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
