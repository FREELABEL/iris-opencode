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

  lines.push(
    `  ${S.TEXT_DIM}Run ${S.TEXT_HIGHLIGHT}iris <command> --help${S.TEXT_DIM} for detailed usage of any command${S.TEXT_NORMAL}`,
  )
  lines.push("")

  return lines.join(EOL)
}
