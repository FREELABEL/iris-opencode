import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, printDivider, printKV, dim, bold, success, highlight } from "./iris-api"
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "fs"
import { join, basename } from "path"
import { ProductionCommand } from "./platform-events-production"

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
  // Exclude tickets files — those are managed by tickets-pull/push
  const files = require("fs").readdirSync(dir).filter((f: string) =>
    f.startsWith(prefix) && f.endsWith(".json") && !f.includes("tickets")
  )
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
      .option("end-date", { describe: "end date (YYYY-MM-DD)", type: "string" })
      .option("end-time", { describe: "end time (HH:MM)", type: "string" })
      .option("venue", { describe: "venue name", type: "string" })
      .option("city", { describe: "city", type: "string" })
      .option("state", { describe: "state", type: "string" })
      .option("zip", { describe: "zip code", type: "string" })
      .option("street", { describe: "street address", type: "string" })
      .option("type", { describe: "event type (showcase/concert/workshop/meetup/conference)", type: "string" })
      .option("pricing", { describe: "pricing info", type: "string" })
      .option("ticket-url", { describe: "ticket purchase URL", type: "string" })
      .option("tags", { describe: "tags (comma-separated)", type: "string" })
      .option("bloq-id", { describe: "associated bloq ID", type: "number" })
      .option("profile-id", { describe: "profile ID/slug", type: "string" })
      .option("json", { describe: "output as JSON", type: "boolean", default: false }),
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
      if (args["end-date"]) payload.end_date = args["end-date"]
      if (args["end-time"]) payload.end_time = args["end-time"]
      if (args.venue) payload.venue_name = args.venue
      if (args.city) payload.city = args.city
      if (args.state) payload.state = args.state
      if (args.zip) payload.zip = args.zip
      if (args.street) payload.street = args.street
      if (args.type) payload.event_type = args.type
      if (args.pricing) payload.pricing = args.pricing
      if (args["ticket-url"]) payload.purchase_ticket_url = args["ticket-url"]
      if (args.tags) payload.tags = args.tags
      if (args["bloq-id"]) payload.bloq_id = args["bloq-id"]
      if (args["profile-id"]) payload.profile_id = args["profile-id"]

      const res = await irisFetch("/api/v1/events", { method: "POST", body: JSON.stringify(payload) })
      const ok = await handleApiError(res, "Create event")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const data = (await res.json()) as any
      const e = data?.event ?? data?.data ?? data
      spinner.stop(`${success("✓")} Created: ${bold(String(e.title ?? e.id))}`)

      if (args.json) {
        console.log(JSON.stringify(e, null, 2))
        prompts.outro("Done")
        return
      }

      printDivider()
      printKV("ID", e.id)
      printKV("Title", e.title)
      printKV("Date", e.start_date)
      printKV("Time", e.start_time)
      printKV("Venue", e.venue_name)
      if (e.city || e.state) printKV("Location", [e.city, e.state].filter(Boolean).join(", "))
      printKV("Type", e.event_type)
      if (e.slug) printKV("URL", `https://heyiris.io/p/${e.slug}`)
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
      .option("date", { describe: "new start date (YYYY-MM-DD)", type: "string" })
      .option("time", { describe: "new start time (HH:MM)", type: "string" })
      .option("end-date", { describe: "new end date (YYYY-MM-DD)", type: "string" })
      .option("end-time", { describe: "new end time (HH:MM)", type: "string" })
      .option("venue", { describe: "new venue name", type: "string" })
      .option("city", { describe: "new city", type: "string" })
      .option("state", { describe: "new state", type: "string" })
      .option("zip", { describe: "new zip code", type: "string" })
      .option("street", { describe: "new street address", type: "string" })
      .option("type", { describe: "new event type (showcase/concert/workshop/meetup/conference)", type: "string" })
      .option("pricing", { describe: "new pricing info", type: "string" })
      .option("ticket-url", { describe: "ticket purchase URL", type: "string" })
      .option("tags", { describe: "tags (comma-separated)", type: "string" })
      .option("bloq-id", { describe: "associated bloq ID", type: "number" })
      .option("status", { describe: "event status", type: "string" })
      .option("json", { describe: "output as JSON", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Update Event #${args.id}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const payload: Record<string, unknown> = {}
    if (args.title) payload.title = args.title
    if (args.description) payload.description = args.description
    if (args.date) payload.start_date = args.date
    if (args.time) payload.start_time = args.time
    if (args["end-date"]) payload.end_date = args["end-date"]
    if (args["end-time"]) payload.end_time = args["end-time"]
    if (args.venue) payload.venue_name = args.venue
    if (args.city) payload.city = args.city
    if (args.state) payload.state = args.state
    if (args.zip) payload.zip = args.zip
    if (args.street) payload.street = args.street
    if (args.type) payload.event_type = args.type
    if (args.pricing) payload.pricing = args.pricing
    if (args["ticket-url"]) payload.purchase_ticket_url = args["ticket-url"]
    if (args.tags) payload.tags = args.tags
    if (args["bloq-id"]) payload.bloq_id = args["bloq-id"]
    if (args.status) payload.status = args.status

    if (Object.keys(payload).length === 0) {
      prompts.log.warn("Nothing to update. Use --title, --description, --date, --time, --venue, --city, --state, --type, etc.")
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

      if (args.json) {
        console.log(JSON.stringify(e, null, 2))
        prompts.outro("Done")
        return
      }

      printDivider()
      printKV("ID", e.id)
      printKV("Title", e.title)
      printKV("Date", e.start_date)
      printKV("Venue", e.venue_name)
      if (e.city || e.state) printKV("Location", [e.city, e.state].filter(Boolean).join(", "))
      printKV("Type", e.event_type)
      printKV("Status", e.status)
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
      // Pass-through: send all fields. API validates known fields,
      // unknown fields are saved to metadata so nothing is lost (#58785)
      const READONLY = new Set(["id", "created_at", "updated_at", "creator", "tickets", "stages", "vendors", "staff", "bloq"])
      const payload: Record<string, unknown> = {}
      const extraMetadata: Record<string, unknown> = {}
      const KNOWN_FIELDS = new Set([
        "title", "description", "start_date", "start_time", "end_date", "end_time",
        "venue_name", "street", "city", "state", "zip", "pricing",
        "purchase_ticket_url", "tags", "event_type", "status", "url", "photo",
        "metadata", "profile_id", "bloq_id",
      ])
      for (const [k, v] of Object.entries(entity)) {
        if (READONLY.has(k) || v === undefined || v === null) continue
        if (KNOWN_FIELDS.has(k)) {
          payload[k] = v
        } else {
          extraMetadata[k] = v
        }
      }
      // Merge extra fields into metadata so they're preserved
      const metaKeys = Object.keys(extraMetadata)
      if (metaKeys.length > 0) {
        payload.metadata = { ...(entity.metadata ?? {}), ...extraMetadata }
      }

      const res = await irisFetch(`/api/v1/events/${args.id}`, { method: "PUT", body: JSON.stringify(payload) })
      const ok = await handleApiError(res, "Push event")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      spinner.stop(success("Pushed"))

      printDivider()
      printKV("ID", args.id)
      printKV("From", filepath)
      // Warn about fields saved to metadata (not schema-validated)
      if (metaKeys.length > 0) {
        console.log(`  ${dim("Saved to metadata:")} ${metaKeys.join(", ")}`)
        console.log(`  ${dim("These fields are preserved but not schema-validated.")}`)
      }
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
    yargs
      .positional("id", { describe: "event ID", type: "number", demandOption: true })
      .option("force", { alias: "y", describe: "skip confirmation prompt", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Delete Event #${args.id}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    if (!args.force) {
      const confirmed = await prompts.confirm({ message: `Delete event #${args.id}? This cannot be undone.` })
      if (!confirmed || prompts.isCancel(confirmed)) { prompts.outro("Cancelled"); return }
    }

    const spinner = prompts.spinner()
    spinner.start("Deleting…")

    try {
      const res = await irisFetch(`/api/v1/events/${args.id}`, { method: "DELETE" })
      const ok = await handleApiError(res, "Delete event")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      spinner.stop(`${success("✓")} Deleted event #${args.id}`)
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

// ============================================================================
// Set Times — artist slots on stages
// ============================================================================

const SetTimesListCommand = cmd({
  command: "set-times <event-id> <stage-id>",
  aliases: ["lineup"],
  describe: "list set times (artist lineup) for a stage",
  handler: async (args: Record<string, unknown>) => {
    const eventId = String(args.eventId)
    const stageId = String(args.stageId)
    await requireAuth()
    const spinner = prompts.spinner()
    spinner.start("Loading lineup…")
    try {
      const res = await irisFetch(`/api/v1/events/${eventId}/stages/${stageId}/set-times`)
      const ok = await handleApiError(res, "List set times")
      if (!ok) { spinner.stop("Failed", 1); return }
      const data = (await res.json()) as any
      const setTimes = data.data || []
      spinner.stop(success(`${setTimes.length} artist(s) on stage`))
      if (args.json) { console.log(JSON.stringify(setTimes, null, 2)); return }
      if (setTimes.length === 0) { prompts.log.info(dim("No set times. Use: iris events add-set-time <event-id> <stage-id> --profile <pk>")); return }
      printDivider()
      for (const st of setTimes) {
        const name = st.profile?.name || st.profile_name || "TBA"
        const time = [st.start_time, st.end_time].filter(Boolean).join(" - ") || "no time set"
        const headliner = st.is_headliner ? " ⭐" : ""
        console.log(`  ${bold(name)}  ${dim(time)}${headliner}`)
      }
      printDivider()
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
    }
  },
  builder: (y) => y
    .positional("event-id", { describe: "event ID", type: "string", demandOption: true })
    .positional("stage-id", { describe: "stage ID", type: "string", demandOption: true })
    .option("json", { describe: "JSON output", type: "boolean" }),
})

const AddSetTimeCommand = cmd({
  command: "add-set-time <event-id> <stage-id>",
  aliases: ["add-artist"],
  describe: "add an artist to a stage lineup",
  handler: async (args: Record<string, unknown>) => {
    const eventId = String(args.eventId)
    const stageId = String(args.stageId)
    await requireAuth()
    const spinner = prompts.spinner()
    spinner.start("Adding artist to lineup…")
    try {
      const body: Record<string, unknown> = {}
      if (args.profile) body.profile_id = String(args.profile)
      if (args.name) body.profile_name = String(args.name)
      if (args.start) body.start_time = String(args.start)
      if (args.end) body.end_time = String(args.end)
      if (args.date) body.start_date = String(args.date)
      if (args.headliner) body.is_headliner = true

      const res = await irisFetch(`/api/v1/events/${eventId}/stages/${stageId}/set-times`, { method: "POST", body: JSON.stringify(body) })
      const ok = await handleApiError(res, "Add set time")
      if (!ok) { spinner.stop("Failed", 1); return }
      const data = (await res.json()) as any
      const st = data.data || data
      const name = st.profile?.name || st.profile_name || "Artist"
      spinner.stop(success(`${name} added to lineup`))
      if (args.json) { console.log(JSON.stringify(st, null, 2)); return }
      printDivider()
      printKV("Artist", name)
      if (st.profile?.id) printKV("Profile", `@${st.profile.id}`)
      if (st.start_time) printKV("Time", [st.start_time, st.end_time].filter(Boolean).join(" - "))
      if (st.is_headliner) printKV("Headliner", "⭐ Yes")
      printDivider()
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
    }
  },
  builder: (y) => y
    .positional("event-id", { describe: "event ID", type: "string", demandOption: true })
    .positional("stage-id", { describe: "stage ID", type: "string", demandOption: true })
    .option("profile", { alias: "p", describe: "profile PK (integer)", type: "string" })
    .option("name", { alias: "n", describe: "artist name (if no profile)", type: "string" })
    .option("start", { describe: "start time (e.g. 8:00 PM)", type: "string" })
    .option("end", { describe: "end time (e.g. 8:30 PM)", type: "string" })
    .option("date", { describe: "date (YYYY-MM-DD)", type: "string" })
    .option("headliner", { describe: "mark as headliner", type: "boolean" })
    .option("json", { describe: "JSON output", type: "boolean" }),
})

const RemoveSetTimeCommand = cmd({
  command: "remove-set-time <event-id> <stage-id> <set-time-id>",
  aliases: ["remove-artist"],
  describe: "remove an artist from a stage lineup",
  handler: async (args: Record<string, unknown>) => {
    const eventId = String(args.eventId)
    const stageId = String(args.stageId)
    const setTimeId = String(args.setTimeId)
    await requireAuth()
    if (!args.force) {
      const confirm = await prompts.confirm({ message: `Remove set time #${setTimeId}?` })
      if (!confirm || prompts.isCancel(confirm)) { prompts.outro(dim("Cancelled")); return }
    }
    const spinner = prompts.spinner()
    spinner.start("Removing…")
    try {
      const res = await irisFetch(`/api/v1/events/${eventId}/stages/${stageId}/set-times/${setTimeId}`, { method: "DELETE" })
      const ok = await handleApiError(res, "Remove set time")
      if (!ok) { spinner.stop("Failed", 1); return }
      spinner.stop(success("Artist removed from lineup"))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
    }
  },
  builder: (y) => y
    .positional("event-id", { describe: "event ID", type: "string", demandOption: true })
    .positional("stage-id", { describe: "stage ID", type: "string", demandOption: true })
    .positional("set-time-id", { describe: "set time ID", type: "string", demandOption: true })
    .option("force", { alias: "y", describe: "skip confirmation", type: "boolean" }),
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
// Venue Deal — link/unlink a venue to an event
// ============================================================================

const LinkVenueCommand = cmd({
  command: "link-venue <event-id> <venue-id>",
  aliases: ["venue-deal", "attach-venue"],
  describe: "link a venue to an event with deal terms",
  handler: async (args: Record<string, unknown>) => {
    const eventId = String(args.eventId)
    const venueId = String(args.venueId)
    await requireAuth()
    const spinner = prompts.spinner()
    spinner.start("Linking venue to event…")
    try {
      const body: Record<string, unknown> = {
        venue_id: Number(venueId),
        deal_type: String(args.type || "flat_fee"),
        deal_value_cents: args.amount ? Number(args.amount) * 100 : 0,
      }
      if (args.share) body.revenue_share_percent = Number(args.share)
      if (args.contact) body.contact_name = String(args.contact)
      if (args.phone) body.contact_phone = String(args.phone)
      if (args.email) body.contact_email = String(args.email)
      if (args.notes) body.notes = String(args.notes)

      const res = await irisFetch(`/api/v1/events/${eventId}/venue-deal`, { method: "POST", body: JSON.stringify(body) })
      const ok = await handleApiError(res, "Link venue")
      if (!ok) { spinner.stop("Failed", 1); return }
      const data = (await res.json()) as any
      const deal = data.data || data
      spinner.stop(success("Venue linked to event"))
      if (args.json) { console.log(JSON.stringify(deal, null, 2)); return }
      printDivider()
      printKV("Event", `#${eventId}`)
      printKV("Venue ID", venueId)
      printKV("Deal Type", deal.deal_type || args.type || "flat_fee")
      if (deal.deal_value_cents) printKV("Amount", `$${(deal.deal_value_cents / 100).toLocaleString()}`)
      if (deal.contact_name) printKV("Contact", deal.contact_name)
      printDivider()
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
    }
  },
  builder: (y) => y
    .positional("event-id", { describe: "event ID", type: "string", demandOption: true })
    .positional("venue-id", { describe: "venue ID", type: "string", demandOption: true })
    .option("type", { describe: "deal type (flat_fee or revenue_share)", type: "string", default: "flat_fee" })
    .option("amount", { describe: "deal amount in dollars", type: "number" })
    .option("share", { describe: "revenue share %", type: "number" })
    .option("contact", { describe: "contact name", type: "string" })
    .option("phone", { describe: "contact phone", type: "string" })
    .option("email", { describe: "contact email", type: "string" })
    .option("notes", { describe: "deal notes", type: "string" })
    .option("json", { describe: "JSON output", type: "boolean" }),
})

const UnlinkVenueCommand = cmd({
  command: "unlink-venue <event-id>",
  aliases: ["remove-venue"],
  describe: "remove venue deal from an event",
  handler: async (args: Record<string, unknown>) => {
    const eventId = String(args.eventId)
    await requireAuth()
    if (!args.force) {
      const confirm = await prompts.confirm({ message: `Remove venue deal from event #${eventId}?` })
      if (!confirm || prompts.isCancel(confirm)) { prompts.outro(dim("Cancelled")); return }
    }
    const spinner = prompts.spinner()
    spinner.start("Removing venue deal…")
    try {
      const res = await irisFetch(`/api/v1/events/${eventId}/venue-deal`, { method: "DELETE" })
      const ok = await handleApiError(res, "Unlink venue")
      if (!ok) { spinner.stop("Failed", 1); return }
      spinner.stop(success(`Venue deal removed from event #${eventId}`))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
    }
  },
  builder: (y) => y
    .positional("event-id", { describe: "event ID", type: "string", demandOption: true })
    .option("force", { alias: "y", describe: "skip confirmation", type: "boolean" }),
})

// ============================================================================
// Event Leads — attach/manage leads on events
// ============================================================================

const ListLeadsCommand = cmd({
  command: "leads <event-id>",
  aliases: ["people", "roster"],
  describe: "list leads attached to an event",
  handler: async (args: Record<string, unknown>) => {
    const eventId = String(args.eventId)
    await requireAuth()
    const spinner = prompts.spinner()
    spinner.start("Loading event leads…")
    try {
      const res = await irisFetch(`/api/v1/events/${eventId}/leads`)
      const ok = await handleApiError(res, "List event leads")
      if (!ok) { spinner.stop("Failed", 1); return }
      const data = (await res.json()) as any
      const leads = data.data || []
      spinner.stop(success(`${leads.length} lead(s) on event #${eventId}`))
      if (args.json) { console.log(JSON.stringify(leads, null, 2)); return }
      if (leads.length === 0) { prompts.log.info(dim("No leads attached. Use: iris events add-lead <event-id> <lead-id> --role performer")); return }
      printDivider()
      for (const el of leads) {
        const lead = el.lead || {}
        const name = lead.nickname || lead.name || `Lead #${el.lead_id}`
        const role = el.role || "—"
        const status = el.status || "—"
        const statusIcon = status === "confirmed" ? "✅" : status === "attended" ? "🎯" : status === "invited" ? "📩" : "⏳"
        console.log(`  ${statusIcon} ${bold(name)}  ${dim(role)}  ${dim(status)}${lead.phone ? "  " + dim(lead.phone) : ""}`)
      }
      printDivider()
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
    }
  },
  builder: (y) => y
    .positional("event-id", { describe: "event ID", type: "string", demandOption: true })
    .option("json", { describe: "JSON output", type: "boolean" }),
})

const AddLeadCommand = cmd({
  command: "add-lead <event-id> <lead-id>",
  aliases: ["attach-lead"],
  describe: "attach a lead to an event with a role",
  handler: async (args: Record<string, unknown>) => {
    const eventId = String(args.eventId)
    const leadId = String(args.leadId)
    await requireAuth()
    const spinner = prompts.spinner()
    spinner.start("Attaching lead to event…")
    try {
      const body: Record<string, unknown> = {
        lead_id: Number(leadId),
        role: String(args.role || "prospect"),
        status: String(args.status || "invited"),
      }
      if (args.notes) body.notes = String(args.notes)

      const res = await irisFetch(`/api/v1/events/${eventId}/leads`, { method: "POST", body: JSON.stringify(body) })
      const ok = await handleApiError(res, "Add lead to event")
      if (!ok) { spinner.stop("Failed", 1); return }
      const data = (await res.json()) as any
      const el = data.data || data
      const lead = el.lead || {}
      spinner.stop(success(`${lead.nickname || lead.name || "Lead #" + leadId} added as ${el.role}`))
      if (args.json) { console.log(JSON.stringify(el, null, 2)); return }
      printDivider()
      printKV("Event", `#${eventId}`)
      printKV("Lead", `#${leadId} — ${lead.nickname || lead.name || "?"}`)
      printKV("Role", el.role)
      printKV("Status", el.status)
      printDivider()
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
    }
  },
  builder: (y) => y
    .positional("event-id", { describe: "event ID", type: "string", demandOption: true })
    .positional("lead-id", { describe: "lead ID", type: "string", demandOption: true })
    .option("role", { alias: "r", describe: "role: performer, organizer, judge, staff, vendor_contact, sponsor, speaker, vip, attendee, prospect", type: "string", default: "prospect" })
    .option("status", { alias: "s", describe: "status: invited, confirmed, attended, no_show, cancelled, waitlisted", type: "string", default: "invited" })
    .option("notes", { describe: "notes", type: "string" })
    .option("json", { describe: "JSON output", type: "boolean" }),
})

const UpdateLeadCommand = cmd({
  command: "update-lead <event-id> <lead-id>",
  describe: "update a lead's role or status on an event",
  handler: async (args: Record<string, unknown>) => {
    const eventId = String(args.eventId)
    const leadId = String(args.leadId)
    await requireAuth()
    const spinner = prompts.spinner()
    spinner.start("Updating…")
    try {
      const body: Record<string, unknown> = {}
      if (args.role) body.role = String(args.role)
      if (args.status) body.status = String(args.status)
      if (args.notes) body.notes = String(args.notes)

      const res = await irisFetch(`/api/v1/events/${eventId}/leads/${leadId}`, { method: "PUT", body: JSON.stringify(body) })
      const ok = await handleApiError(res, "Update event lead")
      if (!ok) { spinner.stop("Failed", 1); return }
      const data = (await res.json()) as any
      const el = data.data || data
      spinner.stop(success(`Lead #${leadId} updated — ${el.role} / ${el.status}`))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
    }
  },
  builder: (y) => y
    .positional("event-id", { describe: "event ID", type: "string", demandOption: true })
    .positional("lead-id", { describe: "lead ID", type: "string", demandOption: true })
    .option("role", { alias: "r", describe: "new role", type: "string" })
    .option("status", { alias: "s", describe: "new status", type: "string" })
    .option("notes", { describe: "notes", type: "string" }),
})

const RemoveLeadCommand = cmd({
  command: "remove-lead <event-id> <lead-id>",
  aliases: ["detach-lead"],
  describe: "remove a lead from an event",
  handler: async (args: Record<string, unknown>) => {
    const eventId = String(args.eventId)
    const leadId = String(args.leadId)
    await requireAuth()
    if (!args.force) {
      const confirm = await prompts.confirm({ message: `Remove lead #${leadId} from event #${eventId}?` })
      if (!confirm || prompts.isCancel(confirm)) { prompts.outro(dim("Cancelled")); return }
    }
    const spinner = prompts.spinner()
    spinner.start("Removing…")
    try {
      const res = await irisFetch(`/api/v1/events/${eventId}/leads/${leadId}`, { method: "DELETE" })
      const ok = await handleApiError(res, "Remove lead")
      if (!ok) { spinner.stop("Failed", 1); return }
      spinner.stop(success(`Lead #${leadId} removed from event #${eventId}`))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
    }
  },
  builder: (y) => y
    .positional("event-id", { describe: "event ID", type: "string", demandOption: true })
    .positional("lead-id", { describe: "lead ID", type: "string", demandOption: true })
    .option("force", { alias: "y", describe: "skip confirmation", type: "boolean" }),
})

// ============================================================================
// Preflight — live system checks before going live
// ============================================================================

const BRIDGE = process.env.BRIDGE_URL ?? "http://localhost:3200"

function bHeaders(): Record<string, string> {
  const key = process.env.BRIDGE_KEY || process.env.HIVE_API_KEY || ""
  const h: Record<string, string> = { Accept: "application/json" }
  if (key) h["X-Bridge-Key"] = key
  return h
}

interface PCheck { name: string; ok: boolean; detail?: string; hint?: string; category: string }

const PreflightCommand = cmd({
  command: "preflight <event-id>",
  aliases: ["pre", "go-check"],
  describe: "production readiness check — verify OBS, stream, tickets, bridge before going live",
  builder: (y) =>
    y.positional("event-id", { type: "number", demandOption: true })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Event #${args["event-id"]} — Preflight Check`)
    if (!(await requireAuth())) { prompts.outro("Done"); return }

    const sp = prompts.spinner()
    sp.start("Loading event…")

    // Fetch event data
    const eventRes = await irisFetch(`/api/v1/events/${args["event-id"]}`)
    if (!eventRes.ok) { await handleApiError(eventRes, "Get event"); sp.stop("Failed", 1); prompts.outro("Done"); return }
    const event = ((await eventRes.json()) as any)?.data ?? {}
    sp.stop(bold(event.title || `Event #${args["event-id"]}`))

    // Fetch sub-resources in parallel
    const [stagesRes, ticketsRes, vendorsRes] = await Promise.all([
      irisFetch(`/api/v1/events/${args["event-id"]}/stages`).catch(() => null),
      irisFetch(`/api/v1/events/${args["event-id"]}/tickets`).catch(() => null),
      irisFetch(`/api/v1/events/${args["event-id"]}/vendors`).catch(() => null),
    ])
    const stages: any[] = stagesRes?.ok ? ((await stagesRes.json()) as any)?.data ?? [] : []
    const tickets: any[] = ticketsRes?.ok ? ((await ticketsRes.json()) as any)?.data ?? [] : []
    const vendors: any[] = vendorsRes?.ok ? ((await vendorsRes.json()) as any)?.data ?? [] : []

    sp.start("Running checks…")

    const checks: PCheck[] = []

    // ── Production checks (OBS + Bridge) ──
    let obsConnected = false
    let obsScenes: string[] = []
    let obsStreamActive = false
    let obsRecordActive = false
    let obsInputs: any[] = []

    try {
      const health = await fetch(`${BRIDGE}/health`, { signal: AbortSignal.timeout(3000), headers: bHeaders() }).then(r => r.json())
      checks.push({ name: "IRIS Bridge", ok: true, detail: "running", category: "Production" })

      const obs = health?.messaging?.obs ?? health?.obs ?? {}
      obsConnected = obs?.status === "running"
      checks.push({
        name: "OBS connected",
        ok: obsConnected,
        detail: obsConnected ? obs.host : "not connected",
        hint: obsConnected ? undefined : "iris obs connect",
        category: "Production",
      })
    } catch {
      checks.push({ name: "IRIS Bridge", ok: false, hint: "iris hive start", category: "Production" })
      checks.push({ name: "OBS connected", ok: false, hint: "start bridge first", category: "Production" })
    }

    if (obsConnected) {
      try {
        const scenes = await fetch(`${BRIDGE}/api/obs/scenes`, { signal: AbortSignal.timeout(3000), headers: bHeaders() }).then(r => r.json())
        obsScenes = (scenes.scenes || []).map((s: any) => s.name)
        const matched = stages.filter(s => obsScenes.some(os => os.toLowerCase().includes(s.title?.toLowerCase() || "___")))
        checks.push({
          name: "Scenes match stages",
          ok: matched.length > 0 || stages.length === 0,
          detail: `${obsScenes.length} scenes, ${matched.length}/${stages.length} stages matched`,
          hint: matched.length === 0 && stages.length > 0 ? "iris obs scenes — map stages to OBS scenes" : undefined,
          category: "Production",
        })
        checks.push({ name: "Current scene", ok: true, detail: scenes.current || "?", category: "Production" })
      } catch {}

      try {
        const stream = await fetch(`${BRIDGE}/api/obs/stream/status`, { signal: AbortSignal.timeout(3000), headers: bHeaders() }).then(r => r.json())
        obsStreamActive = stream.active
        checks.push({
          name: "Streaming",
          ok: true,
          detail: stream.active ? `LIVE — ${stream.timecode}` : "not streaming (ready)",
          category: "Production",
        })
      } catch {}

      try {
        const rec = await fetch(`${BRIDGE}/api/obs/record/status`, { signal: AbortSignal.timeout(3000), headers: bHeaders() }).then(r => r.json())
        obsRecordActive = rec.active
        checks.push({
          name: "Recording",
          ok: true,
          detail: rec.active ? `recording — ${rec.timecode}` : "not recording (ready)",
          category: "Production",
        })
      } catch {}

      try {
        obsInputs = await fetch(`${BRIDGE}/api/obs/inputs`, { signal: AbortSignal.timeout(3000), headers: bHeaders() }).then(r => r.json())
        const cameras = obsInputs.filter((i: any) => i.kind?.includes("capture") && !i.kind?.includes("audio") && !i.kind?.includes("screen"))
        const mics = obsInputs.filter((i: any) => i.kind?.includes("audio"))
        checks.push({ name: "Cameras detected", ok: cameras.length > 0, detail: `${cameras.length} camera(s)`, category: "Production" })
        checks.push({ name: "Audio inputs", ok: mics.length > 0, detail: `${mics.length} mic(s)`, category: "Production" })
      } catch {}
    }

    // ── Tickets ──
    checks.push({
      name: "Tickets created",
      ok: tickets.length > 0,
      detail: tickets.length > 0 ? `${tickets.length} tier(s): ${tickets.map((t: any) => `$${t.price}`).join(" / ")}` : "none",
      hint: tickets.length === 0 ? `iris events ticket-create ${args["event-id"]}` : undefined,
      category: "Tickets",
    })

    const onSale = tickets.filter((t: any) => t.status === "active" && t.is_visible)
    checks.push({
      name: "Tickets on sale",
      ok: onSale.length > 0,
      detail: `${onSale.length}/${tickets.length} on sale`,
      hint: onSale.length === 0 ? "activate tickets in admin" : undefined,
      category: "Tickets",
    })

    // Check checkout URLs
    for (const t of tickets.slice(0, 3)) {
      if (t.checkout_url) {
        try {
          const r = await fetch(t.checkout_url, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(5000) })
          checks.push({ name: `Checkout: ${t.title}`, ok: r.status < 400, detail: `${r.status}`, category: "Tickets" })
        } catch {
          checks.push({ name: `Checkout: ${t.title}`, ok: false, detail: "unreachable", category: "Tickets" })
        }
      }
    }

    // ── Content ──
    const slug = event.slug || event.title?.toLowerCase().replace(/[^a-z0-9]+/g, "-")
    if (slug) {
      try {
        const pageRes = await fetch(`https://heyiris.io/p/${slug}`, { method: "HEAD", signal: AbortSignal.timeout(5000) })
        checks.push({ name: "Event page", ok: pageRes.status === 200, detail: pageRes.status === 200 ? `heyiris.io/p/${slug}` : `HTTP ${pageRes.status}`, hint: pageRes.status !== 200 ? `iris pages create --slug=${slug}` : undefined, category: "Content" })
      } catch {
        checks.push({ name: "Event page", ok: false, hint: `iris pages create --slug=${slug}`, category: "Content" })
      }
    }

    // ── Logistics ──
    checks.push({
      name: "Stages defined",
      ok: stages.length > 0,
      detail: `${stages.length} stage(s)`,
      hint: stages.length === 0 ? `iris events stage-create ${args["event-id"]}` : undefined,
      category: "Logistics",
    })
    checks.push({
      name: "Vendors confirmed",
      ok: vendors.length > 0,
      detail: `${vendors.length} vendor(s)`,
      hint: vendors.length === 0 ? `iris events vendor-create ${args["event-id"]}` : undefined,
      category: "Logistics",
    })
    checks.push({
      name: "Venue set",
      ok: !!(event.venue_name && event.city),
      detail: event.venue_name ? `${event.venue_name}, ${event.city}` : "missing",
      hint: !event.venue_name ? `iris events update ${args["event-id"]} --venue="..."` : undefined,
      category: "Logistics",
    })

    sp.stop("Done")

    // ── Render ──
    if (args.json) {
      console.log(JSON.stringify(checks, null, 2))
      prompts.outro("Done")
      return
    }

    const categories = [...new Set(checks.map(c => c.category))]
    const passing = checks.filter(c => c.ok).length
    const total = checks.length
    const pct = Math.round((passing / total) * 100)

    for (const cat of categories) {
      const catChecks = checks.filter(c => c.category === cat)
      const catPass = catChecks.filter(c => c.ok).length
      console.log()
      console.log(`  ${bold(cat)}  ${dim(`(${catPass}/${catChecks.length})`)}`)
      for (const c of catChecks) {
        const icon = c.ok ? success("✓") : `${UI.Style.TEXT_DANGER}✗${UI.Style.TEXT_NORMAL}`
        const detail = c.detail ? dim(` ${c.detail}`) : ""
        const hint = (!c.ok && c.hint) ? `  ${dim(`→ ${c.hint}`)}` : ""
        console.log(`  ${icon} ${c.name.padEnd(22)}${detail}${hint}`)
      }
    }

    printDivider()
    const color = pct >= 80 ? success : pct >= 50 ? (s: string) => `${UI.Style.TEXT_WARNING}${s}${UI.Style.TEXT_NORMAL}` : (s: string) => `${UI.Style.TEXT_DANGER}${s}${UI.Style.TEXT_NORMAL}`
    console.log(`  Readiness: ${color(`${pct}%`)} (${passing}/${total})`)

    if (pct < 100) process.exitCode = 1
    prompts.outro("Done")
  },
})

// ============================================================================
// Audit — data completeness + professional quality checks
// ============================================================================

const AuditCommand = cmd({
  command: "audit <event-id>",
  aliases: ["qa", "check"],
  describe: "data completeness audit — check all fields, stages, tickets, staff, content quality",
  builder: (y) =>
    y.positional("event-id", { type: "number", demandOption: true })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Event #${args["event-id"]} — Audit`)
    if (!(await requireAuth())) { prompts.outro("Done"); return }

    const sp = prompts.spinner()
    sp.start("Loading event…")

    const eventRes = await irisFetch(`/api/v1/events/${args["event-id"]}`)
    if (!eventRes.ok) { await handleApiError(eventRes, "Get event"); sp.stop("Failed", 1); prompts.outro("Done"); return }
    const event = ((await eventRes.json()) as any)?.data ?? {}

    const [stagesRes, ticketsRes, vendorsRes] = await Promise.all([
      irisFetch(`/api/v1/events/${args["event-id"]}/stages`).catch(() => null),
      irisFetch(`/api/v1/events/${args["event-id"]}/tickets`).catch(() => null),
      irisFetch(`/api/v1/events/${args["event-id"]}/vendors`).catch(() => null),
    ])
    const stages: any[] = stagesRes?.ok ? ((await stagesRes.json()) as any)?.data ?? [] : []
    const tickets: any[] = ticketsRes?.ok ? ((await ticketsRes.json()) as any)?.data ?? [] : []
    const vendors: any[] = vendorsRes?.ok ? ((await vendorsRes.json()) as any)?.data ?? [] : []

    sp.stop(bold(event.title || `Event #${args["event-id"]}`))

    const checks: PCheck[] = []
    const eid = args["event-id"]

    // ── Event Details ──
    checks.push({ name: "Title", ok: !!event.title, detail: event.title || "missing", hint: `iris events update ${eid} --title="..."`, category: "Details" })
    checks.push({ name: "Description", ok: !!(event.description && event.description.length > 20), detail: event.description ? `${event.description.length} chars` : "missing", hint: `iris events update ${eid} --description="..."`, category: "Details" })
    checks.push({ name: "Date set", ok: !!event.start_date, detail: event.start_date || "missing", hint: `iris events update ${eid} --date=YYYY-MM-DD`, category: "Details" })
    checks.push({ name: "Time set", ok: !!event.start_time, detail: event.start_time || "missing", category: "Details" })
    checks.push({ name: "Venue", ok: !!event.venue_name, detail: event.venue_name || "missing", hint: `iris events update ${eid} --venue="..."`, category: "Details" })
    checks.push({ name: "Address", ok: !!(event.city && event.state), detail: event.city ? `${event.city}, ${event.state}` : "missing", category: "Details" })
    checks.push({ name: "Photo/banner", ok: !!event.photo, detail: event.photo ? "set" : "missing", category: "Details" })

    // ── Stages & Lineup ──
    checks.push({ name: "Stages defined", ok: stages.length > 0, detail: `${stages.length} stage(s)`, hint: `iris events stage-create ${eid}`, category: "Stages & Lineup" })
    const stagesWithSetTimes = stages.filter((s: any) => (s.set_times?.length || s.event_stage_set_times?.length || 0) > 0)
    checks.push({ name: "Performers scheduled", ok: stagesWithSetTimes.length > 0 || stages.length === 0, detail: `${stagesWithSetTimes.length}/${stages.length} stages have lineup`, category: "Stages & Lineup" })

    // ── Tickets & Sales ──
    checks.push({ name: "Tickets created", ok: tickets.length > 0, detail: `${tickets.length} tier(s)`, hint: "create ticket tiers", category: "Tickets & Sales" })
    const priced = tickets.filter((t: any) => t.price && parseFloat(t.price) > 0)
    checks.push({ name: "All priced", ok: priced.length === tickets.length && tickets.length > 0, detail: priced.length > 0 ? priced.map((t: any) => `${t.title}: $${t.price}`).join(", ") : "none", category: "Tickets & Sales" })
    const active = tickets.filter((t: any) => t.status === "active")
    checks.push({ name: "Tickets active", ok: active.length > 0, detail: `${active.length}/${tickets.length} active`, category: "Tickets & Sales" })
    const withCheckout = tickets.filter((t: any) => t.checkout_url)
    checks.push({ name: "Checkout URLs", ok: withCheckout.length === tickets.length && tickets.length > 0, detail: `${withCheckout.length}/${tickets.length} have URLs`, hint: `iris events ticket-checkout ${eid}`, category: "Tickets & Sales" })
    const withQR = tickets.filter((t: any) => t.qr_url)
    checks.push({ name: "QR codes", ok: withQR.length > 0, detail: `${withQR.length}/${tickets.length} have QR`, hint: "QR auto-generated from checkout_url", category: "Tickets & Sales" })

    // ── Vendors & Partners ──
    checks.push({ name: "Vendors listed", ok: vendors.length > 0, detail: `${vendors.length} vendor(s)`, hint: `iris events vendor-create ${eid}`, category: "Vendors & Partners" })

    // ── Content & Marketing ──
    const slug = event.slug || event.title?.toLowerCase().replace(/[^a-z0-9]+/g, "-")
    if (slug) {
      try {
        const pageRes = await fetch(`https://heyiris.io/p/${slug}`, { method: "HEAD", signal: AbortSignal.timeout(5000) })
        checks.push({ name: "Landing page", ok: pageRes.status === 200, detail: pageRes.status === 200 ? `heyiris.io/p/${slug}` : "not found", hint: `iris pages create --slug=${slug}`, category: "Content" })
      } catch {
        checks.push({ name: "Landing page", ok: false, hint: `iris pages create --slug=${slug}`, category: "Content" })
      }
    }
    checks.push({ name: "Ticket URL on event", ok: !!event.purchase_ticket_url, detail: event.purchase_ticket_url ? "set" : "missing", category: "Content" })

    // ── Render ──
    if (args.json) {
      console.log(JSON.stringify(checks, null, 2))
      prompts.outro("Done")
      return
    }

    const categories = [...new Set(checks.map(c => c.category))]
    const passing = checks.filter(c => c.ok).length
    const total = checks.length
    const pct = Math.round((passing / total) * 100)

    for (const cat of categories) {
      const catChecks = checks.filter(c => c.category === cat)
      const catPass = catChecks.filter(c => c.ok).length
      console.log()
      console.log(`  ${bold(cat)}  ${dim(`(${catPass}/${catChecks.length})`)}`)
      for (const c of catChecks) {
        const icon = c.ok ? success("✓") : `${UI.Style.TEXT_DANGER}✗${UI.Style.TEXT_NORMAL}`
        const detail = c.detail ? dim(` ${c.detail}`) : ""
        const hint = (!c.ok && c.hint) ? `  ${dim(`→ ${c.hint}`)}` : ""
        console.log(`  ${icon} ${c.name.padEnd(22)}${detail}${hint}`)
      }
    }

    printDivider()
    const color = pct >= 80 ? success : pct >= 50 ? (s: string) => `${UI.Style.TEXT_WARNING}${s}${UI.Style.TEXT_NORMAL}` : (s: string) => `${UI.Style.TEXT_DANGER}${s}${UI.Style.TEXT_NORMAL}`
    console.log(`  Completeness: ${color(`${pct}%`)} (${passing}/${total})`)

    if (pct < 100) process.exitCode = 1
    prompts.outro("Done")
  },
})

// ============================================================================
// Root command
// ============================================================================

export const PlatformEventsCommand = cmd({
  command: "events",
  describe: "manage events, stages, vendors, tickets — pull, push, diff, CRUD, preflight, audit",
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
      // Set Times (artist lineup)
      .command(SetTimesListCommand)
      .command(AddSetTimeCommand)
      .command(RemoveSetTimeCommand)
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
      // Venue Deals
      .command(LinkVenueCommand)
      .command(UnlinkVenueCommand)
      // Event Leads
      .command(ListLeadsCommand)
      .command(AddLeadCommand)
      .command(UpdateLeadCommand)
      .command(RemoveLeadCommand)
      // Production QA
      .command(PreflightCommand)
      .command(AuditCommand)
      .command(ProductionCommand)
      .demandCommand(),
  async handler() {},
})
