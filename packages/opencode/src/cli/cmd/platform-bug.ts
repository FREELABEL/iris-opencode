import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, printDivider, printKV, dim, bold, success, highlight, FL_API, IRIS_API, resolveUserId, requireUserId } from "./iris-api"
import { hiveFetch } from "./platform-hive-nodes"
import { homedir, platform, release, arch, hostname, userInfo } from "os"
import { join } from "path"
import { existsSync, readFileSync } from "fs"
import { execSync } from "child_process"

// Bug reports go to bloq #297 (under user 193) via PUBLIC endpoint — no auth required
const BUG_REPORT_ENDPOINT = "/api/v1/public/bug-report"
const BUG_BLOQ_ID = 297

// Resolve a bug (record the fix/solution + commit) via PUBLIC endpoint — no auth required
const bugResolveEndpoint = (itemId: number) => `/api/v1/public/bug-report/${itemId}/resolve`

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
  const reporter = `${sysInfo.user}@${sysInfo.hostname}`

  // POST to public bug report endpoint — no auth required, always writes to user 193's bloq
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15000)

  let res: Response
  try {
    res = await fetch(`${FL_API}${BUG_REPORT_ENDPOINT}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        title: args.title,
        description: args.description,
        severity: args.severity,
        reporter,
        reporter_lead_id: args.reporterLeadId ?? null,
        reporter_name: args.reporterName ?? null,
        system_info: sysInfo,
        command: args.command ?? null,
        error: args.error ?? null,
      }),
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

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Failed to submit bug report (HTTP ${res.status}): ${text}`)
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
      console.log(JSON.stringify({ items, page: currentPage, total: totalItems, last_page: lastPage }, null, 2))
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
        const fixTag = hasResolution ? `  ${success(`✓ FIXED${fixCommit ? ` ${fixCommit}` : ""}`)}` : ""
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
    if (hasResolution) meta.push(success(`✓ FIXED${fixCommit ? ` ${fixCommit}` : ""}`))
    if (meta.length) console.log(`  ${meta.join("  ")}`)
    printDivider()
    console.log(contentStr ? String(contentStr) : dim("  (no description)"))
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
        const git = detectGitCommit()
        fixCommit = git.hash
        fixCommitUrl = git.url
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

// ============================================================================
// Root command
// ============================================================================

export const PlatformBugCommand = cmd({
  command: "bug",
  aliases: ["bugs", "report"],
  describe: "report bugs and view your submissions",
  builder: (yargs) => yargs.command(ReportCommand).command(ListCommand).command(ShowCommand).command(CloseCommand).demandCommand(),
  async handler() {},
})
