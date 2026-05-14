import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, printDivider, printKV, dim, bold, success, highlight, resolveUserId, IRIS_API } from "./iris-api"
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
  if (v.public_url) console.log(`    ${dim(String(v.public_url))}`)
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
      .option("type", { describe: "venue type (studio/venue/restaurant/bar/store/coffee-shop)", type: "string" })
      .option("sort", { describe: "sort order: name, trending, rating, newest", type: "string" })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    if (!args.json) { UI.empty(); prompts.intro("◈  Venues") }

    const token = await requireAuth()
    if (!token) { if (!args.json) prompts.outro("Done"); return }

    const spinner = args.json ? null : prompts.spinner()
    if (spinner) spinner.start("Loading…")

    try {
      const params = new URLSearchParams({ limit: String(args.limit) })
      if (args.search) params.set("query", args.search)
      if (args.type) params.set("type", args.type)
      if (args.sort) params.set("sort", args.sort)

      const res = await irisFetch(`/api/v1/venues?${params}`)
      const ok = await handleApiError(res, "List venues")
      if (!ok) { if (spinner) spinner.stop("Failed", 1); if (!args.json) prompts.outro("Done"); return }

      const raw = (await res.json()) as any
      const items: any[] = raw?.data?.data ?? raw?.data ?? (Array.isArray(raw) ? raw : [])
      if (spinner) spinner.stop(`${items.length} venue(s)`)

      if (args.json) {
        console.log(JSON.stringify(items, null, 2))
        return
      }

      if (items.length === 0) { prompts.log.warn("No venues found"); prompts.outro("Done"); return }

      printDivider()
      for (const v of items) {
        printVenue(v)
        if (args.sort === "trending" && v.search_count) {
          console.log(`    ${highlight(`[${v.search_count} searches]`)}`)
        }
        console.log()
      }
      printDivider()

      prompts.outro(dim("iris venues get <id>  |  iris venues pull <id>"))
    } catch (err) {
      if (spinner) spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      if (!args.json) prompts.outro("Done")
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
      const res = await irisFetch(`/api/v1/venues/${args.id}`)
      const ok = await handleApiError(res, "Get venue")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const data = (await res.json()) as any
      const v = data?.data ?? data
      spinner.stop(String(v.name ?? `#${v.id}`))

      printDivider()
      printKV("ID", v.id)
      printKV("Name", v.name)
      printKV("Type", v.type)
      printKV("URL", v.public_url)
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
      printKV("Search Count", v.search_count)
      printKV("Last Searched", v.last_searched_at)
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

      const res = await irisFetch("/api/v1/venues", { method: "POST", body: JSON.stringify(payload) })
      const ok = await handleApiError(res, "Create venue")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const data = (await res.json()) as any
      const v = data?.data ?? data?.venue ?? data
      spinner.stop(`${success("✓")} Created: ${bold(String(v.name ?? v.id))}`)

      printDivider()
      printKV("ID", v.id)
      printKV("Name", v.name)
      printKV("Type", v.type)
      printKV("URL", v.public_url)
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
      const res = await irisFetch(`/api/v1/venues/${args.id}`, { method: "PUT", body: JSON.stringify(payload) })
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
      const res = await irisFetch(`/api/v1/venues/${args.id}`)
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

      const res = await irisFetch(`/api/v1/venues/${args.id}`, { method: "PUT", body: JSON.stringify(payload) })
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
      const res = await irisFetch(`/api/v1/venues/${args.id}`)
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
    yargs
      .positional("id", { describe: "venue ID", type: "number", demandOption: true })
      .option("force", { alias: "y", describe: "skip confirmation prompt", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Delete Venue #${args.id}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    if (!args.force) {
      const confirmed = await prompts.confirm({ message: `Delete venue #${args.id}?` })
      if (!confirmed || prompts.isCancel(confirmed)) { prompts.outro("Cancelled"); return }
    }

    const spinner = prompts.spinner()
    spinner.start("Deleting…")

    try {
      const res = await irisFetch(`/api/v1/venues/${args.id}`, { method: "DELETE" })
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
// Search — find venues via Serper Places API and optionally create them
// ============================================================================

const SearchCommand = cmd({
  command: "search <query>",
  describe: "search for venues by city/query via Google Places (Serper). Use --save to auto-create.",
  aliases: ["find", "scrape"],
  builder: (yargs) =>
    yargs
      .positional("query", { describe: "search query (e.g. 'concert venues in Dallas TX')", type: "string", demandOption: true })
      .option("limit", { describe: "max results", type: "number", default: 10 })
      .option("save", { describe: "auto-create venues from results", type: "boolean", default: false })
      .option("type", { describe: "venue type to assign on save", type: "string", default: "venue" })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    if (!args.json) { UI.empty(); prompts.intro("◈  Venue Search") }

    const token = await requireAuth()
    if (!token) { if (!args.json) prompts.outro("Done"); return }

    const spinner = args.json ? null : prompts.spinner()
    if (spinner) spinner.start(`Searching: ${args.query}…`)

    try {
      // Use searchPlaces via iris-api tools/execute (has Serper key configured)
      const userId = await resolveUserId()
      // Extract location hint (last 2-3 words likely city/state) — don't duplicate full query as location
      const queryWords = args.query.trim().split(/\s+/)
      const locationHint = queryWords.length > 3 ? queryWords.slice(-2).join(" ") : ""
      const res = await irisFetch("/api/v1/tools/execute", {
        method: "POST",
        body: JSON.stringify({
          tool: "searchPlaces",
          params: { query: args.query, location: locationHint },
          user_id: userId || 193,
        }),
      }, IRIS_API)
      const ok = await handleApiError(res, "Search venues")
      if (!ok) { if (spinner) spinner.stop("Failed", 1); if (!args.json) prompts.outro("Done"); return }

      const raw = (await res.json()) as any
      const toolResult = raw?.result ?? raw?.data ?? raw
      const places: any[] = (toolResult?.results ?? toolResult?.places ?? []).slice(0, args.limit)

      if (args.json && !args.save) { console.log(JSON.stringify(places, null, 2)); return }

      if (places.length === 0) {
        if (spinner) spinner.stop("No results")
        if (!args.json) prompts.log.warn("No venues found for that query")
        if (!args.json) prompts.outro(dim("Try a different search, e.g. 'music venues in Little Rock AR'"))
        return
      }

      if (spinner) spinner.stop(`${places.length} venue(s) found`)

      // Check each result against existing venues for dedup
      const dedupSpinner = args.json ? null : prompts.spinner()
      if (dedupSpinner) dedupSpinner.start("Checking for duplicates…")

      const enrichedPlaces: Array<any & { _existing?: any; _isNew: boolean }> = []
      for (const p of places) {
        const placeId = p.cid || p.place_id || null
        let existing: any = null

        if (placeId) {
          try {
            const checkRes = await irisFetch(`/api/v1/venues?query=${encodeURIComponent(p.title || "")}&limit=5`)
            if (checkRes.ok) {
              const checkRaw = (await checkRes.json()) as any
              const candidates: any[] = checkRaw?.data?.data ?? checkRaw?.data ?? []
              existing = candidates.find((c: any) => c.google_place_id === placeId) || null
            }
          } catch { /* ignore lookup failures */ }
        }

        enrichedPlaces.push({ ...p, _existing: existing, _isNew: !existing })
      }
      if (dedupSpinner) dedupSpinner.stop("Dedup complete")

      if (!args.save) {
        // Display-only mode with dedup badges
        printDivider()
        for (const p of enrichedPlaces) {
          const badge = p._existing
            ? highlight(`[EXISTS x${p._existing.search_count || 1}]`)
            : success("[NEW]")
          console.log(`  ${bold(p.title || "Unknown")}  ${badge}`)
          if (p.address) console.log(`    ${dim(p.address)}`)
          const meta = [p.rating ? `★ ${p.rating}` : null, p.phone, p.website].filter(Boolean)
          if (meta.length) console.log(`    ${dim(meta.join("  ·  "))}`)
          console.log()
        }
        printDivider()
        prompts.outro(dim("Add --save to auto-create these as venue records"))
        return
      }

      // Save mode — create or touch venues
      const saveSpinner = prompts.spinner()
      saveSpinner.start("Creating/updating venue records…")
      let created = 0
      let touched = 0

      for (const p of enrichedPlaces) {
        if (p._existing) {
          // Venue exists — increment touch via PUT
          try {
            await irisFetch(`/api/v1/venues/${p._existing.id}`, { method: "PUT", body: JSON.stringify({}) })
            touched++
          } catch { /* skip */ }
          continue
        }

        const payload: Record<string, unknown> = {
          name: p.title,
          type: args.type,
          address: p.address || null,
          phone: p.phone || null,
          website_url: p.website || null,
          rating: p.rating || null,
          google_place_id: p.cid || p.place_id || null,
          data_source: "searchPlaces",
        }
        // Try to parse city/state from address
        const addrParts = (p.address || "").split(",").map((s: string) => s.trim())
        if (addrParts.length >= 2) {
          payload.city = addrParts[addrParts.length - 2] || null
          const stateZip = addrParts[addrParts.length - 1] || ""
          const stateMatch = stateZip.match(/^([A-Z]{2})\b/)
          if (stateMatch) payload.state = stateMatch[1]
        }

        try {
          const createRes = await irisFetch("/api/v1/venues", { method: "POST", body: JSON.stringify(payload) })
          if (createRes.ok) created++
        } catch { /* skip individual failures */ }
      }

      const summary = [created > 0 ? `${created} created` : null, touched > 0 ? `${touched} touched` : null].filter(Boolean).join(", ")
      saveSpinner.stop(`${success("✓")} ${summary || "No changes"}`)

      if (args.json) {
        console.log(JSON.stringify({ created, touched, total: places.length, places }, null, 2))
      }

      prompts.outro(dim("iris venues list --sort trending"))
    } catch (err) {
      if (spinner) spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      if (!args.json) prompts.outro("Done")
    }
  },
})

// ============================================================================
// Enrich — backfill venue data from Serper Places + Images
// ============================================================================

const EnrichCommand = cmd({
  command: "enrich <id>",
  describe: "enrich a venue with Google Places data (rating, phone, address, photos)",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "venue ID (or 'all' to enrich all venues missing data)", type: "string", demandOption: true })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    if (!args.json) { UI.empty(); prompts.intro(`◈  Enrich Venue${args.id === "all" ? "s" : " #" + args.id}`) }

    const token = await requireAuth()
    if (!token) { if (!args.json) prompts.outro("Done"); return }

    const spinner = args.json ? null : prompts.spinner()

    // Determine which venues to enrich
    let venueIds: number[] = []
    if (args.id === "all") {
      if (spinner) spinner.start("Finding venues that need enrichment…")
      const listRes = await irisFetch("/api/v1/venues?limit=100")
      if (!listRes.ok) { if (spinner) spinner.stop("Failed", 1); if (!args.json) prompts.outro("Done"); return }
      const listRaw = (await listRes.json()) as any
      const allVenues: any[] = listRaw?.data?.data ?? listRaw?.data ?? (Array.isArray(listRaw) ? listRaw : [])
      venueIds = allVenues
        .filter((v: any) => !v.google_place_id || !v.photo || !v.description)
        .map((v: any) => Number(v.id))
      if (spinner) spinner.stop(`${venueIds.length} venue(s) need enrichment`)
      if (venueIds.length === 0) { if (!args.json) prompts.outro("All venues already enriched"); return }
    } else {
      venueIds = [Number(args.id)]
    }

    const results: any[] = []
    for (const vid of venueIds) {
      if (spinner) spinner.start(`Enriching venue #${vid}…`)

      // Fetch current venue data
      const getRes = await irisFetch(`/api/v1/venues/${vid}`)
      if (!getRes.ok) { if (spinner) spinner.stop(`#${vid}: not found`, 1); continue }
      const venueData = (await getRes.json()) as any
      const venue = venueData?.data ?? venueData?.venue ?? venueData

      // Search Serper for this venue
      const city = venue.city || ""
      const state = venue.state || ""
      const locationStr = [city, state].filter(Boolean).join(", ")
      const searchQuery = `${venue.name} ${locationStr}`

      const enrichUserId = await resolveUserId()
      const searchRes = await irisFetch("/api/v1/tools/execute", {
        method: "POST",
        body: JSON.stringify({
          tool: "searchPlaces",
          params: { query: searchQuery, location: locationStr },
          user_id: enrichUserId || 193,
        }),
      }, IRIS_API)

      if (!searchRes.ok) { if (spinner) spinner.stop(`#${vid}: search failed`, 1); continue }
      const searchRaw = (await searchRes.json()) as any
      const searchResult = searchRaw?.result ?? searchRaw?.data ?? searchRaw
      const places: any[] = searchResult?.results ?? searchResult?.places ?? []
      const match = places[0]

      if (!match) {
        if (spinner) spinner.stop(`#${vid}: no match found`)
        results.push({ id: vid, name: venue.name, status: "no_match" })
        continue
      }

      // Build update payload
      const update: Record<string, unknown> = {}
      if (match.phone && !venue.phone) update.phone = match.phone
      if (match.website && !venue.website_url) update.website_url = match.website
      if (match.rating) update.rating = match.rating
      if (match.address && !venue.address) update.address = match.address

      if (Object.keys(update).length === 0) {
        if (spinner) spinner.stop(`#${vid}: already up to date`)
        results.push({ id: vid, name: venue.name, status: "up_to_date" })
        continue
      }

      // Apply update
      const updateRes = await irisFetch(`/api/v1/venues/${vid}`, { method: "PUT", body: JSON.stringify(update) })
      if (updateRes.ok) {
        if (spinner) spinner.stop(`${success("✓")} #${vid} ${venue.name}: enriched (${Object.keys(update).join(", ")})`)
        results.push({ id: vid, name: venue.name, status: "enriched", fields: Object.keys(update) })
      } else {
        if (spinner) spinner.stop(`#${vid}: update failed`, 1)
        results.push({ id: vid, name: venue.name, status: "update_failed" })
      }
    }

    if (args.json) { console.log(JSON.stringify(results, null, 2)); return }
    prompts.outro(dim("iris venues list"))
  },
})

// ============================================================================
// Discover — full venue outreach pipeline (Eventbrite + DDG + AI tour-seed)
// Wraps the existing tests/e2e/venue-outreach.spec.ts Playwright pipeline
// ============================================================================

function findProjectRoot(): string {
  let dir = process.cwd()
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, "tests", "e2e", "venue-outreach.spec.ts"))) return dir
    if (existsSync(join(dir, "fl-docker-dev"))) return dir
    const parent = join(dir, "..")
    if (parent === dir) break
    dir = parent
  }
  return process.cwd()
}

const DiscoverCommand = cmd({
  command: "discover <cities>",
  describe: "discover, enrich & outreach venues via full pipeline (Eventbrite + DDG + AI tour-seed)",
  builder: (yargs) =>
    yargs
      .positional("cities", { describe: "comma-separated city slugs (e.g. 'houston,dallas,atlanta')", type: "string", demandOption: true })
      .option("artist", { describe: "artist name for tour-seeded discovery + email context", type: "string" })
      .option("genre", { describe: "music genre (default: hip-hop)", type: "string", default: "hip-hop" })
      .option("seed-artists", { describe: "comma-separated similar artists to seed", type: "string" })
      .option("limit", { describe: "venues to process per city", type: "number", default: 15 })
      .option("board", { describe: "board/bloq ID for lead creation", type: "number", default: 292 })
      .option("enrich", { describe: "also enrich venues (scrape emails + socials)", type: "boolean", default: false })
      .option("email", { describe: "also generate + send booking inquiry emails", type: "boolean", default: false })
      .option("dry", { describe: "preview mode — no saves or sends", type: "boolean", default: false })
      .option("tour-seed-max", { describe: "max AI-recommended cities to add", type: "number", default: 8 }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Venue Discovery Pipeline`)

    const root = findProjectRoot()
    const specPath = join(root, "tests", "e2e", "venue-outreach.spec.ts")

    if (!existsSync(specPath)) {
      prompts.log.error(`Pipeline not found at: ${specPath}`)
      prompts.log.warn("Run from the freelabel project root directory")
      prompts.outro("Done")
      return
    }

    // Build env vars for the Playwright pipeline
    const env: Record<string, string> = {
      CITIES: args.cities,
      DISCOVER: "1",
      LIMIT: String(args.limit),
      BOARD_ID: String(args.board),
    }
    if (args.enrich) env.ENRICH = "1"
    if (args.email) env.EMAIL = "1"
    if (args.dry) env.DRY_RUN = "1"
    if (args.artist) env.ARTIST_NAME = args.artist
    if (args.genre) env.GENRE = args.genre
    if (args["seed-artists"]) env.SEED_ARTISTS = args["seed-artists"]
    if (args["tour-seed-max"]) env.TOUR_SEED_MAX = String(args["tour-seed-max"])

    // Display run config
    const cityDisplay = args.cities.split(",").map((c: string) => c.trim().replace(/-/g, " ")).join(", ")
    const phases = ["Discover", args.enrich ? "Enrich" : null, args.email ? "Email" : null].filter(Boolean).join(" → ")

    printDivider()
    printKV("Cities", cityDisplay)
    printKV("Phases", phases)
    printKV("Limit", `${args.limit}/city`)
    printKV("Board", args.board)
    if (args.artist) printKV("Artist", args.artist)
    if (args["seed-artists"]) printKV("Seed Artists", args["seed-artists"])
    if (args.dry) printKV("Mode", "DRY RUN (no saves)")
    printDivider()
    console.log()

    const spinner = prompts.spinner()
    spinner.start("Running venue outreach pipeline…")

    try {
      const { execSync } = require("child_process")
      const timeout = Math.max(600000, args.limit * (args.enrich ? 3 : 1) * 120000)
      const cmd = `npx playwright test tests/e2e/venue-outreach.spec.ts --headed --timeout ${timeout}`

      spinner.stop("Pipeline started — output below:")
      console.log()

      execSync(cmd, {
        stdio: "inherit",
        cwd: root,
        env: { ...process.env, ...env },
      })

      console.log()
      prompts.log.success("Pipeline completed")
      prompts.outro(dim("iris venues list --sort trending"))
    } catch (err: any) {
      console.log()
      if (err.status) {
        prompts.log.error(`Pipeline exited with code ${err.status}`)
      } else {
        prompts.log.error(err instanceof Error ? err.message : String(err))
      }
      prompts.outro(dim("Check output above for details"))
    }
  },
})

// ============================================================================
// Root command
// ============================================================================

export const PlatformVenuesCommand = cmd({
  command: "venues",
  aliases: ["studios"],
  describe: "manage venues & studios — pull, push, diff, CRUD, search, enrich",
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
      .command(SearchCommand)
      .command(EnrichCommand)
      .command(DiscoverCommand)
      .demandCommand(),
  async handler() {},
})
