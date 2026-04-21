import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, printDivider, printKV, dim, bold, success, IRIS_API, resolveUserId } from "./iris-api"
import { homedir, platform, release, arch, hostname, userInfo } from "os"
import { join } from "path"
import { existsSync, readFileSync } from "fs"
import { execSync } from "child_process"

// Bug reports go to bloq #297 (under user 193) via PUBLIC endpoint — no auth required
const BUG_REPORT_ENDPOINT = "/api/v1/public/bug-report"
const BUG_BLOQ_ID = 297

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

  try {
    const v = execSync("iris --version", { encoding: "utf-8", timeout: 3000 }).trim()
    info.iris_version = v
  } catch {}

  // Get last 20 lines of bash history if available
  try {
    const histPath = join(homedir(), ".bash_history")
    if (existsSync(histPath)) {
      const lines = readFileSync(histPath, "utf-8")
        .split("\n")
        .filter((l) => l.includes("iris"))
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
  json?: boolean
}): Promise<void> {
  const sysInfo = collectSystemInfo()
  const reporter = `${sysInfo.user}@${sysInfo.hostname}`

  // POST to public bug report endpoint — no auth required, always writes to user 193's bloq
  const res = await fetch(`${IRIS_API}${BUG_REPORT_ENDPOINT}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      title: args.title,
      description: args.description,
      severity: args.severity,
      reporter,
      system_info: sysInfo,
      command: args.command ?? null,
      error: args.error ?? null,
    }),
  })

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
      console.log("")
      console.log(bold("🐛 Report a Bug"))
      console.log(dim("Help us improve IRIS by reporting issues you encounter."))
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
        json: args.json,
      })
    } catch (e: any) {
      console.error(`Failed to submit bug: ${e.message}`)
      process.exit(1)
    }
  },
})

const ListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list all bug reports",
  builder: (yargs) =>
    yargs
      .option("limit", { describe: "max results", type: "number", default: 20 })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    const token = await requireAuth()
    if (!token) return

    const userId = await resolveUserId()
    if (!userId) {
      console.error("Could not resolve user ID. Set IRIS_USER_ID or run iris-login.")
      return
    }

    const params = new URLSearchParams({ per_page: String(args.limit) })
    const res = await irisFetch(`/api/v1/user/${userId}/bloqs/${BUG_BLOQ_ID}/items?${params}`)
    const ok = await handleApiError(res, "List bug reports")
    if (!ok) return

    const data = (await res.json()) as any
    const rawItems = data?.data?.items ?? data?.data?.data ?? data?.data ?? []
    const items: any[] = Array.isArray(rawItems) ? rawItems : Object.values(rawItems)

    if (args.json) {
      console.log(JSON.stringify(items, null, 2))
      return
    }

    console.log("")
    console.log(bold("📋 Bug Reports"))
    console.log(`  ${dim(`Bloq #${BUG_BLOQ_ID} — ${items.length} item(s)`)}`)
    printDivider()

    if (items.length === 0) {
      console.log(`  ${dim("No bug reports found")}`)
    } else {
      for (const item of items) {
        const contentStr = item.content ?? item.description ?? ""
        const severity = contentStr.match(/Severity:\*?\*?\s*(\w+)/i)?.[1] ?? ""
        const sevTag = severity ? `  [${severity.toUpperCase()}]` : ""
        const status = item.status ? `  ${dim(item.status)}` : ""
        console.log(`  ${bold(String(item.title))}  ${dim(`#${item.id}`)}${sevTag}${status}`)
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
    console.log(dim("  iris bug report — submit a new bug"))
    console.log(dim("  iris boards get <id> — view full details"))
    console.log("")
  },
})

const CloseCommand = cmd({
  command: "close <id>",
  aliases: ["done", "resolve", "complete"],
  describe: "mark a bug report as completed/resolved",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "bug item ID", type: "number", demandOption: true })
      .option("note", { alias: "n", describe: "resolution note", type: "string" }),
  async handler(args) {
    const token = await requireAuth()
    if (!token) return

    const userId = await resolveUserId()
    if (!userId) {
      console.error("Could not resolve user ID.")
      return
    }

    const spinner = prompts.spinner()
    spinner.start(`Closing bug #${args.id}…`)

    try {
      // Update item status to "done" via the bloq item status endpoint
      const res = await irisFetch(`/api/v1/user/${userId}/bloqs/item/${args.id}/status`, {
        method: "PATCH",
        body: JSON.stringify({ status: "done" }),
      })

      if (!res.ok) {
        spinner.stop("Failed", 1)
        const text = await res.text().catch(() => "")
        prompts.log.error(`HTTP ${res.status}: ${text}`)
        return
      }

      spinner.stop(`${success("✓")} Bug #${args.id} marked as done`)
      console.log(dim("  iris bug list  — view all bugs"))
    } catch (e: any) {
      spinner.stop("Error", 1)
      prompts.log.error(e.message)
    }
  },
})

// ============================================================================
// Root command
// ============================================================================

export const PlatformBugCommand = cmd({
  command: "bug",
  aliases: ["bugs", "report"],
  describe: "report bugs and view your submissions",
  builder: (yargs) => yargs.command(ReportCommand).command(ListCommand).command(CloseCommand).demandCommand(),
  async handler() {},
})
