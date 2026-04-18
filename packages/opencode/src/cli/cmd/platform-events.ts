import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, printDivider, printKV, dim, bold, success, highlight } from "./iris-api"
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "fs"
import { join, basename } from "path"

// ============================================================================
// Sync helpers
// ============================================================================

const SYNC_DIR = ".iris/events"

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
  return `${e.id}-${slugify(String(e.title ?? "event"))}.json`
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

function printEvent(e: Record<string, unknown>): void {
  const title = bold(String(e.title ?? `Event #${e.id}`))
  const id = dim(`#${e.id}`)
  const date = e.start_date ? `  ${dim(String(e.start_date))}` : ""
  const venue = e.venue_name ? `  ${dim(String(e.venue_name))}` : ""
  console.log(`  ${title}  ${id}${date}`)
  if (e.venue_name || e.city) {
    const location = [e.venue_name, e.city, e.state].filter(Boolean).join(", ")
    console.log(`    ${dim(location)}`)
  }
}

// ============================================================================
// Subcommands
// ============================================================================

const ListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list events",
  builder: (yargs) =>
    yargs
      .option("limit", { describe: "max results", type: "number", default: 20 })
      .option("future", { describe: "only future events", type: "boolean" })
      .option("past", { describe: "only past events", type: "boolean" })
      .option("city", { describe: "filter by city", type: "string" })
      .option("search", { alias: "s", describe: "search query", type: "string" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Events")

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Loading…")

    try {
      const params = new URLSearchParams({ per_page: String(args.limit) })
      if (args.future) params.set("future_only", "true")
      if (args.past) params.set("past_only", "true")
      if (args.city) params.set("city", args.city)
      if (args.search) params.set("search", args.search)

      const res = await irisFetch(`/api/v1/events?${params}`)
      const ok = await handleApiError(res, "List events")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const data = (await res.json()) as { data?: any[] }
      const items: any[] = data?.data ?? (Array.isArray(data) ? data : [])
      spinner.stop(`${items.length} event(s)`)

      if (items.length === 0) { prompts.log.warn("No events found"); prompts.outro("Done"); return }

      printDivider()
      for (const e of items) { printEvent(e); console.log() }
      printDivider()

      prompts.outro(dim("iris events get <id>  |  iris events pull <id>"))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const GetCommand = cmd({
  command: "get <id>",
  describe: "show event details",
  builder: (yargs) =>
    yargs.positional("id", { describe: "event ID", type: "number", demandOption: true }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Event #${args.id}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Loading…")

    try {
      const res = await irisFetch(`/api/v1/events/${args.id}`)
      const ok = await handleApiError(res, "Get event")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const data = (await res.json()) as { data?: any }
      const e = data?.data?.event ?? data?.data ?? data
      spinner.stop(String(e.title ?? `#${e.id}`))

      printDivider()
      printKV("ID", e.id)
      printKV("Title", e.title)
      printKV("Date", e.start_date)
      printKV("Time", e.start_time)
      printKV("End Date", e.end_date)
      printKV("End Time", e.end_time)
      printKV("Venue", e.venue_name)
      printKV("Address", [e.street, e.city, e.state, e.zip].filter(Boolean).join(", "))
      printKV("Pricing", e.pricing)
      printKV("Ticket URL", e.purchase_ticket_url)
      printKV("Tags", e.tags)
      printKV("Type", e.event_type)
      printKV("Status", e.status)
      printKV("Created", e.created_at)
      if (e.description) { console.log(); console.log(`  ${dim("Description:")} ${String(e.description).slice(0, 200)}`) }
      console.log()
      printDivider()

      prompts.outro(dim(`iris events pull ${args.id}`))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const CreateCommand = cmd({
  command: "create",
  describe: "create a new event",
  builder: (yargs) =>
    yargs
      .option("title", { describe: "event title", type: "string" })
      .option("description", { describe: "description", type: "string" })
      .option("date", { describe: "start date (YYYY-MM-DD)", type: "string" })
      .option("time", { describe: "start time (HH:MM)", type: "string" })
      .option("venue", { describe: "venue name", type: "string" })
      .option("city", { describe: "city", type: "string" })
      .option("state", { describe: "state", type: "string" })
      .option("profile-id", { describe: "profile ID/slug", type: "string" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Create Event")

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    let title = args.title
    if (!title) {
      title = (await prompts.text({ message: "Event title", validate: (x) => (x && x.length > 0 ? undefined : "Required") })) as string
      if (prompts.isCancel(title)) { prompts.outro("Cancelled"); return }
    }

    const spinner = prompts.spinner()
    spinner.start("Creating…")

    try {
      const payload: Record<string, unknown> = { title, status: "1" }
      if (args.description) payload.description = args.description
      if (args.date) payload.start_date = args.date
      if (args.time) payload.start_time = args.time
      if (args.venue) payload.venue_name = args.venue
      if (args.city) payload.city = args.city
      if (args.state) payload.state = args.state
      if (args["profile-id"]) payload.profile_id = args["profile-id"]

      const res = await irisFetch("/api/v1/events", { method: "POST", body: JSON.stringify(payload) })
      const ok = await handleApiError(res, "Create event")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const data = (await res.json()) as any
      const e = data?.event ?? data?.data ?? data
      spinner.stop(`${success("✓")} Created: ${bold(String(e.title ?? e.id))}`)

      printDivider()
      printKV("ID", e.id)
      printKV("Title", e.title)
      printDivider()

      prompts.outro(dim(`iris events get ${e.id}`))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const UpdateCommand = cmd({
  command: "update <id>",
  describe: "update an event",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "event ID", type: "number", demandOption: true })
      .option("title", { describe: "new title", type: "string" })
      .option("description", { describe: "new description", type: "string" })
      .option("date", { describe: "new start date", type: "string" })
      .option("venue", { describe: "new venue", type: "string" })
      .option("city", { describe: "new city", type: "string" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Update Event #${args.id}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const payload: Record<string, unknown> = {}
    if (args.title) payload.title = args.title
    if (args.description) payload.description = args.description
    if (args.date) payload.start_date = args.date
    if (args.venue) payload.venue_name = args.venue
    if (args.city) payload.city = args.city

    if (Object.keys(payload).length === 0) {
      prompts.log.warn("Nothing to update. Use --title, --description, --date, --venue, or --city")
      prompts.outro("Done")
      return
    }

    const spinner = prompts.spinner()
    spinner.start("Updating…")

    try {
      const res = await irisFetch(`/api/v1/events/${args.id}`, { method: "PUT", body: JSON.stringify(payload) })
      const ok = await handleApiError(res, "Update event")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const data = (await res.json()) as any
      const e = data?.event ?? data?.data ?? data
      spinner.stop(`${success("✓")} Updated: ${bold(String(e.title ?? e.id))}`)

      printDivider()
      printKV("ID", e.id)
      printKV("Title", e.title)
      printDivider()

      prompts.outro(dim(`iris events get ${args.id}`))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const PullCommand = cmd({
  command: "pull <id>",
  describe: "download event JSON to local file",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "event ID", type: "number", demandOption: true })
      .option("output", { alias: "o", describe: "output file path", type: "string" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Pull Event #${args.id}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Fetching…")

    try {
      const res = await irisFetch(`/api/v1/events/${args.id}`)
      const ok = await handleApiError(res, "Pull event")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const data = (await res.json()) as { data?: any }
      const entity = data?.data?.event ?? data?.data ?? data

      const dir = resolveSyncDir()
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

      const filename = args.output ?? entityFilename(entity)
      const filepath = filename.startsWith("/") ? filename : join(dir, filename)

      writeFileSync(filepath, JSON.stringify(entity, null, 2))
      spinner.stop(success("Pulled"))

      printDivider()
      printKV("Title", entity.title)
      printKV("ID", entity.id)
      printKV("Date", entity.start_date)
      printKV("Venue", entity.venue_name)
      printKV("Saved to", filepath)
      printDivider()

      prompts.outro(dim(`iris events push ${args.id}  |  iris events diff ${args.id}`))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const PushCommand = cmd({
  command: "push <id>",
  describe: "upload local event JSON to API",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "event ID", type: "number", demandOption: true })
      .option("file", { alias: "f", describe: "local JSON file path", type: "string" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Push Event #${args.id}`)

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
        prompts.log.error(`Local file not found. Run: ${highlight(`iris events pull ${args.id}`)}`)
        prompts.outro("Done")
        return
      }

      spinner.start(`Pushing ${basename(filepath)}…`)

      const entity = JSON.parse(readFileSync(filepath, "utf-8"))
      const payload: Record<string, unknown> = {
        title: entity.title, description: entity.description,
        start_date: entity.start_date, start_time: entity.start_time,
        end_date: entity.end_date, end_time: entity.end_time,
        venue_name: entity.venue_name, street: entity.street,
        city: entity.city, state: entity.state, zip: entity.zip,
        pricing: entity.pricing, purchase_ticket_url: entity.purchase_ticket_url,
        tags: entity.tags, event_type: entity.event_type, status: entity.status,
        url: entity.url, photo: entity.photo,
      }
      for (const k of Object.keys(payload)) { if (payload[k] === undefined) delete payload[k] }

      const res = await irisFetch(`/api/v1/events/${args.id}`, { method: "PUT", body: JSON.stringify(payload) })
      const ok = await handleApiError(res, "Push event")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      spinner.stop(success("Pushed"))

      printDivider()
      printKV("ID", args.id)
      printKV("From", filepath)
      printDivider()

      prompts.outro(dim(`iris events diff ${args.id}`))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const DiffCommand = cmd({
  command: "diff <id>",
  describe: "compare local event JSON vs live API",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "event ID", type: "number", demandOption: true })
      .option("file", { alias: "f", describe: "local JSON file path", type: "string" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Diff Event #${args.id}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Comparing…")

    try {
      const res = await irisFetch(`/api/v1/events/${args.id}`)
      const ok = await handleApiError(res, "Fetch event")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const data = (await res.json()) as { data?: any }
      const live = data?.data?.event ?? data?.data ?? data

      const dir = resolveSyncDir()
      let filepath = args.file
      if (!filepath) filepath = findLocalFile(dir, args.id)

      if (!filepath || !existsSync(filepath)) {
        spinner.stop("Failed", 1)
        prompts.log.error(`Local file not found. Run: ${highlight(`iris events pull ${args.id}`)}`)
        prompts.outro("Done")
        return
      }

      const local = JSON.parse(readFileSync(filepath, "utf-8"))

      const fields = [
        "title", "description", "start_date", "start_time", "end_date", "end_time",
        "venue_name", "street", "city", "state", "zip", "pricing",
        "purchase_ticket_url", "tags", "event_type", "status", "url",
      ]
      const changes: { field: string; live: unknown; local: unknown }[] = []

      for (const f of fields) {
        if (JSON.stringify(live[f] ?? null) !== JSON.stringify(local[f] ?? null)) {
          changes.push({ field: f, live: live[f], local: local[f] })
        }
      }
      if (JSON.stringify(live.metadata ?? null) !== JSON.stringify(local.metadata ?? null)) {
        changes.push({ field: "metadata", live: "(changed)", local: "(changed)" })
      }

      spinner.stop(changes.length === 0 ? success("In sync") : `${changes.length} difference(s)`)

      printDivider()
      printKV("Event", live.title ?? `#${args.id}`)
      printKV("Date", live.start_date)
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

      prompts.outro(changes.length > 0 ? dim(`iris events push ${args.id}`) : "Done")
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const DeleteCommand = cmd({
  command: "delete <id>",
  describe: "delete an event",
  builder: (yargs) =>
    yargs.positional("id", { describe: "event ID", type: "number", demandOption: true }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Delete Event #${args.id}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const confirmed = await prompts.confirm({ message: `Delete event #${args.id}?` })
    if (!confirmed || prompts.isCancel(confirmed)) { prompts.outro("Cancelled"); return }

    const spinner = prompts.spinner()
    spinner.start("Deleting…")

    try {
      const res = await irisFetch(`/api/v1/events/${args.id}`, { method: "DELETE" })
      const ok = await handleApiError(res, "Delete event")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      spinner.stop(`${success("✓")} Deleted`)
      prompts.outro(dim("iris events list"))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

// ============================================================================
// STAGES subcommands
// ============================================================================

const StagesListCommand = cmd({
  command: "stages <event-id>",
  describe: "list stages for an event",
  builder: (yargs) =>
    yargs.positional("event-id", { describe: "event ID", type: "number", demandOption: true }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Stages — Event #${args["event-id"]}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Loading…")

    try {
      const res = await irisFetch(`/api/v1/events/${args["event-id"]}/stages`)
      const ok = await handleApiError(res, "List stages")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const data = (await res.json()) as any
      const items: any[] = data?.data ?? (Array.isArray(data) ? data : [])
      spinner.stop(`${items.length} stage(s)`)

      if (items.length === 0) { prompts.log.warn("No stages found"); prompts.outro("Done"); return }

      printDivider()
      for (const s of items) {
        console.log(`  ${bold(String(s.title ?? `Stage #${s.id}`))}  ${dim(`#${s.id}`)}`)
        if (s.subtitle) console.log(`    ${dim(s.subtitle)}`)
        const setTimes = s.event_stage_set_times ?? []
        if (setTimes.length > 0) console.log(`    ${dim(`${setTimes.length} set time(s)`)}`)
        console.log()
      }
      printDivider()

      prompts.outro(dim(`iris events stage-create ${args["event-id"]}`))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const StageCreateCommand = cmd({
  command: "stage-create <event-id>",
  describe: "add a stage to an event",
  builder: (yargs) =>
    yargs
      .positional("event-id", { describe: "event ID", type: "number", demandOption: true })
      .option("title", { describe: "stage title", type: "string" })
      .option("subtitle", { describe: "subtitle", type: "string" })
      .option("description", { describe: "description", type: "string" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Add Stage — Event #${args["event-id"]}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    let title = args.title
    if (!title) {
      title = (await prompts.text({ message: "Stage title", validate: (x) => (x && x.length > 0 ? undefined : "Required") })) as string
      if (prompts.isCancel(title)) { prompts.outro("Cancelled"); return }
    }

    const spinner = prompts.spinner()
    spinner.start("Creating…")

    try {
      const payload: Record<string, unknown> = { title }
      if (args.subtitle) payload.subtitle = args.subtitle
      if (args.description) payload.description = args.description

      const res = await irisFetch(`/api/v1/events/${args["event-id"]}/stages`, { method: "POST", body: JSON.stringify(payload) })
      const ok = await handleApiError(res, "Create stage")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const data = (await res.json()) as any
      const s = data?.data ?? data
      spinner.stop(`${success("✓")} Stage created: ${bold(String(s.title ?? s.id))}`)

      printDivider()
      printKV("ID", s.id)
      printKV("Title", s.title)
      printDivider()

      prompts.outro(dim(`iris events stages ${args["event-id"]}`))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const StageDeleteCommand = cmd({
  command: "stage-delete <event-id> <stage-id>",
  describe: "remove a stage from an event",
  builder: (yargs) =>
    yargs
      .positional("event-id", { describe: "event ID", type: "number", demandOption: true })
      .positional("stage-id", { describe: "stage ID", type: "number", demandOption: true }),
  async handler(args) {
    UI.empty()
    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const confirmed = await prompts.confirm({ message: `Delete stage #${args["stage-id"]}?` })
    if (!confirmed || prompts.isCancel(confirmed)) { prompts.outro("Cancelled"); return }

    const spinner = prompts.spinner()
    spinner.start("Deleting…")

    try {
      const res = await irisFetch(`/api/v1/events/${args["event-id"]}/stages/${args["stage-id"]}`, { method: "DELETE" })
      const ok = await handleApiError(res, "Delete stage")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      spinner.stop(`${success("✓")} Stage deleted`)
      prompts.outro(dim(`iris events stages ${args["event-id"]}`))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

// ============================================================================
// VENDORS subcommands
// ============================================================================

const VendorsListCommand = cmd({
  command: "vendors <event-id>",
  describe: "list vendors for an event",
  builder: (yargs) =>
    yargs.positional("event-id", { describe: "event ID", type: "number", demandOption: true }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Vendors — Event #${args["event-id"]}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Loading…")

    try {
      const res = await irisFetch(`/api/v1/events/${args["event-id"]}/vendors`)
      const ok = await handleApiError(res, "List vendors")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const data = (await res.json()) as any
      const items: any[] = data?.data ?? (Array.isArray(data) ? data : [])
      spinner.stop(`${items.length} vendor(s)`)

      if (items.length === 0) { prompts.log.warn("No vendors found"); prompts.outro("Done"); return }

      printDivider()
      for (const v of items) {
        const group = v.vendor_group ? `  ${dim(String(v.vendor_group.title ?? ""))}` : ""
        console.log(`  ${bold(String(v.title ?? `Vendor #${v.id}`))}  ${dim(`#${v.id}`)}${group}`)
        if (v.url) console.log(`    ${dim(v.url)}`)
        console.log()
      }
      printDivider()

      prompts.outro(dim(`iris events vendor-create ${args["event-id"]}`))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const VendorCreateCommand = cmd({
  command: "vendor-create <event-id>",
  describe: "add a vendor to an event",
  builder: (yargs) =>
    yargs
      .positional("event-id", { describe: "event ID", type: "number", demandOption: true })
      .option("title", { describe: "vendor name", type: "string" })
      .option("subtitle", { describe: "subtitle", type: "string" })
      .option("description", { describe: "description", type: "string" })
      .option("url", { describe: "vendor URL", type: "string" })
      .option("profile-id", { describe: "linked profile ID", type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Add Vendor — Event #${args["event-id"]}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    let title = args.title
    if (!title) {
      title = (await prompts.text({ message: "Vendor name", validate: (x) => (x && x.length > 0 ? undefined : "Required") })) as string
      if (prompts.isCancel(title)) { prompts.outro("Cancelled"); return }
    }

    const spinner = prompts.spinner()
    spinner.start("Creating…")

    try {
      const payload: Record<string, unknown> = { title }
      if (args.subtitle) payload.subtitle = args.subtitle
      if (args.description) payload.description = args.description
      if (args.url) payload.url = args.url
      if (args["profile-id"]) payload.profile_id = args["profile-id"]

      const res = await irisFetch(`/api/v1/events/${args["event-id"]}/vendors`, { method: "POST", body: JSON.stringify(payload) })
      const ok = await handleApiError(res, "Create vendor")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const data = (await res.json()) as any
      const v = data?.data ?? data
      spinner.stop(`${success("✓")} Vendor added: ${bold(String(v.title ?? v.id))}`)

      printDivider()
      printKV("ID", v.id)
      printKV("Title", v.title)
      printDivider()

      prompts.outro(dim(`iris events vendors ${args["event-id"]}`))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const VendorDeleteCommand = cmd({
  command: "vendor-delete <event-id> <vendor-id>",
  describe: "remove a vendor from an event",
  builder: (yargs) =>
    yargs
      .positional("event-id", { describe: "event ID", type: "number", demandOption: true })
      .positional("vendor-id", { describe: "vendor ID", type: "number", demandOption: true }),
  async handler(args) {
    UI.empty()
    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const confirmed = await prompts.confirm({ message: `Delete vendor #${args["vendor-id"]}?` })
    if (!confirmed || prompts.isCancel(confirmed)) { prompts.outro("Cancelled"); return }

    const spinner = prompts.spinner()
    spinner.start("Deleting…")

    try {
      const res = await irisFetch(`/api/v1/events/${args["event-id"]}/vendors/${args["vendor-id"]}`, { method: "DELETE" })
      const ok = await handleApiError(res, "Delete vendor")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      spinner.stop(`${success("✓")} Vendor deleted`)
      prompts.outro(dim(`iris events vendors ${args["event-id"]}`))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

// ============================================================================
// TICKETS subcommands — pull/push/diff pattern
// ============================================================================

function ticketsFilename(eventId: number): string {
  return `${eventId}-tickets.json`
}

function findTicketsFile(dir: string, eventId: number): string | undefined {
  const filepath = join(dir, ticketsFilename(eventId))
  return existsSync(filepath) ? filepath : undefined
}

function printTicket(t: Record<string, unknown>): void {
  const price = t.price ? `  ${UI.Style.TEXT_SUCCESS}$${t.price}${UI.Style.TEXT_NORMAL}` : ""
  console.log(`  ${bold(String(t.title ?? `Ticket #${t.id}`))}  ${dim(`#${t.id}`)}${price}`)
  if (t.description) console.log(`    ${dim(String(t.description))}`)
  if (t.url) console.log(`    ${dim(String(t.url))}`)
}

async function fetchTickets(eventId: number): Promise<any[] | null> {
  const res = await irisFetch(`/api/v1/events/${eventId}/tickets`)
  const ok = await handleApiError(res, "Fetch tickets")
  if (!ok) return null
  const data = (await res.json()) as any
  return data?.data ?? (Array.isArray(data) ? data : [])
}

const TicketsListCommand = cmd({
  command: "tickets <event-id>",
  describe: "list tickets for an event",
  builder: (yargs) =>
    yargs.positional("event-id", { describe: "event ID", type: "number", demandOption: true }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Tickets — Event #${args["event-id"]}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Loading…")

    try {
      const items = await fetchTickets(args["event-id"])
      if (!items) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      spinner.stop(`${items.length} ticket(s)`)

      if (items.length === 0) {
        prompts.log.warn("No tickets. Run: iris events tickets-pull <id>  →  edit JSON  →  iris events tickets-push <id>")
        prompts.outro("Done")
        return
      }

      printDivider()
      for (const t of items) { printTicket(t); console.log() }
      printDivider()

      prompts.outro(dim(`iris events tickets-pull ${args["event-id"]}  |  iris events ticket-checkout ${args["event-id"]}`))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const TicketsPullCommand = cmd({
  command: "tickets-pull <event-id>",
  describe: "download all tickets for an event to local JSON",
  builder: (yargs) =>
    yargs
      .positional("event-id", { describe: "event ID", type: "number", demandOption: true })
      .option("output", { alias: "o", describe: "output file path", type: "string" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Pull Tickets — Event #${args["event-id"]}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Fetching…")

    try {
      const items = await fetchTickets(args["event-id"])
      if (!items) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      // Normalize to clean ticket objects for local editing
      const tickets = items.map((t: any) => ({
        id: t.id,
        title: t.title,
        price: t.price,
        description: t.description ?? null,
        url: t.url ?? null,
        sale_start_date: t.sale_start_date ?? null,
        sale_end_date: t.sale_end_date ?? null,
        quantity_total: t.quantity_total ?? null,
        quantity_sold: t.quantity_sold ?? 0,
        max_per_order: t.max_per_order ?? 10,
        min_per_order: t.min_per_order ?? 1,
        is_visible: t.is_visible ?? true,
        sort_order: t.sort_order ?? 0,
        status: t.status ?? "active",
      }))

      const dir = resolveSyncDir()
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

      const filename = args.output ?? ticketsFilename(args["event-id"])
      const filepath = filename.startsWith("/") ? filename : join(dir, filename)

      writeFileSync(filepath, JSON.stringify({ event_id: args["event-id"], tickets }, null, 2))
      spinner.stop(success("Pulled"))

      printDivider()
      printKV("Event", `#${args["event-id"]}`)
      printKV("Tickets", String(tickets.length))
      printKV("Saved to", filepath)
      console.log()
      for (const t of tickets) { printTicket(t) }
      printDivider()

      prompts.log.info("Edit the JSON to add, remove, or update tickets, then push:")
      prompts.outro(dim(`iris events tickets-push ${args["event-id"]}`))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const TicketsPushCommand = cmd({
  command: "tickets-push <event-id>",
  describe: "sync local ticket JSON to API (creates new, updates existing, deletes removed)",
  builder: (yargs) =>
    yargs
      .positional("event-id", { describe: "event ID", type: "number", demandOption: true })
      .option("file", { alias: "f", describe: "local JSON file path", type: "string" })
      .option("dry-run", { describe: "show what would change without applying", type: "boolean", default: false })
      .option("force", { alias: "y", describe: "skip confirmation prompt (for automation)", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Push Tickets — Event #${args["event-id"]}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()

    try {
      // 1. Load local file
      const dir = resolveSyncDir()
      let filepath = args.file
      if (!filepath) filepath = findTicketsFile(dir, args["event-id"])

      if (!filepath || !existsSync(filepath)) {
        spinner.start("")
        spinner.stop("Failed", 1)
        prompts.log.error(`Local file not found. Run: ${highlight(`iris events tickets-pull ${args["event-id"]}`)}`)
        prompts.outro("Done")
        return
      }

      const localData = JSON.parse(readFileSync(filepath, "utf-8"))
      const localTickets: any[] = localData.tickets ?? localData

      // 2. Fetch live tickets
      spinner.start("Comparing local vs live…")
      const liveTickets = await fetchTickets(args["event-id"])
      if (!liveTickets) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const liveMap = new Map<number, any>()
      for (const t of liveTickets) liveMap.set(t.id, t)

      // 3. Compute diff
      const toCreate: any[] = []
      const toUpdate: Array<{ id: number; payload: Record<string, unknown>; changes: string[] }> = []
      const toDelete: any[] = []

      for (const local of localTickets) {
        if (!local.id || !liveMap.has(local.id)) {
          // New ticket (no ID or ID doesn't exist on server)
          toCreate.push(local)
        } else {
          // Existing — check for changes
          const live = liveMap.get(local.id)!
          const changes: string[] = []
          const payload: Record<string, unknown> = {}

          for (const field of ["title", "price", "description", "url", "sale_start_date", "sale_end_date", "quantity_total", "max_per_order", "min_per_order", "is_visible", "sort_order", "status"]) {
            const lv = String(live[field] ?? "")
            const ll = String(local[field] ?? "")
            if (lv !== ll) {
              changes.push(field)
              payload[field] = local[field]
            }
          }

          if (changes.length > 0) {
            toUpdate.push({ id: local.id, payload, changes })
          }
          liveMap.delete(local.id)
        }
      }

      // Remaining in liveMap are tickets removed locally
      for (const [id, t] of liveMap) {
        toDelete.push(t)
      }

      spinner.stop(`${toCreate.length} new, ${toUpdate.length} updated, ${toDelete.length} deleted`)

      // 4. Show diff
      printDivider()
      if (toCreate.length > 0) {
        console.log(`  ${UI.Style.TEXT_SUCCESS}+ New tickets:${UI.Style.TEXT_NORMAL}`)
        for (const t of toCreate) {
          console.log(`    ${bold(t.title)} — $${t.price ?? "0"}`)
        }
        console.log()
      }
      if (toUpdate.length > 0) {
        console.log(`  ${UI.Style.TEXT_WARNING}~ Updated tickets:${UI.Style.TEXT_NORMAL}`)
        for (const t of toUpdate) {
          console.log(`    ${bold(`#${t.id}`)} — ${t.changes.join(", ")}`)
        }
        console.log()
      }
      if (toDelete.length > 0) {
        console.log(`  ${UI.Style.TEXT_DANGER}- Deleted tickets:${UI.Style.TEXT_NORMAL}`)
        for (const t of toDelete) {
          console.log(`    ${bold(String(t.title ?? `#${t.id}`))} — $${t.price ?? "0"}`)
        }
        console.log()
      }
      if (toCreate.length === 0 && toUpdate.length === 0 && toDelete.length === 0) {
        console.log(`  ${success("Already in sync")}`)
        printDivider()
        prompts.outro("Done")
        return
      }
      printDivider()

      if (args["dry-run"]) {
        prompts.log.info("Dry run — no changes applied")
        prompts.outro(dim("Remove --dry-run to apply"))
        return
      }

      // 5. Confirm and apply (skip with --force for automation)
      if (!args.force) {
        const confirmed = await prompts.confirm({ message: "Apply these changes?" })
        if (!confirmed || prompts.isCancel(confirmed)) { prompts.outro("Cancelled"); return }
      }

      const applySpinner = prompts.spinner()
      applySpinner.start("Applying…")
      let ops = 0

      // Create new tickets
      for (const t of toCreate) {
        const payload: Record<string, unknown> = { title: t.title }
        for (const f of ["price", "description", "url", "sale_start_date", "sale_end_date", "quantity_total", "max_per_order", "min_per_order", "is_visible", "sort_order", "status"]) {
          if (t[f] !== undefined && t[f] !== null) payload[f] = t[f]
        }
        const res = await irisFetch(`/api/v1/events/${args["event-id"]}/tickets`, { method: "POST", body: JSON.stringify(payload) })
        await handleApiError(res, `Create ${t.title}`)
        ops++
      }

      // Update existing tickets
      for (const t of toUpdate) {
        const res = await irisFetch(`/api/v1/events/${args["event-id"]}/tickets/${t.id}`, { method: "PUT", body: JSON.stringify(t.payload) })
        await handleApiError(res, `Update #${t.id}`)
        ops++
      }

      // Delete removed tickets
      for (const t of toDelete) {
        const res = await irisFetch(`/api/v1/events/${args["event-id"]}/tickets/${t.id}`, { method: "DELETE" })
        await handleApiError(res, `Delete #${t.id}`)
        ops++
      }

      applySpinner.stop(`${success("✓")} ${ops} operation(s) applied`)

      // 6. Re-pull to get fresh IDs for newly created tickets
      prompts.log.info("Re-pulling to sync local file with new IDs…")
      const fresh = await fetchTickets(args["event-id"])
      if (fresh) {
        const freshTickets = fresh.map((t: any) => ({
          id: t.id,
          title: t.title,
          price: t.price,
          description: t.description ?? null,
          url: t.url ?? null,
        }))
        writeFileSync(filepath, JSON.stringify({ event_id: args["event-id"], tickets: freshTickets }, null, 2))
      }

      prompts.outro(dim(`iris events tickets ${args["event-id"]}`))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const TicketsDiffCommand = cmd({
  command: "tickets-diff <event-id>",
  describe: "compare local ticket JSON vs live API",
  builder: (yargs) =>
    yargs
      .positional("event-id", { describe: "event ID", type: "number", demandOption: true })
      .option("file", { alias: "f", describe: "local JSON file path", type: "string" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Diff Tickets — Event #${args["event-id"]}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Comparing…")

    try {
      // Load local
      const dir = resolveSyncDir()
      let filepath = args.file
      if (!filepath) filepath = findTicketsFile(dir, args["event-id"])

      if (!filepath || !existsSync(filepath)) {
        spinner.stop("Failed", 1)
        prompts.log.error(`Local file not found. Run: ${highlight(`iris events tickets-pull ${args["event-id"]}`)}`)
        prompts.outro("Done")
        return
      }

      const localData = JSON.parse(readFileSync(filepath, "utf-8"))
      const localTickets: any[] = localData.tickets ?? localData

      // Fetch live
      const liveTickets = await fetchTickets(args["event-id"])
      if (!liveTickets) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const liveMap = new Map<number, any>()
      for (const t of liveTickets) liveMap.set(t.id, t)

      let diffs = 0
      const lines: string[] = []

      // Check local tickets against live
      for (const local of localTickets) {
        if (!local.id || !liveMap.has(local.id)) {
          lines.push(`  ${UI.Style.TEXT_SUCCESS}+ NEW: ${local.title} — $${local.price ?? "0"}${UI.Style.TEXT_NORMAL}`)
          diffs++
        } else {
          const live = liveMap.get(local.id)!
          for (const field of ["title", "price", "description", "url", "sale_start_date", "sale_end_date", "quantity_total", "max_per_order", "min_per_order", "is_visible", "sort_order", "status"]) {
            if (String(live[field] ?? "") !== String(local[field] ?? "")) {
              lines.push(`  ${UI.Style.TEXT_WARNING}~ #${local.id} ${field}:${UI.Style.TEXT_NORMAL}`)
              lines.push(`    ${UI.Style.TEXT_DANGER}- live:  ${String(live[field] ?? "(empty)").slice(0, 100)}${UI.Style.TEXT_NORMAL}`)
              lines.push(`    ${UI.Style.TEXT_SUCCESS}+ local: ${String(local[field] ?? "(empty)").slice(0, 100)}${UI.Style.TEXT_NORMAL}`)
              diffs++
            }
          }
          liveMap.delete(local.id)
        }
      }

      // Remaining live tickets = deleted locally
      for (const [id, t] of liveMap) {
        lines.push(`  ${UI.Style.TEXT_DANGER}- DELETED: ${t.title ?? `#${id}`} — $${t.price ?? "0"}${UI.Style.TEXT_NORMAL}`)
        diffs++
      }

      spinner.stop(diffs === 0 ? success("In sync") : `${diffs} difference(s)`)

      printDivider()
      if (diffs === 0) {
        console.log(`  ${success("No differences")}`)
      } else {
        for (const line of lines) console.log(line)
      }
      console.log()
      printDivider()

      prompts.outro(diffs > 0 ? dim(`iris events tickets-push ${args["event-id"]}`) : "Done")
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const TicketCheckoutCommand = cmd({
  command: "ticket-checkout <event-id>",
  describe: "generate a Stripe checkout link for a ticket (door sales, sharing)",
  builder: (yargs) =>
    yargs
      .positional("event-id", { describe: "event ID", type: "number", demandOption: true })
      .option("ticket", { alias: "t", describe: "ticket ID", type: "number" })
      .option("email", { alias: "e", describe: "buyer email", type: "string" })
      .option("qty", { alias: "q", describe: "quantity", type: "number", default: 1 })
      .option("open", { describe: "open checkout URL in browser", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Ticket Checkout — Event #${args["event-id"]}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    let ticketId = args.ticket
    let email = args.email

    // If no ticket specified, list them and let user pick
    if (!ticketId) {
      const spinner = prompts.spinner()
      spinner.start("Loading tickets…")

      const items = await fetchTickets(args["event-id"])
      if (!items) { spinner.stop("Failed", 1); prompts.outro("Done"); return }
      spinner.stop(`${items.length} ticket(s)`)

      if (items.length === 0) {
        prompts.log.warn("No tickets found. Run: iris events tickets-pull " + args["event-id"])
        prompts.outro("Done")
        return
      }

      const choice = (await prompts.select({
        message: "Select ticket",
        options: items.map((t: any) => ({
          value: t.id,
          label: `${t.title ?? "Ticket"} — $${t.price ?? "0"}`,
          hint: `#${t.id}`,
        })),
      })) as number
      if (prompts.isCancel(choice)) { prompts.outro("Cancelled"); return }
      ticketId = choice
    }

    // Get email if not provided
    if (!email) {
      email = (await prompts.text({
        message: "Buyer email",
        placeholder: "door@venue.com",
        validate: (x) => {
          if (!x || !x.includes("@")) return "Valid email required"
          return undefined
        },
      })) as string
      if (prompts.isCancel(email)) { prompts.outro("Cancelled"); return }
    }

    const spinner = prompts.spinner()
    spinner.start("Creating checkout session…")

    try {
      const res = await irisFetch(`/api/v1/events/${args["event-id"]}/tickets/${ticketId}/checkout`, {
        method: "POST",
        body: JSON.stringify({
          buyerEmail: email,
          quantity: args.qty ?? 1,
        }),
      })
      const ok = await handleApiError(res, "Create checkout")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const data = (await res.json()) as any
      const url = data?.checkout_url

      if (!url) {
        spinner.stop("No checkout URL returned", 1)
        prompts.outro("Done")
        return
      }

      spinner.stop(`${success("✓")} Checkout link ready`)

      printDivider()
      console.log()
      console.log(`  ${bold("Checkout URL:")}`)
      console.log(`  ${highlight(url)}`)
      console.log()
      printKV("Email", email)
      printKV("Quantity", String(args.qty ?? 1))
      printDivider()

      if (args.open) {
        const { exec } = await import("child_process")
        exec(`open "${url}"`)
        prompts.log.info("Opened in browser")
      }

      prompts.outro(dim("Share this link or open on a phone for door sales"))
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

export const PlatformEventsCommand = cmd({
  command: "events",
  describe: "manage events, stages, vendors, tickets — pull, push, diff, CRUD",
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
      // Stages
      .command(StagesListCommand)
      .command(StageCreateCommand)
      .command(StageDeleteCommand)
      // Vendors
      .command(VendorsListCommand)
      .command(VendorCreateCommand)
      .command(VendorDeleteCommand)
      // Tickets — pull/push/diff pattern
      .command(TicketsListCommand)
      .command(TicketsPullCommand)
      .command(TicketsPushCommand)
      .command(TicketsDiffCommand)
      .command(TicketCheckoutCommand)
      .demandCommand(),
  async handler() {},
})
