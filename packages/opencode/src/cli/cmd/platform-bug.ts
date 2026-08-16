import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, printDivider, printKV, dim, bold, success, highlight, FL_API, IRIS_API, resolveUserId, requireUserId, writeJson } from "./iris-api"
import { hiveFetch } from "./platform-hive-nodes"
import { Auth } from "../../auth"
import { homedir, platform, release, arch, hostname, userInfo } from "os"
import { join, dirname } from "path"
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs"
import { randomUUID } from "crypto"
import { execSync } from "child_process"

// Bug reports go to bloq #297 (under user 193) via PUBLIC endpoint — no auth required
const BUG_REPORT_ENDPOINT = "/api/v1/public/bug-report"
const BUG_BLOQ_ID = 297

// Resolve a bug (record the fix/solution + commit) via PUBLIC endpoint — no auth required
const bugResolveEndpoint = (itemId: number) => `/api/v1/public/bug-report/${itemId}/resolve`
// Amend a bug after the fact (reporter attribution / severity / status / title / note) — no auth
const bugUpdateEndpoint = (itemId: number) => `/api/v1/public/bug-report/${itemId}/update`

/**
 * Render the fix badge for a bug (#177916).
 *
 * The badge used to key off "a resolution exists", with no status check — so a bug that was
 * WRONGLY closed and then reopened kept its green `✓ FIXED <commit>` stamp while showing
 * `todo`. Both at once, which reads as "fixed" to anyone scanning the board, and is exactly
 * how a bad batch close (#177912) survives a QA reopen invisibly.
 *
 * A resolution on a bug that is NOT done is a CONTRADICTED claim, so render it as one.
 */
export function fixBadge(status: unknown, hasResolution: boolean, fixCommit?: string): string {
  if (!hasResolution) return ""
  const commit = fixCommit ? ` ${fixCommit}` : ""
  const done = String(status ?? "").toLowerCase() === "done"
  return done ? success(`✓ FIXED${commit}`) : dim(`was marked fixed${commit} — REOPENED`)
}

/** Repo identity for the cwd, so a fix stamp can say WHICH repo it came from (#177912). */
function detectGitRepo(): string | undefined {
  try {
    const remote = execSync("git config --get remote.origin.url", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim()
    return remote.match(/github\.com[:/]([^/]+\/.+?)(?:\.git)?$/i)?.[1]
  } catch {
    return undefined
  }
}

/**
 * The caller's API key, if we have one — used to attribute a bug report to a real person
 * instead of to the machine it was filed from (#178532, #158230).
 *
 * Checked in the order a key is most likely to be authoritative:
 *   1. the stored credential from `iris auth login`
 *   2. IRIS_API_KEY / FL_API_TOKEN in the environment — this is the one that matters for MCP,
 *      because McpController mints a per-user key and hands it to the iris-exec runner
 *   3. ~/.iris/sdk/.env, which is where the installer writes it (same file platform-hive-enroll
 *      reads for exactly this reason)
 *
 * Returns "" rather than throwing. Bug reporting must never fail because auth had a bad day —
 * an unattributed report is worth far more than no report.
 */
async function resolveReporterToken(): Promise<string> {
  try {
    const stored = await Auth.get("iris")
    if (stored?.type === "api" && stored.key) return stored.key
  } catch {}

  if (process.env.IRIS_API_KEY) return process.env.IRIS_API_KEY
  if (process.env.FL_API_TOKEN) return process.env.FL_API_TOKEN

  try {
    const envPath = join(homedir(), ".iris", "sdk", ".env")
    if (existsSync(envPath)) {
      for (const line of readFileSync(envPath, "utf8").split("\n")) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith("#")) continue
        const eq = trimmed.indexOf("=")
        if (eq < 0) continue
        if (trimmed.slice(0, eq).trim() === "IRIS_API_KEY") {
          return trimmed.slice(eq + 1).trim()
        }
      }
    }
  } catch {}

  return ""
}

// Best-effort current git commit info from the cwd (used to stamp the fix that closed a bug)
function detectGitCommit(): { hash?: string; url?: string } {
  try {
    const hash = execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim()
    if (!hash) return {}

    let url: string | undefined
    try {
      const remote = execSync("git config --get remote.origin.url", { stdio: ["ignore", "pipe", "ignore"] })
        .toString()
        .trim()
      // Normalize git@github.com:Org/repo.git and https URLs into a browsable commit link
      const m = remote.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/i)
      if (m) {
        const fullHash = execSync("git rev-parse HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim()
        url = `https://github.com/${m[1]}/${m[2]}/commit/${fullHash}`
      }
    } catch {}

    return { hash, url }
  } catch {
    return {}
  }
}

// ============================================================================
// Never lose a report
// ============================================================================

const PENDING_BUGS_DIR = join(homedir(), ".iris", "pending-bugs")

/**
 * Keep a report that could not be sent, so it can be sent later.
 *
 * On 2026-08-15 the bug endpoint returned 500 for every submission on the host the CLI
 * posts to. The user experience was one line — "Failed to submit bug report (HTTP 500)" —
 * and the report they had just written was gone. There is no worse endpoint to lose data
 * on: this is the channel people use to tell us something is broken, so the failures it
 * swallows are exactly the failures we most need to hear about, and we cannot even count
 * them because the only record would have been the reports.
 *
 * Returns the path so the caller can tell the user where their words went.
 */
function queueBugReport(payload: string): string | null {
  try {
    mkdirSync(PENDING_BUGS_DIR, { recursive: true })
    const file = join(PENDING_BUGS_DIR, `${Date.now()}-${randomUUID().slice(0, 8)}.json`)
    writeFileSync(file, payload, { mode: 0o600 })
    return file
  } catch {
    return null
  }
}

// ============================================================================
// Stable reporter identity
// ============================================================================

/**
 * A hostname is NOT a stable identity, and on macOS it is barely stable at all.
 *
 * mDNS appends a collision counter whenever another device claims the same name on the
 * network, so one Mac reports as `Alexs-MacBook-Pro-7653.local` today and
 * `Alexs-MacBook-Pro-7087.local` next week. Measured on the live bug board: 144 clinical
 * tickets carried 20 distinct reporter strings that collapse to 8 actual people — one
 * person appeared as 20 reporters across suffixes 5563, 5988, 6841, 7087, 7195, 7285,
 * 7653. Under the MCP connector it is worse: the hostname is a container id that rotates
 * every deploy, so everyone on one deploy also collapses into a single fake reporter.
 *
 * Attribution that fragments cannot be used to thank, follow up, or pay anybody — which
 * is the whole point of recording it.
 */
function stableMachineId(): string {
  const idPath = join(homedir(), ".iris", "machine-id")
  try {
    if (existsSync(idPath)) {
      const existing = readFileSync(idPath, "utf-8").trim()
      if (existing) return existing
    }
  } catch {}

  // Random, not derived from hardware: a machine id that can be recomputed from serial
  // numbers or MAC addresses is a fingerprint, and this only needs to be *consistent*,
  // not identifying. Persisted so it survives hostname churn and CLI upgrades.
  const id = randomUUID()
  try {
    mkdirSync(dirname(idPath), { recursive: true })
    writeFileSync(idPath, id + "\n", { mode: 0o600 })
  } catch {
    // Unwritable home (sandbox, read-only container) — fall back to a per-run id rather
    // than failing the report. Marked so the server can tell it apart from a real one.
    return "ephemeral-" + id
  }
  return id
}

/**
 * Strip the mDNS collision counter and `.local` so the same machine reads the same way
 * even before `machine_id` exists (older reports, and the human-facing display).
 *
 * `Alexs-MacBook-Pro-7653.local` → `Alexs-MacBook-Pro`
 * Deliberately conservative: only a trailing `-<3-5 digits>` is removed, so a machine
 * genuinely named `build-box-01` or `node-2` keeps its name.
 */
export function normalizeHostname(host: string): string {
  // Keep only the first LABEL: the rest is the network domain (.local, .attlocal.net,
  // .lan), which says which network the machine was on when it filed, not which machine it
  // is. Measured: one Mac appeared as three reporters purely for moving between home wifi,
  // tethering and mDNS.
  const label = host.split(".")[0] ?? host
  // Then the mDNS collision counter. 3-5 digits only, so `build-box-01` and `node-2` keep
  // their names — and digits INSIDE the label are left alone, because `AlexMaysnow1063` and
  // `AlexMaysnow1008` are two real machines on this fleet and merging them would be worse
  // than leaving them split.
  return label.replace(/-\d{3,5}$/, "")
}

// ============================================================================
// System info collection
// ============================================================================

function collectSystemInfo(): Record<string, string> {
  const info: Record<string, string> = {
    platform: platform(),
    release: release(),
    arch: arch(),
    hostname: hostname(),
    user: userInfo().username,
    cwd: process.cwd(),
    node: process.version,
    iris_version: "unknown",
  }

  // Don't call "iris --version" — causes recursive hang in compiled binary
  info.iris_version = process.env.npm_package_version || "compiled"

  // Get recent iris commands from bash history (cap read to avoid slow I/O on huge files)
  try {
    const histPath = join(homedir(), ".bash_history")
    if (existsSync(histPath)) {
      // Read only the last 8KB to avoid hanging on multi-MB history files
      const fd = require("fs").openSync(histPath, "r")
      const stat = require("fs").fstatSync(fd)
      const readSize = Math.min(stat.size, 8192)
      const buf = Buffer.alloc(readSize)
      require("fs").readSync(fd, buf, 0, readSize, Math.max(0, stat.size - readSize))
      require("fs").closeSync(fd)
      const lines = buf.toString("utf-8")
        .split("\n")
        .filter((l: string) => l.includes("iris"))
        .slice(-10)
      info.recent_iris_commands = lines.join(" | ")
    }
  } catch {}

  return info
}

// ============================================================================
// Bug submission
// ============================================================================

async function submitBug(args: {
  title: string
  description: string
  severity: string
  command?: string
  error?: string
  reporterLeadId?: number
  reporterName?: string
  json?: boolean
}): Promise<void> {
  const sysInfo = collectSystemInfo()

  // `reporter` is DIAGNOSTICS now, not identity (#178532, #158230). It used to be the only thing
  // the server had, and under the MCP connector the CLI runs in a container — so this string is a
  // container id that rotates every deploy. One person became four reporters over a few weeks;
  // everyone on a single deploy became one. Keep it (the /app cwd is what exposed the bug), but
  // the Authorization header below is what actually says who filed this.
  // Normalised, so the same machine reads the same way across mDNS renames. The raw
  // hostname stays in system_info for diagnostics — that is what exposed the /app cwd
  // under the MCP connector — but it must not be the thing that names a person.
  const reporter = `${sysInfo.user}@${normalizeHostname(sysInfo.hostname)}`

  // The endpoint stays public — an unauthenticated tester must still be able to report. But when
  // we DO hold a key, send it: fl-api derives reporter_user_id from the token server-side, marks
  // it reporter_verified, and ignores any claim in the body. Without this header the report is
  // recorded as honestly-unattributed, which is better than a container id but still means a beta
  // user who reports through Claude cannot be thanked, followed up, or paid a bounty.
  const authToken = await resolveReporterToken()

  // Built once so the fallback host resends the IDENTICAL report rather than a
  // reconstruction that might differ from whatever the primary rejected.
  const payload = JSON.stringify({
    title: args.title,
    description: args.description,
    severity: args.severity,
    reporter,
    machine_id: stableMachineId(),
    reporter_lead_id: args.reporterLeadId ?? null,
    reporter_name: args.reporterName ?? null,
    system_info: sysInfo,
    command: args.command ?? null,
    error: args.error ?? null,
  })

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15000)

  let res: Response
  try {
    res = await fetch(`${FL_API}${BUG_REPORT_ENDPOINT}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      },
      // machine_id survives hostname churn AND container redeploys, so reports from one
      // machine stay one machine. Random persisted UUID, not derived from hardware.
      body: payload,
      signal: controller.signal,
    })
  } catch (e: any) {
    clearTimeout(timeout)
    if (e.name === "AbortError") {
      throw new Error(`Bug report timed out after 15s. Check your network connection and try again.`)
    }
    throw new Error(`Network error submitting bug report: ${e.message}`)
  } finally {
    clearTimeout(timeout)
  }

  // FALL BACK, THEN QUEUE. This endpoint is how someone tells us the product is broken, and
  // on 2026-08-15 it was the broken thing: fl-api returned 500 for every submission while
  // iris-api served the same path fine. Reporters got "HTTP 500" and nothing else — no
  // retry, no second host, no local copy. Reports were simply lost, and the only record
  // that they had existed would have been the reports.
  //
  // A bug reporter with no retry path is the one endpoint that must have one.
  if (!res.ok && res.status >= 500) {
    try {
      const alt = await fetch(`${IRIS_API}${BUG_REPORT_ENDPOINT}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
        },
        body: payload,
        signal: AbortSignal.timeout(15000),
      })
      if (alt.ok) res = alt
    } catch {
      // Fall through to the queue below — the primary already failed, so a failed
      // fallback changes nothing about what we owe the user.
    }
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "")
    // Never lose the report at the keyboard. Someone took the trouble to write it.
    const queued = queueBugReport(payload)
    throw new Error(
      `Failed to submit bug report (HTTP ${res.status}): ${text}` +
        (queued ? `\n\nSaved locally: ${queued}\nRetry all queued reports with: iris bug flush` : ""),
    )
  }

  const data = (await res.json()) as { success?: boolean; data?: { item_id?: number; message?: string } }
  const itemId = data?.data?.item_id

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          success: true,
          item_id: itemId,
          bloq_id: BUG_BLOQ_ID,
          title: args.title,
        },
        null,
        2,
      ),
    )
    return
  }

  console.log("")
  console.log(success("✓ Bug report submitted"))
  console.log(`  ${dim("Bloq:")} IRIS CLI Bug Reports (#${BUG_BLOQ_ID})`)
  if (itemId) console.log(`  ${dim("Item ID:")} #${itemId}`)
  console.log(`  ${dim("Severity:")} ${args.severity}`)
  console.log("")
  console.log(dim("The IRIS team will review and respond. Thanks for helping improve IRIS!"))
}

// ============================================================================
// Commands
// ============================================================================

const ReportCommand = cmd({
  command: "report [title..]",
  aliases: ["submit", "new"],
  describe: "submit a bug report to the IRIS team",
  builder: (yargs) =>
    yargs
      .positional("title", { describe: "short bug title", type: "string", array: true })
      .option("description", {
        alias: "d",
        describe: "detailed description",
        type: "string",
      })
      .option("severity", {
        alias: "s",
        describe: "bug severity",
        choices: ["low", "medium", "high", "critical"] as const,
        default: "medium" as const,
      })
      .option("command", {
        alias: "c",
        describe: "the command that failed (optional)",
        type: "string",
      })
      .option("error", {
        alias: "e",
        describe: "error output (optional)",
        type: "string",
      })
      .option("bounty", {
        alias: "b",
        describe: "post as exchange listing with bounty in dollars (e.g. --bounty 25)",
        type: "number",
      })
      .option("repo", {
        describe: "repo URL for exchange listing (used with --bounty)",
        type: "string",
      })
      .option("user-id", { describe: "user ID (for exchange listing)", type: "number" })
      .option("reporter-lead", {
        describe: "lead ID of the person who actually reported the bug (for bounty attribution)",
        type: "number",
      })
      .option("reporter-name", {
        describe: "display name of the reporter (optional, used with --reporter-lead)",
        type: "string",
      })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    // Combine positional title words + any passthrough args (after --)
    // This handles cases like: iris bug report "--something broke" where yargs
    // would otherwise treat --something as a flag
    const titleParts: string[] = []
    if (Array.isArray(args.title)) titleParts.push(...args.title.map(String))
    if (Array.isArray(args["--"])) titleParts.push(...args["--"].map(String))
    let title = titleParts.join(" ").trim() || undefined
    let description = args.description
    let severity = args.severity as string

    // Guard: catch known subcommand names passed as titles (e.g. "iris bug report list")
    const subcommands = ["list", "ls", "close", "done", "resolve", "complete"]
    if (title && subcommands.includes(title.toLowerCase())) {
      console.error(`\n  Unknown subcommand: ${title}`)
      console.error(`  Did you mean: ${dim(`iris bug ${title}`)}`)
      console.error(`  To submit a report: ${dim(`iris bug report "your bug title here"`)}`)
      console.error("")
      process.exitCode = 1
      return
    }

    // Interactive mode if no title provided
    if (!title || title.length === 0) {
      // In --json mode or non-TTY, don't hang on interactive prompts
      if (args.json || !process.stdin.isTTY) {
        console.error("Error: --title is required in non-interactive mode")
        console.error("Usage: iris bug report \"your bug title here\"")
        process.exitCode = 1
        return
      }

      console.log("")
      console.log(bold("🐛 Report a Bug"))
      console.log(dim("Help us improve IRIS by reporting issues you encounter."))
      console.log(dim("Press Ctrl+C to cancel at any time."))
      console.log("")

      const t = await prompts.text({
        message: "Bug title (short summary)",
        placeholder: "e.g., atlas:meetings ingest fails with 404",
        validate: (v) => (!v || v.length < 5 ? "Title must be at least 5 characters" : undefined),
      })
      if (prompts.isCancel(t)) {
        prompts.cancel("Cancelled")
        process.exit(0)
      }
      title = String(t)

      const d = await prompts.text({
        message: "What happened? (detailed description)",
        placeholder: "Describe what you tried, what you expected, and what actually happened",
      })
      if (prompts.isCancel(d)) {
        prompts.cancel("Cancelled")
        process.exit(0)
      }
      description = String(d)

      const s = await prompts.select({
        message: "Severity",
        options: [
          { value: "low", label: "Low — minor inconvenience" },
          { value: "medium", label: "Medium — affects workflow" },
          { value: "high", label: "High — blocks important tasks" },
          { value: "critical", label: "Critical — completely broken" },
        ],
        initialValue: "medium",
      })
      if (prompts.isCancel(s)) {
        prompts.cancel("Cancelled")
        process.exit(0)
      }
      severity = String(s)
    }

    if (!description) description = "(no description provided)"

    try {
      await submitBug({
        title: title!,
        description,
        severity: severity.toLowerCase(),
        command: args.command,
        error: args.error,
        reporterLeadId: args["reporter-lead"] as number | undefined,
        reporterName: args["reporter-name"] as string | undefined,
        json: args.json,
      })
    } catch (e: any) {
      console.error(`Failed to submit bug: ${e.message}`)
      process.exit(1)
    }

    // Phase 2: IRIS Contribute — also create an exchange listing if --bounty is set
    if (args.bounty && (args.bounty as number) > 0) {
      const bountyDollars = args.bounty as number
      const bountyCents = Math.round(bountyDollars * 100)

      try {
        const userId = await requireUserId(args["user-id"] as number | undefined)
        if (!userId) return

        const res = await hiveFetch(`/api/v6/exchange/listings`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            user_id: userId,
            title: `[BUG] ${title}`,
            description: `${description}\n\n---\nSeverity: ${severity}\nFiled via: iris bug --bounty ${bountyDollars}`,
            bounty_cents: bountyCents,
            category: "bug_fix",
            repo_url: args.repo || null,
            max_claim_hours: 48,
            expires_days: 14,
          }),
        })

        if (res.ok) {
          const data = (await res.json()) as { listing: any }
          if (!args.json) {
            console.log()
            console.log(success(`  Exchange listing created: ${highlight(`$${bountyDollars.toFixed(2)}`)} bounty`))
            console.log(dim(`  ID: ${data.listing.id}`))
            console.log(dim(`  View: iris hive exchange show ${data.listing.id.substring(0, 8)}`))
          }
        } else {
          if (!args.json) {
            console.log(dim(`  Exchange listing failed (HTTP ${res.status}) — bug still filed`))
          }
        }
      } catch {
        if (!args.json) {
          console.log(dim("  Exchange listing failed — bug still filed"))
        }
      }
    }
  },
})

const ListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list bug reports (with pagination and filtering)",
  builder: (yargs) =>
    yargs
      .option("limit", { describe: "results per page", type: "number", default: 20 })
      .option("page", { alias: "p", describe: "page number", type: "number", default: 1 })
      .option("status", { describe: "filter by status (default: open bugs only)", choices: ["todo", "in_progress", "done", "all"] as const, default: "todo" as const })
      .option("severity", { describe: "filter by severity", choices: ["low", "medium", "high", "critical"] as const })
      .option("search", { alias: "q", describe: "search bug titles", type: "string" })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    const token = await requireAuth()
    if (!token) return

    const userId = await resolveUserId()
    if (!userId) {
      console.error("Could not resolve user ID. Set IRIS_USER_ID or run iris-login.")
      return
    }

    const params = new URLSearchParams({
      per_page: String(args.limit),
      page: String(args.page),
    })
    if (args.status && args.status !== "all") params.set("status", args.status)
    if (args.search) params.set("search", args.search)

    const res = await irisFetch(`/api/v1/user/${userId}/bloqs/${BUG_BLOQ_ID}/items?${params}`)
    const ok = await handleApiError(res, "List bug reports")
    if (!ok) return

    const data = (await res.json()) as any
    const rawItems = data?.data?.items ?? data?.data?.data ?? data?.data ?? []
    let items: any[] = Array.isArray(rawItems) ? rawItems : Object.values(rawItems)

    // Extract pagination info from response
    const pagination = data?.data?.pagination ?? data?.meta ?? null
    const totalItems = pagination?.total ?? items.length
    const currentPage = pagination?.current_page ?? args.page
    const lastPage = pagination?.last_page ?? Math.ceil(totalItems / args.limit)

    // Client-side severity filter (API may not support this param)
    if (args.severity) {
      const sev = args.severity.toLowerCase()
      items = items.filter((item: any) => {
        const contentStr = item.content ?? item.description ?? ""
        const itemSev = contentStr.match(/Severity:\*?\*?\s*(\w+)/i)?.[1]?.toLowerCase() ?? ""
        return itemSev === sev
      })
    }

    if (args.json) {
      // AWAITED write, not console.log. console.log is fire-and-forget: for a
      // large payload Bun hands part of it to the pipe and the process exits
      // before the rest drains, so the consumer gets a JSON document cut off
      // mid-string. Measured on this command — three of four runs of
      // `--limit 40 --json | python` truncated at exactly 81,856 chars while the
      // fourth delivered all 142,482. It reads as corrupt data rather than a
      // lost write, and never reproduces in a terminal because TTY writes are
      // synchronous. Awaiting the write removes the race.
      await writeJson({ items, page: currentPage, total: totalItems, last_page: lastPage })
      return
    }

    // Build header with active filters
    const filters: string[] = []
    if (args.status && args.status !== "all") filters.push(`status=${args.status}`)
    if (args.severity) filters.push(`severity=${args.severity}`)
    if (args.search) filters.push(`search="${args.search}"`)
    const filterStr = filters.length > 0 ? ` (${filters.join(", ")})` : ""

    console.log("")
    console.log(bold("📋 Bug Reports"))
    console.log(`  ${dim(`Bloq #${BUG_BLOQ_ID} — ${items.length} item(s)${filterStr} — Page ${currentPage}/${lastPage}`)}`)
    printDivider()

    if (items.length === 0) {
      console.log(`  ${dim("No bug reports found")}`)
      if (filters.length > 0) {
        console.log(`  ${dim("Try: iris bug list --status=all")}`)
      }
    } else {
      for (const item of items) {
        const contentStr = item.content ?? item.description ?? ""
        const severity = contentStr.match(/Severity:\*?\*?\s*(\w+)/i)?.[1] ?? ""
        const sevTag = severity ? `  [${severity.toUpperCase()}]` : ""
        const status = item.status ? `  ${dim(item.status)}` : ""
        // Surface the recorded fix (if any) so other machines can see what resolved it
        const fixCommit = contentStr.match(/Fix commit:\*?\*?\s*`?([0-9a-f]{6,40})`?/i)?.[1]
        const hasResolution = /###\s*✅?\s*Resolution/i.test(contentStr)
        const badge = fixBadge(item.status, hasResolution, fixCommit)
        const fixTag = badge ? `  ${badge}` : ""
        console.log(`  ${bold(String(item.title))}  ${dim(`#${item.id}`)}${sevTag}${status}${fixTag}`)
        if (contentStr) {
          // Show first meaningful line (skip markdown headers)
          const lines = String(contentStr).split("\n").filter((l: string) => l.trim() && !l.startsWith("**") && !l.startsWith("#"))
          if (lines.length > 0) {
            console.log(`    ${dim(lines[0].slice(0, 100))}`)
          }
        }
        console.log()
      }
    }

    printDivider()
    if (currentPage < lastPage) {
      console.log(dim(`  iris bug list --page=${currentPage + 1} — next page`))
    }
    if (currentPage > 1) {
      console.log(dim(`  iris bug list --page=${currentPage - 1} — previous page`))
    }
    console.log(dim("  iris bug list --status=all — include completed bugs"))
    console.log(dim("  iris bug list --severity=critical — critical bugs only"))
    console.log(dim("  iris bug list --search=\"invoice\" — search titles"))
    console.log(dim("  iris bug report — submit a new bug"))
    console.log("")
  },
})

// Show the full, untruncated detail of a single bug by ID. `list` truncates the body
// to one line, so there was no way to read a full report from the CLI without --json
// scraping. Pages through the bug bloq (all statuses) to find the item.
const ShowCommand = cmd({
  command: "show <id>",
  aliases: ["view", "get"],
  describe: "show the full details of a single bug report by ID",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "bug item ID", type: "number", demandOption: true })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    const token = await requireAuth()
    if (!token) return

    const userId = await resolveUserId()
    if (!userId) {
      console.error("Could not resolve user ID. Set IRIS_USER_ID or run iris-login.")
      return
    }

    const targetId = Number(args.id)
    let found: any = null
    const perPage = 50
    const maxPages = 60 // safety cap (~3000 items)

    for (let page = 1; page <= maxPages && !found; page++) {
      // Omit the status param entirely — that's how the API returns ALL statuses
      // (the `list` command treats status=all as "don't send the param"). Sending a
      // literal status=all filters to nothing.
      const params = new URLSearchParams({
        per_page: String(perPage),
        page: String(page),
      })
      const res = await irisFetch(`/api/v1/user/${userId}/bloqs/${BUG_BLOQ_ID}/items?${params}`)
      const ok = await handleApiError(res, "Show bug report")
      if (!ok) return

      const data = (await res.json()) as any
      const rawItems = data?.data?.items ?? data?.data?.data ?? data?.data ?? []
      const items: any[] = Array.isArray(rawItems) ? rawItems : Object.values(rawItems)
      if (items.length === 0) break

      found = items.find((it: any) => Number(it.id) === targetId)

      const pagination = data?.data?.pagination ?? data?.meta ?? null
      const total = pagination?.total ?? items.length
      const lastPage = pagination?.last_page ?? Math.ceil(total / perPage)
      if (page >= lastPage) break
    }

    if (!found) {
      if (args.json) {
        console.log(JSON.stringify({ error: "not_found", id: targetId }, null, 2))
        return
      }
      console.error(`\n  Bug #${targetId} not found (searched open + closed).`)
      console.error(`  ${dim('Try: iris bug list --status=all --search="keyword"')}\n`)
      process.exitCode = 1
      return
    }

    if (args.json) {
      console.log(JSON.stringify(found, null, 2))
      return
    }

    const contentStr = found.content ?? found.description ?? ""
    const severity = contentStr.match(/Severity:\*?\*?\s*(\w+)/i)?.[1] ?? ""
    const hasResolution = /###\s*✅?\s*Resolution/i.test(contentStr)
    const fixCommit = contentStr.match(/Fix commit:\*?\*?\s*`?([0-9a-f]{6,40})`?/i)?.[1]

    console.log("")
    console.log(`  ${bold(String(found.title))}  ${dim(`#${found.id}`)}`)
    const meta: string[] = []
    if (severity) meta.push(`[${severity.toUpperCase()}]`)
    if (found.status) meta.push(dim(String(found.status)))
    const showBadge = fixBadge(found.status, hasResolution, fixCommit)
    if (showBadge) meta.push(showBadge)
    if (meta.length) console.log(`  ${meta.join("  ")}`)
    printDivider()
    console.log(contentStr ? String(contentStr) : dim("  (no description)"))

    // ATTRIBUTION — who this bug is credited to, and from which machine.
    //
    // The API never serialised `attachments`, so there was no read path anywhere that
    // could answer "who gets paid for this". Resolving a mis-attribution meant filing a
    // probe bug and watching `bounty:hunters` move, which is an absurd way to read a
    // field — and verifying machine_id had landed was impossible outright.
    const att = (found as any).attachments
    if (att && typeof att === "object" && Object.keys(att).length) {
      printDivider()
      console.log(`  ${bold("Attribution")}`)
      if (att.reporter_name) console.log(`    ${dim("name:")}        ${att.reporter_name}`)
      if (att.reporter_lead_id) console.log(`    ${dim("lead:")}        ${att.reporter_lead_id}`)
      if (att.reporter_user_id) console.log(`    ${dim("user:")}        ${att.reporter_user_id}`)
      if ("reporter_verified" in att) {
        // Verified means the TOKEN proved it. An unverified claim is still recorded, and
        // a payout must be able to tell "we know who this is" from "someone typed a number".
        console.log(
          `    ${dim("verified:")}    ` +
          (att.reporter_verified
            ? `${UI.Style.TEXT_SUCCESS}yes${UI.Style.TEXT_NORMAL}`
            : `${UI.Style.TEXT_WARNING}no — claimed, not proven${UI.Style.TEXT_NORMAL}`),
        )
      }
      if (att.machine_id) {
        const eph = att.machine_id_ephemeral ? dim("  (ephemeral — differs next run)") : ""
        console.log(`    ${dim("machine:")}     ${String(att.machine_id).slice(0, 18)}…${eph}`)
      }
      if (!att.reporter_lead_id && !att.reporter_user_id) {
        console.log(`    ${dim("unattributed — set one with:")} iris bug update ${found.id} --reporter-lead <id>`)
      }
    }

    printDivider()
    console.log(dim(`  iris bug close ${found.id} --solution "..." — record the fix`))
    console.log("")
  },
})

// Record the fix/solution + commit on a bug via the PUBLIC resolve endpoint (no auth).
// This stamps the resolution into the bug's content so every other machine sees what fixed it.
async function resolveBug(
  itemId: number,
  body: { solution: string; fix_commit?: string; fix_commit_url?: string; resolver: string },
): Promise<void> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15000)

  let res: Response
  try {
    res = await fetch(`${FL_API}${bugResolveEndpoint(itemId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } catch (e: any) {
    clearTimeout(timeout)
    if (e.name === "AbortError") throw new Error("Resolve timed out after 15s. Check your network and try again.")
    throw new Error(`Network error recording resolution: ${e.message}`)
  } finally {
    clearTimeout(timeout)
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`HTTP ${res.status}: ${text}`)
  }
}

const CloseCommand = cmd({
  command: "close <id..>",
  aliases: ["done", "resolve", "complete"],
  describe: "mark bug report(s) as completed — optionally record the fix/solution + commit hash",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "bug item ID(s)", type: "number", array: true, demandOption: true })
      .option("solution", {
        alias: ["fix", "f"],
        describe: "describe how it was fixed — recorded on the bug so other machines see it",
        type: "string",
      })
      .option("commit", {
        alias: "hash",
        describe: "fix commit hash (auto-detected from git HEAD when --solution is given)",
        type: "string",
      })
      .option("no-commit", { describe: "skip git commit auto-detection", type: "boolean", default: false })
      .option("note", { alias: "n", describe: "(deprecated alias for --solution)", type: "string" })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    const ids = (args.id as number[]).filter(Boolean)
    if (ids.length === 0) {
      console.error("No bug IDs provided")
      process.exitCode = 1
      return
    }

    // --note is the legacy flag; treat it as a solution if --solution wasn't given
    const solution = (args.solution as string | undefined) ?? (args.note as string | undefined)

    // ── Path A: record a fix (public resolve endpoint, no auth, sets status=done) ──
    if (solution && solution.trim()) {
      const sysInfo = collectSystemInfo()
      const resolver = `${sysInfo.user}@${sysInfo.hostname}`

      // yargs treats `--no-commit` as NEGATING the --commit string option (sets
      // args.commit === false), so the declared `no-commit` boolean never flips true.
      // Honor BOTH forms, else --no-commit was ignored and we stamped the cwd's HEAD —
      // often the wrong repo (e.g. the parent monorepo, not where the fix landed).
      const noCommit = args["no-commit"] === true || (args.commit as unknown) === false
      let fixCommit = typeof args.commit === "string" ? (args.commit as string) : undefined
      let fixCommitUrl: string | undefined
      if (!fixCommit && !noCommit) {
        // NEVER auto-stamp a BATCH close (#177912). cwd HEAD is a single commit in a single
        // repo; N bugs closed together are rarely all fixed by it. This is exactly how
        // #177889-#177893 (iris-opencode work) got stamped with fd678579 — an unrelated
        // fl-api geo commit that happened to be the cwd's HEAD — making five "fixed"
        // references untrustworthy and hiding that none were actually fixed.
        if (ids.length > 1) {
          prompts.log.error(
            `Refusing to auto-stamp a commit across ${ids.length} bugs — cwd HEAD is one commit in one repo.`,
          )
          prompts.log.info(dim("Pass --commit <hash> if they really share a fix, --no-commit to record none,"))
          prompts.log.info(dim("or close them one at a time so each gets its own commit."))
          prompts.outro("Done")
          return
        }
        const git = detectGitCommit()
        fixCommit = git.hash
        fixCommitUrl = git.url
        // Say WHICH repo the stamp came from. Silence is what let a wrong-repo hash through.
        if (fixCommit) {
          const repo = detectGitRepo()
          prompts.log.info(dim(`Stamping ${fixCommit}${repo ? ` from ${repo}` : ""} (cwd HEAD) — use --commit to override.`))
        }
      }

      const spinner = prompts.spinner()
      spinner.start(`Recording fix for ${ids.length} bug(s)…`)

      const results: Array<{ id: number; ok: boolean; error?: string }> = []
      for (const bugId of ids) {
        try {
          await resolveBug(bugId, {
            solution: solution.trim(),
            fix_commit: fixCommit,
            fix_commit_url: fixCommitUrl,
            resolver,
          })
          results.push({ id: bugId, ok: true })
        } catch (e: any) {
          results.push({ id: bugId, ok: false, error: e.message })
        }
      }

      const okCount = results.filter((r) => r.ok).length
      const failCount = results.filter((r) => !r.ok).length

      if (args.json) {
        spinner.stop("")
        console.log(JSON.stringify({ results, ok: okCount, failed: failCount, fix_commit: fixCommit ?? null }, null, 2))
        return
      }

      if (failCount === 0) {
        spinner.stop(`${success("✓")} ${okCount} bug(s) resolved`)
      } else {
        spinner.stop(`${okCount} resolved, ${failCount} failed`)
        for (const r of results.filter((r) => !r.ok)) prompts.log.error(`#${r.id}: ${r.error}`)
      }
      if (fixCommit) console.log(`  ${dim("Fix commit:")} ${highlight(fixCommit)}`)
      console.log(dim("  Other machines will see this fix via iris bug list --status=all"))
      return
    }

    // ── Path B: plain close (no fix recorded) — authed status update ──
    const token = await requireAuth()
    if (!token) return

    // Bug bloq is owned by user 193 — use that as the route userId
    // so the ownership check in updateStatus passes
    const BUG_OWNER_USER_ID = 193

    const spinner = prompts.spinner()
    spinner.start(`Closing ${ids.length} bug(s)…`)

    const results: Array<{ id: number; ok: boolean; error?: string }> = []

    for (const bugId of ids) {
      try {
        const res = await irisFetch(`/api/v1/user/${BUG_OWNER_USER_ID}/bloqs/item/${bugId}/status`, {
          method: "PATCH",
          body: JSON.stringify({ status: "done" }),
        })

        if (!res.ok) {
          const text = await res.text().catch(() => "")
          results.push({ id: bugId, ok: false, error: `HTTP ${res.status}: ${text}` })
        } else {
          results.push({ id: bugId, ok: true })
        }
      } catch (e: any) {
        results.push({ id: bugId, ok: false, error: e.message })
      }
    }

    const okCount = results.filter((r) => r.ok).length
    const failCount = results.filter((r) => !r.ok).length

    if (args.json) {
      spinner.stop("")
      console.log(JSON.stringify({ results, ok: okCount, failed: failCount }, null, 2))
      return
    }

    if (failCount === 0) {
      spinner.stop(`${success("✓")} ${okCount} bug(s) marked as done`)
    } else {
      spinner.stop(`${okCount} closed, ${failCount} failed`)
      for (const r of results.filter((r) => !r.ok)) {
        prompts.log.error(`#${r.id}: ${r.error}`)
      }
    }
    console.log(dim("  Tip: iris bug close <id> --solution \"how you fixed it\" records the fix for other machines"))
    console.log(dim("  iris bug list --status=all  — view all bugs"))
  },
})

// The marketplace Opportunity that funds bug-bounty payouts (config bounty.bug_opportunity_id).
const BUG_OPPORTUNITY_ID = 581

// Verify (accept) reported bugs for the bug bounty. This flips them to status=done — the state
// BugBountyPayoutService/BloqItemObserver treat as "verified" — so they become payout-eligible
// (the batch sweep keys off done; auto-pay fires on the todo->done transition). Owner-authed via
// the marketplace verifyBug route; the response is the owner bug console (payout status per bug).
const VerifyCommand = cmd({
  command: "verify <id..>",
  aliases: ["accept"],
  describe: "verify bug report(s) for the bug bounty — marks them done so the reporter can be paid",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "bug item ID(s) to verify", type: "number", array: true, demandOption: true })
      .option("opportunity", { alias: "o", describe: "bounty opportunity id", type: "number", default: BUG_OPPORTUNITY_ID })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    const token = await requireAuth()
    if (!token) return

    const ids = (args.id as number[]).filter(Boolean)
    if (ids.length === 0) {
      console.error("No bug IDs provided")
      process.exitCode = 1
      return
    }
    const oppId = Number(args.opportunity)

    const spinner = prompts.spinner()
    spinner.start(`Verifying ${ids.length} bug(s) for opportunity #${oppId}…`)

    // The console returned by the LAST successful call — its per-bug rows carry the payout amount
    // + status we surface (amount_cents, payout_status, severity).
    let lastConsole: any = null
    const results: Array<{ id: number; ok: boolean; error?: string }> = []
    for (const bugId of ids) {
      try {
        const res = await irisFetch(
          `/api/v1/marketplace/opportunities/${oppId}/bug-bounty/bugs/${bugId}/verify`,
          { method: "POST" },
        )
        if (!res.ok) {
          const text = await res.text().catch(() => "")
          results.push({ id: bugId, ok: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}` })
          continue
        }
        lastConsole = ((await res.json()) as any)?.data ?? null
        results.push({ id: bugId, ok: true })
      } catch (e: any) {
        results.push({ id: bugId, ok: false, error: e.message })
      }
    }

    const okCount = results.filter((r) => r.ok).length
    const failCount = results.filter((r) => !r.ok).length

    if (args.json) {
      spinner.stop("")
      console.log(JSON.stringify({ results, ok: okCount, failed: failCount, console: lastConsole }, null, 2))
      return
    }

    if (failCount === 0) {
      spinner.stop(`${success("✓")} ${okCount} bug(s) verified`)
    } else {
      spinner.stop(`${okCount} verified, ${failCount} failed`)
      for (const r of results.filter((r) => !r.ok)) prompts.log.error(`#${r.id}: ${r.error}`)
    }

    // Surface each verified bug's resulting payout state from the owner console.
    const byId = new Map<number, any>()
    for (const b of (lastConsole?.bugs ?? [])) byId.set(Number(b.id), b)
    for (const r of results.filter((r) => r.ok)) {
      const b = byId.get(r.id)
      if (b) {
        const amount = `$${(((b.amount_cents ?? 0) as number) / 100).toFixed(2)}`
        console.log(`  ${dim(`#${r.id}`)} ${String(b.severity ?? "").toUpperCase()} → ${highlight(amount)}  ${dim(String(b.payout_status ?? ""))}`)
      }
    }
    console.log(dim("  Verified bugs are payout-eligible. Pay: iris bounty pay <id> --execute (or the batch sweep)."))
    console.log("")
  },
})

const UpdateCommand = cmd({
  command: "update <id>",
  aliases: ["edit", "amend"],
  describe: "amend a bug — reporter attribution, severity, status, title, or an appended note",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "bug item ID", type: "number", demandOption: true })
      .option("reporter-lead", { describe: "lead ID to attribute as the reporter (bounty tally)", type: "number" })
      .option("reporter-user", { describe: "user ID to attribute as the reporter", type: "number" })
      .option("reporter-name", { describe: "display name of the reporter", type: "string" })
      .option("clear-reporter", {
        describe: "detach reporter attribution entirely (lead, user and name)",
        type: "boolean",
        default: false,
      })
      .option("severity", { alias: "s", describe: "low | medium | high | critical", type: "string" })
      .option("status", { describe: "board status (todo, in_progress, done, …)", type: "string" })
      .option("title", { describe: "new title (severity prefix preserved)", type: "string" })
      .option("description", { alias: ["d", "note"], describe: "append an update note to the bug", type: "string" })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    const itemId = args.id as number
    const body: Record<string, unknown> = {}
    // --reporter-lead had no inverse: once a bug was attributed, nothing in the CLI
    // could detach it, so a mis-attribution could only be corrected with production DB
    // access. On a system whose value is an auditable money trail, that made the trail
    // append-only by accident (#178618). Send explicit nulls so the server clears the
    // keys rather than merely omitting them.
    if (args["clear-reporter"]) {
      body.reporter_lead_id = null
      body.reporter_user_id = null
      body.reporter_name = null
    } else {
      // Accept 0 / negative as "detach" too, so `--reporter-lead 0` does the obvious thing.
      const lead = args["reporter-lead"] as number | undefined
      if (lead != null) body.reporter_lead_id = lead > 0 ? lead : null
      if (args["reporter-user"] != null) {
        const u = args["reporter-user"] as number
        body.reporter_user_id = u > 0 ? u : null
      }
      if (args["reporter-name"]) body.reporter_name = args["reporter-name"]
    }
    if (args.severity) body.severity = args.severity
    if (args.status) body.status = args.status
    if (args.title) body.title = args.title
    if (args.description) body.description = args.description

    if (Object.keys(body).length === 0) {
      console.error(
        "\n  Nothing to update. Pass at least one of:\n" +
          "    --reporter-lead <id> [--reporter-name <name>]  ·  --severity <sev>  ·  --status <s>  ·  --title <t>  ·  --description <note>\n",
      )
      process.exitCode = 1
      return
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15000)
    let res: Response
    try {
      res = await fetch(`${FL_API}${bugUpdateEndpoint(itemId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (e: any) {
      clearTimeout(timeout)
      console.error(e.name === "AbortError" ? "Update timed out after 15s." : `Network error: ${e.message}`)
      process.exitCode = 1
      return
    } finally {
      clearTimeout(timeout)
    }

    const data = await res.json().catch(() => ({}) as any)
    if (!res.ok || data?.success === false) {
      console.error(`Update failed: ${data?.error ?? `HTTP ${res.status}`}`)
      process.exitCode = 1
      return
    }

    // VERIFY THE WRITE LANDED (#179802). This used to fall back to Object.keys(body) — the
    // fields we SENT — whenever the server did not say what it changed, so a multi-field
    // update that applied only one of them still printed all three as updated. Observed:
    // `bug update <id> -s high --title … --description …` applied only the description while
    // reporting success; re-running each flag alone worked. Assert against the item itself.
    const requested = Object.keys(body)
    // `applied` is the REQUEST fields the server acted on. `updated` is the COLUMNS it wrote,
    // and the two do not correspond — a note lands in `content`, severity lands in `title`,
    // and `content` is rewritten on every call. Checking a request field against the column
    // list meant `--note` reported "did NOT apply" on writes that had landed perfectly well:
    // four identical notes went onto one bug, and a duplicate ticket was opened to carry the
    // one presumed lost. Prefer `applied`; fall back to re-reading the item; never treat the
    // column list as an answer about a field it does not name.
    const serverSaid = Array.isArray(data?.data?.applied) ? (data.data.applied as string[]) : null
    let missed: string[] = []

    if (serverSaid) {
      missed = requested.filter((k) => !serverSaid.includes(k))
    } else {
      // No per-field receipt — re-read and compare the fields we can check directly.
      try {
        const check = await irisFetch(`/api/v1/bloqs/items/${itemId}`)
        const fresh = ((await check.json()) as any)?.data ?? null
        if (fresh) {
          const cmp: Record<string, unknown> = {
            severity: fresh.severity,
            status: fresh.status,
            title: fresh.title,
          }
          missed = requested.filter(
            (k) => k in cmp && cmp[k] != null && String(cmp[k]) !== String(body[k]),
          )
        }
      } catch {
        // Unreadable — say nothing rather than claiming either way.
      }
    }

    if (args.json) {
      console.log(JSON.stringify({ ...data, requested, not_applied: missed }, null, 2))
    } else if (missed.length) {
      console.log(
        `${success("✓")} Bug #${itemId} updated` +
          dim(` (${requested.filter((k) => !missed.includes(k)).join(", ") || "nothing"})`),
      )
      prompts.log.error(
        `These did NOT apply: ${missed.join(", ")}.\n` +
          `Re-run them one at a time — a multi-field update can silently drop fields.`,
      )
      process.exitCode = 1
    } else {
      const fields = serverSaid ?? requested
      console.log(success(`✓ Bug #${itemId} updated`) + dim(` (${fields.join(", ")})`))
    }
  },
})

// ============================================================================
// Root command
// ============================================================================


/**
 * Resend reports that could not be submitted when they were written.
 *
 * The queue exists because the endpoint went down (see queueBugReport). A queue nobody can
 * drain is just a slower way of losing the report, so this is not optional furniture.
 */
const FlushCommand = cmd({
  command: "flush",
  describe: "resend bug reports that were saved locally when submission failed",
  builder: (y) => y.option("json", { type: "boolean", default: false }),
  async handler(args: any) {
    const fs = await import("fs")
    if (!existsSync(PENDING_BUGS_DIR)) {
      console.log(dim("  No queued bug reports."))
      return
    }
    const files = fs.readdirSync(PENDING_BUGS_DIR).filter((f: string) => f.endsWith(".json")).sort()
    if (files.length === 0) {
      console.log(dim("  No queued bug reports."))
      return
    }

    const authToken = await resolveReporterToken()
    let sent = 0
    const failed: string[] = []

    for (const f of files) {
      const full = join(PENDING_BUGS_DIR, f)
      let body: string
      try {
        body = readFileSync(full, "utf8")
      } catch {
        continue
      }
      // Try both hosts, same order as a live submission.
      let ok = false
      for (const base of [FL_API, IRIS_API]) {
        try {
          const r = await fetch(`${base}${BUG_REPORT_ENDPOINT}`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json",
              ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
            },
            body,
            signal: AbortSignal.timeout(15000),
          })
          if (r.ok) {
            ok = true
            break
          }
        } catch {
          // try the next host
        }
      }
      if (ok) {
        // Only delete once it is definitely accepted somewhere.
        try {
          fs.unlinkSync(full)
        } catch {}
        sent++
      } else {
        failed.push(f)
      }
    }

    if (args.json) {
      console.log(JSON.stringify({ sent, failed }, null, 2))
      return
    }
    console.log()
    if (sent) console.log(`${success("✓")} sent ${sent} queued report${sent === 1 ? "" : "s"}`)
    if (failed.length) {
      console.log(`${highlight("!")} ${failed.length} still queued in ${dim(PENDING_BUGS_DIR)}`)
      console.log(dim("  Both hosts refused them. They are kept, not discarded."))
    }
    console.log()
  },
})

export const PlatformBugCommand = cmd({
  command: "bug",
  aliases: ["bugs", "report"],
  describe: "report bugs and view your submissions",
  builder: (yargs) => yargs.command(ReportCommand).command(ListCommand).command(ShowCommand).command(VerifyCommand).command(CloseCommand).command(UpdateCommand).command(FlushCommand).demandCommand(),
  async handler() {},
})
