import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, printDivider, printKV, dim, bold, success, highlight } from "./iris-api"
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "fs"
import { join, basename } from "path"

// ============================================================================
// Sync helpers
// ============================================================================

const SYNC_DIR = ".iris/services"

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
  return `${e.id}-${slugify(String(e.title ?? "service"))}.json`
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

function printService(s: Record<string, unknown>): void {
  const title = bold(String(s.title ?? `Service #${s.id}`))
  const id = dim(`#${s.id}`)
  const price = s.price ? `  ${UI.Style.TEXT_SUCCESS}$${s.price}${UI.Style.TEXT_NORMAL}` : ""
  console.log(`  ${title}  ${id}${price}`)
  if (s.description) console.log(`    ${dim(String(s.description).slice(0, 100))}`)
}

// ============================================================================
// Subcommands
// ============================================================================

const ListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list services",
  builder: (yargs) =>
    yargs
      .option("limit", { describe: "max results", type: "number", default: 20 })
      .option("profile-id", { describe: "filter by profile", type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Services")

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Loading…")

    try {
      const params = new URLSearchParams({ per_page: String(args.limit) })
      if (args["profile-id"]) params.set("profile_id", String(args["profile-id"]))

      const res = await irisFetch(`/api/v1/services?${params}`)
      const ok = await handleApiError(res, "List services")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const data = (await res.json()) as { data?: any[] }
      const items: any[] = data?.data ?? (Array.isArray(data) ? data : [])
      spinner.stop(`${items.length} service(s)`)

      if (items.length === 0) { prompts.log.warn("No services found"); prompts.outro("Done"); return }

      printDivider()
      for (const s of items) { printService(s); console.log() }
      printDivider()

      prompts.outro(dim("iris services get <id>  |  iris services pull <id>"))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const GetCommand = cmd({
  command: "get <id>",
  describe: "show service details",
  builder: (yargs) =>
    yargs.positional("id", { describe: "service ID", type: "number", demandOption: true }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Service #${args.id}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Loading…")

    try {
      const res = await irisFetch(`/api/v1/services/${args.id}`)
      const ok = await handleApiError(res, "Get service")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const data = (await res.json()) as { data?: any }
      const s = data?.data?.service ?? data?.data ?? data
      spinner.stop(String(s.title ?? `#${s.id}`))

      printDivider()
      printKV("ID", s.id)
      printKV("Title", s.title)
      printKV("Price", s.price ? `$${s.price}` : undefined)
      printKV("Price Max", s.price_max ? `$${s.price_max}` : undefined)
      printKV("Delivery", s.delivery_amount ? `${s.delivery_amount} ${s.delivery_frequency ?? "days"}` : undefined)
      printKV("Keywords", s.keywords)
      printKV("Status", s.status)
      printKV("Created", s.created_at)
      if (s.description) { console.log(); console.log(`  ${dim("Description:")} ${String(s.description).slice(0, 200)}`) }
      console.log()
      printDivider()

      prompts.outro(dim(`iris services pull ${args.id}`))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const CreateCommand = cmd({
  command: "create",
  describe: "create a new service",
  builder: (yargs) =>
    yargs
      .option("title", { describe: "service title", type: "string" })
      .option("description", { describe: "description", type: "string" })
      .option("price", { describe: "price", type: "number" })
      .option("profile-id", { describe: "profile ID", type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Create Service")

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    let title = args.title
    if (!title) {
      title = (await prompts.text({ message: "Service title", validate: (x) => (x && x.length > 0 ? undefined : "Required") })) as string
      if (prompts.isCancel(title)) { prompts.outro("Cancelled"); return }
    }

    const spinner = prompts.spinner()
    spinner.start("Creating…")

    try {
      const payload: Record<string, unknown> = { title, status: 1 }
      if (args.description) payload.description = args.description
      if (args.price) payload.price = args.price
      if (args["profile-id"]) payload.profile_id = args["profile-id"]

      const res = await irisFetch("/api/v1/services", { method: "POST", body: JSON.stringify(payload) })
      const ok = await handleApiError(res, "Create service")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const data = (await res.json()) as { data?: any }
      const s = data?.data?.service ?? data?.data ?? data
      spinner.stop(`${success("✓")} Created: ${bold(String(s.title ?? s.id))}`)

      printDivider()
      printKV("ID", s.id)
      printKV("Title", s.title)
      printDivider()

      prompts.outro(dim(`iris services get ${s.id}`))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const UpdateCommand = cmd({
  command: "update <id>",
  describe: "update a service",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "service ID", type: "number", demandOption: true })
      .option("title", { describe: "new title", type: "string" })
      .option("description", { describe: "new description", type: "string" })
      .option("price", { describe: "new price", type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Update Service #${args.id}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const payload: Record<string, unknown> = {}
    if (args.title) payload.title = args.title
    if (args.description) payload.description = args.description
    if (args.price) payload.price = args.price

    if (Object.keys(payload).length === 0) {
      prompts.log.warn("Nothing to update. Use --title, --description, or --price")
      prompts.outro("Done")
      return
    }

    const spinner = prompts.spinner()
    spinner.start("Updating…")

    try {
      const res = await irisFetch(`/api/v1/services/${args.id}`, { method: "PUT", body: JSON.stringify(payload) })
      const ok = await handleApiError(res, "Update service")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const data = (await res.json()) as { data?: any }
      const s = data?.data?.service ?? data?.data ?? data
      spinner.stop(`${success("✓")} Updated: ${bold(String(s.title ?? s.id))}`)

      printDivider()
      printKV("ID", s.id)
      printKV("Title", s.title)
      printKV("Price", s.price ? `$${s.price}` : undefined)
      printDivider()

      prompts.outro(dim(`iris services get ${args.id}`))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const PullCommand = cmd({
  command: "pull <id>",
  describe: "download service JSON to local file",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "service ID", type: "number", demandOption: true })
      .option("output", { alias: "o", describe: "output file path", type: "string" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Pull Service #${args.id}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Fetching…")

    try {
      const res = await irisFetch(`/api/v1/services/${args.id}`)
      const ok = await handleApiError(res, "Pull service")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const data = (await res.json()) as { data?: any }
      const entity = data?.data?.service ?? data?.data ?? data

      const dir = resolveSyncDir()
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

      const filename = args.output ?? entityFilename(entity)
      const filepath = filename.startsWith("/") ? filename : join(dir, filename)

      writeFileSync(filepath, JSON.stringify(entity, null, 2))
      spinner.stop(success("Pulled"))

      printDivider()
      printKV("Title", entity.title)
      printKV("ID", entity.id)
      printKV("Price", entity.price ? `$${entity.price}` : undefined)
      printKV("Saved to", filepath)
      printDivider()

      prompts.outro(dim(`iris services push ${args.id}  |  iris services diff ${args.id}`))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const PushCommand = cmd({
  command: "push <id>",
  describe: "upload local service JSON to API",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "service ID", type: "number", demandOption: true })
      .option("file", { alias: "f", describe: "local JSON file path", type: "string" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Push Service #${args.id}`)

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
        prompts.log.error(`Local file not found. Run: ${highlight(`iris services pull ${args.id}`)}`)
        prompts.outro("Done")
        return
      }

      spinner.start(`Pushing ${basename(filepath)}…`)

      const entity = JSON.parse(readFileSync(filepath, "utf-8"))
      const payload: Record<string, unknown> = {
        title: entity.title, description: entity.description, price: entity.price,
        price_max: entity.price_max, keywords: entity.keywords, checklist: entity.checklist,
        addons: entity.addons, delivery_amount: entity.delivery_amount,
        delivery_frequency: entity.delivery_frequency, status: entity.status,
      }
      for (const k of Object.keys(payload)) { if (payload[k] === undefined) delete payload[k] }

      const res = await irisFetch(`/api/v1/services/${args.id}`, { method: "PUT", body: JSON.stringify(payload) })
      const ok = await handleApiError(res, "Push service")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      spinner.stop(success("Pushed"))

      printDivider()
      printKV("ID", args.id)
      printKV("From", filepath)
      printDivider()

      prompts.outro(dim(`iris services diff ${args.id}`))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const DiffCommand = cmd({
  command: "diff <id>",
  describe: "compare local service JSON vs live API",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "service ID", type: "number", demandOption: true })
      .option("file", { alias: "f", describe: "local JSON file path", type: "string" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Diff Service #${args.id}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Comparing…")

    try {
      const res = await irisFetch(`/api/v1/services/${args.id}`)
      const ok = await handleApiError(res, "Fetch service")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const data = (await res.json()) as { data?: any }
      const live = data?.data?.service ?? data?.data ?? data

      const dir = resolveSyncDir()
      let filepath = args.file
      if (!filepath) filepath = findLocalFile(dir, args.id)

      if (!filepath || !existsSync(filepath)) {
        spinner.stop("Failed", 1)
        prompts.log.error(`Local file not found. Run: ${highlight(`iris services pull ${args.id}`)}`)
        prompts.outro("Done")
        return
      }

      const local = JSON.parse(readFileSync(filepath, "utf-8"))

      const fields = ["title", "description", "price", "price_max", "keywords", "status", "delivery_amount", "delivery_frequency"]
      const changes: { field: string; live: unknown; local: unknown }[] = []

      for (const f of fields) {
        if (JSON.stringify(live[f] ?? null) !== JSON.stringify(local[f] ?? null)) {
          changes.push({ field: f, live: live[f], local: local[f] })
        }
      }
      for (const f of ["checklist", "addons"]) {
        if (JSON.stringify(live[f] ?? null) !== JSON.stringify(local[f] ?? null)) {
          changes.push({ field: f, live: "(changed)", local: "(changed)" })
        }
      }

      spinner.stop(changes.length === 0 ? success("In sync") : `${changes.length} difference(s)`)

      printDivider()
      printKV("Service", live.title ?? `#${args.id}`)
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

      prompts.outro(changes.length > 0 ? dim(`iris services push ${args.id}`) : "Done")
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const DeleteCommand = cmd({
  command: "delete <id>",
  describe: "delete a service",
  builder: (yargs) =>
    yargs.positional("id", { describe: "service ID", type: "number", demandOption: true }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Delete Service #${args.id}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const confirmed = await prompts.confirm({ message: `Delete service #${args.id}?` })
    if (!confirmed || prompts.isCancel(confirmed)) { prompts.outro("Cancelled"); return }

    const spinner = prompts.spinner()
    spinner.start("Deleting…")

    try {
      const res = await irisFetch(`/api/v1/services/${args.id}`, { method: "DELETE" })
      const ok = await handleApiError(res, "Delete service")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      spinner.stop(`${success("✓")} Deleted`)
      prompts.outro(dim("iris services list"))
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

export const PlatformServicesCommand = cmd({
  command: "services",
  describe: "manage profile services — pull, push, diff, CRUD",
  builder: (yargs) =>
    yargs
      .command(ListCommand)
      .command(GetCommand)
      .command(CreateCommand)
      .command(UpdateCommand)
      .command(PullCommand)
      .command(PushCommand)
      .command(DiffCommand)
      .command(DeleteCommand)
      .demandCommand(),
  async handler() {},
})
