import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, printDivider, printKV, dim, bold, success, highlight, promptOrFail, MissingFlagError, isNonInteractive, PLATFORM_URLS, BRIDGE_URL, getBridgeToken } from "./iris-api"
import { executeIntegrationCall } from "./platform-run"
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "fs"
import { join, basename, isAbsolute } from "path"

// ============================================================================
// Sync helpers
// ============================================================================

const SYNC_DIR = ".iris/leads"

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

function leadFilename(l: Record<string, unknown>): string {
  const name = String(l.name ?? l.first_name ?? "lead")
  return `${l.id}-${slugify(name)}.json`
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

function statusColor(status: string): string {
  const colors: Record<string, string> = {
    Won: UI.Style.TEXT_SUCCESS,
    Lost: UI.Style.TEXT_DANGER,
    Active: UI.Style.TEXT_HIGHLIGHT,
    New: UI.Style.TEXT_INFO,
    Pending: UI.Style.TEXT_WARNING,
  }
  const c = colors[status] ?? UI.Style.TEXT_DIM
  return `${c}${status}${UI.Style.TEXT_NORMAL}`
}

function printLead(l: Record<string, unknown>): void {
  const id = dim(`#${l.id}`)
  const name = bold(String(l.name ?? l.first_name ?? `Lead #${l.id}`))
  const company = l.company ? `  ${dim(String(l.company))}` : ""
  const status = l.status ? `  ${statusColor(String(l.status))}` : ""
  const email = l.email ? `  ${dim(String(l.email))}` : ""
  // Show bloq associations (project/CRM the lead belongs to)
  const bloqIds = Array.isArray(l.bloq_ids) ? l.bloq_ids : []
  const bloqNames = Array.isArray(l.bloq_names) ? l.bloq_names : []
  const bloqLabel = bloqIds.length > 0
    ? `  ${dim(bloqIds.map((id: unknown, i: number) => `bloq:${id}${bloqNames[i] ? ` (${bloqNames[i]})` : ""}`).join(", "))}`
    : ""
  console.log(`  ${id}  ${name}${company}${status}${bloqLabel}`)
  if (l.email) console.log(`    ${dim("✉")} ${email}`)
}

// ============================================================================
// Calendar helpers (mirrors platform-calendar.ts pattern)
// ============================================================================

async function calExec(action: string, params: Record<string, unknown>): Promise<any> {
  return executeIntegrationCall("google-calendar", action, params)
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso)
    if (isNaN(d.getTime())) return iso
    return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true })
  } catch { return iso }
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso)
    if (isNaN(d.getTime())) return iso
    return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })
  } catch { return iso }
}

/**
 * Search Google Calendar for events matching a lead's name/email.
 * Returns events split into past and upcoming.
 */
async function fetchLeadCalendarEvents(
  lead: { name?: string; email?: string; id: number },
  opts: { days?: number; futureDays?: number } = {},
): Promise<{ past: any[]; upcoming: any[] }> {
  const pastDays = opts.days ?? 30
  const futureDays = opts.futureDays ?? 30
  const now = new Date()
  const timeMin = new Date(now.getTime() - pastDays * 86400000).toISOString()
  const timeMax = new Date(now.getTime() + futureDays * 86400000).toISOString()

  const result = await calExec("get_events", { time_min: timeMin, time_max: timeMax, max_results: 2500 })
  // calExec returns { success, events: [...] } — handle various shapes
  let events: any[] = []
  if (Array.isArray(result)) events = result
  else if (result?.events) events = result.events
  else if (result?.data?.events) events = result.data.events
  else if (result?.data && Array.isArray(result.data)) events = result.data

  // Client-side filter: match lead name or email in summary/description/attendees
  const nameL = (lead.name ?? "").toLowerCase()
  const emailL = (lead.email ?? "").toLowerCase()
  const filtered = events.filter((ev: any) => {
    const haystack = [ev.summary, ev.description, JSON.stringify(ev.attendees ?? [])]
      .join(" ").toLowerCase()
    if (emailL && haystack.includes(emailL)) return true
    if (nameL && nameL.length > 2 && haystack.includes(nameL)) return true
    return false
  })

  const past: any[] = []
  const upcoming: any[] = []
  for (const ev of filtered) {
    const start = new Date(ev.start || ev.start_time || "")
    if (start < now) past.push(ev)
    else upcoming.push(ev)
  }
  past.sort((a, b) => new Date(b.start || "").getTime() - new Date(a.start || "").getTime())
  upcoming.sort((a, b) => new Date(a.start || "").getTime() - new Date(b.start || "").getTime())
  return { past, upcoming }
}

/**
 * Resolve a lead ID from a numeric ID, name, or email.
 * Reusable across pulse, meet, meetings.
 */
async function resolveLeadId(idOrQuery: string): Promise<{ leadId: number; lead: any } | null> {
  let leadId = Number(idOrQuery)

  if (isNaN(leadId)) {
    const spinner = prompts.spinner()
    spinner.start(`Looking up "${idOrQuery}"…`)
    try {
      const params = new URLSearchParams({ search: String(idOrQuery), per_page: "5" })
      const searchRes = await irisFetch(`/api/v1/leads?${params}`)
      if (!searchRes.ok) { spinner.stop("Search failed", 1); return null }
      const searchData = (await searchRes.json()) as { data?: any[] }
      const matches: any[] = searchData?.data ?? []
      if (matches.length === 0) { spinner.stop("No leads found", 1); return null }
      if (matches.length === 1) {
        leadId = matches[0].id
        spinner.stop(`Found: ${matches[0].name ?? matches[0].email ?? `#${leadId}`}`)
      } else if (isNonInteractive()) {
        spinner.stop(`${matches.length} matches — ambiguous`)
        prompts.log.warn("Multiple leads match. Specify by ID or use a more precise query:")
        for (const m of matches) {
          prompts.log.info(`  #${m.id}  ${m.name ?? m.email ?? "Unknown"}${m.company ? `  ${m.company}` : ""}  ${m.status ?? ""}`)
        }
        process.exitCode = 1
        return null
      } else {
        spinner.stop(`${matches.length} matches`)
        const choice = await prompts.select({
          message: "Which lead?",
          options: matches.map((l: any) => ({
            value: l.id,
            label: `#${l.id}  ${l.name ?? l.email ?? "Unknown"}${l.company ? `  ${l.company}` : ""}  ${l.status ?? ""}`,
          })),
        })
        if (prompts.isCancel(choice)) return null
        leadId = choice as number
      }
    } catch (err) {
      spinner.stop("Error", 1)
      return null
    }
  }

  // Fetch full lead — Bug #57345: show error when lead not found
  const res = await irisFetch(`/api/v1/leads/${leadId}`)
  if (!res.ok) {
    prompts.log.error(`Lead not found: #${leadId}`)
    process.exitCode = 1
    return null
  }
  const data = (await res.json()) as { data?: any }
  const lead = data?.data ?? data
  return { leadId, lead }
}

// ============================================================================
// Subcommands
// ============================================================================

const LeadsListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list leads",
  builder: (yargs) =>
    yargs
      .option("status", { describe: "filter by status", type: "string" })
      .option("search", { alias: "s", describe: "search query", type: "string" })
      .option("limit", { describe: "max results", type: "number", default: 20 })
      .option("bloq-id", { describe: "filter by bloq (CRM)", type: "number" })
      .option("all", { describe: "include Prospected leads (hidden by default)", type: "boolean", default: false })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  IRIS Leads")

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Loading leads…")

    try {
      // Fetch more than requested so we can filter + sort client-side
      const fetchLimit = args.all || args.status || args.search ? args.limit : Math.max(args.limit * 5, 100)
      const params = new URLSearchParams({ per_page: String(fetchLimit) })
      if (args.status) params.set("status", args.status)
      if (args.search) params.set("search", args.search)
      if (args["bloq-id"]) params.set("bloq_id", String(args["bloq-id"]))

      const res = await irisFetch(`/api/v1/leads?${params}`)
      const ok = await handleApiError(res, "List leads")
      if (!ok) { spinner.stop("Failed", 1); process.exitCode = 1; prompts.outro("Done"); return }

      const data = (await res.json()) as { data?: any[]; total?: number; meta?: { total?: number } }
      let leads: any[] = data?.data ?? []

      // Default: hide Prospected leads (mass-scraped venue/SOM leads)
      // Use --all or --status to see everything
      if (!args.all && !args.status && !args.search) {
        leads = leads.filter((l: any) => {
          const s = (l.status ?? "").toLowerCase()
          return s !== "prospected"
        })
      }

      // Sort by status priority: active clients first
      const statusPriority: Record<string, number> = {
        won: 0,
        "in negotiation": 1,
        interested: 2,
        contacted: 3,
        qualified: 4,
        new: 5,
        prospected: 6,
        lost: 7,
        unresponsive: 8,
      }
      leads.sort((a: any, b: any) => {
        const pa = statusPriority[(a.status ?? "").toLowerCase()] ?? 5
        const pb = statusPriority[(b.status ?? "").toLowerCase()] ?? 5
        return pa - pb
      })

      // Trim to requested limit
      leads = leads.slice(0, args.limit)
      const total = data?.meta?.total ?? leads.length
      spinner.stop(`${leads.length} lead(s)${!args.all && !args.status ? dim(` (${total} total — use --all to see Prospected)`) : ""}`)

      if (args.json) {
        console.log(JSON.stringify(leads, null, 2))
        return
      }

      if (leads.length === 0) {
        prompts.log.warn("No leads found")
        prompts.outro(`Create one: ${dim("iris leads create")}`)
        return
      }

      printDivider()
      for (const l of leads) {
        printLead(l)
        console.log()
      }
      printDivider()

      prompts.outro(
        `${dim("iris leads get <id>")}  ·  ${dim("iris leads search <query>")}`,
      )
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const LeadsGetCommand = cmd({
  command: "get <id>",
  describe: "show lead details (accepts numeric ID or name/email to search)",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "lead ID, name, or email", type: "string", demandOption: true })
      .option("notes", { describe: "show full note content inline", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    let leadId = Number(args.id)

    // If not a numeric ID, search by name/email and resolve to an ID
    if (isNaN(leadId)) {
      prompts.intro(`◈  Looking up "${args.id}"`)
      const spinner = prompts.spinner()
      spinner.start("Searching…")
      try {
        const params = new URLSearchParams({ search: String(args.id), per_page: "5" })
        const searchRes = await irisFetch(`/api/v1/leads?${params}`)
        if (!searchRes.ok) {
          spinner.stop("Search failed", 1)
          process.exitCode = 1
          prompts.outro("Done")
          return
        }
        const searchData = (await searchRes.json()) as { data?: any[] }
        const matches: any[] = searchData?.data ?? []
        if (matches.length === 0) {
          spinner.stop("No leads found", 1)
          process.exitCode = 1
          prompts.log.warn(`No leads matching "${args.id}". Use a numeric ID from: ${dim("iris leads search")}`)
          prompts.outro("Done")
          return
        }
        if (matches.length === 1) {
          leadId = matches[0].id
          spinner.stop(`Found: ${matches[0].name ?? matches[0].email ?? `#${leadId}`}`)
        } else if (isNonInteractive()) {
          // Non-TTY / parallel context — auto-pick first match to avoid hanging (#55719)
          leadId = matches[0].id
          spinner.stop(`${matches.length} matches — auto-selected: ${matches[0].name ?? matches[0].email ?? `#${leadId}`}`)
        } else {
          spinner.stop(`${matches.length} matches`)
          const choice = await prompts.select({
            message: "Which lead?",
            options: matches.map((l: any) => ({
              value: l.id,
              label: `#${l.id}  ${l.name ?? l.email ?? "Unknown"}${l.company ? `  ${l.company}` : ""}  ${l.status ?? ""}`,
            })),
          })
          if (prompts.isCancel(choice)) { prompts.cancel("Cancelled"); return }
          leadId = choice as number
        }
      } catch (err) {
        spinner.stop("Error", 1)
        process.exitCode = 1
        prompts.log.error(err instanceof Error ? err.message : String(err))
        prompts.outro("Done")
        return
      }
    }

    prompts.intro(`◈  Lead #${leadId}`)

    const spinner = prompts.spinner()
    spinner.start("Loading…")

    try {
      const res = await irisFetch(`/api/v1/leads/${leadId}`)
      const ok = await handleApiError(res, "Get lead")
      if (!ok) { spinner.stop("Failed", 1); process.exitCode = 1; prompts.outro("Done"); return }

      const data = (await res.json()) as { data?: any }
      const l = data?.data ?? data
      if (!l || !l.id) { spinner.stop("Lead not found", 1); process.exitCode = 1; prompts.outro("Done"); return }
      spinner.stop(String(l.name ?? l.first_name ?? `Lead #${l.id}`))

      printDivider()
      printKV("ID", l.id)
      printKV("Name", l.name ?? `${l.first_name ?? ""} ${l.last_name ?? ""}`.trim())
      printKV("Email", l.email)
      printKV("Phone", l.phone)
      printKV("Company", l.company)
      printKV("Website", l.website)
      printKV("Status", l.status)
      printKV("Stage", l.stage)
      printKV("Source", l.source)
      printKV("Bid", l.price_bid ? `$${l.price_bid}` : undefined)
      printKV("Created", l.created_at)

      // #57686: Completeness score in leads get (same logic as pulse)
      {
        const gFields = [
          { name: "email", has: !!l.email },
          { name: "phone", has: !!l.phone },
          { name: "company", has: !!l.company },
          { name: "stage", has: !!l.stage },
          { name: "source", has: !!(l.source ?? l.keywords?.source) },
          { name: "bloq", has: Array.isArray(l.bloq_ids) ? l.bloq_ids.length > 0 : !!l.bloq_id },
          { name: "notes", has: Array.isArray(l.notes) && l.notes.length > 0 },
        ]
        const gScore = Math.round((gFields.filter((f) => f.has).length / gFields.length) * 100)
        const gMissing = gFields.filter((f) => !f.has).map((f) => f.name)
        const gColor = gScore >= 80 ? success(`${gScore}%`) : gScore >= 50 ? `${UI.Style.TEXT_WARNING}${gScore}%${UI.Style.TEXT_NORMAL}` : `${UI.Style.TEXT_DANGER}${gScore}%${UI.Style.TEXT_NORMAL}`
        if (gMissing.length > 0) {
          printKV("Completeness", `${gColor}  ${dim(`missing: ${gMissing.join(", ")}`)}`)
        } else {
          printKV("Completeness", gColor)
        }
      }

      // Tags
      const tags: any[] = Array.isArray(l.tags) ? l.tags : []
      if (tags.length > 0) {
        console.log(`  ${dim("Tags:")}  ${tags.map((t: any) => highlight(t.name)).join("  ")}`)
      }

      // Outreach summary
      if ((l.outreach_steps_count ?? 0) > 0) {
        printKV(
          "Outreach",
          `${l.completed_outreach_steps_count ?? 0} / ${l.outreach_steps_count} steps completed`,
        )
      }

      // Notes — truncated by default, full with --notes flag (#57652)
      const notes: any[] = Array.isArray(l.notes) ? l.notes : []
      if (notes.length > 0) {
        const showFull = args.notes as boolean
        console.log()
        console.log(`  ${dim("Notes")}  ${dim(`(${notes.length})`)}`)
        for (const note of notes) {
          const rawContent =
            typeof note === "object"
              ? (note.content ?? JSON.stringify(note)).replace(/\\n/g, "\n")
              : String(note)
          const display = showFull ? rawContent : (rawContent.length > 200 ? rawContent.slice(0, 200) + "..." : rawContent)
          const date = typeof note === "object" ? (note.created_at ?? "") : ""
          if (date) console.log(`    ${dim(date)}`)
          const lines = display.split("\n")
          for (const line of lines) {
            if (line.trim()) console.log(`    ${line.trim()}`)
          }
          console.log()
        }
        if (!showFull && notes.some((n: any) => {
          const c = typeof n === "object" ? (n.content ?? JSON.stringify(n)) : String(n)
          return c.length > 200
        })) {
          console.log(`    ${dim(`Use ${highlight(`--notes`)} for full content`)}`)
        }
      }

      printDivider()

      prompts.outro(
        `${dim("iris leads note " + leadId + ' "follow up scheduled"')}  Add a note`,
      )
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const LeadsSearchCommand = cmd({
  command: "search <query>",
  describe: "search leads",
  builder: (yargs) =>
    yargs
      .positional("query", { describe: "search query", type: "string", demandOption: true })
      .option("limit", { describe: "max results", type: "number", default: 10 }),
  async handler(args) {
    UI.empty()

    // Bug #4: validate non-empty query
    if (!args.query || !args.query.trim()) {
      prompts.log.error("Search query cannot be empty")
      prompts.log.info(dim(`iris leads search "haroon"`))
      process.exitCode = 1
      return
    }

    prompts.intro(`◈  Lead Search: ${args.query}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Searching…")

    try {
      const params = new URLSearchParams({ search: args.query, per_page: String(args.limit) })
      const res = await irisFetch(`/api/v1/leads?${params}`)
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({})) as Record<string, unknown>
        const errMsg = String(errBody?.message || errBody?.error || `HTTP ${res.status}`)
        spinner.stop("Failed", 1)
        process.exitCode = 1
        prompts.log.error(`Search leads failed: ${errMsg}`)
        prompts.outro("Done")
        return
      }

      const data = (await res.json()) as { data?: any[]; meta?: { total?: number } }
      let leads: any[] = data?.data ?? []

      // Fallback: if multi-word query returned 0, try searching by last name only
      if (leads.length === 0 && args.query.includes(" ")) {
        const words = args.query.trim().split(/\s+/)
        for (const word of words) {
          if (word.length < 3) continue
          const fallbackParams = new URLSearchParams({ search: word, per_page: String(args.limit) })
          const fbRes = await irisFetch(`/api/v1/leads?${fallbackParams}`)
          if (fbRes.ok) {
            const fbData = (await fbRes.json()) as { data?: any[] }
            const fbLeads = fbData?.data ?? []
            if (fbLeads.length > 0) {
              // Filter to leads that match ALL words (case-insensitive)
              const allWords = words.map((w) => w.toLowerCase())
              const filtered = fbLeads.filter((l: any) => {
                const haystack = `${l.name ?? ""} ${l.first_name ?? ""} ${l.last_name ?? ""} ${l.email ?? ""} ${l.company ?? ""}`.toLowerCase()
                return allWords.every((w) => haystack.includes(w))
              })
              if (filtered.length > 0) { leads = filtered; break }
              // If no multi-word match, show partial matches
              if (leads.length === 0) leads = fbLeads
            }
          }
        }
      }

      const total = data?.meta?.total ?? leads.length
      spinner.stop(`${total} result(s)`)

      if (leads.length === 0) {
        prompts.log.warn(`No leads matching "${args.query}"`)
        prompts.outro("Done")
        return
      }

      printDivider()
      for (const l of leads) {
        printLead(l)
        console.log()
      }
      printDivider()

      prompts.outro(dim("iris leads get <id>"))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const LeadsCreateCommand = cmd({
  command: "create",
  describe: "create a new lead",
  builder: (yargs) =>
    yargs
      .option("name", { describe: "lead name", type: "string" })
      .option("email", { describe: "primary email address", type: "string" })
      .option("emails", { describe: "additional emails (comma-separated)", type: "string" })
      .option("phone", { describe: "phone number", type: "string" })
      .option("company", { describe: "company name", type: "string" })
      .option("source", { describe: "lead source (e.g. referral, inbound, outreach)", type: "string" })
      .option("status", { describe: "initial status", type: "string", choices: ["Prospected", "Contacted", "Interested", "Converted", "Archived"] })
      .option("notes", { describe: "initial note to attach", type: "string" })
      .option("bloq-id", { describe: "CRM bloq ID (default: auto-detect)", type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Create Lead")

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    // Bug #6/#57642: Require non-empty name. Trim whitespace before checking.
    let name = typeof args.name === "string" ? args.name.trim() : args.name
    if (!name) {
      if (isNonInteractive()) {
        prompts.log.error("Missing required --name flag.")
        prompts.log.info(dim(`iris leads create --name "Jane Doe" --email jane@co.com`))
        process.exitCode = 1
        prompts.outro("Done")
        return
      }
      const result = await prompts.text({
        message: "Full name",
        validate: (x) => (x && x.length > 0 ? undefined : "Required"),
      })
      if (prompts.isCancel(result)) { prompts.outro("Cancelled"); return }
      name = result as string
    }

    // Bug #6: In non-interactive mode, skip email prompt entirely — use flag or nothing.
    let email = args.email
    if (email === undefined && !isNonInteractive()) {
      const result = await prompts.text({
        message: "Email address (optional, press Enter to skip)",
        placeholder: "e.g. jane@company.com",
      })
      if (prompts.isCancel(result)) {
        email = undefined
      } else {
        email = (result as string) || undefined
      }
    }

    let bloqId = args["bloq-id"] ?? 38

    const spinner = prompts.spinner()
    spinner.start("Creating lead…")

    try {
      const payload: Record<string, unknown> = {
        name,
        bloqId, // API expects camelCase
      }
      if (email) payload.email = email
      if (args.phone) payload.phone = args.phone
      if (args.company) payload.company = args.company
      if (args.source) payload.source = args.source
      if (args.status) payload.status = args.status
      // Store additional emails in contact_info.emails array
      if (args.emails) {
        const extras = String(args.emails).split(",").map((e: string) => e.trim()).filter(Boolean)
        if (extras.length > 0) {
          payload.contact_info = { emails: extras }
        }
      }

      const res = await irisFetch("/api/v1/leads", {
        method: "POST",
        body: JSON.stringify(payload),
      })
      const ok = await handleApiError(res, "Create lead")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const data = (await res.json()) as { data?: any }
      const l = data?.data ?? data
      spinner.stop(`${success("✓")} Lead created: ${bold(String(l.name ?? l.id))} (#${l.id})`)

      printDivider()
      printKV("ID", l.id)
      printKV("Name", l.name)
      printKV("Email", l.email ?? dim("none"))
      if (args.emails) printKV("Alt Emails", String(args.emails))
      printKV("Company", l.company ?? dim("none"))
      printKV("Source", l.source ?? args.source ?? dim("none"))
      printKV("Status", l.status)
      printDivider()

      // Auto-attach note if provided
      if (args.notes) {
        try {
          await irisFetch(`/api/v1/leads/${l.id}/notes`, {
            method: "POST",
            body: JSON.stringify({ message: args.notes }),
          })
          prompts.log.info(dim("Note attached"))
        } catch { /* non-fatal */ }
      }

      prompts.outro(dim(`iris leads get ${l.id}`))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const LeadsNotesCommand = cmd({
  command: "notes <id>",
  aliases: ["view-notes"],
  describe: "list all notes for a lead",
  builder: (yargs) =>
    yargs.positional("id", { describe: "lead ID or name", type: "string", demandOption: true }),
  async handler(args) {
    UI.empty()

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    let leadId = Number(args.id)
    if (isNaN(leadId)) {
      // Resolve name → ID
      const params = new URLSearchParams({ search: String(args.id), per_page: "5" })
      const searchRes = await irisFetch(`/api/v1/leads?${params}`)
      if (!searchRes.ok) { prompts.log.error("Search failed"); prompts.outro("Done"); return }
      const searchData = (await searchRes.json()) as { data?: any[] }
      const matches: any[] = searchData?.data ?? []
      if (matches.length === 0) { prompts.log.warn(`No leads matching "${args.id}"`); prompts.outro("Done"); return }
      if (matches.length === 1) { leadId = matches[0].id }
      else if (isNonInteractive()) { leadId = matches[0].id }
      else {
        const choice = await prompts.select({
          message: "Which lead?",
          options: matches.map((l: any) => ({
            value: l.id,
            label: `#${l.id}  ${l.name ?? l.email ?? "Unknown"}`,
          })),
        })
        if (prompts.isCancel(choice)) { prompts.cancel("Cancelled"); return }
        leadId = choice as number
      }
    }

    prompts.intro(`◈  Notes — Lead #${leadId}`)
    const spinner = prompts.spinner()
    spinner.start("Loading…")

    try {
      const res = await irisFetch(`/api/v1/leads/${leadId}`)
      const ok = await handleApiError(res, "Get lead")
      if (!ok) { spinner.stop("Failed", 1); process.exitCode = 1; prompts.outro("Done"); return }

      const data = (await res.json()) as { data?: any }
      const lead = data?.data ?? data
      const name = lead.name ?? lead.first_name ?? `Lead #${leadId}`
      const notes: any[] = Array.isArray(lead.notes) ? lead.notes : []

      spinner.stop(bold(name))

      if (notes.length === 0) {
        prompts.log.info("No notes yet.")
        prompts.outro(dim(`iris leads note ${leadId} "your note here"`))
        return
      }

      printDivider()
      for (const note of notes) {
        const content = typeof note === "object"
          ? (note.content ?? JSON.stringify(note)).replace(/\\n/g, "\n")
          : String(note)
        const date = typeof note === "object" ? (note.created_at ?? "") : ""
        if (date) console.log(`  ${dim(date)}`)
        const lines = content.split("\n")
        for (const line of lines) {
          if (line.trim()) console.log(`  ${line.trim()}`)
        }
        console.log()
      }
      printDivider()
      prompts.outro(`${success("✓")} ${notes.length} note${notes.length === 1 ? "" : "s"}  ·  ${dim(`iris leads note ${leadId} "…"`)}`)
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const LeadsNoteCommand = cmd({
  command: "note <id> [message]",
  describe: "add a note to a lead (inline text or --file)",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "lead ID, name, or email", type: "string", demandOption: true })
      .positional("message", { describe: "note content (optional if --file used)", type: "string" })
      .option("file", { alias: "f", describe: "read note content from a file (.md, .txt)", type: "string" })
      .option("type", { describe: "note type tag", type: "string", choices: ["note", "meeting_intel", "call_log", "email_log", "system"] }),
  async handler(args) {
    UI.empty()

    // ── Validate: need a message or --file ── (Bug #2)
    if (!args.message && !args.file) {
      prompts.log.error("Provide a message or --file <path>")
      prompts.log.info(dim(`iris leads note <id> "your note"`) + "  or  " + dim(`iris leads note <id> --file notes.md`))
      process.exitCode = 1
      return
    }

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    // ── Resolve lead ID from name/email if not numeric ──
    const resolved = await resolveLeadId(String(args.id))
    if (!resolved) { process.exitCode = 1; prompts.outro("Done"); return }
    const { leadId } = resolved

    prompts.intro(`◈  Note — Lead #${leadId}`)

    // ── Resolve content from --file or positional message ──
    let content = String(args.message ?? "")
    if (args.file) {
      const filePath = isAbsolute(String(args.file)) ? String(args.file) : join(process.cwd(), String(args.file))
      if (!existsSync(filePath)) {
        prompts.log.error(`File not found: ${filePath}`)
        process.exitCode = 1  // Bug #5: exit 1 not 0
        prompts.outro("Done"); return
      }
      content = readFileSync(filePath, "utf-8")
      if (!content.trim()) {
        prompts.log.error("File is empty")
        process.exitCode = 1
        prompts.outro("Done"); return
      }
      prompts.log.info(dim(`Read ${content.length.toLocaleString()} chars from ${basename(filePath)}`))
    }

    const spinner = prompts.spinner()
    spinner.start("Adding note…")

    try {
      const body: Record<string, unknown> = { message: content }
      if (args.type) {
        body.type = args.type
        body.activity_type = args.type
      }

      const res = await irisFetch(`/api/v1/leads/${leadId}/notes`, {
        method: "POST",
        body: JSON.stringify(body),
      })
      const ok = await handleApiError(res, "Add note")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      spinner.stop(`${success("✓")} Note added`)
      prompts.outro(dim(`iris leads get ${leadId}`))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const LeadsUpdateCommand = cmd({
  command: "update <id>",
  describe: "update a lead",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "lead ID, name, or email", type: "string", demandOption: true })
      .option("name", { describe: "new name", type: "string" })
      .option("email", { describe: "new email", type: "string" })
      .option("phone", { describe: "new phone", type: "string" })
      .option("company", { describe: "new company", type: "string" })
      .option("status", { describe: "new status", type: "string" })
      .option("bloq-id", { alias: "bloq", describe: "CRM bloq ID to associate", type: "number" })
      .option("website", { describe: "website URL", type: "string" })
      .option("source", { describe: "lead source", type: "string" })
      .option("stage", { describe: "pipeline stage", type: "string" })
      .option("bid", { describe: "price bid amount", type: "number" })
      .option("mrr", { describe: "monthly recurring revenue amount", type: "number" })
      .option("revenue-type", { describe: "revenue type", type: "string", choices: ["retainer", "performance", "one_time"] as const })
      .option("payment-method", { describe: "how they pay", type: "string", choices: ["stripe", "mercury", "offline", "mixed"] as const })
      .option("chat-id", { describe: "link an iMessage chat ID (e.g. chat713220476491386040)", type: "string" }),
  async handler(args) {
    UI.empty()

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    // ── Resolve lead ID from name/email if not numeric ── (Bug #3)
    const resolved = await resolveLeadId(String(args.id))
    if (!resolved) { process.exitCode = 1; prompts.outro("Done"); return }
    const { leadId } = resolved

    prompts.intro(`◈  Update Lead #${leadId}`)

    const payload: Record<string, unknown> = {}
    if (args.name) payload.name = args.name
    if (args.email) payload.email = args.email
    if (args.phone) payload.phone = args.phone
    if (args.company) payload.company = args.company
    if (args.status) payload.status = args.status
    if (args["bloq-id"]) payload.bloq_id = args["bloq-id"]
    if (args.website) payload.website = args.website
    if (args.source) payload.source = args.source
    if (args.stage) payload.stage = args.stage
    if (args.bid) payload.price_bid = args.bid
    if (args.mrr) payload.mrr_amount = args.mrr
    if (args["revenue-type"]) payload.revenue_type = args["revenue-type"]
    if (args["payment-method"]) payload.payment_method = args["payment-method"]
    // #57668: --chat-id appends to contact_info.chat_ids (fetches existing to avoid overwrite)
    if (args["chat-id"]) {
      try {
        const lr = await irisFetch(`/api/v1/leads/${leadId}`)
        const ci = lr.ok ? (((await lr.json()) as any)?.data?.contact_info ?? {}) : {}
        const ids: string[] = Array.isArray(ci.chat_ids) ? ci.chat_ids : []
        if (!ids.includes(String(args["chat-id"]))) ids.push(String(args["chat-id"]))
        payload.contact_info = { chat_ids: ids }
      } catch {
        payload.contact_info = { chat_ids: [String(args["chat-id"])] }
      }
    }

    if (Object.keys(payload).length === 0) {
      prompts.log.warn("Nothing to update. Use --name, --email, --status, --bloq-id, etc.")
      prompts.outro("Done")
      return
    }

    const spinner = prompts.spinner()
    spinner.start("Updating…")

    try {
      const res = await irisFetch(`/api/v1/leads/${leadId}`, {
        method: "PUT",
        body: JSON.stringify(payload),
      })
      const ok = await handleApiError(res, "Update lead")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const data = (await res.json()) as { data?: any }
      const l = data?.data ?? data
      spinner.stop(`${success("✓")} Updated: ${bold(String(l.name ?? l.id))}`)

      printDivider()
      printKV("ID", l.id)
      printKV("Name", l.name)
      printKV("Status", l.status)
      printDivider()

      prompts.outro(dim(`iris leads get ${leadId}`))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const LeadsPullCommand = cmd({
  command: "pull <id>",
  describe: "download lead JSON to local file",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "lead ID", type: "number", demandOption: true })
      .option("output", { alias: "o", describe: "output file path", type: "string" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Pull Lead #${args.id}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Fetching lead…")

    try {
      const res = await irisFetch(`/api/v1/leads/${args.id}`)
      const ok = await handleApiError(res, "Pull lead")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const data = (await res.json()) as { data?: any }
      const lead = data?.data ?? data

      const dir = resolveSyncDir()
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

      const filename = args.output ?? leadFilename(lead)
      const filepath = filename.startsWith("/") ? filename : join(dir, filename)

      writeFileSync(filepath, JSON.stringify(lead, null, 2))
      spinner.stop(success("Pulled"))

      printDivider()
      printKV("Name", lead.name)
      printKV("ID", lead.id)
      printKV("Email", lead.email)
      printKV("Status", lead.status)
      printKV("Company", lead.company)
      printKV("Saved to", filepath)
      printDivider()

      prompts.outro(dim(`iris leads push ${args.id}  |  iris leads diff ${args.id}`))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const LeadsPushCommand = cmd({
  command: "push <id>",
  describe: "upload local lead JSON to API",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "lead ID", type: "number", demandOption: true })
      .option("file", { alias: "f", describe: "local JSON file path", type: "string" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Push Lead #${args.id}`)

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
        prompts.log.error(`Local file not found. Run: ${highlight(`iris leads pull ${args.id}`)}`)
        prompts.outro("Done")
        return
      }

      spinner.start(`Pushing ${basename(filepath)}…`)

      const lead = JSON.parse(readFileSync(filepath, "utf-8"))
      const payload: Record<string, unknown> = {
        name: lead.name,
        email: lead.email,
        phone: lead.phone,
        company: lead.company,
        status: lead.status,
        source: lead.source,
        lead_type: lead.lead_type,
        keywords: lead.keywords,
        contact_info: lead.contact_info,
        address: lead.address,
        city: lead.city,
        state: lead.state,
        zipcode: lead.zipcode,
        country: lead.country,
        price_bid: lead.price_bid,
        price_min: lead.price_min,
        price_max: lead.price_max,
      }
      for (const k of Object.keys(payload)) {
        if (payload[k] === undefined) delete payload[k]
      }
      if (lead.bloq_id) payload.bloq_id = lead.bloq_id

      const res = await irisFetch(`/api/v1/leads/${args.id}`, {
        method: "PUT",
        body: JSON.stringify(payload),
      })
      const ok = await handleApiError(res, "Push lead")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const data = (await res.json()) as { data?: any }
      const result = data?.data ?? data
      spinner.stop(success("Pushed"))

      printDivider()
      printKV("Name", result.name)
      printKV("ID", args.id)
      printKV("Status", result.status)
      printKV("From", filepath)
      printDivider()

      prompts.outro(dim(`iris leads diff ${args.id}`))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const LeadsDiffCommand = cmd({
  command: "diff <id>",
  describe: "compare local lead JSON vs live API",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "lead ID", type: "number", demandOption: true })
      .option("file", { alias: "f", describe: "local JSON file path", type: "string" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Diff Lead #${args.id}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Comparing…")

    try {
      const res = await irisFetch(`/api/v1/leads/${args.id}`)
      const ok = await handleApiError(res, "Fetch lead")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const data = (await res.json()) as { data?: any }
      const live = data?.data ?? data

      const dir = resolveSyncDir()
      let filepath = args.file
      if (!filepath) filepath = findLocalFile(dir, args.id)

      if (!filepath || !existsSync(filepath)) {
        spinner.stop("Failed", 1)
        prompts.log.error(`Local file not found. Run: ${highlight(`iris leads pull ${args.id}`)}`)
        prompts.outro("Done")
        return
      }

      const local = JSON.parse(readFileSync(filepath, "utf-8"))

      const fields = ["name", "email", "phone", "company", "status", "source", "lead_type", "address", "city", "state", "zipcode", "country", "price_bid", "website", "stage"]
      const changes: { field: string; live: unknown; local: unknown }[] = []

      for (const f of fields) {
        const liveVal = JSON.stringify(live[f] ?? null)
        const localVal = JSON.stringify(local[f] ?? null)
        if (liveVal !== localVal) {
          changes.push({ field: f, live: live[f], local: local[f] })
        }
      }

      // Compare nested arrays
      for (const f of ["keywords", "contact_info"]) {
        if (JSON.stringify(live[f] ?? null) !== JSON.stringify(local[f] ?? null)) {
          changes.push({ field: f, live: "(changed)", local: "(changed)" })
        }
      }

      // Count notes diff
      const liveNotes = Array.isArray(live.notes) ? live.notes.length : 0
      const localNotes = Array.isArray(local.notes) ? local.notes.length : 0
      if (liveNotes !== localNotes) {
        changes.push({ field: "notes", live: `${liveNotes} note(s)`, local: `${localNotes} note(s)` })
      }

      spinner.stop(changes.length === 0 ? success("In sync") : `${changes.length} difference(s)`)

      printDivider()
      printKV("Lead", live.name ?? `#${args.id}`)
      printKV("Status (live)", live.status)
      printKV("Status (local)", local.status)
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

      if (changes.length > 0) {
        prompts.outro(dim(`iris leads push ${args.id}  — to push local changes live`))
      } else {
        prompts.outro("Done")
      }
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const LeadsDeleteCommand = cmd({
  command: "delete <id>",
  describe: "delete a lead",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "lead ID", type: "number", demandOption: true })
      .option("yes", { describe: "skip confirmation prompt", type: "boolean", alias: "y", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Delete Lead #${args.id}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    let confirmed: boolean | symbol = args.yes
    if (!confirmed) {
      if (isNonInteractive()) {
        prompts.log.error("Refusing to delete without --yes in non-interactive mode.")
        prompts.outro("Done")
        process.exitCode = 2
        return
      }
      confirmed = await prompts.confirm({ message: `Delete lead #${args.id}? This cannot be undone.` })
    }
    if (!confirmed || prompts.isCancel(confirmed)) { prompts.outro("Cancelled"); return }

    const spinner = prompts.spinner()
    spinner.start("Deleting…")

    try {
      const res = await irisFetch(`/api/v1/leads/${args.id}`, { method: "DELETE" })
      const ok = await handleApiError(res, "Delete lead")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      spinner.stop(`${success("✓")} Lead #${args.id} deleted`)
      prompts.outro(dim("iris leads list"))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

// ============================================================================
// Merge — combine duplicate leads into one
// ============================================================================

const LeadsMergeCommand = cmd({
  command: "merge <keep> <remove..>",
  describe: "merge duplicate leads (keep one, delete the rest)",
  builder: (yargs) =>
    yargs
      .positional("keep", { describe: "lead ID to keep (primary)", type: "number", demandOption: true })
      .positional("remove", { describe: "lead ID(s) to merge into the primary and delete", type: "number", array: true, demandOption: true })
      .option("yes", { describe: "skip confirmation prompt", type: "boolean", alias: "y", default: false }),
  async handler(args) {
    UI.empty()
    const removeIds: number[] = (args.remove as number[]) ?? []
    prompts.intro(`◈  Merge Leads → keep #${args.keep}, remove ${removeIds.map((id) => `#${id}`).join(", ")}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Loading leads…")

    try {
      // Fetch all leads to show what will be merged
      const allIds = [args.keep, ...removeIds]
      const leads: Record<number, any> = {}
      for (const id of allIds) {
        const res = await irisFetch(`/api/v1/leads/${id}`)
        if (!res.ok) {
          spinner.stop(`Failed to load lead #${id}`, 1)
          prompts.outro("Done")
          return
        }
        const data = (await res.json()) as { data?: any }
        leads[id] = data?.data ?? data
      }
      spinner.stop("Loaded")

      const primary = leads[args.keep]
      printDivider()
      console.log(`  ${bold("Keep")} → #${args.keep}  ${primary.name ?? "Unknown"}  ${dim(primary.email ?? "")}  ${primary.status ?? ""}`)
      for (const rid of removeIds) {
        const r = leads[rid]
        console.log(`  ${dim("Remove")} → #${rid}  ${r.name ?? "Unknown"}  ${dim(r.email ?? "")}  ${r.status ?? ""}`)
      }
      printDivider()

      // Show what notes/data will be merged
      const notesToMerge: string[] = []
      for (const rid of removeIds) {
        const r = leads[rid]
        const notes: any[] = Array.isArray(r.notes) ? r.notes : []
        for (const n of notes) {
          notesToMerge.push(typeof n === "object" ? (n.content ?? JSON.stringify(n)) : String(n))
        }
      }
      if (notesToMerge.length > 0) {
        console.log(`  ${dim(`${notesToMerge.length} note(s) will be copied to #${args.keep}`)}`)
      }

      // Confirm
      let confirmed: boolean | symbol = args.yes
      if (!confirmed) {
        if (isNonInteractive()) {
          prompts.log.error("Refusing to merge without --yes in non-interactive mode.")
          prompts.outro("Done")
          process.exitCode = 2
          return
        }
        confirmed = await prompts.confirm({ message: `Merge ${removeIds.length} lead(s) into #${args.keep} and delete them?` })
      }
      if (!confirmed || prompts.isCancel(confirmed)) { prompts.outro("Cancelled"); return }

      const mergeSpinner = prompts.spinner()
      mergeSpinner.start("Merging…")

      // Copy notes from removed leads to the primary
      for (const rid of removeIds) {
        const r = leads[rid]
        const notes: any[] = Array.isArray(r.notes) ? r.notes : []
        for (const n of notes) {
          const content = typeof n === "object" ? (n.content ?? JSON.stringify(n)) : String(n)
          await irisFetch(`/api/v1/leads/${args.keep}/notes`, {
            method: "POST",
            body: JSON.stringify({ content: `[Merged from #${rid}] ${content}` }),
          })
        }

        // If primary is missing fields, fill from the removed lead
        const updates: Record<string, unknown> = {}
        for (const field of ["company", "phone", "website", "city", "state", "country"]) {
          if (!primary[field] && r[field]) updates[field] = r[field]
        }
        if (Object.keys(updates).length > 0) {
          await irisFetch(`/api/v1/leads/${args.keep}`, {
            method: "PATCH",
            body: JSON.stringify(updates),
          })
        }

        // Delete the removed lead
        await irisFetch(`/api/v1/leads/${rid}`, { method: "DELETE" })
      }

      mergeSpinner.stop(`${success("✓")} Merged ${removeIds.length} lead(s) into #${args.keep}`)
      prompts.outro(dim(`iris leads get ${args.keep}`))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

// ============================================================================
// Integration Health Checks (#57677) — pre-flight validation for pulse + doctor
// ============================================================================

const BRIDGE_BASE = BRIDGE_URL

/** Helper to add auth token to bridge fetch calls */
function bridgeHeaders(): Record<string, string> {
  const token = getBridgeToken()
  const h: Record<string, string> = { Accept: "application/json" }
  if (token) h["X-Bridge-Key"] = token
  return h
}

interface ChannelHealth {
  name: string
  ok: boolean
  status: "verified" | "expired" | "error" | "not_connected" | "no_permission"
  error?: string
  hint?: string
}

/**
 * Run health checks on all channels pulse uses.
 * Each check is non-blocking — one failure doesn't stop others.
 * Exported so iris doctor can reuse it.
 */
export async function runChannelHealthChecks(): Promise<ChannelHealth[]> {
  const results: ChannelHealth[] = []

  const checks = await Promise.allSettled([
    // Gmail — verify via fl-api integration endpoint
    (async (): Promise<ChannelHealth> => {
      try {
        const res = await irisFetch("/api/v1/leads/0/gmail-threads")
        // 401/403 = token expired; 404 = lead not found but integration works; 200 = ok
        if (res.status === 401 || res.status === 403) {
          return { name: "Gmail", ok: false, status: "expired", error: "token expired", hint: "run: iris connect gmail" }
        }
        // Any response (even 404 for lead 0) means the integration is reachable
        return { name: "Gmail", ok: true, status: "verified" }
      } catch {
        return { name: "Gmail", ok: false, status: "not_connected", hint: "run: iris connect gmail" }
      }
    })(),

    // Google Calendar — verify via bridge
    (async (): Promise<ChannelHealth> => {
      try {
        const res = await fetch(`${BRIDGE_BASE}/api/calendar/events?days=1&limit=1`, { signal: AbortSignal.timeout(3000), headers: bridgeHeaders() })
        if (res.ok) return { name: "Google Calendar", ok: true, status: "verified" }
        return { name: "Google Calendar", ok: false, status: "error", error: `HTTP ${res.status}`, hint: "check bridge: iris hive doctor" }
      } catch {
        return { name: "Google Calendar", ok: false, status: "not_connected", hint: "bridge not running — iris hive start" }
      }
    })(),

    // iMessage — verify macOS Messages.app SQLite access
    (async (): Promise<ChannelHealth> => {
      try {
        const { isAvailable } = await import("../lib/imessage")
        if (isAvailable()) {
          return { name: "iMessage", ok: true, status: "verified" }
        }
        return { name: "iMessage", ok: false, status: "no_permission", error: "Full Disk Access required", hint: "System Settings → Privacy → Full Disk Access → enable terminal" }
      } catch {
        return { name: "iMessage", ok: false, status: "error", error: "check failed", hint: "check macOS Messages.app" }
      }
    })(),

    // Apple Mail — verify via bridge
    (async (): Promise<ChannelHealth> => {
      try {
        const res = await fetch(`${BRIDGE_BASE}/api/mail/search?from=test&days=1&limit=1`, { signal: AbortSignal.timeout(3000), headers: bridgeHeaders() })
        if (res.ok) return { name: "Apple Mail", ok: true, status: "verified" }
        return { name: "Apple Mail", ok: false, status: "error", error: `HTTP ${res.status}`, hint: "check bridge: iris hive doctor" }
      } catch {
        return { name: "Apple Mail", ok: false, status: "not_connected", hint: "bridge not running — iris hive start" }
      }
    })(),

    // Bridge health (covers iMessage bridge + Apple Mail)
    (async (): Promise<ChannelHealth> => {
      try {
        const res = await fetch(`${BRIDGE_BASE}/health`, { signal: AbortSignal.timeout(2000) })
        if (res.ok) return { name: "IRIS Bridge", ok: true, status: "verified" }
        return { name: "IRIS Bridge", ok: false, status: "error", error: `HTTP ${res.status}` }
      } catch {
        return { name: "IRIS Bridge", ok: false, status: "not_connected", hint: "run: iris hive start" }
      }
    })(),
  ])

  for (const result of checks) {
    if (result.status === "fulfilled") results.push(result.value)
  }

  return results
}

// ============================================================================
// Pulse — cross-channel activity check for a lead
// ============================================================================

// ============================================================================
// LeadsSyncCommsCommand — silent batch comms ingest (used by Hive comms_sync task)
// ============================================================================
//
// Fetches recent comms (Gmail / iMessage / Apple Mail) for one or more leads
// and POSTs them to /api/v1/atlas/comms/ingest. NO TUI. NO score display.
// Designed to be invoked by the bridge daemon when it picks up a comms_sync
// Hive task — silent so the daily Pulse score speaks for itself.
//
//   iris leads sync-comms 12065 12066 12067
//
// Output: a single JSON line per lead on stdout: {lead_id, ingested, errors}
// Exit code: 0 if at least one lead succeeded; non-zero only on hard failure
// ============================================================================
const LeadsSyncCommsCommand = cmd({
  command: "sync-comms <ids...>",
  describe: "silently fetch + ingest recent comms for one or more leads (used by Hive comms_sync)",
  builder: (yargs) =>
    yargs
      .positional("ids", { describe: "lead IDs to sync", type: "string", array: true, demandOption: true })
      .option("days", { describe: "look-back window in days", type: "number", default: 30 })
      .option("limit", { describe: "max messages per channel per lead", type: "number", default: 50 }),
  async handler(args) {
    const token = await requireAuth()
    if (!token) { process.exitCode = 1; return }

    const days = args.days as number
    const msgLimit = args.limit as number
    const ids = (args.ids as string[]).map((s) => parseInt(s, 10)).filter((n) => !isNaN(n))

    let totalIngested = 0
    let totalErrors = 0

    for (const leadId of ids) {
      try {
        // Load lead (need email + phone to drive the channel scan)
        const leadRes = await irisFetch(`/api/v1/leads/${leadId}`)
        if (!leadRes.ok) {
          console.log(JSON.stringify({ lead_id: leadId, ingested: 0, error: `lead-fetch HTTP ${leadRes.status}` }))
          totalErrors++
          continue
        }
        const leadBody = (await leadRes.json()) as any
        const lead = leadBody?.data ?? leadBody
        const email = (lead?.email ?? "") as string
        const phone = (lead?.phone ?? "") as string
        const name = (lead?.name ?? lead?.first_name ?? "") as string

        if (!email && !phone && !name) {
          console.log(JSON.stringify({ lead_id: leadId, ingested: 0, error: "no email/phone/name" }))
          continue
        }

        type ChannelResult = { name: string; messages: any[]; error?: string }
        const channels: ChannelResult[] = []

        // ── Gmail (server-side endpoint — no bridge needed) ──
        if (email) {
          try {
            const r = await irisFetch(`/api/v1/leads/${leadId}/gmail-threads`)
            if (r.ok) {
              const d = (await r.json()) as any
              const threads = d?.data ?? d?.threads ?? []
              const msgs = Array.isArray(threads)
                ? threads.slice(0, msgLimit).map((t: any) => ({
                    subject: t.subject ?? t.snippet ?? "(no subject)",
                    from: t.from ?? "",
                    date: t.last_message_at ?? t.first_message_at ?? "",
                    thread_id: t.gmail_thread_id ?? "",
                  }))
                : []
              channels.push({ name: "Gmail", messages: msgs })
            }
          } catch { /* non-fatal */ }
        }

        // ── iMessage (via local bridge) ──
        const handle = phone || email
        if (handle) {
          try {
            const r = await fetch(
              `${BRIDGE_BASE}/api/imessage/search?handle=${encodeURIComponent(handle)}&days=${days}&limit=${msgLimit}`,
              { headers: bridgeHeaders(), signal: AbortSignal.timeout(10000) },
            )
            if (r.ok) {
              const d = (await r.json()) as any
              channels.push({ name: "iMessage", messages: d?.messages ?? [] })
            }
          } catch { /* bridge offline → silent skip */ }
        }

        // ── Apple Mail (via local bridge) ──
        if (email) {
          try {
            const r = await fetch(
              `${BRIDGE_BASE}/api/mail/search?from=${encodeURIComponent(email)}&days=${days}&limit=${msgLimit}`,
              { headers: bridgeHeaders(), signal: AbortSignal.timeout(10000) },
            )
            if (r.ok) {
              const d = (await r.json()) as any
              channels.push({ name: "Apple Mail", messages: d?.messages ?? [] })
            }
          } catch { /* non-fatal */ }
        }

        // ── Map channel results → atlas/comms/ingest payload (same shape as pulse) ──
        const channelMap: Record<string, string> = { Gmail: "gmail", iMessage: "imessage", "Apple Mail": "apple_mail" }
        let leadIngested = 0
        for (const ch of channels) {
          const channelKey = channelMap[ch.name]
          if (!channelKey || ch.messages.length === 0) continue

          const items = ch.messages.map((msg: any) => {
            if (ch.name === "iMessage") {
              return {
                direction: msg.from_me ? "outbound" : "inbound",
                from_identifier: msg.from_me ? "me" : (phone || email),
                body: msg.text ?? "",
                sent_at: msg.ts ?? msg.date ?? null,
                metadata: { source: "comms_sync_task" },
              }
            } else if (ch.name === "Gmail") {
              return {
                direction: (msg.from ?? "").toLowerCase().includes(email.toLowerCase()) ? "inbound" : "outbound",
                from_identifier: msg.from ?? "",
                subject: msg.subject ?? "",
                body: msg.snippet ?? msg.subject ?? "",
                sent_at: msg.date ?? null,
                metadata: { gmail_thread_id: msg.thread_id, source: "comms_sync_task" },
              }
            } else {
              return {
                direction: "inbound",
                from_identifier: email,
                subject: msg.subject ?? "",
                body: msg.body ?? msg.subject ?? "",
                sent_at: msg.date ?? msg.ts ?? null,
                metadata: { source: "comms_sync_task" },
              }
            }
          })

          if (items.length > 0) {
            try {
              const ingestRes = await irisFetch("/api/v1/atlas/comms/ingest", {
                method: "POST",
                body: JSON.stringify({ lead_id: leadId, channel: channelKey, items }),
              })
              if (ingestRes.ok) leadIngested += items.length
            } catch { /* non-fatal */ }
          }
        }

        totalIngested += leadIngested
        console.log(JSON.stringify({ lead_id: leadId, ingested: leadIngested, channels: channels.length }))
      } catch (e: any) {
        totalErrors++
        console.log(JSON.stringify({ lead_id: leadId, ingested: 0, error: e?.message ?? String(e) }))
      }
    }

    if (totalIngested === 0 && totalErrors === ids.length) process.exitCode = 1
  },
})

const LeadsPulseCommand = cmd({
  command: "pulse <id>",
  aliases: ["inbox", "incoming"],
  describe: "check recent activity across all channels (CRM, Gmail, iMessage, Apple Mail, Meetings)",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "lead ID, name, or email", type: "string", demandOption: true })
      .option("days", { describe: "look-back window in days", type: "number", default: 30 })
      .option("limit", { describe: "max messages per channel", type: "number", default: 50 })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    let leadId = Number(args.id)

    // Resolve name/email → ID (same logic as leads get)
    if (isNaN(leadId)) {
      const spinner = prompts.spinner()
      spinner.start(`Looking up "${args.id}"…`)
      try {
        const params = new URLSearchParams({ search: String(args.id), per_page: "5" })
        const searchRes = await irisFetch(`/api/v1/leads?${params}`)
        if (!searchRes.ok) { spinner.stop("Search failed", 1); process.exitCode = 1; prompts.outro("Done"); return }
        const searchData = (await searchRes.json()) as { data?: any[] }
        const matches: any[] = searchData?.data ?? []
        if (matches.length === 0) {
          spinner.stop("No leads found", 1)
          process.exitCode = 1
          prompts.outro("Done")
          return
        }
        if (matches.length === 1) {
          leadId = matches[0].id
          spinner.stop(`Found: ${matches[0].name ?? matches[0].email ?? `#${leadId}`}`)
        } else if (isNonInteractive()) {
          // Non-TTY / parallel context — auto-pick first match with warning (#55742)
          leadId = matches[0].id
          spinner.stop(`${matches.length} matches — auto-selected: ${matches[0].name ?? matches[0].email ?? `#${leadId}`}`)
          prompts.log.warn("Multiple matches found. Using first result. Other matches:")
          for (const m of matches.slice(1)) {
            prompts.log.info(`  #${m.id}  ${m.name ?? m.email ?? "Unknown"}${m.company ? `  ${m.company}` : ""}  ${m.status ?? ""}`)
          }
        } else {
          spinner.stop(`${matches.length} matches`)
          const choice = await prompts.select({
            message: "Which lead?",
            options: matches.map((l: any) => ({
              value: l.id,
              label: `#${l.id}  ${l.name ?? l.email ?? "Unknown"}${l.company ? `  ${l.company}` : ""}  ${l.status ?? ""}`,
            })),
          })
          if (prompts.isCancel(choice)) { prompts.cancel("Cancelled"); return }
          leadId = choice as number
        }
      } catch (err) {
        spinner.stop("Error", 1)
        process.exitCode = 1
        prompts.log.error(err instanceof Error ? err.message : String(err))
        prompts.outro("Done")
        return
      }
    }

    prompts.intro(`◈  Lead #${leadId} — Pulse Check`)

    const spinner = prompts.spinner()
    spinner.start("Loading lead…")

    try {
      // Step 1: Fetch lead details (#55722 — exit non-zero if lead not found)
      const res = await irisFetch(`/api/v1/leads/${leadId}`)
      const ok = await handleApiError(res, "Get lead")
      if (!ok) { spinner.stop("Failed", 1); process.exitCode = 1; prompts.outro("Done"); return }

      const data = (await res.json()) as { data?: any }
      const lead = data?.data ?? data
      if (!lead || !lead.id) {
        spinner.stop("Lead not found", 1)
        process.exitCode = 1
        prompts.outro("Done")
        return
      }
      const email = lead.email ?? ""
      const phone = lead.phone ?? ""
      const name = lead.name ?? lead.first_name ?? `Lead #${leadId}`

      spinner.stop(bold(name))
      printDivider()
      printKV("ID", lead.id)
      printKV("Email", email || dim("(none)"))
      printKV("Phone", phone || dim("(none)"))
      printKV("Status", lead.status)
      printKV("Company", lead.company)

      // Pulse readiness score — single source of truth.
      // Same number the cron snapshots and the daily digest emails.
      // Replaces the old inline 7-field completeness % calc.
      let pulseReadiness: any = null
      try {
        const rRes = await irisFetch(`/api/v1/leads/${leadId}/readiness?include=history`)
        if (rRes.ok) {
          const rBody = (await rRes.json()) as any
          pulseReadiness = rBody?.data ?? null
        }
      } catch { /* non-fatal — render without the score */ }

      if (pulseReadiness) {
        const ps = pulseReadiness.score as number
        const band = (pulseReadiness.band as string) ?? "failing"
        const bandLabel: Record<string, string> = {
          healthy: success(`${ps}/100  healthy`),
          attention: `${UI.Style.TEXT_WARNING}${ps}/100  attention${UI.Style.TEXT_NORMAL}`,
          at_risk: `${UI.Style.TEXT_WARNING}${ps}/100  at risk${UI.Style.TEXT_NORMAL}`,
          failing: `${UI.Style.TEXT_DANGER}${ps}/100  failing${UI.Style.TEXT_NORMAL}`,
        }
        printKV("Pulse", bandLabel[band] ?? `${ps}/100  ${band}`)

        // Sparkline — 8 most recent snapshots, oldest left, newest right.
        const history: Array<{ score: number }> = pulseReadiness.history ?? []
        if (history.length >= 2) {
          const blocks = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"]
          const chronological = [...history].reverse() // history is newest-first
          const recent = chronological.slice(-8)
          const sparkline = recent
            .map((h) => blocks[Math.min(7, Math.max(0, Math.floor(h.score / 12.5)))])
            .join("")
          printKV("Trend", `${dim(sparkline)}  ${dim(`(${history.length} snapshots)`)}`)
        }

        // Per-signal breakdown — show what's pulling the score down/up.
        const sigs = pulseReadiness.signals ?? {}
        const reqS = sigs.requirements?.score
        const liveS = sigs.liveness?.score
        const commsS = sigs.comms_freshness?.score
        const cfgS = sigs.config?.score
        const fmt = (v: number | null | undefined) =>
          v === null || v === undefined ? dim("—") : `${v}/100`
        const sigLine = [
          `req ${fmt(reqS)}`,
          `live ${fmt(liveS)}`,
          `comms ${fmt(commsS)}`,
          `cfg ${fmt(cfgS)}`,
        ].join(dim(" · "))
        printKV("Signals", sigLine)
      }

      // Duplicate detection — search for leads with same email/phone/name
      let duplicateLeadIds: number[] = []
      try {
        const dupSearches: Promise<any[]>[] = []
        if (email) dupSearches.push(irisFetch(`/api/v1/leads?search=${encodeURIComponent(email)}&per_page=5`).then(async (r) => r.ok ? ((await r.json()) as any)?.data ?? [] : []).catch(() => []))
        if (phone) dupSearches.push(irisFetch(`/api/v1/leads?search=${encodeURIComponent(phone)}&per_page=5`).then(async (r) => r.ok ? ((await r.json()) as any)?.data ?? [] : []).catch(() => []))
        if (name && name !== `Lead #${leadId}`) dupSearches.push(irisFetch(`/api/v1/leads?search=${encodeURIComponent(name)}&per_page=5`).then(async (r) => r.ok ? ((await r.json()) as any)?.data ?? [] : []).catch(() => []))
        const results = await Promise.all(dupSearches)
        const allMatches = results.flat().filter((l: any) => l.id !== leadId)
        // Deduplicate by ID
        const seen = new Set<number>()
        for (const m of allMatches) {
          if (!seen.has(m.id)) { seen.add(m.id); duplicateLeadIds.push(m.id) }
        }
        if (duplicateLeadIds.length > 0) {
          // #57685: Rank duplicates by data richness to suggest best master record
          const uniqueDups = allMatches.filter((v: any, i: number, a: any[]) => a.findIndex((x: any) => x.id === v.id) === i)
          const scoreLead = (l: any) => {
            let s = 0
            if (l.email) s += 2
            if (l.phone) s += 2
            if (l.company) s += 1
            if (l.notes?.length) s += Math.min(l.notes.length, 5)
            if (l.status === "Active" || l.status === "Converted" || l.status === "Won") s += 3
            if (l.outreach_steps_count) s += 1
            return s
          }
          // Score current lead vs duplicates to pick best master
          const currentScore = scoreLead(lead)
          const bestDup = uniqueDups.sort((a: any, b: any) => scoreLead(b) - scoreLead(a))[0]
          const bestDupScore = bestDup ? scoreLead(bestDup) : 0
          const masterId = bestDupScore > currentScore ? bestDup.id : leadId
          const mergeId = masterId === leadId ? (bestDup?.id ?? duplicateLeadIds[0]) : leadId

          console.log()
          console.log(`  ${UI.Style.TEXT_WARNING}⚠ Possible duplicates${UI.Style.TEXT_NORMAL}  ${dim(`(${duplicateLeadIds.length})`)}`)
          for (const m of uniqueDups.slice(0, 3)) {
            console.log(`    ${dim(`#${m.id}`)}  ${m.name ?? "Unknown"}  ${dim(m.email ?? "")}  ${dim(m.status ?? "")}`)
          }

          // #71784: Interactive merge prompt instead of just showing command
          if (!isNonInteractive() && !args.json) {
            const mergeAction = await prompts.select({
              message: `Merge #${mergeId} into #${masterId}?`,
              options: [
                { value: "skip", label: "Skip — review later" },
                { value: "merge", label: `Merge now (keep #${masterId}, remove #${mergeId})` },
                { value: "view", label: `View #${mergeId} details first` },
              ],
            })
            if (!prompts.isCancel(mergeAction)) {
              if (mergeAction === "merge") {
                const mergeRes = await irisFetch(`/api/v1/leads/${masterId}/merge`, {
                  method: "POST",
                  body: JSON.stringify({ merge_lead_ids: [mergeId] }),
                }).catch(() => null)
                if (mergeRes?.ok) {
                  console.log(`    ${success("✓")} Merged #${mergeId} into #${masterId}`)
                } else {
                  console.log(`    ${dim(`Manual merge: iris leads merge ${masterId} ${mergeId}`)}`)
                }
              } else if (mergeAction === "view") {
                console.log(`    ${dim(`Run: iris leads pulse ${mergeId}`)}`)
              }
            }
          } else {
            console.log(`    ${dim(`Merge: iris leads merge ${masterId} ${mergeId}`)}`)
          }
        }
      } catch { /* non-fatal */ }

      // CRM notes summary
      const notes: any[] = Array.isArray(lead.notes) ? lead.notes : []
      if (notes.length > 0) {
        console.log()
        console.log(`  ${bold("CRM Notes")}  ${dim(`(${notes.length})`)}`)
        // #57684: Mask credentials/tokens/passwords in note previews
        const maskSecrets = (text: string): string =>
          text
            .replace(/(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret)\s*[:=]\s*\S+/gi, (m) => m.split(/[:=]/)[0] + ": ●●●●●●●●")
            .replace(/(?:sk|pk|rk|Bearer|eyJ)[_-]?[A-Za-z0-9\-_.]{20,}/g, "●●●●●●●●")
            .replace(/(?:ghp|gho|github_pat)_[A-Za-z0-9]{20,}/g, "●●●●●●●●")
        // Show latest 3 note previews
        for (const n of notes.slice(0, 3)) {
          const content = typeof n === "object" ? (n.content ?? "") : String(n)
          const firstLine = content.split("\n").find((l: string) => l.trim()) ?? ""
          const masked = maskSecrets(firstLine.trim().slice(0, 100))
          console.log(`    ${dim("•")} ${masked}${firstLine.length > 100 ? "…" : ""}`)
        }
        if (notes.length > 3) {
          console.log(`    ${dim(`…and ${notes.length - 3} more`)}`)
        }
      }

      // Deal Health section (#57649/#57665) — fetch deal-status + stripe-payments + score + activities in parallel
      let dealHealth: any = null
      let stripeData: any = null
      let leadTasks: any[] = []
      let leadScore: any = null
      let activities: any[] = []
      {
        const [dealRes, stripeRes, tasksRes, scoreRes, activityRes] = await Promise.allSettled([
          irisFetch(`/api/v1/leads/${leadId}/deal-status`),
          irisFetch(`/api/v1/leads/${leadId}/stripe-payments`),
          irisFetch(`/api/v1/leads/${leadId}/tasks`),
          irisFetch(`/api/v1/leads/${leadId}/score`),
          irisFetch(`/api/v1/leads/${leadId}/activities?limit=20`),
        ])

        // Parse deal-status
        if (dealRes.status === "fulfilled" && dealRes.value.ok) {
          dealHealth = ((await dealRes.value.json()) as any)?.data ?? {}
        }
        // Parse stripe-payments (#57665)
        if (stripeRes.status === "fulfilled" && stripeRes.value.ok) {
          stripeData = ((await stripeRes.value.json()) as any)?.data ?? {}
        }
        // Parse tasks (#57666)
        if (tasksRes.status === "fulfilled" && tasksRes.value.ok) {
          const td = ((await tasksRes.value.json()) as any)?.data
          leadTasks = td?.tasks ?? td ?? []
          if (!Array.isArray(leadTasks)) leadTasks = []
        }
        // #71782: Parse engagement score
        if (scoreRes.status === "fulfilled" && scoreRes.value.ok) {
          leadScore = ((await scoreRes.value.json()) as any)?.data ?? null
        }
        // #71785: Parse activity feed
        if (activityRes.status === "fulfilled" && activityRes.value.ok) {
          const ad = ((await activityRes.value.json()) as any)?.data
          activities = Array.isArray(ad) ? ad : []
        }
      }

      // If duplicates found and primary has no Stripe data, check duplicates for payments
      if (duplicateLeadIds.length > 0 && (!stripeData?.total_paid || stripeData.total_paid === 0)) {
        for (const dupId of duplicateLeadIds.slice(0, 3)) {
          try {
            const dupRes = await irisFetch(`/api/v1/leads/${dupId}/stripe-payments`)
            if (dupRes.ok) {
              const dupStripe = ((await dupRes.json()) as any)?.data ?? {}
              if (dupStripe.total_paid > 0) {
                stripeData = dupStripe
                stripeData._from_duplicate = dupId
                break // use first duplicate with payment data
              }
            }
          } catch { /* non-fatal */ }
        }
      }

      // #71782: Engagement Score — composite score from backend LeadScoringService
      if (leadScore) {
        const s = leadScore.score ?? 0
        const scoreLabel = s >= 70 ? success(`${s}/100`) : s >= 40 ? `${UI.Style.TEXT_WARNING}${s}/100${UI.Style.TEXT_NORMAL}` : `${UI.Style.TEXT_DANGER}${s}/100${UI.Style.TEXT_NORMAL}`
        const hotBadge = leadScore.is_hot_lead ? `  ${success("HOT")}` : ""
        printKV("Engagement", `${scoreLabel}${hotBadge}`)
      }

      // Render Deal Health — always show (#57659)
      console.log()
      console.log(`  ${bold("Deal Health")}`)
      if (dealHealth?.has_payment_gate) {
        const gateStatus = dealHealth.payment_received ? success("Paid") : (dealHealth.status === "sent" || dealHealth.status === "awaiting_payment" ? dim("Sent — awaiting payment") : dim(dealHealth.status ?? "Draft"))
        printKV("  Payment Gate", gateStatus)
        if (dealHealth.amount) printKV("  Amount", `$${(dealHealth.amount / 100).toFixed(2)}`)
        // #71783: Show total received (Stripe + offline combined)
        if (dealHealth.total_received > 0) {
          printKV("  Total Received", success(`$${Number(dealHealth.total_received).toFixed(2)}`))
        }
      } else {
        printKV("  Payment Gate", dim("None — create with: iris leads payment-gate " + leadId + " -a 500"))
      }

      // #71783: Offline payments — show when present (cash, Zelle, Venmo, etc.)
      const offlineAmt = dealHealth?.offline_received ?? 0
      if (offlineAmt > 0) {
        const method = dealHealth.offline_payment_method ? ` via ${dealHealth.offline_payment_method}` : ""
        const paidAt = dealHealth.offline_paid_at ? dim(` · ${dealHealth.offline_paid_at.split(" ")[0]}`) : ""
        printKV("  Offline Paid", success(`$${Number(offlineAmt).toFixed(2)}${method}`) + paidAt)
        if (dealHealth.offline_notes) printKV("  Offline Notes", dim(dealHealth.offline_notes))
      }

      // Stripe payments (#57665) — unified financial picture (may include duplicate lead data)
      const stripeDupNote = stripeData?._from_duplicate ? dim(` (from lead #${stripeData._from_duplicate})`) : ""
      if (stripeData?.summary) {
        const s = stripeData.summary
        const totalPaid = stripeData.total_paid ?? 0 // API returns dollars, NOT cents
        printKV("  Stripe Received", totalPaid > 0 ? success(`$${Number(totalPaid).toFixed(2)}`) + stripeDupNote : dim("$0"))
        if (s.total_invoices > 0) {
          printKV("  Stripe Invoices", `${s.total_invoices} (${s.paid_invoices} paid${s.pending_invoices > 0 ? `, ${s.pending_invoices} pending` : ""})`)
        } else {
          printKV("  Stripe Invoices", dim("None"))
        }
        // #57691: Show subscription details (MRR + next billing)
        if (s.active_subscriptions > 0) {
          const subs = stripeData.subscriptions ?? []
          const activeSubs = subs.filter((sub: any) => sub.status === "active" || sub.status === "trialing")
          if (activeSubs.length > 0) {
            for (const sub of activeSubs) {
              const amt = sub.amount ? `$${Number(sub.amount).toFixed(2)}` : sub.plan_name ?? "active"
              const interval = sub.interval ? `/${sub.interval}` : ""
              const nextBill = sub.current_period_end ? dim(` · next: ${sub.current_period_end}`) : ""
              printKV("  Subscription", `${success(amt + interval)}${nextBill}`)
            }
          } else {
            printKV("  Subscriptions", `${s.active_subscriptions} active`)
          }
        }
        if (s.past_due_subscriptions > 0) printKV("  Past Due", `${UI.Style.TEXT_DANGER}${s.past_due_subscriptions} subscription(s)${UI.Style.TEXT_NORMAL}`)
        if (s.pending_sessions > 0) printKV("  Checkout", dim(`${s.pending_sessions} pending session(s)`))
      } else if (!stripeData?.has_stripe_customer) {
        printKV("  Stripe", dim("No Stripe customer"))
      } else {
        printKV("  Stripe", dim("Connected — no payments yet"))
      }

      // Deal-status extras (contracts, proposals)
      const contracts = dealHealth?.contracts ?? []
      printKV("  Contracts", contracts.length > 0 ? `${contracts.length} (${contracts.filter((c: any) => c.signed_at).length} signed)` : dim("None"))
      const proposals = dealHealth?.proposals ?? []
      printKV("  Proposals", proposals.length > 0 ? `${proposals.length}` : dim("None"))

      // Tasks section (#57666)
      console.log()
      console.log(`  ${bold("Tasks")}  ${dim(`(${leadTasks.length})`)}`)
      if (leadTasks.length === 0) {
        console.log(`    ${dim("No tasks — create with: iris leads tasks create " + leadId + ' --title "..."')}`)
      } else {
        const now = new Date()
        const pending = leadTasks.filter((t: any) => !t.is_completed)
        const completed = leadTasks.filter((t: any) => t.is_completed)
        // #57689: Sort pending tasks — overdue first, then by due date asc, no-date last
        pending.sort((a: any, b: any) => {
          const aOverdue = a.due_date && new Date(a.due_date) < now ? 1 : 0
          const bOverdue = b.due_date && new Date(b.due_date) < now ? 1 : 0
          if (aOverdue !== bOverdue) return bOverdue - aOverdue // overdue first
          if (a.due_date && b.due_date) return new Date(a.due_date).getTime() - new Date(b.due_date).getTime()
          if (a.due_date) return -1 // has date before no-date
          if (b.due_date) return 1
          return 0
        })
        const overdue = pending.filter((t: any) => t.due_date && new Date(t.due_date) < now)
        if (overdue.length > 0) printKV("  Overdue", `${UI.Style.TEXT_DANGER}${overdue.length}${UI.Style.TEXT_NORMAL}`)
        printKV("  Pending", `${pending.length}`)
        printKV("  Completed", `${completed.length}`)
        // Show top 5 pending tasks (already sorted: overdue first, then by due date)
        for (const t of pending.slice(0, 5)) {
          const due = t.due_date ? dim(` due ${t.due_date.split("T")[0]}`) : ""
          const overdueMark = t.due_date && new Date(t.due_date) < now ? ` ${UI.Style.TEXT_DANGER}OVERDUE${UI.Style.TEXT_NORMAL}` : ""
          console.log(`    ${dim("○")} ${t.title}${due}${overdueMark}`)
        }
        if (pending.length > 5) console.log(`    ${dim(`…and ${pending.length - 5} more`)}`)

        // #71786: Make overdue tasks actionable — prompt to complete or snooze
        if (overdue.length > 0 && !isNonInteractive() && !args.json) {
          console.log()
          for (const t of overdue.slice(0, 3)) {
            const action = await prompts.select({
              message: `Overdue: "${t.title}" (due ${t.due_date?.split("T")[0]})`,
              options: [
                { value: "skip", label: "Skip — deal with later" },
                { value: "complete", label: "Mark complete" },
                { value: "snooze7", label: "Snooze 7 days" },
              ],
            })
            if (prompts.isCancel(action)) break
            if (action === "complete") {
              await irisFetch(`/api/v1/leads/${leadId}/tasks/${t.id}`, {
                method: "PUT",
                body: JSON.stringify({ is_completed: true }),
              }).catch(() => {})
              console.log(`    ${success("✓")} Completed: ${t.title}`)
            } else if (action === "snooze7") {
              const newDate = new Date(Date.now() + 7 * 86400000).toISOString().split("T")[0]
              await irisFetch(`/api/v1/leads/${leadId}/tasks/${t.id}`, {
                method: "PUT",
                body: JSON.stringify({ due_date: newDate }),
              }).catch(() => {})
              console.log(`    ${dim("⏰")} Snoozed to ${newDate}: ${t.title}`)
            }
          }
        }
      }

      // Requirements Health — automated deliverable testing
      try {
        const reqRes = await irisFetch(`/api/v1/leads/${leadId}/requirements/summary`)
        if (reqRes.ok) {
          const rs = await reqRes.json().catch(() => ({}))
          if (rs.total > 0) {
            console.log()
            console.log(`  ${bold("Requirements Health")}`)
            const icon = rs.failing > 0 ? `${UI.Style.TEXT_DANGER}✗${UI.Style.TEXT_NORMAL}` : success("✓")
            const statusText = rs.failing > 0
              ? `${UI.Style.TEXT_DANGER}${rs.passing}/${rs.total} passing (${rs.failing} FAILING)${UI.Style.TEXT_NORMAL}`
              : success(`${rs.passing}/${rs.total} passing`)
            console.log(`    ${icon} ${statusText}`)
            if (rs.untested > 0) console.log(`    ${dim(`${rs.untested} untested`)}`)
            console.log(`    ${dim(`Last run: ${rs.last_run ? rs.last_run.split("T")[0] : "never"}`)}`)
            console.log(`    ${dim(`Run: iris leads requirements run ${leadId}`)}`)
          }
        }
      } catch {}

      // #71785: Unified Activity Timeline — recent activity across all sources
      if (activities.length > 0) {
        console.log()
        console.log(`  ${bold("Recent Activity")}  ${dim(`(${activities.length})`)}`)
        for (const act of activities.slice(0, 8)) {
          const icon = act.activity_icon ?? "~"
          const type = act.activity_type ?? "note"
          const content = (act.content ?? "").split("\n")[0].slice(0, 100)
          const dateStr = act.created_at ? dim(` ${String(act.created_at).split("T")[0]}`) : ""
          const who = act.is_system_generated ? dim(" [system]") : (act.user_name && act.user_name !== "Unknown User" ? dim(` [${act.user_name}]`) : "")
          console.log(`    ${icon} ${highlight(type.padEnd(18))}${content}${dateStr}${who}`)
        }
        if (activities.length > 8) console.log(`    ${dim(`…and ${activities.length - 8} more — iris leads activities ${leadId}`)}`)
      }

      // Step 2: Integration pre-flight checks (#57677)
      console.log()
      console.log(`  ${bold("Integration Health")}`)
      const healthChecks = await runChannelHealthChecks()
      for (const hc of healthChecks) {
        const icon = hc.ok ? success("✓") : (hc.status === "not_connected" ? dim("—") : `${UI.Style.TEXT_DANGER}✗${UI.Style.TEXT_NORMAL}`)
        const statusText = hc.ok
          ? success("connected + verified")
          : hc.status === "not_connected"
            ? dim("not connected")
            : `${UI.Style.TEXT_DANGER}${hc.error}${UI.Style.TEXT_NORMAL}`
        const hint = (!hc.ok && hc.hint) ? dim(` — ${hc.hint}`) : ""
        console.log(`  ${icon} ${highlight(hc.name.padEnd(18))}${statusText}${hint}`)
      }

      // Step 2.5: Requirements (automated tests for this lead's deliverables)
      try {
        const reqRes = await irisFetch(`/api/v1/leads/${leadId}/requirements`)
        if (reqRes.ok) {
          const reqBody = await reqRes.json().catch(() => ({}))
          const reqs: any[] = reqBody.data ?? []
          if (reqs.length > 0) {
            const passing = reqs.filter(r => r.last_status === "passed" || r.last_status === "completed").length
            const failing = reqs.filter(r => r.last_status === "failed").length
            const untested = reqs.length - passing - failing
            const headerColor = failing > 0 ? highlight : (untested === reqs.length ? dim : success)

            console.log()
            console.log(`  ${bold("Requirements")}  ${headerColor(`${passing}/${reqs.length} passing`)}${failing > 0 ? highlight(` · ${failing} FAILING`) : ""}${untested > 0 ? dim(` · ${untested} untested`) : ""}`)
            for (const r of reqs.slice(0, 5)) {
              const icon = r.last_status === "passed" || r.last_status === "completed" ? success("✓")
                : r.last_status === "failed" ? `${UI.Style.TEXT_DANGER}✗${UI.Style.TEXT_NORMAL}`
                : dim("○")
              const lastRun = r.last_run_at ? dim(r.last_run_at.split("T")[0]) : dim("never run")
              console.log(`  ${icon} ${highlight(r.name.padEnd(28))}${lastRun}`)
            }
            if (reqs.length > 5) console.log(dim(`  …and ${reqs.length - 5} more — iris leads requirements list ${leadId}`))
            if (untested > 0) console.log(dim(`  Run all: iris leads requirements run ${leadId}`))
          }
        }
      } catch (e) { /* requirements section is best-effort */ }

      // Step 3: Search channels in parallel
      console.log()
      const channelSpinner = prompts.spinner()
      channelSpinner.start("Scanning channels…")

      const days = args.days as number
      const channels: { name: string; messages: any[]; error?: string }[] = []

      // Check if the lead has any contact info at all (#55721)
      if (!email && !phone) {
        channelSpinner.stop("No channels available")
        prompts.log.warn(`Lead #${leadId} has no email or phone — cannot scan Gmail, iMessage, or Apple Mail.`)
        prompts.log.info(`Add contact info: ${dim(`iris leads update ${leadId} --email "…" --phone "…"`)}`)
      } else {
        // Build parallel fetches
        const fetches: Promise<void>[] = []
        const msgLimit = args.limit as number

        // Gmail (via lead-specific Gmail threads endpoint — avoids MCP 422) (#55620)
        if (email) {
          fetches.push(
            irisFetch(`/api/v1/leads/${leadId}/gmail-threads`)
              .then(async (r) => {
                if (r.ok) {
                  const d = (await r.json()) as any
                  const threads = d?.data ?? d?.threads ?? []
                  // Flatten thread summaries into message-like entries
                  const msgs = Array.isArray(threads)
                    ? threads.slice(0, msgLimit).map((t: any) => ({
                        subject: t.subject ?? t.snippet ?? "(no subject)",
                        from: t.from ?? "",
                        date: t.last_message_at ?? t.first_message_at ?? "",
                        message_count: t.message_count ?? 1,
                        thread_id: t.gmail_thread_id ?? "",
                      }))
                    : []
                  // Filter to only threads involving the lead's email (#55723)
                  const filtered = msgs.filter((m: any) => {
                    if (!m.from) return true // keep if no from info
                    const fromLower = m.from.toLowerCase()
                    return fromLower.includes(email.toLowerCase())
                  })
                  channels.push({ name: "Gmail", messages: filtered })
                } else {
                  // Fallback: try Apple Mail-style search via bridge as Gmail backup
                  const body = await r.text().catch(() => "")
                  let errorMsg = `HTTP ${r.status}`
                  try { errorMsg = JSON.parse(body)?.error ?? JSON.parse(body)?.message ?? errorMsg } catch {}
                  channels.push({ name: "Gmail", messages: [], error: errorMsg })
                }
              })
              .catch((e) => { channels.push({ name: "Gmail", messages: [], error: e.message }) }),
          )
        }

        // iMessage (via local bridge daemon) — 1:1 by phone/email handle or contact name
        const handle = phone || email
        if (handle) {
          fetches.push(
            fetch(`${BRIDGE_BASE}/api/imessage/search?handle=${encodeURIComponent(handle)}&days=${days}&limit=${msgLimit}`, { headers: bridgeHeaders() })
              .then(async (r) => {
                if (r.ok) {
                  const d = (await r.json()) as any
                  channels.push({ name: "iMessage", messages: d?.messages ?? [] })
                } else {
                  const body = await r.text().catch(() => "")
                  channels.push({ name: "iMessage", messages: [], error: body || `HTTP ${r.status}` })
                }
              })
              .catch((e) => { channels.push({ name: "iMessage", messages: [], error: e.message }) }),
          )
        } else if (name) {
          // Fallback: search by contact name via Contacts.app resolution
          fetches.push(
            fetch(`${BRIDGE_BASE}/api/imessage/search?name=${encodeURIComponent(name)}&days=${days}&limit=${msgLimit}`, { headers: bridgeHeaders() })
              .then(async (r) => {
                if (r.ok) {
                  const d = (await r.json()) as any
                  channels.push({ name: "iMessage", messages: d?.messages ?? [] })
                } else {
                  const body = await r.text().catch(() => "")
                  channels.push({ name: "iMessage", messages: [], error: body || `HTTP ${r.status}` })
                }
              })
              .catch((e) => { channels.push({ name: "iMessage", messages: [], error: e.message }) }),
          )
        } else {
          channels.push({ name: "iMessage", messages: [], error: `No phone, email, or name — add with: iris leads update ${leadId} --phone "..."` })
        }

        // #71781: iMessage group chats — scan linked chat IDs or auto-discover via bridge
        let chatIds: string[] = Array.isArray(lead.contact_info?.chat_ids) ? lead.contact_info.chat_ids : []
        // Auto-discover group chats if none linked and we have a handle
        if (chatIds.length === 0 && handle) {
          fetches.push(
            fetch(`${BRIDGE_BASE}/api/imessage/group-chats?handle=${encodeURIComponent(handle)}&days=${days}&limit=5`, { headers: bridgeHeaders() })
              .then(async (r) => {
                if (r.ok) {
                  const d = (await r.json()) as any
                  const groups = d?.group_chats ?? []
                  for (const gc of groups) {
                    if (gc.recent_count > 0) {
                      chatIds.push(gc.chat_identifier)
                    }
                  }
                  // Now scan discovered group chats
                  const gcFetches = chatIds.map((chatId: string) =>
                    fetch(`${BRIDGE_BASE}/api/imessage/search?handle=${encodeURIComponent(chatId)}&days=${days}&limit=${msgLimit}`, { headers: bridgeHeaders() })
                      .then(async (r2) => {
                        if (r2.ok) {
                          const d2 = (await r2.json()) as any
                          const label = groups.find((g: any) => g.chat_identifier === chatId)?.display_name || chatId.slice(0, 12)
                          channels.push({ name: `iMessage Group (${label})`, messages: d2?.messages ?? [] })
                        }
                      })
                      .catch(() => {}),
                  )
                  await Promise.allSettled(gcFetches)
                }
              })
              .catch(() => {}), // non-fatal — bridge may not support this yet
          )
        } else {
          // Scan explicitly linked chat IDs
          for (const chatId of chatIds) {
            fetches.push(
              fetch(`${BRIDGE_BASE}/api/imessage/search?handle=${encodeURIComponent(chatId)}&days=${days}&limit=${msgLimit}`, { headers: bridgeHeaders() })
                .then(async (r) => {
                  if (r.ok) {
                    const d = (await r.json()) as any
                    channels.push({ name: `iMessage Group (${chatId.slice(0, 12)}…)`, messages: d?.messages ?? [] })
                  } else {
                    channels.push({ name: `iMessage Group`, messages: [], error: `Chat ${chatId.slice(0, 20)} — HTTP ${r.status}` })
                  }
                })
                .catch((e) => { channels.push({ name: `iMessage Group`, messages: [], error: e.message }) }),
            )
          }
        }

        // Apple Mail (via local bridge daemon)
        if (email) {
          fetches.push(
            fetch(`${BRIDGE_BASE}/api/mail/search?from=${encodeURIComponent(email)}&days=${days}&limit=${msgLimit}&include_body=0`, { headers: bridgeHeaders() })
              .then(async (r) => {
                if (r.ok) {
                  const d = (await r.json()) as any
                  channels.push({ name: "Apple Mail", messages: d?.messages ?? [] })
                } else {
                  const body = await r.text().catch(() => "")
                  channels.push({ name: "Apple Mail", messages: [], error: body || `HTTP ${r.status}` })
                }
              })
              .catch((e) => { channels.push({ name: "Apple Mail", messages: [], error: e.message }) }),
          )
        }

        // Google Calendar meetings (search by lead name/email)
        fetches.push(
          fetchLeadCalendarEvents({ name, email, id: leadId }, { days, futureDays: 90 })
            .then(({ past, upcoming }) => {
              const allEvents = [...upcoming, ...past].map((ev) => ({
                summary: ev.summary || "(no title)",
                date: ev.start || ev.start_time || "",
                status: new Date(ev.start || ev.start_time || "") >= new Date() ? "upcoming" : "past",
                location: ev.location || "",
              }))
              channels.push({ name: "Meetings", messages: allEvents })
            })
            .catch((e) => { channels.push({ name: "Meetings", messages: [], error: e.message }) }),
        )

        await Promise.allSettled(fetches)

        const totalMessages = channels.reduce((sum, ch) => sum + ch.messages.length, 0)
        channelSpinner.stop(`${totalMessages} message(s) across ${channels.length} channel(s)`)

        // Persist-after: fire-and-forget write to lead_comms for history (#57657)
        // Maps live-scan results → atlas:comms ingest format. Dedup hash prevents duplicates.
        const channelMap: Record<string, string> = { "Gmail": "gmail", "iMessage": "imessage", "Apple Mail": "apple_mail", "Meetings": "calendar" }
        for (const ch of channels) {
          const channelKey = channelMap[ch.name]
          if (!channelKey || ch.messages.length === 0) continue
          const items = ch.messages.map((msg: any) => {
            if (ch.name === "iMessage") {
              return { direction: msg.from_me ? "outbound" : "inbound", from_identifier: msg.from_me ? "me" : (phone || email), body: msg.text ?? "", sent_at: msg.ts ?? msg.date ?? null, metadata: { source: "pulse_scan" } }
            } else if (ch.name === "Gmail") {
              return { direction: (msg.from ?? "").toLowerCase().includes(email.toLowerCase()) ? "inbound" : "outbound", from_identifier: msg.from ?? "", subject: msg.subject ?? "", body: msg.snippet ?? msg.subject ?? "", sent_at: msg.date ?? null, metadata: { gmail_thread_id: msg.thread_id, source: "pulse_scan" } }
            } else if (ch.name === "Apple Mail") {
              return { direction: "inbound", from_identifier: email, subject: msg.subject ?? "", body: msg.body ?? msg.subject ?? "", sent_at: msg.date ?? msg.ts ?? null, metadata: { source: "pulse_scan" } }
            } else if (ch.name === "Meetings") {
              return { direction: "outbound", from_identifier: "me", subject: msg.summary ?? "", body: `Meeting: ${msg.summary ?? ""}${msg.location ? ` @ ${msg.location}` : ""}`, sent_at: msg.date ?? null, metadata: { event_status: msg.status, source: "pulse_scan" } }
            }
            return null
          }).filter(Boolean)
          if (items.length > 0) {
            irisFetch("/api/v1/atlas/comms/ingest", {
              method: "POST",
              body: JSON.stringify({ lead_id: leadId, channel: channelKey, items }),
            }).catch(() => {}) // fire-and-forget — dedup makes next run safe
          }
        }
      }

      // JSON output
      if (args.json) {
        console.log(JSON.stringify({ lead, dealHealth, stripeData, tasks: leadTasks, score: leadScore, activities, channels }, null, 2))
        prompts.outro("Done")
        return
      }

      // Step 3: Display channel results
      for (const ch of channels) {
        console.log()
        const count = ch.messages.length
        const label = ch.error
          ? `${ch.name}  ${dim(`⚠ ${ch.error}`)}`
          : `${ch.name}  ${dim(`(${count})`)}`
        console.log(`  ${bold(label)}`)

        if (count === 0 && !ch.error) {
          console.log(`    ${dim("No messages in last " + days + " days")}`)
          continue
        }

        const displayLimit = Math.min(10, ch.messages.length)
        for (const msg of ch.messages.slice(0, displayLimit)) {
          if (ch.name === "iMessage") {
            const dir = msg.from_me ? "→" : "←"
            const text = (msg.text ?? "").slice(0, 120)
            console.log(`    ${dim(msg.ts ?? "")}  ${dir}  ${text}`)
          } else if (ch.name === "Gmail") {
            const subj = msg.subject ?? msg.snippet ?? "(no subject)"
            const from = msg.from ?? ""
            console.log(`    ${dim(msg.date ?? "")}  ${dim(from)}`)
            console.log(`      ${subj.slice(0, 120)}`)
          } else if (ch.name === "Apple Mail") {
            const subj = msg.subject ?? "(no subject)"
            const ts = msg.date ?? msg.ts ?? dim("(no date)")
            console.log(`    ${dim(ts)}  ${subj.slice(0, 120)}`)
          } else if (ch.name === "Meetings") {
            const tag = msg.status === "upcoming" ? success("upcoming") : dim("past")
            const dateStr = msg.date ? `${formatDate(msg.date)} ${formatTime(msg.date)}` : "(no date)"
            console.log(`    ${dim(dateStr)}  ${msg.summary.slice(0, 80)}  [${tag}]`)
          }
        }
        if (count > displayLimit) {
          console.log(`    ${dim(`…and ${count - displayLimit} more`)}`)
        }
      }

      // Extract and surface shared links from all channels (#55733)
      const urlRegex = /https?:\/\/[^\s<>"')\]]+/g
      const sharedLinks: { url: string; channel: string; from: string }[] = []
      for (const ch of channels) {
        for (const msg of ch.messages) {
          const text = msg.text ?? msg.subject ?? msg.body ?? ""
          const urls = text.match(urlRegex)
          if (urls) {
            for (const url of urls) {
              if (!sharedLinks.some((l) => l.url === url)) {
                const from = ch.name === "iMessage" ? (msg.from_me ? "You" : "Them") : (msg.from ?? msg.sender ?? "")
                sharedLinks.push({ url, channel: ch.name, from })
              }
            }
          }
        }
      }
      if (sharedLinks.length > 0) {
        console.log()
        console.log(`  ${bold("Shared Links")}  ${dim(`(${sharedLinks.length})`)}`)
        for (const link of sharedLinks.slice(0, 10)) {
          console.log(`    ${highlight(link.url)}`)
          console.log(`      ${dim(`via ${link.channel}`)}${link.from ? dim(` · ${link.from}`) : ""}`)
        }
        if (sharedLinks.length > 10) console.log(`    ${dim(`…and ${sharedLinks.length - 10} more`)}`)
      }

      console.log()
      printDivider()
      prompts.outro(
        `${dim(`iris leads meet ${leadId} --at …`)}  ·  ${dim(`iris leads meetings ${leadId}`)}  ·  ${dim(`iris leads note ${leadId} "…"`)}`,
      )
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

// ============================================================================
// Meet — schedule a meeting with a lead (syncs to Google Calendar)
// ============================================================================

const LeadsMeetCommand = cmd({
  command: "meet <id>",
  aliases: ["schedule"],
  describe: "schedule a meeting with a lead (syncs to Google Calendar)",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "lead ID, name, or email", type: "string", demandOption: true })
      .option("title", { type: "string", describe: "event title (default: 'Meeting with {name}')" })
      .option("at", { type: "string", demandOption: true, describe: "start time (ISO: 2026-04-21T10:00:00)" })
      .option("duration", { type: "number", default: 30, describe: "duration in minutes" })
      .option("location", { alias: "l", type: "string" })
      .option("notes", { type: "string", describe: "meeting agenda/notes" })
      .option("no-calendar", { type: "boolean", default: false, describe: "skip Google Calendar sync (note + task only)" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    if (!(await requireAuth())) { prompts.outro("Done"); return }

    const resolved = await resolveLeadId(String(args.id))
    if (!resolved) { process.exitCode = 1; prompts.outro("Done"); return }
    const { leadId, lead } = resolved
    const leadName = lead.name ?? lead.first_name ?? `Lead #${leadId}`

    const title = args.title || `Meeting with ${leadName}`
    const rawAt = args.at as string
    // Bug #57346: Validate date before using — crash on Invalid Date with helpful message
    const parsedStart = new Date(rawAt)
    if (isNaN(parsedStart.getTime())) {
      prompts.log.error(`Invalid date: "${rawAt}"`)
      prompts.log.info(dim("Use ISO format: 2026-04-21T10:00:00"))
      prompts.log.info(dim("Examples: 2026-04-21T14:30:00, 2026-04-21"))
      process.exitCode = 1
      prompts.outro("Done")
      return
    }
    const startTime = parsedStart.toISOString()
    const durationMs = (args.duration as number) * 60000
    const endTime = new Date(parsedStart.getTime() + durationMs).toISOString()
    const description = [
      args.notes ?? "",
      "",
      `Lead: #${leadId} ${leadName}`,
      lead.email ? `Email: ${lead.email}` : "",
      lead.phone ? `Phone: ${lead.phone}` : "",
    ].filter(Boolean).join("\n")

    prompts.intro(`◈  Schedule Meeting — ${leadName}`)
    const spinner = prompts.spinner()

    let calendarResult: any = null
    if (!args["no-calendar"]) {
      spinner.start("Creating calendar event…")
      try {
        calendarResult = await calExec("create_event", {
          title,
          start_time: startTime,
          end_time: endTime,
          description,
          location: args.location ?? undefined,
          timezone: "America/Chicago",
        })
        spinner.stop(`${success("✓")} Calendar event created`)
      } catch (err: any) {
        spinner.stop(`Calendar sync failed: ${err.message}`)
        prompts.log.warn("Continuing with note + task only")
      }
    }

    // Save note on lead
    try {
      const noteMsg = `Meeting scheduled: ${title}\nDate: ${formatDate(startTime)} ${formatTime(startTime)}${args.location ? `\nLocation: ${args.location}` : ""}${args.notes ? `\nAgenda: ${args.notes}` : ""}${calendarResult?.event_url ? `\nCalendar: ${calendarResult.event_url}` : ""}`
      await irisFetch(`/api/v1/leads/${leadId}/notes`, {
        method: "POST",
        body: JSON.stringify({ message: noteMsg, type: "meeting_scheduled", activity_type: "meeting", activity_icon: "calendar" }),
      })
    } catch {}

    // Create task with due_date
    try {
      await irisFetch(`/api/v1/leads/${leadId}/tasks`, {
        method: "POST",
        body: JSON.stringify({
          title,
          description: args.notes ?? `Meeting with ${leadName}`,
          due_date: startTime,
          status: "pending",
        }),
      })
    } catch {}

    if (args.json) {
      console.log(JSON.stringify({ lead_id: leadId, title, start: startTime, end: endTime, calendar: calendarResult ?? null }, null, 2))
    } else {
      printDivider()
      printKV("Lead", `#${leadId} ${leadName}`)
      printKV("Title", title)
      printKV("When", `${formatDate(startTime)} ${formatTime(startTime)}`)
      printKV("Duration", `${args.duration} min`)
      if (args.location) printKV("Location", args.location as string)
      if (calendarResult?.event_url) printKV("Calendar", calendarResult.event_url)
      printKV("Synced", args["no-calendar"] ? dim("skipped") : (calendarResult ? success("✓ Google Calendar") : dim("failed")))
      printKV("Note", success("✓ saved"))
      printKV("Task", success("✓ created"))
      printDivider()
    }

    prompts.outro(`${dim(`iris leads pulse ${leadId}`)}  ·  ${dim(`iris leads meetings ${leadId}`)}`)
  },
})

// ============================================================================
// Meetings — list calendar meetings for a lead
// ============================================================================

const LeadsMeetingsCommand = cmd({
  command: "meetings <id>",
  aliases: ["cal"],
  describe: "list all calendar meetings for a lead",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "lead ID, name, or email", type: "string", demandOption: true })
      .option("days", { type: "number", default: 30, describe: "look-back window in days" })
      .option("future", { type: "number", default: 30, describe: "look-ahead window in days" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    if (!(await requireAuth())) { prompts.outro("Done"); return }

    const resolved = await resolveLeadId(String(args.id))
    if (!resolved) { process.exitCode = 1; prompts.outro("Done"); return }
    const { leadId, lead } = resolved
    const leadName = lead.name ?? lead.first_name ?? `Lead #${leadId}`

    prompts.intro(`◈  Meetings — ${leadName}`)
    const spinner = prompts.spinner()
    spinner.start("Searching calendar…")

    try {
      const { past, upcoming } = await fetchLeadCalendarEvents(
        { name: leadName, email: lead.email, id: leadId },
        { days: args.days as number, futureDays: args.future as number },
      )

      spinner.stop(`${upcoming.length} upcoming, ${past.length} past`)

      if (args.json) {
        console.log(JSON.stringify({ lead_id: leadId, upcoming, past }, null, 2))
        prompts.outro("Done")
        return
      }

      if (upcoming.length > 0) {
        console.log()
        console.log(`  ${bold("Upcoming")}`)
        for (const ev of upcoming) {
          const start = ev.start || ev.start_time || ""
          console.log(`    ${success("▸")} ${formatDate(start)} ${formatTime(start)}  ${bold(ev.summary || "(no title)")}`)
          if (ev.location) console.log(`      ${dim(ev.location)}`)
        }
      }

      if (past.length > 0) {
        console.log()
        console.log(`  ${bold("Past")}  ${dim(`(last ${args.days} days)`)}`)
        for (const ev of past.slice(0, 10)) {
          const start = ev.start || ev.start_time || ""
          console.log(`    ${dim("▸")} ${formatDate(start)} ${formatTime(start)}  ${ev.summary || "(no title)"}`)
        }
        if (past.length > 10) console.log(`    ${dim(`…and ${past.length - 10} more`)}`)
      }

      if (upcoming.length === 0 && past.length === 0) {
        console.log()
        prompts.log.info("No meetings found for this lead.")
      }

      console.log()
      printDivider()
      prompts.outro(`${dim(`iris leads meet ${leadId} --at …`)}  ·  ${dim(`iris leads pulse ${leadId}`)}`)
    } catch (err: any) {
      spinner.stop("Error", 1)
      prompts.log.error(err.message)
      prompts.outro("Done")
    }
  },
})

// ============================================================================
// Payment Gate — create contract + Stripe checkout + proposal page
// ============================================================================

const LeadsPaymentGateCommand = cmd({
  command: "payment-gate <id>",
  aliases: ["invoice"],
  describe: "create a payment gate (contract + Stripe + proposal page)",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "lead ID", type: "number", demandOption: true })
      .option("amount", { alias: "a", describe: "total amount", type: "number", demandOption: true })
      .option("scope", { alias: "s", describe: "scope of work", type: "string", demandOption: true })
      .option("bloq", { alias: "b", describe: "bloq ID", type: "number" })
      .option("package", { alias: "p", describe: "service package ID (auto-fills amount + scope)", type: "number" })
      .option("packages", { describe: "multiple package IDs for selectable tiers (comma-separated)", type: "string" })
      .option("interval", { alias: "i", describe: "billing interval", type: "string", choices: ["one-time", "month", "quarter", "year"] })
      .option("term", { alias: "t", describe: "duration in months (for recurring)", type: "number" })
      .option("deposit", { describe: "deposit percentage (0-100)", type: "number" })
      .option("list-price", { describe: "original list price (shows strikethrough discount)", type: "number" })
      .option("discount", { describe: "discount percentage (0-100)", type: "number" })
      .option("no-auto-remind", { describe: "disable D+1/D+3/D+7 auto-reminders", type: "boolean" })
      .option("json", { describe: "JSON output", type: "boolean" }),
  async handler(args) {
    if (!(await requireAuth())) return

    const body: Record<string, unknown> = {
      amount: args.amount,
      scope: args.scope,
      auto_send_reminders: !args["no-auto-remind"],
    }
    if (args.bloq) body.bloq_id = args.bloq
    if (args.package) body.package_id = args.package
    if (args.packages) body.package_ids = args.packages.split(",").map(Number)
    if (args.interval) body.interval = args.interval
    if (args.term) body.duration_months = args.term
    if (args.deposit != null) body.deposit_percent = args.deposit
    if (args["list-price"]) body.list_price = args["list-price"]
    if (args.discount != null) body.discount_percent = args.discount

    const res = await irisFetch(`/api/v1/leads/${args.id}/payment-gate`, {
      method: "POST",
      body: JSON.stringify(body),
    })
    if (!(await handleApiError(res, "Create payment gate"))) return

    const data = await res.json().catch(() => ({}))

    if (args.json) { console.log(JSON.stringify(data, null, 2)); return }

    if (!data.success) {
      if (data.error === "duplicate") {
        prompts.log.warn(data.message || "A payment gate already exists for this lead")
        const step = data.step?.data ?? {}
        if (step.proposal_url) {
          console.log("")
          printKV("Existing Proposal", step.proposal_url)
        }
        return
      }
      prompts.log.error(data.message || "Failed to create payment gate")
      return
    }

    console.log("")
    console.log(success("Payment gate created!"))
    printDivider()
    printKV("Proposal URL", data.proposal_url ?? dim("(not generated)"))
    printKV("Contract URL", data.contract_signing_url ?? dim("(not configured)"))
    printKV("Stripe URL", data.stripe_checkout_url ?? dim("(not configured)"))
    printKV("Custom Request", `#${data.custom_request_id}`)
    printDivider()
  },
})

// ============================================================================
// Update Payment Gate
// ============================================================================

const LeadsUpdatePaymentGateCommand = cmd({
  command: "update-gate <id>",
  aliases: ["update-invoice"],
  describe: "update an existing payment gate (amount, scope)",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "lead ID", type: "number", demandOption: true })
      .option("amount", { alias: "a", describe: "new amount", type: "number" })
      .option("scope", { alias: "s", describe: "new scope of work", type: "string" })
      .option("json", { describe: "JSON output", type: "boolean" }),
  async handler(args) {
    if (!(await requireAuth())) return

    if (!args.amount && !args.scope) {
      prompts.log.error("Provide at least --amount or --scope to update")
      return
    }

    const body: Record<string, unknown> = {}
    if (args.amount) body.amount = args.amount
    if (args.scope) body.scope = args.scope

    const res = await irisFetch(`/api/v1/leads/${args.id}/payment-gate`, {
      method: "PUT",
      body: JSON.stringify(body),
    })
    if (!(await handleApiError(res, "Update payment gate"))) return

    const data = await res.json().catch(() => ({}))
    if (args.json) { console.log(JSON.stringify(data, null, 2)); return }

    if (data.success) {
      console.log(success("Payment gate updated"))
    } else {
      prompts.log.error(data.message || "Failed to update payment gate")
    }
  },
})

// ============================================================================
// Delete Payment Gate
// ============================================================================

const LeadsDeletePaymentGateCommand = cmd({
  command: "delete-gate <id>",
  aliases: ["delete-invoice", "rm-gate"],
  describe: "delete a lead's payment gate",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "lead ID", type: "number", demandOption: true })
      .option("json", { describe: "JSON output", type: "boolean" }),
  async handler(args) {
    if (!(await requireAuth())) return

    const res = await irisFetch(`/api/v1/leads/${args.id}/payment-gate`, {
      method: "DELETE",
    })
    if (!(await handleApiError(res, "Delete payment gate"))) return

    const data = await res.json().catch(() => ({}))
    if (args.json) { console.log(JSON.stringify(data, null, 2)); return }

    if (data.success) {
      console.log(success(data.message || "Payment gate deleted"))
    } else {
      prompts.log.error(data.message || "Failed to delete payment gate")
    }
  },
})

// ============================================================================
// Deal Status — show payment gate progress
// ============================================================================

const LeadsDealStatusCommand = cmd({
  command: "deal-status <id>",
  aliases: ["deal"],
  describe: "show deal status for a lead's payment gate",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "lead ID", type: "number", demandOption: true })
      .option("json", { describe: "JSON output", type: "boolean" }),
  async handler(args) {
    if (!(await requireAuth())) return

    const res = await irisFetch(`/api/v1/leads/${args.id}/deal-status`)
    if (!(await handleApiError(res, "Get deal status"))) return

    const result = await res.json().catch(() => ({}))
    const status = result?.data ?? result

    if (args.json) { console.log(JSON.stringify(status, null, 2)); return }

    if (!status?.has_payment_gate) {
      prompts.log.info(`No payment gate for lead #${args.id}`)
      console.log(dim(`Create one: iris leads payment-gate ${args.id} -a 500 -s "Description"`))
      return
    }

    const statusLabels: Record<string, string> = {
      deal_closed: success("CLOSED"),
      awaiting_payment: highlight("AWAITING PAYMENT"),
      awaiting_contract: highlight("AWAITING CONTRACT"),
      awaiting_both: dim("PENDING"),
    }

    console.log("")
    console.log(bold(`Deal Status — Lead #${args.id}`))
    printDivider()
    printKV("Status", statusLabels[status.status] ?? status.status)
    printKV("Amount", `$${Number(status.amount ?? 0).toFixed(2)}`)
    printKV("Scope", status.scope ?? dim("—"))
    printKV("Contract", status.contract_signed ? success("Signed") : highlight("Pending"))
    printKV("Payment", status.payment_received ? success("Received") : highlight("Pending"))
    printKV("Reminders", `${status.reminders_sent ?? 0}/${status.reminders_total ?? 0} sent`)
    printKV("Auto-send", status.auto_send_reminders ? success("Yes") : dim("No"))

    if (status.proposal_url) {
      console.log("")
      printKV("Proposal URL", status.proposal_url)
    }
    if (status.contract_signing_url) {
      printKV("Contract URL", status.contract_signing_url)
    }
    if (status.stripe_checkout_url) {
      printKV("Payment URL", status.stripe_checkout_url)
    }
    printDivider()
  },
})

// ============================================================================
// Packages — list service packages for a bloq
// ============================================================================

const LeadsPackagesCommand = cmd({
  command: "packages <bloq>",
  aliases: ["pkgs"],
  describe: "list service packages for a bloq",
  builder: (yargs) =>
    yargs
      .positional("bloq", { describe: "bloq ID", type: "number", demandOption: true })
      .option("json", { describe: "JSON output", type: "boolean" }),
  async handler(args) {
    if (!(await requireAuth())) return

    const res = await irisFetch(`/api/v1/bloqs/${args.bloq}/packages`)
    if (!(await handleApiError(res, "List packages"))) return

    const result = await res.json().catch(() => ({}))
    const packages: any[] = result?.data?.packages ?? result?.data ?? []

    if (args.json) { console.log(JSON.stringify(packages, null, 2)); return }

    if (!packages.length) {
      prompts.log.info(`No packages found for bloq #${args.bloq}`)
      console.log(dim("Create one in the dashboard or via API: POST /api/v1/bloqs/{id}/packages"))
      return
    }

    console.log("")
    console.log(bold(`Service Packages — Bloq #${args.bloq}`))
    printDivider()
    for (const pkg of packages) {
      const billing = pkg.billing_type && pkg.billing_type !== "one_time" ? dim(` (${pkg.billing_type})`) : ""
      const active = pkg.is_active === false ? dim(" [inactive]") : ""
      console.log(`  ${dim(`#${pkg.id}`)}  ${bold(pkg.name)}  ${success(`$${Number(pkg.price ?? 0).toFixed(2)}`)}${billing}${active}`)
      if (pkg.scope_template) {
        console.log(`       ${dim(String(pkg.scope_template).slice(0, 70))}`)
      }
    }
    printDivider()
  },
})

// ============================================================================
// Create Package — create a service package for a bloq
// ============================================================================

const LeadsCreatePackageCommand = cmd({
  command: "create-package <bloq>",
  aliases: ["add-package", "new-package"],
  describe: "create a service package for a bloq (used in multi-tier proposals)",
  builder: (yargs) =>
    yargs
      .positional("bloq", { describe: "bloq ID", type: "number", demandOption: true })
      .option("name", { alias: "n", describe: "package name", type: "string", demandOption: true })
      .option("price", { alias: "a", describe: "price (or use --amount)", type: "number", demandOption: true })
      .option("billing", { alias: "b", describe: "billing type", type: "string", choices: ["one_time", "monthly", "yearly", "milestone"], default: "monthly" })
      .option("scope", { alias: "s", describe: "scope of work template", type: "string" })
      .option("features", { alias: "f", describe: "features (comma-separated)", type: "string" })
      .option("description", { alias: "d", describe: "package description", type: "string" })
      .option("json", { describe: "JSON output", type: "boolean" }),
  async handler(args) {
    if (!(await requireAuth())) return

    const body: Record<string, unknown> = {
      name: args.name,
      price: args.price,
      billing_type: args.billing,
    }
    if (args.scope) body.scope_template = args.scope
    if (args.description) body.description = args.description
    if (args.features) body.features = args.features.split(/,(?!\d{3}(?!\d))/).map((f: string) => f.trim())

    const res = await irisFetch(`/api/v1/bloqs/${args.bloq}/packages`, {
      method: "POST",
      body: JSON.stringify(body),
    })

    const data = await res.json().catch(() => ({}))

    if (args.json) { console.log(JSON.stringify(data, null, 2)); return }

    if (!res.ok || !data.success) {
      prompts.log.error(data.message || "Failed to create package")
      if (data.errors) {
        for (const [field, msgs] of Object.entries(data.errors)) {
          console.log(`  ${dim(field)}: ${(msgs as string[]).join(", ")}`)
        }
      }
      if (data.hint) {
        console.log("")
        console.log(dim("Required: " + (data.hint as any).required?.join(", ")))
      }
      return
    }

    const pkg = data.data
    console.log("")
    console.log(success(`Package created: #${pkg.id}`))
    printDivider()
    printKV("Name", pkg.name)
    printKV("Price", `$${Number(pkg.price).toFixed(2)}`)
    printKV("Billing", pkg.billing_type)
    if (pkg.scope_template) printKV("Scope", pkg.scope_template.slice(0, 80))
    if (pkg.features?.length) printKV("Features", pkg.features.join(", "))
    printDivider()
  },
})

// ============================================================================
// Update Package — update an existing service package
// ============================================================================

const LeadsUpdatePackageCommand = cmd({
  command: "update-package <bloq> <packageId>",
  aliases: ["edit-package"],
  describe: "update a service package (name, price, billing, features, scope)",
  builder: (yargs) =>
    yargs
      .positional("bloq", { describe: "bloq ID", type: "number", demandOption: true })
      .positional("packageId", { describe: "package ID", type: "number", demandOption: true })
      .option("name", { alias: "n", describe: "package name", type: "string" })
      .option("price", { alias: "a", describe: "price", type: "number" })
      .option("billing", { alias: "b", describe: "billing type", type: "string", choices: ["one_time", "monthly", "yearly", "milestone"] })
      .option("scope", { alias: "s", describe: "scope of work template", type: "string" })
      .option("features", { alias: "f", describe: "features (comma-separated)", type: "string" })
      .option("description", { alias: "d", describe: "package description", type: "string" })
      .option("active", { describe: "set active/inactive", type: "boolean" })
      .option("json", { describe: "JSON output", type: "boolean" }),
  async handler(args) {
    if (!(await requireAuth())) return

    const body: Record<string, unknown> = {}
    if (args.name) body.name = args.name
    if (args.price != null) body.price = args.price
    if (args.billing) body.billing_type = args.billing
    if (args.scope) body.scope_template = args.scope
    if (args.description) body.description = args.description
    if (args.active != null) body.is_active = args.active
    if (args.features) body.features = args.features.split(/,(?!\d{3}(?!\d))/).map((f: string) => f.trim())

    if (Object.keys(body).length === 0) {
      prompts.log.error("Nothing to update — provide at least one flag (--name, --price, --billing, etc.)")
      return
    }

    const res = await irisFetch(`/api/v1/bloqs/${args.bloq}/packages/${args.packageId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    })

    const data = await res.json().catch(() => ({}))

    if (args.json) { console.log(JSON.stringify(data, null, 2)); return }

    if (!res.ok || !data.success) {
      prompts.log.error(data.message || "Failed to update package")
      return
    }

    const pkg = data.data
    console.log("")
    console.log(success(`Package #${pkg.id} updated`))
    printDivider()
    printKV("Name", pkg.name)
    printKV("Price", `$${Number(pkg.price).toFixed(2)}`)
    printKV("Billing", `${pkg.billing_type} (interval: ${pkg.billing_interval})`)
    if (pkg.scope_template) printKV("Scope", pkg.scope_template.slice(0, 80))
    if (pkg.features?.length) printKV("Features", pkg.features.join(", "))
    printDivider()
  },
})

// ============================================================================
// Regenerate Checkout — force-refresh a stale Stripe session
// ============================================================================

const LeadsRegenCheckoutCommand = cmd({
  command: "regen-checkout <id>",
  aliases: ["refresh-checkout"],
  describe: "force-regenerate the Stripe checkout session for a lead's payment gate",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "lead ID", type: "number", demandOption: true })
      .option("json", { describe: "JSON output", type: "boolean" }),
  async handler(args) {
    if (!(await requireAuth())) return

    // Get the deal status to find the existing checkout URL
    const statusRes = await irisFetch(`/api/v1/leads/${args.id}/deal-status`)
    if (!(await handleApiError(statusRes, "Get deal status"))) return

    const statusData = await statusRes.json().catch(() => ({}))
    const status = statusData?.data ?? statusData

    if (!status?.has_payment_gate) {
      prompts.log.warn(`No payment gate for lead #${args.id}`)
      return
    }

    if (!status.stripe_checkout_url) {
      prompts.log.warn("No Stripe checkout URL on this payment gate")
      return
    }

    // Trigger regeneration by hitting the checkout redirect URL.
    // The CheckoutRedirectController auto-regenerates stale sessions on click.
    const url = String(status.stripe_checkout_url)
    prompts.log.info(`Hitting ${dim(url)} to trigger auto-refresh...`)

    try {
      const res = await fetch(url, { redirect: "manual" })
      if (args.json) {
        console.log(JSON.stringify({ status: res.status, location: res.headers.get("location") }, null, 2))
        return
      }
      if (res.status === 302 || res.status === 301) {
        const dest = res.headers.get("location") ?? "(unknown)"
        console.log("")
        console.log(success("Checkout session refreshed"))
        printDivider()
        printKV("Short URL", url)
        printKV("Fresh Stripe URL", dest.length > 80 ? dest.slice(0, 80) + "..." : dest)
        printDivider()
      } else if (res.status === 200) {
        prompts.log.success("Checkout link is healthy (returned 200)")
      } else if (res.status === 410) {
        prompts.log.error("Short URL has expired (our expiration). Create a new payment gate.")
      } else {
        prompts.log.error(`Unexpected status: ${res.status}`)
      }
    } catch (err) {
      prompts.log.error(err instanceof Error ? err.message : String(err))
    }
  },
})

// ============================================================================
// Tasks (#57667)
// ============================================================================

const LeadsTasksListCommand = cmd({
  command: "list <id>",
  aliases: ["ls"],
  describe: "list tasks for a lead",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "lead ID", type: "number", demandOption: true })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    if (!(await requireAuth())) { prompts.outro("Done"); return }
    const spinner = prompts.spinner()
    spinner.start("Loading tasks…")
    try {
      const res = await irisFetch(`/api/v1/leads/${args.id}/tasks`)
      const ok = await handleApiError(res, "List tasks")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }
      const data = ((await res.json()) as any)?.data
      const tasks: any[] = data?.tasks ?? data ?? []
      spinner.stop(`${tasks.length} task(s)`)
      if (args.json) { console.log(JSON.stringify(tasks, null, 2)); return }
      if (tasks.length === 0) {
        prompts.log.info("No tasks yet")
        prompts.outro(dim(`iris leads tasks create ${args.id} --title "Follow up"`))
        return
      }
      printDivider()
      for (const t of tasks) {
        const check = t.is_completed ? success("✓") : "○"
        const due = t.due_date ? dim(` due ${String(t.due_date).split("T")[0]}`) : ""
        const overdue = !t.is_completed && t.due_date && new Date(t.due_date) < new Date() ? ` ${UI.Style.TEXT_DANGER}OVERDUE${UI.Style.TEXT_NORMAL}` : ""
        console.log(`  ${check} ${bold(t.title)}  ${dim(`#${t.id}`)}${due}${overdue}`)
        if (t.description) console.log(`    ${dim(t.description.slice(0, 120))}`)
      }
      printDivider()
      prompts.outro(dim(`iris leads tasks create ${args.id} --title "..."`))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
    }
  },
})

const LeadsTasksCreateCommand = cmd({
  command: "create <id>",
  aliases: ["add"],
  describe: "create a task for a lead",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "lead ID", type: "number", demandOption: true })
      .option("title", { type: "string", demandOption: true, describe: "task title" })
      .option("description", { alias: "d", type: "string" })
      .option("due", { type: "string", describe: "due date (YYYY-MM-DD)" })
      .option("agent-id", { type: "number", describe: "assign to agent" }),
  async handler(args) {
    UI.empty()
    if (!(await requireAuth())) { prompts.outro("Done"); return }
    const spinner = prompts.spinner()
    spinner.start("Creating task…")
    try {
      const body: Record<string, unknown> = { title: args.title }
      if (args.description) body.description = args.description
      if (args.due) body.due_date = args.due
      if (args["agent-id"]) body.agent_id = args["agent-id"]
      const res = await irisFetch(`/api/v1/leads/${args.id}/tasks`, { method: "POST", body: JSON.stringify(body) })
      const ok = await handleApiError(res, "Create task")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }
      const data = ((await res.json()) as any)?.data
      const task = data?.task ?? data
      spinner.stop(`${success("✓")} Task created: ${task.title} (#${task.id})`)
      prompts.outro(dim(`iris leads tasks list ${args.id}`))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
    }
  },
})

const LeadsTasksCompleteCommand = cmd({
  command: "complete <lead-id> <task-id>",
  aliases: ["done"],
  describe: "mark a task as completed",
  builder: (yargs) =>
    yargs
      .positional("lead-id", { type: "number", demandOption: true })
      .positional("task-id", { type: "number", demandOption: true }),
  async handler(args) {
    UI.empty()
    if (!(await requireAuth())) { prompts.outro("Done"); return }
    const spinner = prompts.spinner()
    spinner.start("Completing…")
    try {
      const res = await irisFetch(`/api/v1/leads/${args["lead-id"]}/tasks/${args["task-id"]}`, {
        method: "PUT",
        body: JSON.stringify({ is_completed: true }),
      })
      const ok = await handleApiError(res, "Complete task")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }
      spinner.stop(success("✓ Task completed"))
      prompts.outro(dim(`iris leads tasks list ${args["lead-id"]}`))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
    }
  },
})

const LeadsTasksDeleteCommand = cmd({
  command: "delete <lead-id> <task-id>",
  aliases: ["rm"],
  describe: "delete a task",
  builder: (yargs) =>
    yargs
      .positional("lead-id", { type: "number", demandOption: true })
      .positional("task-id", { type: "number", demandOption: true }),
  async handler(args) {
    UI.empty()
    if (!(await requireAuth())) { prompts.outro("Done"); return }
    const spinner = prompts.spinner()
    spinner.start("Deleting…")
    try {
      const res = await irisFetch(`/api/v1/leads/${args["lead-id"]}/tasks/${args["task-id"]}`, { method: "DELETE" })
      const ok = await handleApiError(res, "Delete task")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }
      spinner.stop(success("✓ Task deleted"))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
    }
  },
})

const LeadsTasksCommand = cmd({
  command: "tasks",
  describe: "manage tasks for leads — list, create, complete, delete",
  builder: (yargs) =>
    yargs
      .command(LeadsTasksListCommand)
      .command(LeadsTasksCreateCommand)
      .command(LeadsTasksCompleteCommand)
      .command(LeadsTasksDeleteCommand)
      .demandCommand(),
  async handler() {},
})

// ============================================================================
// Root command
// ============================================================================

export const PlatformLeadsCommand = cmd({
  command: "leads",
  aliases: ["crm"],
  describe: "manage CRM leads — pull, push, diff, CRUD, payment gates",
  builder: (yargs) =>
    yargs
      .command(LeadsListCommand)
      .command(LeadsGetCommand)
      .command(LeadsSearchCommand)
      .command(LeadsCreateCommand)
      .command(LeadsUpdateCommand)
      .command(LeadsPullCommand)
      .command(LeadsPushCommand)
      .command(LeadsDiffCommand)
      .command(LeadsDeleteCommand)
      .command(LeadsMergeCommand)
      .command(LeadsPulseCommand)
      .command(LeadsSyncCommsCommand)
      .command(LeadsMeetCommand)
      .command(LeadsMeetingsCommand)
      .command(LeadsNotesCommand)
      .command(LeadsNoteCommand)
      .command(LeadsTasksCommand)
      .command(LeadsPaymentGateCommand)
      .command(LeadsUpdatePaymentGateCommand)
      .command(LeadsDeletePaymentGateCommand)
      .command(LeadsDealStatusCommand)
      .command(LeadsPackagesCommand)
      .command(LeadsCreatePackageCommand)
      .command(LeadsUpdatePackageCommand)
      .command(LeadsRegenCheckoutCommand)
      .command(LeadsCollectCommand)
      .command(LeadsSegmentCommand)
      .command(LeadsRequirementsCommand)
      .demandCommand(),
  async handler() {},
})

// ============================================================================
// Deals command group — discoverable surface for payment pipeline
// ============================================================================

const DealsListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list all leads with active payment gates",
  builder: (yargs) =>
    yargs
      .option("bloq", { alias: "b", describe: "filter by bloq ID", type: "number" })
      .option("json", { describe: "JSON output", type: "boolean" }),
  async handler(args) {
    if (!(await requireAuth())) return

    const params = new URLSearchParams()
    if (args.bloq) params.set("bloq_id", String(args.bloq))

    const res = await irisFetch(`/api/v1/deals/active?${params}`)
    if (!(await handleApiError(res, "List active deals"))) return

    const result = await res.json().catch(() => ({}))
    const data = result?.data ?? {}
    const deals: any[] = data?.deals ?? []

    if (args.json) { console.log(JSON.stringify(data, null, 2)); return }

    if (!deals.length) {
      prompts.log.info("No active deals found")
      console.log(dim("Create one: iris leads payment-gate <lead-id> -a 500 -s \"Scope\""))
      return
    }

    console.log("")
    console.log(bold(`Active Deals — ${deals.length} total | Pipeline: $${Number(data.pipeline_value ?? 0).toFixed(2)}`))
    printDivider()

    const statusLabels: Record<string, string> = {
      deal_closed: success("CLOSED"),
      awaiting_payment: highlight("AWAITING PAYMENT"),
      awaiting_contract: highlight("AWAITING CONTRACT"),
      awaiting_both: dim("PENDING"),
    }

    for (const d of deals) {
      const label = statusLabels[d.deal_status] ?? d.deal_status
      const amount = `$${Number(d.amount ?? 0).toFixed(2)}`
      const age = `${d.days_open}d`
      const reminders = `${d.reminders_sent}/${d.reminders_total}`
      console.log(`  ${dim(`#${d.lead_id}`)}  ${bold(d.name ?? "Unknown")}${d.company ? dim(` @ ${d.company}`) : ""}`)
      console.log(`       ${label}  ${success(amount)}  ${dim(age + " open")}  reminders: ${reminders}`)
      if (d.proposal_url) console.log(`       ${dim(d.proposal_url)}`)
      console.log("")
    }
    printDivider()
  },
})

const DealsStatusCommand = cmd({
  command: "status <id>",
  aliases: ["info"],
  describe: "show deal status for a lead",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "lead ID", type: "number", demandOption: true })
      .option("json", { describe: "JSON output", type: "boolean" }),
  async handler(args) {
    // Reuse same logic as LeadsDealStatusCommand
    if (!(await requireAuth())) return

    const res = await irisFetch(`/api/v1/leads/${args.id}/deal-status`)
    if (!(await handleApiError(res, "Get deal status"))) return

    const result = await res.json().catch(() => ({}))
    const status = result?.data ?? result

    if (args.json) { console.log(JSON.stringify(status, null, 2)); return }

    if (!status?.has_payment_gate) {
      prompts.log.info(`No payment gate for lead #${args.id}`)
      console.log(dim(`Create one: iris deals create ${args.id} -a 500 -s "Description"`))
      return
    }

    const statusLabels: Record<string, string> = {
      deal_closed: success("CLOSED"),
      awaiting_payment: highlight("AWAITING PAYMENT"),
      awaiting_contract: highlight("AWAITING CONTRACT"),
      awaiting_both: dim("PENDING"),
    }

    console.log("")
    console.log(bold(`Deal Status — Lead #${args.id}`))
    printDivider()
    printKV("Status", statusLabels[status.status] ?? status.status)
    printKV("Amount", `$${Number(status.amount ?? 0).toFixed(2)}`)
    printKV("Scope", status.scope ?? dim("��"))
    printKV("Contract", status.contract_signed ? success("Signed") : highlight("Pending"))
    printKV("Payment", status.payment_received ? success("Received") : highlight("Pending"))
    printKV("Reminders", `${status.reminders_sent ?? 0}/${status.reminders_total ?? 0} sent`)
    printKV("Auto-send", status.auto_send_reminders ? success("Yes") : dim("No"))

    if (status.proposal_url) {
      console.log("")
      printKV("Proposal URL", status.proposal_url)
    }
    if (status.contract_signing_url) {
      printKV("Contract URL", status.contract_signing_url)
    }
    if (status.stripe_checkout_url) {
      printKV("Payment URL", status.stripe_checkout_url)
    }
    printDivider()
  },
})

const DealsRemindCommand = cmd({
  command: "remind <id>",
  aliases: ["nudge"],
  describe: "send the next pending reminder for a deal",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "lead ID", type: "number", demandOption: true })
      .option("json", { describe: "JSON output", type: "boolean" }),
  async handler(args) {
    if (!(await requireAuth())) return

    const res = await irisFetch(`/api/v1/leads/${args.id}/payment-gate/send-next-reminder`, {
      method: "POST",
    })
    if (!(await handleApiError(res, "Send next reminder"))) return

    const result = await res.json().catch(() => ({}))

    if (args.json) { console.log(JSON.stringify(result, null, 2)); return }

    if (result?.success) {
      prompts.log.success(result.message ?? "Reminder sent")
      if (result.data?.title) {
        printKV("Step", result.data.title)
        printKV("Lead", `${result.data.lead_name} (#${result.data.lead_id})`)
      }
    } else {
      prompts.log.error(result?.message ?? "Failed to send reminder")
    }
  },
})

const DealsRecoverCommand = cmd({
  command: "recover <id>",
  aliases: ["winback"],
  describe: "trigger win-back sequence for a stale or lost deal",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "lead ID", type: "number", demandOption: true })
      .option("json", { describe: "JSON output", type: "boolean" }),
  async handler(args) {
    if (!(await requireAuth())) return

    // First check the deal status
    const statusRes = await irisFetch(`/api/v1/leads/${args.id}/deal-status`)
    if (!(await handleApiError(statusRes, "Get deal status"))) return

    const statusResult = await statusRes.json().catch(() => ({}))
    const status = statusResult?.data ?? statusResult

    if (!status?.has_payment_gate) {
      prompts.log.error(`No payment gate for lead #${args.id} — nothing to recover`)
      return
    }

    if (status.payment_received) {
      prompts.log.info(`Lead #${args.id} already paid — no recovery needed`)
      return
    }

    // Send all remaining reminders in sequence
    let sent = 0
    const maxReminders = 3
    for (let i = 0; i < maxReminders; i++) {
      const res = await irisFetch(`/api/v1/leads/${args.id}/payment-gate/send-next-reminder`, {
        method: "POST",
      })
      const result = await res.json().catch(() => ({}))
      if (!result?.success) break
      sent++
      if (!args.json) {
        prompts.log.success(`Reminder ${sent}: ${result.data?.title ?? "sent"}`)
      }
    }

    if (args.json) {
      console.log(JSON.stringify({ lead_id: args.id, reminders_triggered: sent, status: status.status }, null, 2))
      return
    }

    if (sent === 0) {
      prompts.log.info("All reminders already sent — consider a manual follow-up")
      console.log(dim(`View deal: iris deals status ${args.id}`))
    } else {
      console.log("")
      prompts.log.success(`Recovery sequence triggered: ${sent} reminder(s) scheduled for lead #${args.id}`)
      console.log(dim(`Track progress: iris deals status ${args.id}`))
    }
  },
})

const DealsCreateCommand = cmd({
  command: "create <id>",
  aliases: ["gate", "invoice"],
  describe: "create a payment gate for a lead (alias for leads payment-gate)",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "lead ID", type: "number", demandOption: true })
      .option("amount", { alias: "a", describe: "amount in dollars", type: "number" })
      .option("scope", { alias: "s", describe: "scope of work", type: "string" })
      .option("bloq", { alias: "b", describe: "bloq ID", type: "number" })
      .option("package", { alias: "p", describe: "package ID", type: "number" })
      .option("packages", { describe: "comma-separated package IDs for multi-tier", type: "string" })
      .option("interval", { alias: "i", describe: "billing interval", type: "string", choices: ["one-time", "month", "quarter", "year"] })
      .option("pass-fees", { describe: "pass Stripe processing fees to the client (default 2.9% + $0.30)", type: "boolean" })
      .option("absorb-fees", { describe: "absorb Stripe processing fees (you pay them)", type: "boolean" })
      .option("fee-percent", { describe: "processing fee percentage (default 2.9)", type: "number" })
      .option("fee-flat", { describe: "processing fee flat amount (default 0.30)", type: "number" })
      .option("no-auto-remind", { describe: "disable auto-send reminders", type: "boolean" })
      .option("json", { describe: "JSON output", type: "boolean" }),
  async handler(args) {
    if (!(await requireAuth())) return

    const body: Record<string, unknown> = {}
    if (args.amount) body.amount = args.amount
    if (args.scope) body.scope = args.scope
    if (args.bloq) body.bloq_id = args.bloq
    if (args.package) body.package_id = args.package
    if (args.packages) body.package_ids = args.packages.split(",").map(Number)
    if (args.interval) body.interval = args.interval
    if (args["no-auto-remind"]) body.auto_send_reminders = false
    if (args["pass-fees"] || args["absorb-fees"] || args["fee-percent"] || args["fee-flat"]) {
      body.processing_fee_mode = args["absorb-fees"] ? "absorb" : "pass_to_client"
      if (args["fee-percent"] !== undefined) body.processing_fee_percent = args["fee-percent"]
      if (args["fee-flat"] !== undefined) body.processing_fee_flat = args["fee-flat"]
    }

    const res = await irisFetch(`/api/v1/leads/${args.id}/payment-gate`, {
      method: "POST",
      body: JSON.stringify(body),
    })
    if (!(await handleApiError(res, "Create payment gate"))) return

    const result = await res.json().catch(() => ({}))

    if (args.json) { console.log(JSON.stringify(result, null, 2)); return }

    if (result?.success || result?.data) {
      const data = result?.data ?? result
      prompts.log.success(`Payment gate created for lead #${args.id}`)
      if (data.proposal_url) printKV("Proposal", data.proposal_url)
      if (data.contract_url) printKV("Contract", data.contract_url)
      if (data.checkout_url) printKV("Checkout", data.checkout_url)
      console.log(dim(`\nTrack: iris deals status ${args.id}`))
    } else {
      prompts.log.error(result?.message ?? "Failed to create payment gate")
    }
  },
})

const DealsDeleteCommand = cmd({
  command: "delete <id>",
  aliases: ["cancel", "rm"],
  describe: "delete/cancel an existing payment gate for a lead",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "lead ID", type: "number", demandOption: true })
      .option("json", { describe: "JSON output", type: "boolean" }),
  async handler(args) {
    if (!(await requireAuth())) return

    // First check the deal exists
    const statusRes = await irisFetch(`/api/v1/leads/${args.id}/deal-status`)
    if (!(await handleApiError(statusRes, "Get deal status"))) return

    const statusResult = await statusRes.json().catch(() => ({}))
    const status = statusResult?.data ?? statusResult

    if (!status?.has_payment_gate) {
      prompts.log.error(`No payment gate for lead #${args.id}`)
      return
    }

    const res = await irisFetch(`/api/v1/leads/${args.id}/payment-gate`, {
      method: "DELETE",
    })
    if (!(await handleApiError(res, "Delete payment gate"))) return

    const result = await res.json().catch(() => ({}))

    if (args.json) { console.log(JSON.stringify(result, null, 2)); return }

    if (result?.success) {
      prompts.log.success(`Payment gate deleted for lead #${args.id}`)
    } else {
      prompts.log.error(result?.message ?? "Failed to delete payment gate")
    }
  },
})

const DealsUpdateCommand = cmd({
  command: "update <id>",
  aliases: ["edit"],
  describe: "update an existing payment gate (amount, scope, interval)",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "lead ID", type: "number", demandOption: true })
      .option("amount", { alias: "a", describe: "new amount in dollars", type: "number" })
      .option("scope", { alias: "s", describe: "new scope of work", type: "string" })
      .option("interval", { alias: "i", describe: "billing interval", type: "string", choices: ["one-time", "month", "quarter", "year"] })
      .option("pass-fees", { describe: "pass Stripe processing fees to the client", type: "boolean" })
      .option("absorb-fees", { describe: "absorb Stripe processing fees (you pay them)", type: "boolean" })
      .option("fee-percent", { describe: "processing fee percentage (default 2.9)", type: "number" })
      .option("fee-flat", { describe: "processing fee flat amount (default 0.30)", type: "number" })
      .option("json", { describe: "JSON output", type: "boolean" }),
  async handler(args) {
    if (!(await requireAuth())) return

    if (!args.amount && !args.scope && !args.interval && !args["pass-fees"] && !args["absorb-fees"]) {
      prompts.log.error("Provide at least one field to update: --amount, --scope, --interval, or --pass-fees")
      return
    }

    // Get current deal to find step_id
    const statusRes = await irisFetch(`/api/v1/leads/${args.id}/deal-status`)
    if (!(await handleApiError(statusRes, "Get deal status"))) return

    const statusResult = await statusRes.json().catch(() => ({}))
    const status = statusResult?.data ?? statusResult

    if (!status?.has_payment_gate) {
      prompts.log.error(`No payment gate for lead #${args.id} — create one first: iris deals create ${args.id}`)
      return
    }

    // Delete existing and recreate with updated values
    const delRes = await irisFetch(`/api/v1/leads/${args.id}/payment-gate`, { method: "DELETE" })
    if (!(await handleApiError(delRes, "Remove existing payment gate"))) return

    const body: Record<string, unknown> = {
      amount: args.amount ?? status.amount,
      scope: args.scope ?? status.scope,
    }
    // Always preserve interval — check explicit flag first, then infer from existing billing_type
    if (args.interval) {
      body.interval = args.interval
    } else if (status.billing_type) {
      const mapped = { monthly: "month", quarterly: "quarter", yearly: "year", one_time: "one-time" } as Record<string, string>
      body.interval = mapped[status.billing_type] ?? status.billing_type
    }
    if (args["pass-fees"] || args["absorb-fees"] || args["fee-percent"] || args["fee-flat"]) {
      body.processing_fee_mode = args["absorb-fees"] ? "absorb" : "pass_to_client"
      if (args["fee-percent"] !== undefined) body.processing_fee_percent = args["fee-percent"]
      if (args["fee-flat"] !== undefined) body.processing_fee_flat = args["fee-flat"]
    }

    const createRes = await irisFetch(`/api/v1/leads/${args.id}/payment-gate`, {
      method: "POST",
      body: JSON.stringify(body),
    })
    if (!(await handleApiError(createRes, "Recreate payment gate"))) return

    const result = await createRes.json().catch(() => ({}))

    if (args.json) { console.log(JSON.stringify(result, null, 2)); return }

    const data = result?.data ?? result
    prompts.log.success(`Payment gate updated for lead #${args.id}`)
    if (args.amount) printKV("Amount", `$${args.amount}`)
    if (args.scope) printKV("Scope", args.scope.substring(0, 80) + (args.scope.length > 80 ? "…" : ""))
    if (args.interval) printKV("Interval", args.interval)
    if (data?.proposal_url) printKV("Proposal", data.proposal_url)
    console.log(dim(`\nTrack: iris deals status ${args.id}`))
  },
})

export const PlatformDealsCommand = cmd({
  command: "deals",
  aliases: ["deal", "pipeline"],
  describe: "manage deals — active payment gates, status, reminders, recovery",
  builder: (yargs) =>
    yargs
      .command(DealsListCommand)
      .command(DealsStatusCommand)
      .command(DealsCreateCommand)
      .command(DealsUpdateCommand)
      .command(DealsDeleteCommand)
      .command(DealsRemindCommand)
      .command(DealsRecoverCommand)
      .demandCommand(),
  async handler() {},
})

// ============================================================================
// Collect — one-shot payment collection: invoice → checkout → send → mark-paid
// ============================================================================

const LeadsCollectCommand = cmd({
  command: "collect <lead-id>",
  aliases: ["bill"],
  describe: "collect payment — create invoice, send link, or record offline payment",
  builder: (yargs) =>
    yargs
      .positional("lead-id", { describe: "lead ID", type: "number", demandOption: true })
      .option("amount", { alias: "a", describe: "amount in dollars", type: "number", demandOption: true })
      .option("title", { alias: "t", describe: "invoice title/description", type: "string" })
      .option("method", {
        alias: "m",
        describe: "if already paid offline, record it (skip Stripe)",
        type: "string",
        choices: ["cash", "check", "wire", "ach", "zelle", "venmo", "paypal", "crypto", "barter", "other"] as const,
      })
      .option("date", { describe: "payment date if marking paid (YYYY-MM-DD)", type: "string" })
      .option("notes", { describe: "notes about the payment", type: "string" })
      .option("send", { describe: "send payment link via email", type: "boolean", default: true })
      .option("subscribe", { describe: "create recurring subscription instead of one-time", type: "boolean" })
      .option("interval", { describe: "subscription interval", type: "string", choices: ["month", "year"] as const, default: "month" })
      .option("json", { describe: "JSON output", type: "boolean" }),
  async handler(args) {
    if (!(await requireAuth())) return

    const leadId = args.leadId as number
    const results: Record<string, unknown> = { lead_id: leadId, steps: [] }
    const steps = results.steps as string[]

    // Get lead info
    const leadRes = await irisFetch(`/api/v1/leads/${leadId}`)
    const leadData = await leadRes.json().catch(() => ({}))
    const lead = leadData?.data ?? leadData?.lead ?? leadData
    const leadName = lead?.name ?? `Lead #${leadId}`

    if (!args.json) {
      console.log("")
      console.log(bold(`Collecting from ${leadName} (#${leadId})`))
      printDivider()
    }

    // Offline payment flow — record and done
    if (args.method) {
      if (!args.json) console.log(dim(`  Recording offline payment: $${args.amount} via ${args.method}...`))

      // Ensure invoice exists
      const listRes = await irisFetch(`/api/v1/leads/${leadId}/invoices`)
      const listBody = await listRes.json().catch(() => ({}))
      const invoices = listBody?.data ?? listBody?.invoices ?? []

      if (!Array.isArray(invoices) || invoices.length === 0) {
        const createRes = await irisFetch(`/api/v1/leads/${leadId}/invoice/create`, {
          method: "POST",
          body: JSON.stringify({ price: args.amount, title: args.title ?? `Payment from ${leadName}` }),
        })
        const createBody = await createRes.json().catch(() => ({}))
        steps.push("invoice_created")
        if (!args.json) console.log(success(`  ✓ Invoice created (#${createBody?.data?.id ?? createBody?.id ?? "?"})`))
      }

      const payload: Record<string, unknown> = { amount: args.amount, method: args.method }
      if (args.date) payload.paid_at = args.date
      if (args.notes) payload.notes = args.notes

      const markRes = await irisFetch(`/api/v1/leads/${leadId}/invoice/mark-paid`, {
        method: "POST",
        body: JSON.stringify(payload),
      })
      const markBody = await markRes.json().catch(() => ({}))

      if (markBody?.success) {
        steps.push("marked_paid")
        results.total_received = markBody.total_received
        if (!args.json) {
          console.log(success(`  ✓ Payment recorded: $${args.amount} via ${args.method}`))
          printKV("Total Received", `$${Number(markBody.total_received ?? 0).toFixed(2)}`)
        }
      } else {
        steps.push("mark_paid_failed")
        if (!args.json) console.log(highlight(`  ⚠ Mark paid failed: ${markBody?.error ?? markBody?.message ?? "unknown"}`))
      }

      if (args.json) { console.log(JSON.stringify(results, null, 2)); return }
      printDivider()
      return
    }

    // Online flow: create invoice → checkout → send email
    let invoiceId: number | null = null

    if (args.subscribe) {
      if (!args.json) console.log(dim(`  Creating $${args.amount}/${args.interval} subscription...`))
      const subRes = await irisFetch(`/api/v1/leads/${leadId}/subscription/create`, {
        method: "POST",
        body: JSON.stringify({
          price: args.amount,
          title: args.title ?? `${leadName} — Monthly Retainer`,
          interval: args.interval ?? "month",
        }),
      })
      const subBody = await subRes.json().catch(() => ({}))
      invoiceId = subBody?.data?.id ?? subBody?.invoice?.id
      results.checkout_url = subBody?.data?.checkout_url ?? subBody?.checkout_url
      steps.push("subscription_created")
      if (!args.json) console.log(success(`  ✓ Subscription created (#${invoiceId})`))
    } else {
      if (!args.json) console.log(dim(`  Creating $${args.amount} invoice...`))
      const createRes = await irisFetch(`/api/v1/leads/${leadId}/invoice/create`, {
        method: "POST",
        body: JSON.stringify({ price: args.amount, title: args.title ?? `Payment from ${leadName}` }),
      })
      const createBody = await createRes.json().catch(() => ({}))
      invoiceId = createBody?.data?.id ?? createBody?.invoice?.id ?? createBody?.id
      steps.push("invoice_created")
      if (!args.json) console.log(success(`  ✓ Invoice created (#${invoiceId})`))
    }

    if (!invoiceId) {
      if (args.json) console.log(JSON.stringify({ ...results, error: "invoice_creation_failed" }, null, 2))
      else console.log(highlight("  ⚠ Failed to create invoice"))
      return
    }

    // Generate checkout URL
    if (!results.checkout_url) {
      if (!args.json) console.log(dim("  Generating Stripe checkout link..."))
      const checkoutRes = await irisFetch(`/api/v1/custom-requests/${invoiceId}/generate-checkout`, { method: "POST" })
      const checkoutBody = await checkoutRes.json().catch(() => ({}))
      results.checkout_url = checkoutBody?.data?.checkout_url ?? checkoutBody?.checkout_url ?? checkoutBody?.url
      steps.push("checkout_generated")
      if (!args.json && results.checkout_url) console.log(success("  ✓ Checkout link ready"))
    }

    // Send email
    if (args.send) {
      if (!args.json) console.log(dim("  Sending payment email..."))
      const sendRes = await irisFetch(`/api/v1/custom-requests/${invoiceId}/send-reminder`, { method: "POST" })
      const sendBody = await sendRes.json().catch(() => ({}))
      if (sendBody?.success !== false) {
        steps.push("email_sent")
        if (!args.json) console.log(success(`  ✓ Payment email sent to ${lead?.email ?? "lead"}`))
      } else {
        steps.push("email_failed")
        if (!args.json) console.log(highlight(`  ⚠ Email failed: ${sendBody?.message ?? "unknown"}`))
      }
    }

    if (args.json) { console.log(JSON.stringify({ ...results, invoice_id: invoiceId }, null, 2)); return }
    printDivider()
    if (results.checkout_url) printKV("Payment Link", String(results.checkout_url))
    console.log(dim(`  Track: iris deals status ${leadId}`))
  },
})

// ============================================================================
// Segment — saved filters for lead groups
// ============================================================================

const SEGMENT_FILE = ".iris/lead-segments.json"

function resolveSegmentFile(): string {
  let dir = process.cwd()
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, "fl-docker-dev"))) return join(dir, SEGMENT_FILE)
    const parent = join(dir, "..")
    if (parent === dir) break
    dir = parent
  }
  return join(process.cwd(), SEGMENT_FILE)
}

interface LeadSegment {
  name: string
  filters: Record<string, string>
  created: string
}

function loadSegments(): LeadSegment[] {
  const path = resolveSegmentFile()
  if (!existsSync(path)) return []
  try { return JSON.parse(readFileSync(path, "utf-8")) } catch { return [] }
}

function saveSegments(segments: LeadSegment[]): void {
  const path = resolveSegmentFile()
  const dir = join(path, "..")
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(path, JSON.stringify(segments, null, 2))
}

const SegmentListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list saved segments",
  builder: (yargs) => yargs.option("json", { describe: "JSON output", type: "boolean" }),
  async handler(args) {
    const segments = loadSegments()
    if ((args as any).json) { console.log(JSON.stringify(segments, null, 2)); return }
    if (segments.length === 0) {
      prompts.log.info("No segments saved yet")
      console.log(dim("Create one: iris leads segment create \"Won Retainers\" --status=Won"))
      return
    }
    console.log("")
    console.log(bold(`Lead Segments (${segments.length})`))
    printDivider()
    for (const seg of segments) {
      const filters = Object.entries(seg.filters).map(([k, v]) => `${k}=${v}`).join(", ")
      console.log(`  ${bold(seg.name)}  ${dim(filters)}  ${dim(seg.created)}`)
    }
    printDivider()
  },
})

const SegmentCreateCommand = cmd({
  command: "create <name>",
  aliases: ["add", "save"],
  describe: "create a named segment with filters",
  builder: (yargs) =>
    yargs
      .positional("name", { describe: "segment name", type: "string", demandOption: true })
      .option("status", { describe: "filter by status (Won, Active, In Negotiation, etc.)", type: "string" })
      .option("search", { describe: "search query (name/email/company)", type: "string" })
      .option("bloq-id", { describe: "filter by bloq/project ID", type: "number" })
      .option("min-price", { describe: "minimum price_bid", type: "number" })
      .option("max-price", { describe: "maximum price_bid", type: "number" })
      .option("tag", { describe: "filter by tag", type: "string" })
      .option("json", { describe: "JSON output", type: "boolean" }),
  async handler(args) {
    const filters: Record<string, string> = {}
    if (args.status) filters.status = String(args.status)
    if (args.search) filters.search = String(args.search)
    if (args["bloq-id"]) filters.bloq_id = String(args["bloq-id"])
    if (args["min-price"]) filters.min_price = String(args["min-price"])
    if (args["max-price"]) filters.max_price = String(args["max-price"])
    if (args.tag) filters.tag = String(args.tag)

    if (Object.keys(filters).length === 0) {
      prompts.log.error("At least one filter required (--status, --search, --bloq-id, --min-price, --tag)")
      return
    }

    const segments = loadSegments()
    const existing = segments.findIndex((s) => s.name === args.name)
    const seg: LeadSegment = { name: String(args.name), filters, created: new Date().toISOString().split("T")[0] }

    if (existing >= 0) segments[existing] = seg
    else segments.push(seg)

    saveSegments(segments)

    if ((args as any).json) { console.log(JSON.stringify(seg, null, 2)); return }
    prompts.log.success(`Segment "${args.name}" ${existing >= 0 ? "updated" : "created"}`)
    console.log(dim(`  Filters: ${Object.entries(filters).map(([k, v]) => `${k}=${v}`).join(", ")}`))
    console.log(dim(`  View: iris leads segment view "${args.name}"`))
  },
})

const SegmentViewCommand = cmd({
  command: "view <name>",
  aliases: ["show", "run"],
  describe: "run a saved segment and show matching leads",
  builder: (yargs) =>
    yargs
      .positional("name", { describe: "segment name", type: "string", demandOption: true })
      .option("limit", { describe: "max results", type: "number", default: 50 })
      .option("json", { describe: "JSON output", type: "boolean" }),
  async handler(args) {
    if (!(await requireAuth())) return

    const segments = loadSegments()
    const seg = segments.find((s) => s.name === args.name)
    if (!seg) {
      prompts.log.error(`Segment "${args.name}" not found`)
      const names = segments.map((s) => s.name).join(", ")
      if (names) console.log(dim(`  Available: ${names}`))
      return
    }

    const params = new URLSearchParams({ per_page: String(args.limit) })
    for (const [k, v] of Object.entries(seg.filters)) {
      if (!["min_price", "max_price", "tag"].includes(k)) params.set(k, v)
    }

    const res = await irisFetch(`/api/v1/leads?${params}`)
    if (!(await handleApiError(res, "Fetch segment"))) return

    const data = await res.json().catch(() => ({}))
    let leads: any[] = data?.data ?? []

    // Client-side filters the API doesn't support natively
    if (seg.filters.min_price) {
      const min = Number(seg.filters.min_price)
      leads = leads.filter((l: any) => Number(l.price_bid ?? 0) >= min)
    }
    if (seg.filters.max_price) {
      const max = Number(seg.filters.max_price)
      leads = leads.filter((l: any) => Number(l.price_bid ?? 0) <= max)
    }
    if (seg.filters.tag) {
      const tag = seg.filters.tag.toLowerCase()
      leads = leads.filter((l: any) => {
        const tags = Array.isArray(l.tags) ? l.tags : (typeof l.tags === "string" ? l.tags.split(",") : [])
        return tags.some((t: string) => t.toLowerCase().includes(tag))
      })
    }

    if ((args as any).json) { console.log(JSON.stringify({ segment: seg, leads, count: leads.length }, null, 2)); return }

    console.log("")
    console.log(bold(`Segment: ${seg.name} — ${leads.length} leads`))
    console.log(dim(`  Filters: ${Object.entries(seg.filters).map(([k, v]) => `${k}=${v}`).join(", ")}`))
    printDivider()

    if (leads.length === 0) { prompts.log.info("No leads match this segment"); return }
    for (const l of leads) printLead(l)
    printDivider()
  },
})

const SegmentDeleteCommand = cmd({
  command: "delete <name>",
  aliases: ["rm", "remove"],
  describe: "delete a saved segment",
  builder: (yargs) =>
    yargs.positional("name", { describe: "segment name", type: "string", demandOption: true }),
  async handler(args) {
    const segments = loadSegments()
    const idx = segments.findIndex((s) => s.name === args.name)
    if (idx < 0) { prompts.log.error(`Segment "${args.name}" not found`); return }
    segments.splice(idx, 1)
    saveSegments(segments)
    prompts.log.success(`Segment "${args.name}" deleted`)
  },
})

export const LeadsSegmentCommand = cmd({
  command: "segment",
  aliases: ["segments", "seg"],
  describe: "manage saved lead segments — named filters for quick access",
  builder: (yargs) =>
    yargs
      .command(SegmentListCommand)
      .command(SegmentCreateCommand)
      .command(SegmentViewCommand)
      .command(SegmentDeleteCommand)
      .demandCommand(),
  async handler() {},
})

// ============================================================================
// Requirements — automated deliverable testing via Hive/Playwright
// ============================================================================

function generateRequirementSpec(leadName: string, leadId: number, url: string): string {
  return `// Auto-generated requirements for: ${leadName} (#${leadId})
// URL: ${url}
// Generated: ${new Date().toISOString().split("T")[0]}
import { test, expect } from '@playwright/test';

test.describe('${leadName} — Requirements', () => {
  const URL = '${url}';

  test('site loads (HTTP < 400)', async ({ page }) => {
    const res = await page.goto(URL, { waitUntil: 'networkidle', timeout: 60000 });
    expect(res?.status()).toBeLessThan(400);
  });

  test('page not blank (>100 chars)', async ({ page }) => {
    await page.goto(URL, { waitUntil: 'networkidle', timeout: 60000 });
    const text = await page.textContent('body');
    expect(text?.trim().length).toBeGreaterThan(100);
  });

  test('SSL valid (HTTPS)', async ({ page }) => {
    const res = await page.goto(URL);
    expect(res?.url()).toMatch(/^https:\\/\\//);
  });

  test('no console errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(URL, { waitUntil: 'networkidle', timeout: 60000 });
    expect(errors).toHaveLength(0);
  });

  test('no broken assets (no 404s)', async ({ page }) => {
    const broken: string[] = [];
    page.on('response', r => { if (r.status() >= 400) broken.push(r.url()); });
    await page.goto(URL, { waitUntil: 'networkidle', timeout: 60000 });
    expect(broken).toHaveLength(0);
  });
});
`
}

const ReqCreateCommand = cmd({
  command: "create <lead-id>",
  aliases: ["add"],
  describe: "create a requirement test for a lead",
  builder: (yargs) =>
    yargs
      .positional("lead-id", { describe: "lead ID", type: "number", demandOption: true })
      .option("name", { alias: "n", describe: "requirement name", type: "string", demandOption: true })
      .option("url", { alias: "u", describe: "URL to test (auto-generates Playwright spec)", type: "string" })
      .option("script-file", { alias: "f", describe: "path to custom .spec.ts file", type: "string" })
      .option("json", { describe: "JSON output", type: "boolean" }),
  async handler(args) {
    if (!(await requireAuth())) return

    const leadId = args.leadId as number

    // Get lead name for spec generation
    const leadRes = await irisFetch(`/api/v1/leads/${leadId}`)
    const leadData = await leadRes.json().catch(() => ({}))
    const leadName = leadData?.data?.name ?? leadData?.lead?.name ?? `Lead #${leadId}`

    let scriptContent: string
    if (args["script-file"]) {
      const filePath = isAbsolute(String(args["script-file"])) ? String(args["script-file"]) : join(process.cwd(), String(args["script-file"]))
      if (!existsSync(filePath)) {
        prompts.log.error(`File not found: ${filePath}`)
        return
      }
      scriptContent = readFileSync(filePath, "utf-8")
    } else if (args.url) {
      scriptContent = generateRequirementSpec(leadName, leadId, String(args.url))
    } else {
      prompts.log.error("Either --url or --script-file is required")
      return
    }

    const res = await irisFetch(`/api/v1/leads/${leadId}/requirements`, {
      method: "POST",
      body: JSON.stringify({ name: args.name, script_content: scriptContent }),
    })
    if (!(await handleApiError(res, "Create requirement"))) return

    const body = await res.json().catch(() => ({}))

    if ((args as any).json) { console.log(JSON.stringify(body, null, 2)); return }

    if (body.success) {
      prompts.log.success(`Requirement "${args.name}" created for ${leadName} (#${leadId})`)
      if (args.url) console.log(dim(`  Auto-generated 5 checks for ${args.url}`))
      console.log(dim(`  Run: iris leads requirements run ${leadId}`))
    } else {
      prompts.log.error(body.error ?? body.message ?? "Failed")
    }
  },
})

const ReqListCommand = cmd({
  command: "list <lead-id>",
  aliases: ["ls"],
  describe: "list requirements for a lead",
  builder: (yargs) =>
    yargs
      .positional("lead-id", { describe: "lead ID", type: "number", demandOption: true })
      .option("json", { describe: "JSON output", type: "boolean" }),
  async handler(args) {
    if (!(await requireAuth())) return

    const res = await irisFetch(`/api/v1/leads/${args.leadId}/requirements`)
    if (!(await handleApiError(res, "List requirements"))) return

    const body = await res.json().catch(() => ({}))
    const reqs: any[] = body.data ?? []

    if ((args as any).json) { console.log(JSON.stringify(reqs, null, 2)); return }

    if (reqs.length === 0) {
      prompts.log.info(`No requirements for lead #${args.leadId}`)
      console.log(dim(`Create one: iris leads requirements create ${args.leadId} --name "QA" --url "https://..."`))
      return
    }

    console.log("")
    console.log(bold(`Requirements — Lead #${args.leadId} (${reqs.length})`))
    printDivider()
    for (const r of reqs) {
      const statusIcon = r.last_status === "passed" || r.last_status === "completed" ? success("✓")
        : r.last_status === "failed" ? highlight("✗")
        : dim("○")
      const lastRun = r.last_run_at ? dim(r.last_run_at.split("T")[0]) : dim("never run")
      console.log(`  ${statusIcon}  ${bold(r.name)}  ${dim(`#${r.id}`)}  ${lastRun}`)
    }
    printDivider()
    console.log(dim(`  Run all: iris leads requirements run ${args.leadId}`))
  },
})

const ReqRunCommand = cmd({
  command: "run <lead-id>",
  aliases: ["test", "check"],
  describe: "run requirements tests for a lead via Hive",
  builder: (yargs) =>
    yargs
      .positional("lead-id", { describe: "lead ID", type: "number", demandOption: true })
      .option("name", { alias: "n", describe: "run specific requirement by name", type: "string" })
      .option("json", { describe: "JSON output", type: "boolean" }),
  async handler(args) {
    if (!(await requireAuth())) return

    const leadId = args.leadId as number

    if (!args.json) {
      console.log("")
      console.log(bold(`Running requirements for lead #${leadId}...`))
      printDivider()
    }

    let url = `/api/v1/leads/${leadId}/requirements/run-all`
    if (args.name) {
      // Look up the requirement by name first
      const listRes = await irisFetch(`/api/v1/leads/${leadId}/requirements`)
      if (listRes.ok) {
        const listBody = await listRes.json().catch(() => ({}))
        const reqs = listBody?.data ?? listBody?.requirements ?? listBody ?? []
        const match = Array.isArray(reqs) ? reqs.find((r: any) =>
          (r.name ?? r.title ?? '').toLowerCase() === String(args.name).toLowerCase()
        ) : null
        if (match?.id) {
          url = `/api/v1/leads/${leadId}/requirements/${match.id}/run`
        } else {
          prompts.log.error(`No requirement found matching name "${args.name}"`)
          return
        }
      }
    }

    const res = await irisFetch(url, { method: "POST" })
    if (!(await handleApiError(res, "Run requirements"))) return

    const body = await res.json().catch(() => ({}))

    if ((args as any).json) { console.log(JSON.stringify(body, null, 2)); return }

    if (body.success) {
      console.log(success(`  ✓ ${body.dispatched}/${body.total} requirements dispatched to Hive`))
      if (body.failed > 0) console.log(highlight(`  ⚠ ${body.failed} failed to dispatch`))
      if (body.task_ids?.length) {
        console.log(dim(`  Task IDs: ${body.task_ids.join(", ")}`))
      }
      printDivider()
      console.log(dim(`  Results will appear in: iris leads requirements list ${leadId}`))
      console.log(dim(`  Or check pulse: iris leads pulse ${leadId}`))
    } else {
      prompts.log.error(body.error ?? "Failed to run requirements")
    }
  },
})

const ReqSummaryCommand = cmd({
  command: "summary <lead-id>",
  aliases: ["status", "health"],
  describe: "show requirements health summary for a lead",
  builder: (yargs) =>
    yargs
      .positional("lead-id", { describe: "lead ID", type: "number", demandOption: true })
      .option("json", { describe: "JSON output", type: "boolean" }),
  async handler(args) {
    if (!(await requireAuth())) return

    const res = await irisFetch(`/api/v1/leads/${args.leadId}/requirements/summary`)
    if (!(await handleApiError(res, "Get summary"))) return

    const s = await res.json().catch(() => ({}))

    if ((args as any).json) { console.log(JSON.stringify(s, null, 2)); return }

    if (s.total === 0) {
      prompts.log.info(`No requirements for lead #${args.leadId}`)
      return
    }

    const icon = s.failing > 0 ? "✗" : "✓"
    const color = s.failing > 0 ? highlight : success

    console.log("")
    console.log(bold(`Requirements Health — Lead #${args.leadId}`))
    printDivider()
    console.log(`  ${color(`${icon} ${s.passing}/${s.total} passing`)}`)
    if (s.failing > 0) console.log(`  ${highlight(`${s.failing} FAILING`)}`)
    if (s.untested > 0) console.log(`  ${dim(`${s.untested} untested`)}`)
    console.log(`  ${dim(`Last run: ${s.last_run ?? "never"}`)}`)
    printDivider()
  },
})

const ReqDeleteCommand = cmd({
  command: "delete <lead-id>",
  aliases: ["rm"],
  describe: "delete a requirement",
  builder: (yargs) =>
    yargs
      .positional("lead-id", { describe: "lead ID", type: "number", demandOption: true })
      .option("id", { describe: "requirement ID to delete", type: "number", demandOption: true })
      .option("json", { describe: "JSON output", type: "boolean" }),
  async handler(args) {
    if (!(await requireAuth())) return

    const res = await irisFetch(`/api/v1/leads/${args.leadId}/requirements/${args.id}`, { method: "DELETE" })
    if (!(await handleApiError(res, "Delete requirement"))) return

    const body = await res.json().catch(() => ({}))
    if ((args as any).json) { console.log(JSON.stringify(body, null, 2)); return }
    prompts.log.success(body.message ?? "Requirement deleted")
  },
})

const ReqAllCommand = cmd({
  command: "all",
  aliases: ["everywhere", "global"],
  describe: "list all active requirements across all leads (paginated)",
  builder: (yargs) =>
    yargs
      .option("page", { alias: "p", describe: "page number", type: "number", default: 1 })
      .option("per-page", { describe: "results per page", type: "number", default: 25 })
      .option("status", { alias: "s", describe: "filter by status", type: "string", choices: ["passed", "failed", "untested"] })
      .option("search", { describe: "filter by lead name/company", type: "string" })
      .option("json", { describe: "JSON output", type: "boolean" }),
  async handler(args) {
    if (!(await requireAuth())) return

    const params = new URLSearchParams({
      page: String(args.page),
      per_page: String(args["per-page"]),
    })
    if (args.status) params.set("status", String(args.status))
    if (args.search) params.set("search", String(args.search))

    const res = await irisFetch(`/api/v1/requirements/all?${params}`)
    if (!(await handleApiError(res, "List all requirements"))) return

    const body = await res.json().catch(() => ({}))
    if ((args as any).json) { console.log(JSON.stringify(body, null, 2)); return }

    const items: any[] = body.data ?? []
    const pg = body.pagination ?? {}

    if (items.length === 0) {
      prompts.log.info(`No requirements found${args.status ? ` (status=${args.status})` : ""}`)
      return
    }

    console.log("")
    console.log(bold(`Active Requirements — ${pg.total ?? items.length} total · page ${pg.current_page ?? 1}/${pg.last_page ?? 1}`))
    printDivider()

    for (const r of items) {
      const status = r.last_status
      const icon = status === "passed" || status === "completed" ? success("✓")
        : status === "failed" ? highlight("✗")
        : dim("○")
      const lead = r.lead ? `${r.lead.name ?? "?"}${r.lead.company ? dim(" — " + r.lead.company) : ""}` : dim("(no lead)")
      const lastRun = r.last_run_at ? dim(r.last_run_at.split("T")[0]) : dim("never")
      const counts = (r.pass_count || r.fail_count) ? dim(` ${r.pass_count}✓ / ${r.fail_count}✗`) : ""
      console.log(`  ${icon}  ${bold(r.name)}${counts}`)
      console.log(`     ${dim(`#${r.id} · lead #${r.lead?.id ?? "?"}`)} ${lead}  ${lastRun}`)
    }

    printDivider()
    if (pg.last_page && pg.last_page > 1) {
      const next = (pg.current_page ?? 1) < pg.last_page ? `iris leads requirements all --page ${(pg.current_page ?? 1) + 1}` : null
      if (next) console.log(dim(`  Next: ${next}`))
    }
    console.log(dim(`  Filters: --status passed|failed|untested  --search <name>  --per-page 50`))
  },
})

const ReqScheduleCommand = cmd({
  command: "schedule <lead-id>",
  aliases: ["watch"],
  describe: "schedule recurring requirement test runs for a lead (continuous monitoring)",
  builder: (yargs) =>
    yargs
      .positional("lead-id", { describe: "lead ID", type: "number", demandOption: true })
      .option("frequency", {
        alias: "f",
        describe: "run frequency",
        type: "string",
        choices: ["hourly", "every_2_hours", "every_4_hours", "every_6_hours", "every_8_hours", "every_12_hours", "daily", "weekly"],
        default: "hourly",
      })
      .option("name", { describe: "schedule name", type: "string" })
      .option("json", { describe: "JSON output", type: "boolean" }),
  async handler(args) {
    if (!(await requireAuth())) return

    const leadId = args.leadId as number
    const name = (args.name as string) || `Requirements monitor — Lead #${leadId}`

    const body = {
      type: "lead_requirements_run",
      task_name: name,
      data: {
        lead_id: leadId,
      },
      frequency: args.frequency,
      enabled: true,
    }

    const res = await irisFetch(`/api/v1/scheduled-jobs`, {
      method: "POST",
      body: JSON.stringify(body),
    })
    if (!(await handleApiError(res, "Schedule requirements"))) return

    const result = await res.json().catch(() => ({}))
    if ((args as any).json) { console.log(JSON.stringify(result, null, 2)); return }

    if (result?.success || result?.id || result?.data) {
      const data = result.data ?? result
      prompts.log.success(`Scheduled requirements run for lead #${leadId}`)
      printKV("Frequency", String(args.frequency))
      printKV("Schedule ID", String(data.id ?? data.scheduled_job_id ?? "?"))
      console.log(dim(`\nView: iris schedules get ${data.id ?? "?"}`))
      console.log(dim(`Disable: iris schedules toggle ${data.id ?? "?"}`))
    } else {
      prompts.log.error(result?.message ?? "Failed to schedule")
    }
  },
})

const LeadsRequirementsCommand = cmd({
  command: "requirements",
  aliases: ["reqs", "req"],
  describe: "manage automated deliverable tests — create, run, monitor",
  builder: (yargs) =>
    yargs
      .command(ReqAllCommand)
      .command(ReqListCommand)
      .command(ReqCreateCommand)
      .command(ReqRunCommand)
      .command(ReqScheduleCommand)
      .command(ReqSummaryCommand)
      .command(ReqDeleteCommand)
      .demandCommand(),
  async handler() {},
})
