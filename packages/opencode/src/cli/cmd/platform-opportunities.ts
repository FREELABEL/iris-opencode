import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, printDivider, printKV, dim, bold, success, highlight } from "./iris-api"
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "fs"
import { join, basename } from "path"

// ============================================================================
// Sync helpers
// ============================================================================

const SYNC_DIR = ".iris/opportunities"

function resolveSyncDir(): string {
  let dir = process.cwd()
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, "fl-docker-dev"))) return join(dir, SYNC_DIR)
    const parent = join(dir, "..")
    if (parent === dir) break
    dir = parent
  }
  return join(process.cwd(), SYNC_DIR)
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")
}

function entityFilename(e: Record<string, unknown>): string {
  return `${e.id}-${slugify(String(e.title ?? "opportunity"))}.json`
}

function findLocalFile(dir: string, id: number): string | undefined {
  if (!existsSync(dir)) return undefined
  const prefix = `${id}-`
  const files = require("fs").readdirSync(dir).filter((f: string) => f.startsWith(prefix) && f.endsWith(".json"))
  return files.length > 0 ? join(dir, files[0]) : undefined
}

// ============================================================================
// Display helpers
// ============================================================================

function printOpportunity(o: Record<string, unknown>): void {
  const title = bold(String(o.title ?? `Opportunity #${o.id}`))
  const id = dim(`#${o.id}`)
  const status = o.status ? `  ${dim(String(o.status))}` : ""
  console.log(`  ${title}  ${id}${status}`)
  if (o.description) console.log(`    ${dim(String(o.description).slice(0, 100))}`)
}

// ============================================================================
// Subcommands
// ============================================================================

const ListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list marketplace opportunities",
  builder: (yargs) =>
    yargs.option("limit", { describe: "max results", type: "number", default: 20 }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Marketplace Opportunities")

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Loading…")

    try {
      const params = new URLSearchParams({ per_page: String(args.limit) })
      const res = await irisFetch(`/api/v1/marketplace/opportunities?${params}`)
      const ok = await handleApiError(res, "List opportunities")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const data = (await res.json()) as { data?: any[] }
      const items: any[] = data?.data ?? (Array.isArray(data) ? data : [])
      spinner.stop(`${items.length} opportunity(ies)`)

      if (items.length === 0) { prompts.log.warn("No opportunities found"); prompts.outro("Done"); return }

      printDivider()
      for (const o of items) { printOpportunity(o); console.log() }
      printDivider()

      prompts.outro(dim("iris opportunities get <id>  |  iris opportunities pull <id>"))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const GetCommand = cmd({
  command: "get <id>",
  describe: "show opportunity details",
  builder: (yargs) =>
    yargs.positional("id", { describe: "opportunity ID", type: "number", demandOption: true }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Opportunity #${args.id}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Loading…")

    try {
      const res = await irisFetch(`/api/v1/marketplace/opportunities/${args.id}`)
      const ok = await handleApiError(res, "Get opportunity")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const data = (await res.json()) as { data?: any }
      const o = data?.data ?? data
      spinner.stop(String(o.title ?? `#${o.id}`))

      printDivider()
      printKV("ID", o.id)
      printKV("Title", o.title)
      printKV("Status", o.status)
      printKV("Budget", o.min_budget || o.max_budget ? `$${o.min_budget ?? "?"} - $${o.max_budget ?? "?"}` : undefined)
      printKV("Deadline", o.deadline)
      printKV("Skills", Array.isArray(o.skills) ? o.skills.join(", ") : o.skills)
      printKV("Created", o.created_at)
      if (o.description) { console.log(); console.log(`  ${dim("Description:")} ${String(o.description).slice(0, 200)}`) }
      console.log()
      printDivider()

      prompts.outro(dim(`iris opportunities pull ${args.id}`))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const CreateCommand = cmd({
  command: "create",
  describe: "create a new opportunity",
  builder: (yargs) =>
    yargs
      .option("title", { describe: "title", type: "string" })
      .option("description", { describe: "description", type: "string" })
      .option("skills", { describe: "required skills (comma-separated)", type: "string" })
      .option("min-budget", { describe: "minimum budget", type: "number" })
      .option("max-budget", { describe: "maximum budget", type: "number" })
      .option("deadline", { describe: "deadline (YYYY-MM-DD)", type: "string" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Create Opportunity")

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    let title = args.title
    if (!title) {
      title = (await prompts.text({ message: "Title", validate: (x) => (x && x.length > 0 ? undefined : "Required") })) as string
      if (prompts.isCancel(title)) { prompts.outro("Cancelled"); return }
    }

    const spinner = prompts.spinner()
    spinner.start("Creating…")

    try {
      const payload: Record<string, unknown> = { title }
      if (args.description) payload.description = args.description
      if (args.skills) payload.skills = args.skills.split(",").map((s: string) => s.trim())
      if (args["min-budget"]) payload.min_budget = args["min-budget"]
      if (args["max-budget"]) payload.max_budget = args["max-budget"]
      if (args.deadline) payload.deadline = args.deadline

      const res = await irisFetch("/api/v1/marketplace/opportunities", { method: "POST", body: JSON.stringify(payload) })
      const ok = await handleApiError(res, "Create opportunity")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const data = (await res.json()) as { data?: any }
      const o = data?.data ?? data
      spinner.stop(`${success("✓")} Created: ${bold(String(o.title ?? o.id))}`)

      printDivider()
      printKV("ID", o.id)
      printKV("Title", o.title)
      printDivider()

      prompts.outro(dim(`iris opportunities get ${o.id}`))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const PullCommand = cmd({
  command: "pull <id>",
  describe: "download opportunity JSON to local file",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "opportunity ID", type: "number", demandOption: true })
      .option("output", { alias: "o", describe: "output file path", type: "string" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Pull Opportunity #${args.id}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Fetching…")

    try {
      const res = await irisFetch(`/api/v1/marketplace/opportunities/${args.id}`)
      const ok = await handleApiError(res, "Pull opportunity")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const data = (await res.json()) as { data?: any }
      const entity = data?.data ?? data

      const dir = resolveSyncDir()
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

      const filename = args.output ?? entityFilename(entity)
      const filepath = filename.startsWith("/") ? filename : join(dir, filename)

      writeFileSync(filepath, JSON.stringify(entity, null, 2))
      spinner.stop(success("Pulled"))

      printDivider()
      printKV("Title", entity.title)
      printKV("ID", entity.id)
      printKV("Saved to", filepath)
      printDivider()

      prompts.outro(dim(`iris opportunities push ${args.id}  |  iris opportunities diff ${args.id}`))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const PushCommand = cmd({
  command: "push <id>",
  describe: "upload local opportunity JSON to API",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "opportunity ID", type: "number", demandOption: true })
      .option("file", { alias: "f", describe: "local JSON file path", type: "string" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Push Opportunity #${args.id}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()

    try {
      const dir = resolveSyncDir()
      let filepath = args.file
      if (!filepath) filepath = findLocalFile(dir, args.id)

      if (!filepath || !existsSync(filepath)) {
        spinner.start("")
        spinner.stop("Failed", 1)
        prompts.log.error(`Local file not found. Run: ${highlight(`iris opportunities pull ${args.id}`)}`)
        prompts.outro("Done")
        return
      }

      spinner.start(`Pushing ${basename(filepath)}…`)

      const entity = JSON.parse(readFileSync(filepath, "utf-8"))
      const payload: Record<string, unknown> = {
        title: entity.title, description: entity.description, skills: entity.skills,
        min_budget: entity.min_budget, max_budget: entity.max_budget, deadline: entity.deadline,
      }
      for (const k of Object.keys(payload)) { if (payload[k] === undefined) delete payload[k] }

      const res = await irisFetch(`/api/v1/marketplace/opportunities/${args.id}`, { method: "PUT", body: JSON.stringify(payload) })
      const ok = await handleApiError(res, "Push opportunity")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const data = (await res.json()) as { data?: any }
      const result = data?.data ?? data
      spinner.stop(success("Pushed"))

      printDivider()
      printKV("Title", result.title)
      printKV("ID", args.id)
      printKV("From", filepath)
      printDivider()

      prompts.outro(dim(`iris opportunities diff ${args.id}`))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const DiffCommand = cmd({
  command: "diff <id>",
  describe: "compare local opportunity JSON vs live API",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "opportunity ID", type: "number", demandOption: true })
      .option("file", { alias: "f", describe: "local JSON file path", type: "string" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Diff Opportunity #${args.id}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Comparing…")

    try {
      const res = await irisFetch(`/api/v1/marketplace/opportunities/${args.id}`)
      const ok = await handleApiError(res, "Fetch opportunity")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const data = (await res.json()) as { data?: any }
      const live = data?.data ?? data

      const dir = resolveSyncDir()
      let filepath = args.file
      if (!filepath) filepath = findLocalFile(dir, args.id)

      if (!filepath || !existsSync(filepath)) {
        spinner.stop("Failed", 1)
        prompts.log.error(`Local file not found. Run: ${highlight(`iris opportunities pull ${args.id}`)}`)
        prompts.outro("Done")
        return
      }

      const local = JSON.parse(readFileSync(filepath, "utf-8"))

      const fields = ["title", "description", "status", "min_budget", "max_budget", "deadline"]
      const changes: { field: string; live: unknown; local: unknown }[] = []

      for (const f of fields) {
        if (JSON.stringify(live[f] ?? null) !== JSON.stringify(local[f] ?? null)) {
          changes.push({ field: f, live: live[f], local: local[f] })
        }
      }
      if (JSON.stringify(live.skills ?? null) !== JSON.stringify(local.skills ?? null)) {
        changes.push({ field: "skills", live: live.skills, local: local.skills })
      }

      spinner.stop(changes.length === 0 ? success("In sync") : `${changes.length} difference(s)`)

      printDivider()
      printKV("Opportunity", live.title ?? `#${args.id}`)
      console.log()

      if (changes.length === 0) {
        console.log(`  ${success("No differences")}`)
      } else {
        for (const c of changes) {
          console.log(`  ${UI.Style.TEXT_WARNING}~ ${c.field}${UI.Style.TEXT_NORMAL}`)
          console.log(`    ${UI.Style.TEXT_DANGER}- live:  ${String(c.live ?? "(empty)").slice(0, 120)}${UI.Style.TEXT_NORMAL}`)
          console.log(`    ${UI.Style.TEXT_SUCCESS}+ local: ${String(c.local ?? "(empty)").slice(0, 120)}${UI.Style.TEXT_NORMAL}`)
        }
      }
      console.log()
      printDivider()

      prompts.outro(changes.length > 0 ? dim(`iris opportunities push ${args.id}`) : "Done")
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const DeleteCommand = cmd({
  command: "delete <id>",
  describe: "delete an opportunity",
  builder: (yargs) =>
    yargs.positional("id", { describe: "opportunity ID", type: "number", demandOption: true }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Delete Opportunity #${args.id}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const confirmed = await prompts.confirm({ message: `Delete opportunity #${args.id}?` })
    if (!confirmed || prompts.isCancel(confirmed)) { prompts.outro("Cancelled"); return }

    const spinner = prompts.spinner()
    spinner.start("Deleting…")

    try {
      const res = await irisFetch(`/api/v1/marketplace/opportunities/${args.id}`, { method: "DELETE" })
      const ok = await handleApiError(res, "Delete opportunity")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      spinner.stop(`${success("✓")} Deleted`)
      prompts.outro(dim("iris opportunities list"))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

// ============================================================================
// Root command
// ============================================================================

export const PlatformOpportunitiesCommand = cmd({
  command: "opportunities",
  aliases: ["opps"],
  describe: "manage marketplace opportunities — pull, push, diff, CRUD",
  builder: (yargs) =>
    yargs
      .command(ListCommand)
      .command(GetCommand)
      .command(CreateCommand)
      .command(PullCommand)
      .command(PushCommand)
      .command(DiffCommand)
      .command(DeleteCommand)
      .demandCommand(),
  async handler() {},
})
