import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { irisFetch, dim, bold, success, IRIS_API } from "./iris-api"
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
    let title = Array.isArray(args.title) ? args.title.join(" ").trim() : (args.title as string | undefined)
    let description = args.description
    let severity = args.severity as string

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
        severity,
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
  describe: "view bug reports (opens dashboard)",
  async handler() {
    console.log("")
    console.log(bold("📋 Bug Reports"))
    console.log("")
    console.log(`  All reports go to ${dim("IRIS CLI Bug Reports")} (bloq #${BUG_BLOQ_ID})`)
    console.log(`  View at: ${success(`https://app.heyiris.io/iris?board=${BUG_BLOQ_ID}`)}`)
    console.log("")
    console.log(dim("To submit a new bug:"))
    console.log(`  iris bug report`)
    console.log("")
  },
})

// ============================================================================
// Root command
// ============================================================================

export const PlatformBugCommand = cmd({
  command: "bug",
  aliases: ["bugs", "report"],
  describe: "report bugs and view your submissions",
  builder: (yargs) => yargs.command(ReportCommand).command(ListCommand).demandCommand(),
  async handler() {},
})
