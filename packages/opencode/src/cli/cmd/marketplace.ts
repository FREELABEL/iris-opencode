import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import fuzzysort from "fuzzysort"
import { irisFetch, requireAuth } from "./iris-api"

// ============================================================================
// Types
// ============================================================================

interface SkillItem {
  name: string
  display_name: string
  description: string
  type: string
  categories: string[]
  github_stars: number
  license: string
  slug: string
}

// ============================================================================
// Display helpers
// ============================================================================

const TYPE_LABEL: Record<string, string> = {
  mcp_server: "MCP Server",
  agent_capability: "Agent",
  workflow: "Workflow",
  integration: "API",
  cli_tool: "CLI Tool",
  api_endpoint: "API",
}

const TYPE_COLOR: Record<string, string> = {
  mcp_server: UI.Style.TEXT_HIGHLIGHT, // cyan
  agent_capability: "\x1b[95m", // magenta/purple
  workflow: UI.Style.TEXT_SUCCESS, // green
  integration: UI.Style.TEXT_INFO, // blue
  cli_tool: UI.Style.TEXT_WARNING, // yellow
  api_endpoint: UI.Style.TEXT_INFO,
}

function typeLabel(type: string): string {
  return TYPE_LABEL[type] ?? type
}

function typeColored(type: string): string {
  const color = TYPE_COLOR[type] ?? UI.Style.TEXT_DIM
  return `${color}[${typeLabel(type)}]${UI.Style.TEXT_NORMAL}`
}

function stars(count: number): string {
  if (!count) return ""
  const k = count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count)
  return `${UI.Style.TEXT_WARNING}★${UI.Style.TEXT_NORMAL} ${k}`
}

function printSkillRow(skill: SkillItem): void {
  const cat = (skill.categories ?? []).slice(0, 2).join(", ")
  const starsStr = stars(skill.github_stars)
  const catStr = cat ? `${UI.Style.TEXT_DIM}${cat}${UI.Style.TEXT_NORMAL}` : ""
  const line1 = `  ${typeColored(skill.type)}  ${UI.Style.TEXT_NORMAL_BOLD}${skill.slug}${UI.Style.TEXT_NORMAL}${catStr ? "  " + catStr : ""}${starsStr ? "  " + starsStr : ""}`
  const line2 = `    ${UI.Style.TEXT_DIM}${skill.description ?? ""}${UI.Style.TEXT_NORMAL}`
  console.log(line1)
  console.log(line2)
}

function printDivider(): void {
  console.log(`  ${UI.Style.TEXT_DIM}${"─".repeat(60)}${UI.Style.TEXT_NORMAL}`)
}

// ============================================================================
// Subcommands
// ============================================================================

const MarketplaceSearchCommand = cmd({
  command: "search <query>",
  describe: "search skills, APIs, workflows, and agents",
  builder: (yargs) =>
    yargs
      .positional("query", {
        describe: "search query",
        type: "string",
        demandOption: true,
      })
      .option("type", {
        describe: "filter by type (mcp_server, workflow, agent_capability, integration, cli_tool)",
        type: "string",
      })
      .option("limit", {
        describe: "number of results",
        type: "number",
        default: 10,
      }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  IRIS Marketplace")

    const spinner = prompts.spinner()
    spinner.start("Searching…")

    try {
      const params = new URLSearchParams({
        q: args.query,
        per_page: String(args.limit),
      })
      if (args.type) params.set("type", args.type)

      const res = await irisFetch(`/api/v1/marketplace/skills?${params}`)
      const json = await res.json() as { success: boolean; data: SkillItem[]; meta?: { total: number } }

      if (!json.success || !json.data) {
        spinner.stop("Search failed", 1)
        prompts.log.error("Could not fetch results")
        prompts.outro("Done")
        return
      }

      const skills = json.data as SkillItem[]
      spinner.stop(`Found ${json.meta?.total ?? skills.length} result(s)`)

      if (skills.length === 0) {
        prompts.log.warn(`No skills found for "${args.query}"`)
        prompts.outro(`Try: iris marketplace featured`)
        return
      }

      printDivider()
      for (const skill of skills) {
        printSkillRow(skill)
        console.log()
      }
      printDivider()

      prompts.outro(
        `${skills.length} result(s)  ·  ${UI.Style.TEXT_DIM}iris marketplace install <slug>${UI.Style.TEXT_NORMAL}`,
      )
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const MarketplaceFeaturedCommand = cmd({
  command: "featured",
  describe: "show featured and trending skills",
  async handler() {
    UI.empty()
    prompts.intro("◈  IRIS Marketplace — Featured")

    const spinner = prompts.spinner()
    spinner.start("Loading…")

    try {
      const res = await irisFetch("/api/v1/marketplace/skills/featured")
      const json = await res.json() as { success: boolean; data: SkillItem[] }

      if (!json.success || !json.data) {
        spinner.stop("Failed", 1)
        prompts.log.error("Could not load featured skills")
        prompts.outro("Done")
        return
      }

      const skills = (json.data as SkillItem[]).slice(0, 6)
      spinner.stop(`${skills.length} featured skill(s)`)

      printDivider()
      for (const skill of skills) {
        printSkillRow(skill)
        console.log()
      }
      printDivider()

      prompts.outro(
        `${UI.Style.TEXT_DIM}iris marketplace install <slug>${UI.Style.TEXT_NORMAL}  ·  ${UI.Style.TEXT_DIM}iris marketplace search <query>${UI.Style.TEXT_NORMAL}`,
      )
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const MarketplaceInstallCommand = cmd({
  command: "install <slug>",
  describe: "install a skill into your agent",
  builder: (yargs) =>
    yargs.positional("slug", {
      describe: "skill slug",
      type: "string",
      demandOption: true,
    }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Installing ${args.slug}`)

    const token = await requireAuth()
    if (!token) {
      prompts.outro("Done")
      return
    }

    const spinner = prompts.spinner()
    spinner.start(`Fetching ${args.slug}…`)

    // First, load the skill details
    try {
      const detailRes = await irisFetch(`/api/v1/marketplace/skills/${args.slug}`)
      if (detailRes.status === 404) {
        spinner.stop("Not found", 1)
        prompts.log.error(`Skill "${args.slug}" not found in marketplace.`)
        prompts.log.info(`Try: ${UI.Style.TEXT_DIM}iris marketplace search ${args.slug}${UI.Style.TEXT_NORMAL}`)
        prompts.outro("Done")
        return
      }
      const detail = await detailRes.json() as { success: boolean; data: SkillItem & { id?: number } }
      if (!detail.success) {
        spinner.stop("Failed", 1)
        prompts.log.error("Could not load skill details")
        prompts.outro("Done")
        return
      }

      const skill = detail.data
      spinner.stop(`Found: ${skill.display_name ?? skill.name}`)
      prompts.log.info(`  ${typeColored(skill.type)}  ${UI.Style.TEXT_DIM}${skill.description}${UI.Style.TEXT_NORMAL}`)
    } catch (err) {
      spinner.stop("Error fetching skill", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
      return
    }

    // Install
    const installSpinner = prompts.spinner()
    installSpinner.start("Wiring into agent harness…")

    try {
      const installRes = await irisFetch(`/api/v1/marketplace/skills/${args.slug}/install`, { method: "POST" })

      if (installRes.status === 401 || installRes.status === 403) {
        installSpinner.stop("Authentication required", 1)
        prompts.log.warn("Your token may be expired or invalid.")
        prompts.log.info(`Refresh:  ${UI.Style.TEXT_HIGHLIGHT}export IRIS_API_TOKEN=<your-token>${UI.Style.TEXT_NORMAL}`)
        prompts.outro("Done")
        return
      }

      if (!installRes.ok) {
        const err = await installRes.json() as { error?: string }
        installSpinner.stop("Install failed", 1)
        prompts.log.error(err.error ?? `HTTP ${installRes.status}`)
        prompts.outro("Done")
        return
      }

      installSpinner.stop(`${UI.Style.TEXT_SUCCESS}✓${UI.Style.TEXT_NORMAL} Installed!`)

      console.log()
      prompts.log.info(
        `${UI.Style.TEXT_SUCCESS_BOLD}${args.slug}${UI.Style.TEXT_NORMAL} is now available to your agents.`,
      )
      prompts.log.info(
        `${UI.Style.TEXT_DIM}Try asking: "use ${args.slug} to help me"${UI.Style.TEXT_NORMAL}`,
      )

      prompts.outro(
        `${UI.Style.TEXT_DIM}iris run "describe what ${args.slug} can do"${UI.Style.TEXT_NORMAL}`,
      )
    } catch (err) {
      installSpinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const MarketplaceBrowseCommand = cmd({
  command: "browse",
  describe: "interactively browse and install skills",
  async handler() {
    UI.empty()
    prompts.intro("◈  IRIS Marketplace — Browse")

    const spinner = prompts.spinner()
    spinner.start("Loading skills…")

    let allSkills: SkillItem[] = []

    try {
      const res = await irisFetch("/api/v1/marketplace/skills?per_page=100&sort=popular")
      const json = await res.json() as { success: boolean; data: SkillItem[] }

      if (!json.success || !json.data) {
        spinner.stop("Failed", 1)
        prompts.log.error("Could not load marketplace")
        prompts.outro("Done")
        return
      }

      allSkills = json.data as SkillItem[]
      spinner.stop(`${allSkills.length} skills loaded`)
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
      return
    }

    // Interactive search → select → install loop
    while (true) {
      const query = await prompts.text({
        message: "Filter (leave blank to show all, or type to search)",
        placeholder: "e.g. github, slack, mcp…",
      })
      if (prompts.isCancel(query)) break

      const filtered =
        query && (query as string).trim()
          ? fuzzysort
              .go(query as string, allSkills, {
                keys: ["slug", "display_name", "description", "type"],
                threshold: -10000,
              })
              .map((r) => r.obj)
          : allSkills

      if (filtered.length === 0) {
        prompts.log.warn(`No results for "${query}"`)
        continue
      }

      const options = filtered.slice(0, 20).map((skill) => ({
        label: `${skill.slug}`,
        value: skill.slug,
        hint: `${typeLabel(skill.type)}  ${skill.description ? skill.description.slice(0, 60) : ""}`,
      }))

      const selected = await prompts.select({
        message: "Select a skill to install (↑↓ to navigate, Enter to install)",
        options: [
          ...options,
          { label: "← Back / search again", value: "__back__", hint: "" },
        ],
      })
      if (prompts.isCancel(selected) || selected === "__back__") continue

      // Trigger install inline
      const browseToken = await requireAuth()
      if (!browseToken) {
        continue
      }

      const installSpinner = prompts.spinner()
      installSpinner.start(`Installing ${selected}…`)

      try {
        const res = await irisFetch(`/api/v1/marketplace/skills/${selected}/install`, { method: "POST" })
        if (!res.ok) {
          const err = await res.json() as { error?: string }
          installSpinner.stop("Failed", 1)
          prompts.log.error(err.error ?? `HTTP ${res.status}`)
          continue
        }
        installSpinner.stop(`${UI.Style.TEXT_SUCCESS}✓${UI.Style.TEXT_NORMAL} ${selected} installed!`)
      } catch (err) {
        installSpinner.stop("Error", 1)
        prompts.log.error(err instanceof Error ? err.message : String(err))
      }

      const again = await prompts.confirm({ message: "Install another?", initialValue: false })
      if (prompts.isCancel(again) || !again) break
    }

    prompts.outro("Done")
  },
})

// ============================================================================
// Root command
// ============================================================================

export const MarketplaceCommand = cmd({
  command: "marketplace",
  aliases: ["market", "mp"],
  describe: "browse, search, and install skills from the IRIS Marketplace",
  builder: (yargs) =>
    yargs
      .command(MarketplaceSearchCommand)
      .command(MarketplaceFeaturedCommand)
      .command(MarketplaceInstallCommand)
      .command(MarketplaceBrowseCommand)
      .demandCommand(),
  async handler() {},
})
