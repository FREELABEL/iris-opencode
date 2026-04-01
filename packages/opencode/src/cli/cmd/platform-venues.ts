import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, printDivider, printKV, dim, bold, success, highlight } from "./iris-api"
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "fs"
import { join, basename } from "path"

// ============================================================================
// Sync helpers
// ============================================================================

const SYNC_DIR = ".iris/venues"

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
  return `${e.id}-${slugify(String(e.name ?? "venue"))}.json`
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

function printVenue(v: Record<string, unknown>): void {
  const name = bold(String(v.name ?? `Venue #${v.id}`))
  const id = dim(`#${v.id}`)
  const type = v.type ? `  ${dim(String(v.type))}` : ""
  const location = [v.city, v.state].filter(Boolean).join(", ")
  console.log(`  ${name}  ${id}${type}`)
  if (location) console.log(`    ${dim(location)}`)
}

// ============================================================================
// Subcommands
// ============================================================================

const ListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list venues",
  builder: (yargs) =>
    yargs
      .option("limit", { describe: "max results", type: "number", default: 20 })
      .option("search", { alias: "q", describe: "search query", type: "string" })
      .option("type", { describe: "venue type (studio/venue/restaurant/bar/store/coffee-shop)", type: "string" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Venues")

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Loading…")

    try {
      const params = new URLSearchParams({ limit: String(args.limit) })
      if (args.search) params.set("query", args.search)
      if (args.type) params.set("type", args.type)

      const res = await irisFetch(`/api/venues?${params}`)
      const ok = await handleApiError(res, "List venues")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const data = (await res.json()) as any
      const items: any[] = data?.data ?? (Array.isArray(data) ? data : [])
      spinner.stop(`${items.length} venue(s)`)

      if (items.length === 0) { prompts.log.warn("No venues found"); prompts.outro("Done"); return }

      printDivider()
      for (const v of items) { printVenue(v); console.log() }
      printDivider()

      prompts.outro(dim("iris venues get <id>  |  iris venues pull <id>"))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const GetCommand = cmd({
  command: "get <id>",
  describe: "show venue details",
  builder: (yargs) =>
    yargs.positional("id", { describe: "venue ID", type: "number", demandOption: true }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Venue #${args.id}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Loading…")

    try {
      const res = await irisFetch(`/api/venues/${args.id}`)
      const ok = await handleApiError(res, "Get venue")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const data = (await res.json()) as any
      const v = data?.data ?? data
      spinner.stop(String(v.name ?? `#${v.id}`))

      printDivider()
      printKV("ID", v.id)
      printKV("Name", v.name)
      printKV("Type", v.type)
      printKV("Address", v.address)
      printKV("City", v.city)
      printKV("State", v.state)
      printKV("Zip", v.zipcode)
      printKV("Phone", v.phone)
      printKV("Email", v.email)
      printKV("Website", v.website_url)
      printKV("Hourly Rate", v.hourly_rate ? `$${v.hourly_rate}` : undefined)
      printKV("Rating", v.rating)
      printKV("Instagram", v.instagram)
      printKV("Google Place ID", v.google_place_id)
      if (v.description) { console.log(); console.log(`  ${dim("Description:")} ${String(v.description).slice(0, 200)}`) }
      console.log()
      printDivider()

      prompts.outro(dim(`iris venues pull ${args.id}`))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const CreateCommand = cmd({
  command: "create",
  describe: "create a new venue",
  builder: (yargs) =>
    yargs
      .option("name", { describe: "venue name", type: "string" })
      .option("type", { describe: "type (studio/venue/restaurant/bar/store/coffee-shop)", type: "string", default: "venue" })
      .option("city", { describe: "city", type: "string" })
      .option("state", { describe: "state", type: "string" })
      .option("address", { describe: "street address", type: "string" })
      .option("phone", { describe: "phone number", type: "string" })
      .option("email", { describe: "email", type: "string" })
      .option("website", { describe: "website URL", type: "string" })
      .option("hourly-rate", { describe: "hourly rate", type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Create Venue")

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    let name = args.name
    if (!name) {
      name = (await prompts.text({ message: "Venue name", validate: (x) => (x && x.length > 0 ? undefined : "Required") })) as string
      if (prompts.isCancel(name)) { prompts.outro("Cancelled"); return }
    }

    const spinner = prompts.spinner()
    spinner.start("Creating…")

    try {
      const payload: Record<string, unknown> = { name, type: args.type }
      if (args.city) payload.city = args.city
      if (args.state) payload.state = args.state
      if (args.address) payload.address = args.address
      if (args.phone) payload.phone = args.phone
      if (args.email) payload.email = args.email
      if (args.website) payload.website_url = args.website
      if (args["hourly-rate"]) payload.hourly_rate = args["hourly-rate"]

      const res = await irisFetch("/api/venues", { method: "POST", body: JSON.stringify(payload) })
      const ok = await handleApiError(res, "Create venue")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const data = (await res.json()) as any
      const v = data?.data ?? data?.venue ?? data
      spinner.stop(`${success("✓")} Created: ${bold(String(v.name ?? v.id))}`)

      printDivider()
      printKV("ID", v.id)
      printKV("Name", v.name)
      printKV("Type", v.type)
      printDivider()

      prompts.outro(dim(`iris venues get ${v.id}`))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const UpdateCommand = cmd({
  command: "update <id>",
  describe: "update a venue",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "venue ID", type: "number", demandOption: true })
      .option("name", { describe: "new name", type: "string" })
      .option("type", { describe: "new type", type: "string" })
      .option("city", { describe: "new city", type: "string" })
      .option("address", { describe: "new address", type: "string" })
      .option("phone", { describe: "new phone", type: "string" })
      .option("hourly-rate", { describe: "new hourly rate", type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Update Venue #${args.id}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const payload: Record<string, unknown> = {}
    if (args.name) payload.name = args.name
    if (args.type) payload.type = args.type
    if (args.city) payload.city = args.city
    if (args.address) payload.address = args.address
    if (args.phone) payload.phone = args.phone
    if (args["hourly-rate"]) payload.hourly_rate = args["hourly-rate"]

    if (Object.keys(payload).length === 0) {
      prompts.log.warn("Nothing to update. Use --name, --type, --city, etc.")
      prompts.outro("Done")
      return
    }

    const spinner = prompts.spinner()
    spinner.start("Updating…")

    try {
      const res = await irisFetch(`/api/venues/${args.id}`, { method: "PUT", body: JSON.stringify(payload) })
      const ok = await handleApiError(res, "Update venue")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const data = (await res.json()) as any
      const v = data?.data ?? data?.venue ?? data
      spinner.stop(`${success("✓")} Updated: ${bold(String(v.name ?? v.id))}`)

      printDivider()
      printKV("ID", v.id)
      printKV("Name", v.name)
      printDivider()

      prompts.outro(dim(`iris venues get ${args.id}`))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const PullCommand = cmd({
  command: "pull <id>",
  describe: "download venue JSON to local file",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "venue ID", type: "number", demandOption: true })
      .option("output", { alias: "o", describe: "output file path", type: "string" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Pull Venue #${args.id}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Fetching…")

    try {
      const res = await irisFetch(`/api/venues/${args.id}`)
      const ok = await handleApiError(res, "Pull venue")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const data = (await res.json()) as any
      const entity = data?.data ?? data

      const dir = resolveSyncDir()
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

      const filename = args.output ?? entityFilename(entity)
      const filepath = filename.startsWith("/") ? filename : join(dir, filename)

      writeFileSync(filepath, JSON.stringify(entity, null, 2))
      spinner.stop(success("Pulled"))

      printDivider()
      printKV("Name", entity.name)
      printKV("ID", entity.id)
      printKV("Type", entity.type)
      printKV("City", entity.city)
      printKV("Saved to", filepath)
      printDivider()

      prompts.outro(dim(`iris venues push ${args.id}  |  iris venues diff ${args.id}`))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const PushCommand = cmd({
  command: "push <id>",
  describe: "upload local venue JSON to API",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "venue ID", type: "number", demandOption: true })
      .option("file", { alias: "f", describe: "local JSON file path", type: "string" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Push Venue #${args.id}`)

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
        prompts.log.error(`Local file not found. Run: ${highlight(`iris venues pull ${args.id}`)}`)
        prompts.outro("Done")
        return
      }

      spinner.start(`Pushing ${basename(filepath)}…`)

      const entity = JSON.parse(readFileSync(filepath, "utf-8"))
      const payload: Record<string, unknown> = {
        name: entity.name, type: entity.type, city: entity.city, state: entity.state,
        address: entity.address, zipcode: entity.zipcode, email: entity.email, phone: entity.phone,
        website_url: entity.website_url, description: entity.description, hourly_rate: entity.hourly_rate,
        instagram: entity.instagram, twitter: entity.twitter, slug: entity.slug,
        amenities: entity.amenities, keywords: entity.keywords, tags: entity.tags,
        studio_hours: entity.studio_hours, studio_rules: entity.studio_rules,
      }
      for (const k of Object.keys(payload)) { if (payload[k] === undefined) delete payload[k] }

      const res = await irisFetch(`/api/venues/${args.id}`, { method: "PUT", body: JSON.stringify(payload) })
      const ok = await handleApiError(res, "Push venue")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      spinner.stop(success("Pushed"))

      printDivider()
      printKV("ID", args.id)
      printKV("From", filepath)
      printDivider()

      prompts.outro(dim(`iris venues diff ${args.id}`))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const DiffCommand = cmd({
  command: "diff <id>",
  describe: "compare local venue JSON vs live API",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "venue ID", type: "number", demandOption: true })
      .option("file", { alias: "f", describe: "local JSON file path", type: "string" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Diff Venue #${args.id}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Comparing…")

    try {
      const res = await irisFetch(`/api/venues/${args.id}`)
      const ok = await handleApiError(res, "Fetch venue")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const data = (await res.json()) as any
      const live = data?.data ?? data

      const dir = resolveSyncDir()
      let filepath = args.file
      if (!filepath) filepath = findLocalFile(dir, args.id)

      if (!filepath || !existsSync(filepath)) {
        spinner.stop("Failed", 1)
        prompts.log.error(`Local file not found. Run: ${highlight(`iris venues pull ${args.id}`)}`)
        prompts.outro("Done")
        return
      }

      const local = JSON.parse(readFileSync(filepath, "utf-8"))

      const fields = ["name", "type", "city", "state", "address", "zipcode", "email", "phone", "website_url", "description", "hourly_rate", "instagram", "rating"]
      const changes: { field: string; live: unknown; local: unknown }[] = []

      for (const f of fields) {
        if (JSON.stringify(live[f] ?? null) !== JSON.stringify(local[f] ?? null)) {
          changes.push({ field: f, live: live[f], local: local[f] })
        }
      }

      spinner.stop(changes.length === 0 ? success("In sync") : `${changes.length} difference(s)`)

      printDivider()
      printKV("Venue", live.name ?? `#${args.id}`)
      printKV("Type", live.type)
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

      prompts.outro(changes.length > 0 ? dim(`iris venues push ${args.id}`) : "Done")
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const DeleteCommand = cmd({
  command: "delete <id>",
  describe: "delete a venue",
  builder: (yargs) =>
    yargs.positional("id", { describe: "venue ID", type: "number", demandOption: true }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Delete Venue #${args.id}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const confirmed = await prompts.confirm({ message: `Delete venue #${args.id}?` })
    if (!confirmed || prompts.isCancel(confirmed)) { prompts.outro("Cancelled"); return }

    const spinner = prompts.spinner()
    spinner.start("Deleting…")

    try {
      const res = await irisFetch(`/api/venues/${args.id}`, { method: "DELETE" })
      const ok = await handleApiError(res, "Delete venue")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      spinner.stop(`${success("✓")} Deleted`)
      prompts.outro(dim("iris venues list"))
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

export const PlatformVenuesCommand = cmd({
  command: "venues",
  aliases: ["studios"],
  describe: "manage venues & studios — pull, push, diff, CRUD",
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
