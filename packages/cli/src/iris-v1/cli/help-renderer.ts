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

// Surface `<prefix>:*` namespaced commands under `iris <prefix> [--help]`.
// yargs registers each `atlas:datasets`, `pages:batch`, etc. as a SEPARATE top-level
// command, so they never appear under their bare-word parent's help. For `atlas` the
// problem is worse: the bare word is an alias of `bloqs`, so the whole Atlas OS suite
// is invisible from `iris atlas --help` (#137271, #137272). This block lists them.
export function renderNamespacedHelp(prefix: string): string | null {
  const S = UI.Style
  const namespaced = getRegistry().filter((c) => c.name.startsWith(`${prefix}:`))
  if (namespaced.length === 0) return null

  // Prefer the friendly category title (e.g. "Atlas OS") when the prefix maps to one.
  const catKey = COMMAND_CATEGORY_MAP[namespaced[0]!.name]
  const heading = catKey && CATEGORIES[catKey] ? CATEGORIES[catKey]!.name : prefix

  const lines: string[] = []
  lines.push("")
  lines.push(
    `  ${S.TEXT_HIGHLIGHT_BOLD}${heading}${S.TEXT_NORMAL}  ${S.TEXT_DIM}namespaced commands (iris ${prefix}:<name>)${S.TEXT_NORMAL}`,
  )
  lines.push("")
  for (const cmd of namespaced.sort((a, b) => a.name.localeCompare(b.name))) {
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
  lines.push(
    `  ${S.TEXT_DIM}Run ${S.TEXT_HIGHLIGHT}iris ${prefix}:<name> --help${S.TEXT_DIM} for details on any of these${S.TEXT_NORMAL}`,
  )
  lines.push("")
  return lines.join(EOL)
}

// Workflow recipes shown at the bottom of each topic guide
const TOPIC_RECIPES: Record<string, string[]> = {
  crm: [
    "Common Workflows:",
    "",
    "  # Pulse — business health scorecard",
    "  iris leads pulse-all                         # scorecard for all Won leads",
    "  iris leads pulse-all --hydrate --dry-run     # preview AI follow-up emails",
    "  iris leads pulse-all --hydrate               # send follow-ups to stale leads",
    "  iris leads pulse 15336                       # single lead (CRM + email + iMessage)",
    "  iris leads pulse 15336 --hydrate             # generate + send AI follow-up",
    "  iris leads pulse 15336 --hydrate --dry-run   # preview without sending",
    "  iris leads pulse 15336 --hydrate --to me@x.com  # redirect to test email",
    "",
    "  # Payment gates — contracts + proposals + Stripe in one shot",
    "  iris leads payment-gate 15336 -a 125 -s \"Retainer\" -i month --fee 2.5",
    "  iris leads gate-all -a 125 -i month --dry-run  # batch-create for all Won leads",
    "  iris leads deal-status 15336                 # check contract/payment/reminders",
    "  iris leads update-gate 15336 -a 150          # change amount (keeps links alive)",
    "",
    "  # Subscriptions",
    "  iris leads subscription-update 15336 -a 128  # upgrade Stripe sub price",
    "",
    "  # Deal pipeline",
    "  iris deals list                              # all active deals + pipeline value",
    "  iris deals status 15336                      # contract, payment, reminders",
    "",
    "  # Record an offline payment",
    "  iris leads collect 15336 --amount 500 --method cash",
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
  entities: [
    "Common Workflows:",
    "",
    "  # Brand design tokens — full lifecycle",
    "  iris brands create --name \"Acme\" --slug acme",
    "  iris brands dt import acme --css ./tokens.css    # import from CSS",
    "  iris brands dt pull acme                         # download to ./brands/acme-tokens.json",
    "  iris brands dt diff acme                         # compare local vs remote",
    "  iris brands dt push acme                         # upload local changes",
    "  iris brands dt export acme --format md           # AGENTS.md for AI workspaces",
    "  iris brands dt export acme --format css           # CSS custom properties",
    "",
    "  # View design system in browser",
    "  # https://freelabel.net/design-system/acme",
    "",
    "  # Personas",
    "  iris brands personas list 1",
    "  iris brands personas add 1 --name \"Formal\" --tone \"professional\"",
  ],
  knowledge: [
    "Common Workflows:",
    "",
    "  # Bloqs — knowledge base CRUD",
    "  iris bloqs list                                # all bloqs",
    "  iris bloqs show 217                            # details + lists",
    "  iris bloqs search \"onboarding\"                 # full-text search",
    "",
    "  # Memory — agent working memory",
    "  iris memory store \"Client prefers email\"       # save a fact",
    "  iris memory search \"payment preferences\"       # find stored facts",
    "",
    "  # Boards — Kanban / task management",
    "  iris boards list",
    "  iris boards show 1",
  ],
  integrations: [
    "Common Workflows:",
    "",
    "  # Connect services",
    "  iris integrations list                         # all available",
    "  iris integrations status                       # connected + health",
    "  iris integrations connect gmail                # OAuth flow",
    "",
    "  # Execute integration functions",
    "  iris integrations exec gmail read_emails       # direct function call",
    "  iris integrations exec google-drive search_and_summarize",
    "",
    "  # n8n workflow automation",
    "  iris n8n list                                  # all workflows",
    "  iris n8n dispatch <id>                         # trigger a workflow",
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
  finance: [
    "Common Workflows:",
    "",
    "  # Payment collection + subscription management",
    "  iris leads payment-gate 15336 -a 125 -s \"Retainer\" -i month",
    "  iris leads collect 15336 --amount 500 --method cash",
    "  iris leads subscription-update 15336 -a 150",
    "",
    "  # Good Deals planning",
    "  iris good-deals list",
    "",
    "  # LinkedIn outreach",
    "  iris linkedin status",
    "  iris linkedin search \"AI founder Austin\" --dry-run",
    "  iris linkedin connect --board 302 --limit 10",
  ],
  compute: [
    "Common Workflows:",
    "",
    "  # Hive — distributed compute nodes",
    "  iris hive status                               # all connected nodes",
    "  iris hive tasks                                # running + queued tasks",
    "",
    "  # Deploy an app",
    "  iris app deploy ./my-app --name \"My App\"",
  ],
  system: [
    "Common Workflows:",
    "",
    "  # Bug reporting",
    "  iris bug list                                  # all open bugs",
    "  iris bug report --title \"Issue\" --severity high",
    "",
    "  # Health check + diagnostics",
    "  iris doctor status                             # system health",
    "",
    "  # Daily diary",
    "  iris diary today                               # today's log",
    "  iris diary add \"Shipped design tokens\"         # add entry",
    "",
    "  # SDK direct calls",
    "  iris sdk:call GET /api/v1/brands               # raw API call",
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
