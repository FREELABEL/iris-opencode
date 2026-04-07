import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { irisFetch, requireAuth, requireUserId, dim, bold, success, FL_API } from "./iris-api"
import { homedir, platform, release, arch, hostname, userInfo } from "os"
import { join } from "path"
import { existsSync, readFileSync } from "fs"
import { execSync } from "child_process"

// Bug reports bloq + Todo list (created on iris-api)
const BUG_BLOQ_ID = 297
const BUG_LIST_ID = 1029

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
  const auth = await requireAuth()
  const userId = await requireUserId()

  const sysInfo = collectSystemInfo()

  // Build the bug report content
  const lines: string[] = [
    `## ${args.title}`,
    "",
    `**Severity:** ${args.severity}`,
    `**Reported by:** ${sysInfo.user}@${sysInfo.hostname}`,
    `**Date:** ${new Date().toISOString()}`,
    "",
    `### Description`,
    args.description,
    "",
  ]

  if (args.command) {
    lines.push(`### Command That Failed`, "```", args.command, "```", "")
  }

  if (args.error) {
    lines.push(`### Error Output`, "```", args.error, "```", "")
  }

  lines.push(`### System Info`)
  for (const [k, v] of Object.entries(sysInfo)) {
    lines.push(`- **${k}:** ${v}`)
  }

  const content = lines.join("\n")

  // Submit as a bloq item (board card) on the IRIS CLI Bug Reports bloq
  const res = await irisFetch(`/api/v1/user/bloqs/lists/${BUG_LIST_ID}/items`, {
    method: "POST",
    body: JSON.stringify({
      title: `[${args.severity.toUpperCase()}] ${args.title}`,
      content,
      type: "task",
      status: "todo",
    }),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Failed to submit bug report (HTTP ${res.status}): ${text}`)
  }

  const data = (await res.json()) as { data?: { id?: number }; id?: number }
  const itemId = data?.data?.id ?? data?.id

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
  describe: "list your submitted bug reports",
  builder: (yargs) => yargs.option("json", { type: "boolean", default: false }),
  async handler(args) {
    await requireAuth()

    const res = await irisFetch(`/api/v1/user/bloqs/${BUG_BLOQ_ID}`, {})
    if (!res.ok) {
      console.error(`Failed to fetch bug reports (HTTP ${res.status})`)
      process.exit(1)
    }

    const data = (await res.json()) as { data?: any; lists?: any[] }
    const bloq = data?.data ?? data
    const lists = bloq?.lists ?? []

    if (args.json) {
      console.log(JSON.stringify(lists, null, 2))
      return
    }

    let total = 0
    for (const list of lists) {
      const items = list.items ?? []
      if (items.length === 0) continue
      console.log("")
      console.log(bold(`${list.name} (${items.length})`))
      for (const item of items) {
        const id = item.id ?? "?"
        const title = item.title ?? "(untitled)"
        console.log(`  #${id}  ${title}`)
        total++
      }
    }

    if (total === 0) {
      console.log(dim("No bug reports yet."))
    } else {
      console.log("")
      console.log(dim(`${total} total reports`))
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
  builder: (yargs) => yargs.command(ReportCommand).command(ListCommand).demandCommand(),
  async handler() {},
})
