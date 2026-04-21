import { UI } from "./ui"
import {
  CATEGORIES,
  COMMAND_CATEGORY_MAP,
  getRegistry,
  type RegisteredCommand,
} from "./cmd/command-groups"
import { EOL } from "os"

export function renderGroupedHelp(): string {
  const commands = getRegistry()
  const S = UI.Style

  // Group commands by category
  const grouped: Record<string, RegisteredCommand[]> = {}

  for (const cmd of commands) {
    const catKey = COMMAND_CATEGORY_MAP[cmd.name]
    if (!catKey) continue
    if (!grouped[catKey]) grouped[catKey] = []
    grouped[catKey].push(cmd)
  }

  const lines: string[] = []
  lines.push("")
  lines.push(UI.logo())
  lines.push("")
  lines.push(
    `${S.TEXT_NORMAL_BOLD}Usage:${S.TEXT_NORMAL}  iris <command> [options]`,
  )
  lines.push("")

  // Sort categories by order
  const sortedCats = Object.entries(CATEGORIES).sort(
    ([, a], [, b]) => a.order - b.order,
  )

  for (const [catKey, cat] of sortedCats) {
    const cmds = grouped[catKey]
    if (!cmds || cmds.length === 0) continue

    lines.push(`  ${S.TEXT_HIGHLIGHT_BOLD}${cat.name}${S.TEXT_NORMAL}`)

    for (const cmd of cmds.sort((a, b) => a.name.localeCompare(b.name))) {
      const nameCol = cmd.name.padEnd(24)
      const aliasStr =
        cmd.aliases.length > 0
          ? ` ${S.TEXT_DIM}(${cmd.aliases.join(", ")})${S.TEXT_NORMAL}`
          : ""
      lines.push(
        `    ${S.TEXT_NORMAL_BOLD}${nameCol}${S.TEXT_NORMAL}${cmd.describe}${aliasStr}`,
      )
    }
    lines.push("")
  }

  // Footer
  lines.push(
    `  ${S.TEXT_DIM}Run ${S.TEXT_HIGHLIGHT}iris guide <topic>${S.TEXT_DIM} for detailed help on a category${S.TEXT_NORMAL}`,
  )
  lines.push(
    `  ${S.TEXT_DIM}Run ${S.TEXT_HIGHLIGHT}iris <command> --help${S.TEXT_DIM} for help on a specific command${S.TEXT_NORMAL}`,
  )
  lines.push("")
  lines.push(
    `  ${S.TEXT_DIM}Topics: ${Object.keys(CATEGORIES).join(", ")}${S.TEXT_NORMAL}`,
  )
  lines.push("")

  return lines.join(EOL)
}

// Workflow recipes shown at the bottom of each topic guide
const TOPIC_RECIPES: Record<string, string[]> = {
  crm: [
    "Common Workflows:",
    "",
    "  # Full deal flow — create packages, send proposal, track payment",
    "  iris leads create-package 40 -n \"Starter\" -a 250 -b monthly -f \"Feature A, Feature B\"",
    "  iris leads create-package 40 -n \"Pro\" -a 450 -b monthly -f \"Everything in Starter, Priority support\"",
    "  iris leads payment-gate 15336 -a 250 -s \"Project scope\" --packages 5,6 --term 24 -b 40",
    "  iris leads deal-status 15336",
    "",
    "  # Quick single-price invoice",
    "  iris leads payment-gate 15336 -a 1500 -s \"One-time project\" -b 40",
    "",
    "  # Check a lead's full context (CRM + email + iMessage + meetings)",
    "  iris leads pulse 15336",
    "",
    "  # Record an offline payment",
    "  iris invoices mark-paid 15336 --amount 500 --method cash",
  ],
  pages: [
    "Common Workflows:",
    "",
    "  # Create and publish a landing page",
    "  iris pages create --title \"My Page\" --slug my-page",
    "  iris pages push my-page                    # upload local JSON",
    "  iris pages publish my-page                 # make it live",
    "",
    "  # Connect a client domain",
    "  iris domains connect example.com --page my-page --yes",
    "",
    "  # Publish content across social platforms",
    "  iris copycat publish --brand beatbox --platform instagram",
  ],
  agents: [
    "Common Workflows:",
    "",
    "  # Chat with an agent",
    "  iris chat 11 \"What's the status of Project X?\"",
    "",
    "  # View and manage scheduled jobs",
    "  iris schedules list",
    "  iris schedules run 761                     # trigger immediately",
    "",
    "  # Monitor agent health",
    "  iris monitor status",
  ],
  atlas: [
    "Common Workflows:",
    "",
    "  # Ingest a meeting and extract lead intel",
    "  iris atlas:meetings                        # scan Gmail for meetings",
    "  iris leads:meeting 15336 --file notes.md   # ingest transcript",
    "",
    "  # View all comms for a lead",
    "  iris atlas:comms 15336",
  ],
  communication: [
    "Common Workflows:",
    "",
    "  # Read recent emails and iMessages",
    "  iris mail read --unread --limit 10",
    "  iris imessage chats",
    "  iris imessage read <chat-id>",
    "",
    "  # Transcribe a video",
    "  iris transcribe https://youtube.com/watch?v=...",
    "",
    "  # Check calendar",
    "  iris calendar events --upcoming",
  ],
}

export function renderTopicHelp(topic: string): string {
  const S = UI.Style
  const commands = getRegistry()

  // Fuzzy match topic to category key
  const normalized = topic.toLowerCase().replace(/[^a-z0-9]/g, "")
  let catKey: string | undefined

  for (const [key, cat] of Object.entries(CATEGORIES)) {
    const catNorm = cat.name.toLowerCase().replace(/[^a-z0-9]/g, "")
    if (
      key === normalized ||
      catNorm.includes(normalized) ||
      normalized.includes(key)
    ) {
      catKey = key
      break
    }
  }

  if (!catKey) {
    return `${EOL}  ${S.TEXT_DANGER}Unknown topic: "${topic}"${S.TEXT_NORMAL}${EOL}${EOL}  Available topics: ${Object.keys(CATEGORIES).join(", ")}${EOL}`
  }

  const cat = CATEGORIES[catKey]!
  const catCommands = commands.filter(
    (c) => COMMAND_CATEGORY_MAP[c.name] === catKey,
  )

  const lines: string[] = []
  lines.push("")
  lines.push(
    `  ${S.TEXT_HIGHLIGHT_BOLD}${cat.name}${S.TEXT_NORMAL}  ${S.TEXT_DIM}${cat.description}${S.TEXT_NORMAL}`,
  )
  lines.push("")

  for (const cmd of catCommands.sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    lines.push(`  ${S.TEXT_NORMAL_BOLD}${cmd.name}${S.TEXT_NORMAL}`)
    lines.push(`    ${cmd.describe}`)
    if (cmd.aliases.length > 0) {
      lines.push(
        `    ${S.TEXT_DIM}aliases: ${cmd.aliases.join(", ")}${S.TEXT_NORMAL}`,
      )
    }
    lines.push("")
  }

  // Show workflow recipes if available for this topic
  const recipes = TOPIC_RECIPES[catKey]
  if (recipes) {
    lines.push(`  ${S.TEXT_HIGHLIGHT_BOLD}${recipes[0]}${S.TEXT_NORMAL}`)
    for (const line of recipes.slice(1)) {
      if (line.startsWith("  #")) {
        lines.push(`  ${S.TEXT_DIM}${line}${S.TEXT_NORMAL}`)
      } else if (line.startsWith("  iris")) {
        lines.push(`  ${S.TEXT_HIGHLIGHT}${line}${S.TEXT_NORMAL}`)
      } else {
        lines.push(line)
      }
    }
    lines.push("")
  }

  lines.push(
    `  ${S.TEXT_DIM}Run ${S.TEXT_HIGHLIGHT}iris <command> --help${S.TEXT_DIM} for detailed usage of any command${S.TEXT_NORMAL}`,
  )
  lines.push("")

  return lines.join(EOL)
}
