import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, printDivider, printKV, dim, bold, success } from "./iris-api"

// ============================================================================
// Helpers
// ============================================================================

const BASE = "/api/v1/marketplace/skills"

const SKILL_TYPES = ["cli_tool", "api_endpoint", "workflow", "agent_capability", "integration", "mcp_server"]

async function getSkill(slug: string): Promise<any | null> {
  const res = await irisFetch(`${BASE}/${encodeURIComponent(slug)}`)
  if (!res.ok) return null
  const data = (await res.json()) as { data?: any }
  return data?.data ?? data
}

// ============================================================================
// Subcommands
// ============================================================================

const SearchCmd = cmd({
  command: "search [query]",
  describe: "search marketplace skills",
  builder: (y) =>
    y
      .positional("query", { describe: "search query", type: "string" })
      .option("type", { alias: "t", describe: `skill type (${SKILL_TYPES.join("|")})`, type: "string" })
      .option("category", { alias: "c", describe: "category filter", type: "string" })
      .option("limit", { describe: "max results", type: "number", default: 20 })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Marketplace Search")
    if (!(await requireAuth())) { prompts.outro("Done"); return }
    const sp = prompts.spinner()
    sp.start("Searching…")
    try {
      const params = new URLSearchParams({ per_page: String(args.limit) })
      if (args.query) params.set("search", args.query)
      if (args.type) params.set("type", args.type)
      if (args.category) params.set("category", args.category)
      const res = await irisFetch(`${BASE}?${params}`)
      if (!(await handleApiError(res, "Search"))) { sp.stop("Failed", 1); prompts.outro("Done"); return }
      const data = (await res.json()) as { data?: any[] }
      const items = data?.data ?? []
      sp.stop(`${items.length} result(s)`)
      if (args.json) {
        console.log(JSON.stringify(items, null, 2))
        prompts.outro("Done")
        return
      }
      if (items.length === 0) { prompts.log.warn("No results"); prompts.outro("Done"); return }
      printDivider()
      for (const s of items) {
        console.log(`  ${bold(s.name ?? s.slug)}  ${dim(`[${s.skill_type ?? "?"}]`)}`)
        console.log(`    ${dim(s.slug)}  ${dim(`v${s.version ?? "?"}`)}`)
        if (s.description) console.log(`    ${dim(String(s.description).slice(0, 100))}`)
        console.log()
      }
      printDivider()
      prompts.outro(dim("iris marketplace info <slug>"))
    } catch (err) {
      sp.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const InfoCmd = cmd({
  command: "info <slug>",
  describe: "show details for a marketplace skill",
  builder: (y) =>
    y
      .positional("slug", { describe: "skill slug", type: "string", demandOption: true })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  ${args.slug}`)
    if (!(await requireAuth())) { prompts.outro("Done"); return }
    const sp = prompts.spinner()
    sp.start("Loading…")
    const skill = await getSkill(args.slug)
    if (!skill) { sp.stop("Not found", 1); prompts.outro("Done"); return }
    sp.stop(String(skill.name ?? skill.slug))
    if (args.json) {
      console.log(JSON.stringify(skill, null, 2))
      prompts.outro("Done")
      return
    }
    printDivider()
    printKV("Name", skill.name)
    printKV("Slug", skill.slug)
    printKV("Type", skill.skill_type)
    printKV("Version", skill.version)
    printKV("Author", skill.author_name ?? skill.author)
    printKV("Description", skill.description)
    printKV("Installs", skill.install_count)
    printKV("Rating", skill.rating)
    printDivider()
    prompts.outro(dim(`iris marketplace install ${args.slug}`))
  },
})

const InstallCmd = cmd({
  command: "install <slug>",
  describe: "install a marketplace skill",
  builder: (y) => y.positional("slug", { describe: "skill slug", type: "string", demandOption: true }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Install ${args.slug}`)
    if (!(await requireAuth())) { prompts.outro("Done"); return }
    const sp = prompts.spinner()
    sp.start("Installing…")
    try {
      const res = await irisFetch(`${BASE}/${encodeURIComponent(args.slug)}/install`, { method: "POST" })
      if (!(await handleApiError(res, "Install"))) { sp.stop("Failed", 1); prompts.outro("Done"); return }
      sp.stop(success("Installed"))
      prompts.outro("Done")
    } catch (err) {
      sp.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const UninstallCmd = cmd({
  command: "uninstall <slug>",
  describe: "uninstall a marketplace skill",
  builder: (y) => y.positional("slug", { describe: "skill slug", type: "string", demandOption: true }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Uninstall ${args.slug}`)
    if (!(await requireAuth())) { prompts.outro("Done"); return }
    const sp = prompts.spinner()
    sp.start("Uninstalling…")
    try {
      const res = await irisFetch(`${BASE}/${encodeURIComponent(args.slug)}/uninstall`, { method: "POST" })
      if (!(await handleApiError(res, "Uninstall"))) { sp.stop("Failed", 1); prompts.outro("Done"); return }
      sp.stop(success("Uninstalled"))
      prompts.outro("Done")
    } catch (err) {
      sp.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const ListInstalledCmd = cmd({
  command: "installed",
  describe: "list installed skills",
  async handler() {
    UI.empty()
    prompts.intro("◈  Installed Skills")
    if (!(await requireAuth())) { prompts.outro("Done"); return }
    const sp = prompts.spinner()
    sp.start("Loading…")
    try {
      const res = await irisFetch(`${BASE}/my/installed`)
      if (!(await handleApiError(res, "List installed"))) { sp.stop("Failed", 1); prompts.outro("Done"); return }
      const data = (await res.json()) as { data?: any[] }
      const items = data?.data ?? []
      sp.stop(`${items.length} installed`)
      if (items.length === 0) { prompts.outro("None"); return }
      printDivider()
      for (const s of items) {
        console.log(`  ${bold(s.name ?? s.slug)}  ${dim(`[${s.skill_type ?? "?"}]`)}`)
      }
      printDivider()
      prompts.outro("Done")
    } catch (err) {
      sp.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const PublishedCmd = cmd({
  command: "published",
  describe: "list skills you have published",
  async handler() {
    UI.empty()
    prompts.intro("◈  Published Skills")
    if (!(await requireAuth())) { prompts.outro("Done"); return }
    const sp = prompts.spinner()
    sp.start("Loading…")
    try {
      const res = await irisFetch(`${BASE}/my/published`)
      if (!(await handleApiError(res, "List published"))) { sp.stop("Failed", 1); prompts.outro("Done"); return }
      const data = (await res.json()) as { data?: any[] }
      const items = data?.data ?? []
      sp.stop(`${items.length} published`)
      if (items.length === 0) { prompts.outro("None"); return }
      printDivider()
      for (const s of items) {
        console.log(`  ${bold(s.name ?? s.slug)}  ${dim(`v${s.version ?? "?"}`)}`)
      }
      printDivider()
      prompts.outro("Done")
    } catch (err) {
      sp.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

// ============================================================================
// Root
// ============================================================================

export const PlatformMarketplaceCommand = cmd({
  command: "platform-marketplace",
  aliases: ["iris-marketplace"],
  describe: "browse, install, and manage IRIS marketplace skills",
  builder: (y) =>
    y
      .command(SearchCmd)
      .command(InfoCmd)
      .command(InstallCmd)
      .command(UninstallCmd)
      .command(ListInstalledCmd)
      .command(PublishedCmd)
      .demandCommand(),
  async handler() {},
})
