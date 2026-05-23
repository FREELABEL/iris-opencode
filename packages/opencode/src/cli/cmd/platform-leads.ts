import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import {
  irisFetch,
  requireAuth,
  handleApiError,
  printDivider,
  printKV,
  dim,
  bold,
  success,
  highlight,
  promptOrFail,
  MissingFlagError,
  isNonInteractive,
  PLATFORM_URLS,
  BRIDGE_URL,
  getBridgeToken,
  resolveUserId,
} from "./iris-api"
import { executeIntegrationCall } from "./platform-run"
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from "fs"
import { homedir } from "os"
import { join, basename, isAbsolute } from "path"
import { spawnSync } from "child_process"
import {
  aiGenerateCarouselProps,
  resolveRemotionDir,
} from "./platform-remotion"

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
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
}

function leadFilename(l: Record<string, unknown>): string {
  const name = String(l.name ?? l.first_name ?? "lead")
  return `${l.id}-${slugify(name)}.json`
}

function findLocalFile(dir: string, id: number): string | undefined {
  if (!existsSync(dir)) return undefined
  const prefix = `${id}-`
  const files = require("fs")
    .readdirSync(dir)
    .filter((f: string) => f.startsWith(prefix) && f.endsWith(".json"))
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
  const bloqLabel =
    bloqIds.length > 0
      ? `  ${dim(bloqIds.map((id: unknown, i: number) => `bloq:${id}${bloqNames[i] ? ` (${bloqNames[i]})` : ""}`).join(", "))}`
      : ""
  console.log(`  ${id}  ${name}${company}${status}${bloqLabel}`)
  if (l.email) console.log(`    ${dim("✉")} ${email}`)
}

// ============================================================================
// Calendar helpers (mirrors platform-calendar.ts pattern)
// ============================================================================

async function calExec(
  action: string,
  params: Record<string, unknown>,
  opts: { integrationId?: number; account?: string } = {},
): Promise<any> {
  return executeIntegrationCall("google-calendar", action, params, opts)
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso)
    if (isNaN(d.getTime())) return iso
    return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true })
  } catch {
    return iso
  }
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso)
    if (isNaN(d.getTime())) return iso
    return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })
  } catch {
    return iso
  }
}

/**
 * Search Google Calendar for events matching a lead's name/email.
 * Returns events split into past and upcoming.
 */
async function fetchLeadCalendarEvents(
  lead: { name?: string; email?: string; emails?: string[]; id: number },
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

  // Client-side filter: match lead name or ANY email in summary/description/attendees
  const nameL = (lead.name ?? "").toLowerCase()
  const emailsToMatch = lead.emails?.length ? lead.emails : (lead.email ? [lead.email.toLowerCase()] : [])
  const filtered = events.filter((ev: any) => {
    const haystack = [ev.summary, ev.description, JSON.stringify(ev.attendees ?? [])].join(" ").toLowerCase()
    if (emailsToMatch.some((e) => haystack.includes(e))) return true
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
      if (!searchRes.ok) {
        spinner.stop("Search failed", 1)
        return null
      }
      const searchData = (await searchRes.json()) as { data?: any[] }
      const matches: any[] = searchData?.data ?? []
      if (matches.length === 0) {
        spinner.stop("No leads found", 1)
        return null
      }
      if (matches.length === 1) {
        leadId = matches[0].id
        spinner.stop(`Found: ${matches[0].name ?? matches[0].email ?? `#${leadId}`}`)
      } else if (isNonInteractive()) {
        spinner.stop(`${matches.length} matches — ambiguous`)
        prompts.log.warn("Multiple leads match. Specify by ID or use a more precise query:")
        for (const m of matches) {
          prompts.log.info(
            `  #${m.id}  ${m.name ?? m.email ?? "Unknown"}${m.company ? `  ${m.company}` : ""}  ${m.status ?? ""}`,
          )
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
      .option("bloq-id", { alias: "bloq", describe: "filter by bloq/project ID", type: "number" })
      .option("all", { describe: "include Prospected leads (hidden by default)", type: "boolean", default: false })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  IRIS Leads")

    const token = await requireAuth()
    if (!token) {
      prompts.outro("Done")
      return
    }

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
      if (!ok) {
        spinner.stop("Failed", 1)
        process.exitCode = 1
        prompts.outro("Done")
        return
      }

      const data = (await res.json()) as { data?: any[]; total?: number; meta?: { total?: number } }
      let leads: any[] = data?.data ?? []

      // Default: hide Prospected leads (mass-scraped venue/SOM leads)
      // Use --all or --status to see everything
      const totalFromApi = data?.meta?.total ?? leads.length
      let prospectedCount = 0
      if (!args.all && !args.status && !args.search) {
        prospectedCount = leads.filter((l: any) => (l.status ?? "").toLowerCase() === "prospected").length
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
      if (!args.all && !args.status && !args.search) {
        const suffix = prospectedCount > 0 ? dim(` (${prospectedCount} Prospected hidden — use --all to include)`) : ""
        spinner.stop(`${leads.length} lead(s)${suffix}`)
      } else if (args.search && totalFromApi > leads.length) {
        spinner.stop(`Showing ${leads.length} of ${totalFromApi} results for "${args.search}"`)
      } else {
        spinner.stop(`${leads.length} lead(s)`)
      }

      if (args.json) {
        console.log(JSON.stringify(leads, null, 2))
        return
      }

      if (leads.length === 0) {
        if (prospectedCount > 0) {
          prompts.log.warn(`No active leads — ${prospectedCount} Prospected leads hidden`)
          prompts.outro(`View them: ${dim("iris leads list --all")}`)
        } else {
          prompts.log.warn("No leads found")
          prompts.outro(`Create one: ${dim("iris leads create")}`)
        }
        return
      }

      printDivider()
      for (const l of leads) {
        printLead(l)
        console.log()
      }
      printDivider()

      prompts.outro(`${dim("iris leads get <id>")}  ·  ${dim("iris leads search <query>")}`)
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
      .option("notes", { describe: "show full note content inline", type: "boolean", default: false })
      .option("json", { describe: "output raw JSON", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()

    const token = await requireAuth()
    if (!token) {
      prompts.outro("Done")
      return
    }

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
          spinner.stop(
            `${matches.length} matches — auto-selected: ${matches[0].name ?? matches[0].email ?? `#${leadId}`}`,
          )
        } else {
          spinner.stop(`${matches.length} matches`)
          const choice = await prompts.select({
            message: "Which lead?",
            options: matches.map((l: any) => ({
              value: l.id,
              label: `#${l.id}  ${l.name ?? l.email ?? "Unknown"}${l.company ? `  ${l.company}` : ""}  ${l.status ?? ""}`,
            })),
          })
          if (prompts.isCancel(choice)) {
            prompts.cancel("Cancelled")
            return
          }
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
      if (!ok) {
        spinner.stop("Failed", 1)
        process.exitCode = 1
        prompts.outro("Done")
        return
      }

      const data = (await res.json()) as { data?: any }
      const l = data?.data ?? data
      if (!l || !l.id) {
        spinner.stop("Lead not found", 1)
        process.exitCode = 1
        prompts.outro("Done")
        return
      }
      spinner.stop(String(l.name ?? l.first_name ?? `Lead #${l.id}`))

      if (args.json) {
        console.log(JSON.stringify(l, null, 2))
        return
      }

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
        const gColor =
          gScore >= 80
            ? success(`${gScore}%`)
            : gScore >= 50
              ? `${UI.Style.TEXT_WARNING}${gScore}%${UI.Style.TEXT_NORMAL}`
              : `${UI.Style.TEXT_DANGER}${gScore}%${UI.Style.TEXT_NORMAL}`
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

      // Outreach summary (steps + messages)
      if ((l.outreach_steps_count ?? 0) > 0) {
        printKV("Outreach", `${l.completed_outreach_steps_count ?? 0} / ${l.outreach_steps_count} steps completed`)
      }
      // Fetch outreach message stats (fire-and-forget display)
      try {
        const omRes = await irisFetch(`/api/v1/leads/${leadId}/outreach/messages?limit=1`)
        if (omRes.ok) {
          const omBody = (await omRes.json()) as any
          const st = omBody.stats ?? {}
          if ((st.total ?? 0) > 0) {
            printKV("DMs", `${st.outbound ?? 0} sent, ${st.inbound ?? 0} received, ${st.replied ?? 0} replied  ${dim(`iris leads outreach ${leadId}`)}`)
          }
        }
      } catch { /* non-critical */ }

      // Notes — truncated by default, full with --notes flag (#57652)
      const notes: any[] = Array.isArray(l.notes) ? l.notes : []
      if (notes.length > 0) {
        const showFull = args.notes as boolean
        console.log()
        console.log(`  ${dim("Notes")}  ${dim(`(${notes.length})`)}`)
        for (const note of notes) {
          const rawContent =
            typeof note === "object" ? (note.content ?? JSON.stringify(note)).replace(/\\n/g, "\n") : String(note)
          const display = showFull
            ? rawContent
            : rawContent.length > 200
              ? rawContent.slice(0, 200) + "..."
              : rawContent
          const date = typeof note === "object" ? (note.created_at ?? "") : ""
          if (date) console.log(`    ${dim(date)}`)
          const lines = display.split("\n")
          for (const line of lines) {
            if (line.trim()) console.log(`    ${line.trim()}`)
          }
          console.log()
        }
        if (
          !showFull &&
          notes.some((n: any) => {
            const c = typeof n === "object" ? (n.content ?? JSON.stringify(n)) : String(n)
            return c.length > 200
          })
        ) {
          console.log(`    ${dim(`Use ${highlight(`--notes`)} for full content`)}`)
        }
      }

      printDivider()

      prompts.outro(`${dim("iris leads note " + leadId + ' "follow up scheduled"')}  Add a note`)
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
      .option("limit", { describe: "max results", type: "number", default: 10 })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
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
    if (!token) {
      prompts.outro("Done")
      return
    }

    const spinner = prompts.spinner()
    spinner.start("Searching…")

    try {
      const params = new URLSearchParams({ search: args.query, per_page: String(args.limit) })
      const res = await irisFetch(`/api/v1/leads?${params}`)
      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as Record<string, unknown>
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
                const haystack =
                  `${l.name ?? ""} ${l.first_name ?? ""} ${l.last_name ?? ""} ${l.email ?? ""} ${l.company ?? ""}`.toLowerCase()
                return allWords.every((w) => haystack.includes(w))
              })
              if (filtered.length > 0) {
                leads = filtered
                break
              }
              // If no multi-word match, show partial matches
              if (leads.length === 0) leads = fbLeads
            }
          }
        }
      }

      const total = data?.meta?.total ?? leads.length
      spinner.stop(`${total} result(s)`)

      if (args.json) {
        console.log(JSON.stringify(leads, null, 2))
        return
      }

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
      .option("status", {
        describe: "initial status",
        type: "string",
        choices: ["Prospected", "Contacted", "Interested", "Converted", "Archived"],
      })
      .option("notes", { describe: "initial note to attach", type: "string" })
      .option("bloq-id", { describe: "CRM bloq ID (default: auto-detect)", type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Create Lead")

    const token = await requireAuth()
    if (!token) {
      prompts.outro("Done")
      return
    }

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
      if (prompts.isCancel(result)) {
        prompts.outro("Cancelled")
        return
      }
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
        const extras = String(args.emails)
          .split(",")
          .map((e: string) => e.trim())
          .filter(Boolean)
        if (extras.length > 0) {
          payload.contact_info = { emails: extras }
        }
      }

      const res = await irisFetch("/api/v1/leads", {
        method: "POST",
        body: JSON.stringify(payload),
      })
      const ok = await handleApiError(res, "Create lead")
      if (!ok) {
        spinner.stop("Failed", 1)
        prompts.outro("Done")
        return
      }

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
        } catch {
          /* non-fatal */
        }
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
  builder: (yargs) => yargs.positional("id", { describe: "lead ID or name", type: "string", demandOption: true }),
  async handler(args) {
    UI.empty()

    const token = await requireAuth()
    if (!token) {
      prompts.outro("Done")
      return
    }

    let leadId = Number(args.id)
    if (isNaN(leadId)) {
      // Resolve name → ID
      const params = new URLSearchParams({ search: String(args.id), per_page: "5" })
      const searchRes = await irisFetch(`/api/v1/leads?${params}`)
      if (!searchRes.ok) {
        prompts.log.error("Search failed")
        prompts.outro("Done")
        return
      }
      const searchData = (await searchRes.json()) as { data?: any[] }
      const matches: any[] = searchData?.data ?? []
      if (matches.length === 0) {
        prompts.log.warn(`No leads matching "${args.id}"`)
        prompts.outro("Done")
        return
      }
      if (matches.length === 1) {
        leadId = matches[0].id
      } else if (isNonInteractive()) {
        leadId = matches[0].id
      } else {
        const choice = await prompts.select({
          message: "Which lead?",
          options: matches.map((l: any) => ({
            value: l.id,
            label: `#${l.id}  ${l.name ?? l.email ?? "Unknown"}`,
          })),
        })
        if (prompts.isCancel(choice)) {
          prompts.cancel("Cancelled")
          return
        }
        leadId = choice as number
      }
    }

    prompts.intro(`◈  Notes — Lead #${leadId}`)
    const spinner = prompts.spinner()
    spinner.start("Loading…")

    try {
      const res = await irisFetch(`/api/v1/leads/${leadId}`)
      const ok = await handleApiError(res, "Get lead")
      if (!ok) {
        spinner.stop("Failed", 1)
        process.exitCode = 1
        prompts.outro("Done")
        return
      }

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
        const content =
          typeof note === "object" ? (note.content ?? JSON.stringify(note)).replace(/\\n/g, "\n") : String(note)
        const date = typeof note === "object" ? (note.created_at ?? "") : ""
        if (date) console.log(`  ${dim(date)}`)
        const lines = content.split("\n")
        for (const line of lines) {
          if (line.trim()) console.log(`  ${line.trim()}`)
        }
        console.log()
      }
      printDivider()
      prompts.outro(
        `${success("✓")} ${notes.length} note${notes.length === 1 ? "" : "s"}  ·  ${dim(`iris leads note ${leadId} "…"`)}`,
      )
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const LeadsOutreachCommand = cmd({
  command: "outreach <id>",
  describe: "show outreach message history for a lead (DMs sent/received)",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "lead ID", type: "string", demandOption: true })
      .option("direction", { describe: "filter: inbound | outbound", type: "string" })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const leadId = Number(args.id)
    if (isNaN(leadId)) {
      prompts.log.error("Lead ID must be numeric")
      process.exitCode = 1
      return
    }

    prompts.intro(`◈  Outreach — Lead #${leadId}`)
    const spinner = prompts.spinner()
    spinner.start("Loading…")

    try {
      const params = new URLSearchParams()
      if (args.direction) params.set("direction", args.direction as string)
      const qs = params.toString() ? `?${params}` : ""
      const res = await irisFetch(`/api/v1/leads/${leadId}/outreach/messages${qs}`)
      const ok = await handleApiError(res, "Get outreach messages")
      if (!ok) { spinner.stop("Failed", 1); process.exitCode = 1; prompts.outro("Done"); return }

      const body = (await res.json()) as any
      const messages: any[] = body.messages ?? []
      const stats = body.stats ?? {}

      spinner.stop(`${messages.length} messages`)

      if (args.json) {
        console.log(JSON.stringify(body, null, 2))
        return
      }

      printDivider()
      console.log(`  ${bold("Outbound")}: ${stats.outbound ?? 0}    ${bold("Inbound")}: ${stats.inbound ?? 0}    ${bold("Replied")}: ${stats.replied ?? 0}`)
      printDivider()

      if (messages.length === 0) {
        prompts.log.info("No outreach messages recorded yet.")
        prompts.outro("Done")
        return
      }

      for (const m of messages) {
        const dir = m.direction === "outbound" ? "→ OUT" : "← IN"
        const dirColor = m.direction === "outbound" ? highlight(dir) : success(dir)
        const date = m.sent_at ?? m.created_at ?? ""
        const account = m.channel_account ? `@${m.channel_account}` : ""
        const status = m.status ?? ""
        const meta = m.metadata ?? {}
        const campaign = meta.campaign_name ? dim(` [${meta.campaign_name}]`) : ""

        console.log(`  ${dirColor}  ${dim(date)}  ${account}  ${dim(status)}${campaign}`)
        const text = (m.message ?? "").slice(0, 200)
        if (text) console.log(`    ${text}${(m.message?.length ?? 0) > 200 ? "..." : ""}`)
        console.log()
      }

      printDivider()
      prompts.outro(`${messages.length} message${messages.length === 1 ? "" : "s"}`)
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
      .option("type", {
        describe: "note type tag",
        type: "string",
        choices: ["note", "meeting_intel", "call_log", "email_log", "system"],
      }),
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
    if (!token) {
      prompts.outro("Done")
      return
    }

    // ── Resolve lead ID from name/email if not numeric ──
    const resolved = await resolveLeadId(String(args.id))
    if (!resolved) {
      process.exitCode = 1
      prompts.outro("Done")
      return
    }
    const { leadId } = resolved

    prompts.intro(`◈  Note — Lead #${leadId}`)

    // ── Resolve content from --file or positional message ──
    let content = String(args.message ?? "")
    if (args.file) {
      const filePath = isAbsolute(String(args.file)) ? String(args.file) : join(process.cwd(), String(args.file))
      if (!existsSync(filePath)) {
        prompts.log.error(`File not found: ${filePath}`)
        process.exitCode = 1 // Bug #5: exit 1 not 0
        prompts.outro("Done")
        return
      }
      content = readFileSync(filePath, "utf-8")
      if (!content.trim()) {
        prompts.log.error("File is empty")
        process.exitCode = 1
        prompts.outro("Done")
        return
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
      if (!ok) {
        spinner.stop("Failed", 1)
        prompts.outro("Done")
        return
      }

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
      .option("revenue-type", {
        describe: "revenue type",
        type: "string",
        choices: ["retainer", "performance", "one_time"] as const,
      })
      .option("payment-method", {
        describe: "how they pay",
        type: "string",
        choices: ["stripe", "mercury", "offline", "mixed"] as const,
      })
      .option("chat-id", { describe: "link an iMessage chat ID (e.g. chat713220476491386040)", type: "string" })
      .option("add-email", { describe: "add an alternate email address (for multi-email inbox scanning)", type: "string" }),
  async handler(args) {
    UI.empty()

    const token = await requireAuth()
    if (!token) {
      prompts.outro("Done")
      return
    }

    // ── Resolve lead ID from name/email if not numeric ── (Bug #3)
    const resolved = await resolveLeadId(String(args.id))
    if (!resolved) {
      process.exitCode = 1
      prompts.outro("Done")
      return
    }
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
    // --add-email appends to contact_info.emails (fetches existing to avoid overwrite)
    if (args["add-email"]) {
      try {
        const lr = await irisFetch(`/api/v1/leads/${leadId}`)
        const existingLead = lr.ok ? (((await lr.json()) as any)?.data ?? {}) : {}
        const ci = existingLead.contact_info ?? {}
        const emails: string[] = Array.isArray(ci.emails) ? ci.emails : []
        const newEmail = String(args["add-email"]).trim().toLowerCase()
        if (!emails.map((e: string) => e.toLowerCase()).includes(newEmail)) emails.push(newEmail)
        // Merge with any existing contact_info payload (e.g. from --chat-id)
        payload.contact_info = { ...(payload.contact_info as Record<string, unknown> ?? {}), ...ci, emails }
      } catch {
        payload.contact_info = { ...(payload.contact_info as Record<string, unknown> ?? {}), emails: [String(args["add-email"]).trim()] }
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
      if (!ok) {
        spinner.stop("Failed", 1)
        prompts.outro("Done")
        return
      }

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
    if (!token) {
      prompts.outro("Done")
      return
    }

    const spinner = prompts.spinner()
    spinner.start("Fetching lead…")

    try {
      const res = await irisFetch(`/api/v1/leads/${args.id}`)
      const ok = await handleApiError(res, "Pull lead")
      if (!ok) {
        spinner.stop("Failed", 1)
        prompts.outro("Done")
        return
      }

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
    if (!token) {
      prompts.outro("Done")
      return
    }

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
      if (!ok) {
        spinner.stop("Failed", 1)
        prompts.outro("Done")
        return
      }

      const data = (await res.json()) as { data?: any }
      const result = data?.data ?? data

      // Handle bloq reassignment if bloq_ids changed
      const localBloqIds: number[] = Array.isArray(lead.bloq_ids) ? lead.bloq_ids : lead.bloq_id ? [lead.bloq_id] : []
      const remoteBloqIds: number[] = Array.isArray(result.bloq_ids) ? result.bloq_ids : []

      if (localBloqIds.length > 0) {
        // Attach new bloqs
        for (const bid of localBloqIds) {
          if (!remoteBloqIds.includes(bid)) {
            await irisFetch(`/api/v1/leads/${args.id}/attach-bloq`, {
              method: "POST",
              body: JSON.stringify({ bloq_id: bid }),
            }).catch(() => {})
          }
        }
        // Detach removed bloqs
        for (const bid of remoteBloqIds) {
          if (!localBloqIds.includes(bid)) {
            await irisFetch(`/api/v1/leads/${args.id}/detach-bloq`, {
              method: "POST",
              body: JSON.stringify({ bloq_id: bid }),
            }).catch(() => {})
          }
        }
      }

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
    if (!token) {
      prompts.outro("Done")
      return
    }

    const spinner = prompts.spinner()
    spinner.start("Comparing…")

    try {
      const res = await irisFetch(`/api/v1/leads/${args.id}`)
      const ok = await handleApiError(res, "Fetch lead")
      if (!ok) {
        spinner.stop("Failed", 1)
        prompts.outro("Done")
        return
      }

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

      const fields = [
        "name",
        "email",
        "phone",
        "company",
        "status",
        "source",
        "lead_type",
        "address",
        "city",
        "state",
        "zipcode",
        "country",
        "price_bid",
        "website",
        "stage",
      ]
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
          console.log(
            `    ${UI.Style.TEXT_DANGER}- live:  ${String(c.live ?? "(empty)").slice(0, 120)}${UI.Style.TEXT_NORMAL}`,
          )
          console.log(
            `    ${UI.Style.TEXT_SUCCESS}+ local: ${String(c.local ?? "(empty)").slice(0, 120)}${UI.Style.TEXT_NORMAL}`,
          )
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
      .option("force", { alias: "y", describe: "skip confirmation prompt", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Delete Lead #${args.id}`)

    const token = await requireAuth()
    if (!token) {
      prompts.outro("Done")
      return
    }

    let confirmed: boolean | symbol = args.force
    if (!confirmed) {
      if (isNonInteractive()) {
        prompts.log.error("Refusing to delete without --yes in non-interactive mode.")
        prompts.outro("Done")
        process.exitCode = 2
        return
      }
      confirmed = await prompts.confirm({ message: `Delete lead #${args.id}? This cannot be undone.` })
    }
    if (!confirmed || prompts.isCancel(confirmed)) {
      prompts.outro("Cancelled")
      return
    }

    const spinner = prompts.spinner()
    spinner.start("Deleting…")

    try {
      const res = await irisFetch(`/api/v1/leads/${args.id}`, { method: "DELETE" })
      const ok = await handleApiError(res, "Delete lead")
      if (!ok) {
        spinner.stop("Failed", 1)
        prompts.outro("Done")
        return
      }

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
      .positional("remove", {
        describe: "lead ID(s) to merge into the primary and delete",
        type: "number",
        array: true,
        demandOption: true,
      })
      .option("force", { alias: "y", describe: "skip confirmation prompt", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    const removeIds: number[] = ((args.remove as number[]) ?? []).filter((id) => id !== args.keep)
    if (removeIds.length === 0) {
      prompts.log.error("Cannot merge a lead into itself.")
      prompts.outro("Done")
      return
    }
    prompts.intro(`◈  Merge Leads → keep #${args.keep}, remove ${removeIds.map((id) => `#${id}`).join(", ")}`)

    const token = await requireAuth()
    if (!token) {
      prompts.outro("Done")
      return
    }

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
      console.log(
        `  ${bold("Keep")} → #${args.keep}  ${primary.name ?? "Unknown"}  ${dim(primary.email ?? "")}  ${primary.status ?? ""}`,
      )
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
      let confirmed: boolean | symbol = args.force
      if (!confirmed) {
        if (isNonInteractive()) {
          prompts.log.error("Refusing to merge without --yes in non-interactive mode.")
          prompts.outro("Done")
          process.exitCode = 2
          return
        }
        confirmed = await prompts.confirm({
          message: `Merge ${removeIds.length} lead(s) into #${args.keep} and delete them?`,
        })
      }
      if (!confirmed || prompts.isCancel(confirmed)) {
        prompts.outro("Cancelled")
        return
      }

      const mergeSpinner = prompts.spinner()
      mergeSpinner.start("Merging…")

      // Use server-side merge endpoint (transfers all FKs: notes, tasks, comms, outreach, invoices, etc.)
      const mergeRes = await irisFetch(`/api/v1/leads/${args.keep}/merge`, {
        method: "POST",
        body: JSON.stringify({ remove: removeIds }),
      }).catch(() => null)

      if (mergeRes?.ok) {
        const result = await mergeRes.json().catch(() => ({}))
        mergeSpinner.stop(`${success("✓")} ${result.message ?? `Merged ${removeIds.length} lead(s) into #${args.keep}`}`)
      } else {
        // Fallback to legacy client-side merge if endpoint not available
        mergeSpinner.stop(dim("Server merge unavailable — falling back to legacy merge"))
        const legacySpinner = prompts.spinner()
        legacySpinner.start("Legacy merge…")

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

          await irisFetch(`/api/v1/leads/${rid}`, { method: "DELETE" })
        }

        legacySpinner.stop(`${success("✓")} Merged ${removeIds.length} lead(s) into #${args.keep} (legacy)`)
      }
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
          return {
            name: "Gmail",
            ok: false,
            status: "expired",
            error: "token expired",
            hint: "run: iris connect gmail",
          }
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
        const res = await fetch(`${BRIDGE_BASE}/api/calendar/events?days=1&limit=1`, {
          signal: AbortSignal.timeout(3000),
          headers: bridgeHeaders(),
        })
        if (res.ok) return { name: "Google Calendar", ok: true, status: "verified" }
        return {
          name: "Google Calendar",
          ok: false,
          status: "error",
          error: `HTTP ${res.status}`,
          hint: "check bridge: iris hive doctor",
        }
      } catch {
        return {
          name: "Google Calendar",
          ok: false,
          status: "not_connected",
          hint: "bridge not running — iris-daemon start",
        }
      }
    })(),

    // iMessage — verify macOS Messages.app SQLite access
    (async (): Promise<ChannelHealth> => {
      try {
        const { isAvailable } = await import("../lib/imessage")
        if (isAvailable()) {
          return { name: "iMessage", ok: true, status: "verified" }
        }
        return {
          name: "iMessage",
          ok: false,
          status: "no_permission",
          error: "Full Disk Access required",
          hint: "System Settings → Privacy → Full Disk Access → enable terminal",
        }
      } catch {
        return { name: "iMessage", ok: false, status: "error", error: "check failed", hint: "check macOS Messages.app" }
      }
    })(),

    // Apple Mail — verify via bridge
    (async (): Promise<ChannelHealth> => {
      try {
        const res = await fetch(`${BRIDGE_BASE}/api/mail/search?from=test&days=1&limit=1`, {
          signal: AbortSignal.timeout(3000),
          headers: bridgeHeaders(),
        })
        if (res.ok) return { name: "Apple Mail", ok: true, status: "verified" }
        return {
          name: "Apple Mail",
          ok: false,
          status: "error",
          error: `HTTP ${res.status}`,
          hint: "check bridge: iris hive doctor",
        }
      } catch {
        return {
          name: "Apple Mail",
          ok: false,
          status: "not_connected",
          hint: "bridge not running — iris-daemon start",
        }
      }
    })(),

    // Bridge health (covers iMessage bridge + Apple Mail)
    (async (): Promise<ChannelHealth> => {
      try {
        const res = await fetch(`${BRIDGE_BASE}/health`, { signal: AbortSignal.timeout(2000) })
        if (res.ok) return { name: "IRIS Bridge", ok: true, status: "verified" }
        return { name: "IRIS Bridge", ok: false, status: "error", error: `HTTP ${res.status}` }
      } catch {
        return { name: "IRIS Bridge", ok: false, status: "not_connected", hint: "run: iris-daemon start" }
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
    if (!token) {
      process.exitCode = 1
      return
    }

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
          } catch {
            /* non-fatal */
          }
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
          } catch {
            /* bridge offline → silent skip */
          }
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
          } catch {
            /* non-fatal */
          }
        }

        // ── WhatsApp (via local bridge — Playwright persistent session) ──
        // Try phone first, fall back to name (contacts may be saved by name, not number)
        if (phone || name) {
          const waHandles = [phone, name].filter(Boolean)
          for (const waHandle of waHandles) {
            try {
              const r = await fetch(
                `${BRIDGE_BASE}/api/whatsapp/search?handle=${encodeURIComponent(waHandle)}&days=${days}&limit=${msgLimit}`,
                { headers: bridgeHeaders(), signal: AbortSignal.timeout(15000) },
              )
              if (r.ok) {
                const d = (await r.json()) as any
                if (d?.messages?.length) {
                  channels.push({ name: "WhatsApp", messages: d.messages })
                  break // found messages, stop trying handles
                }
              }
            } catch {
              /* bridge offline or WA session expired → silent skip */
              break
            }
          }
        }

        // ── Map channel results → atlas/comms/ingest payload (same shape as pulse) ──
        const channelMap: Record<string, string> = { Gmail: "gmail", iMessage: "imessage", "Apple Mail": "apple_mail", WhatsApp: "whatsapp" }
        let leadIngested = 0
        for (const ch of channels) {
          const channelKey = channelMap[ch.name]
          if (!channelKey || ch.messages.length === 0) continue

          const items = ch.messages.map((msg: any) => {
            if (ch.name === "iMessage") {
              return {
                direction: msg.from_me ? "outbound" : "inbound",
                from_identifier: msg.from_me ? "me" : phone || email,
                body: msg.text ?? "",
                sent_at: msg.ts ?? msg.date ?? null,
                metadata: { source: "comms_sync_task" },
              }
            } else if (ch.name === "WhatsApp") {
              return {
                direction: msg.from_me ? "outbound" : "inbound",
                from_identifier: msg.from_me ? "me" : phone || email,
                body: msg.text ?? "",
                sent_at: msg.ts ?? msg.date ?? null,
                metadata: { source: "comms_sync_task", platform: "whatsapp" },
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
            } catch {
              /* non-fatal */
            }
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
      .option("hydrate", {
        describe: "generate + send follow-up if gate is unpaid + past throttle window",
        type: "boolean",
        default: false,
      })
      .option("dry-run", {
        describe: "with --hydrate: generate the AI email but don't send it",
        type: "boolean",
        default: false,
      })
      .option("to", { describe: "with --hydrate: redirect email to this address (for testing)", type: "string" })
      .option("force", { describe: "with --hydrate/--recap: ignore throttle window", type: "boolean", default: false })
      .option("recap", {
        describe: "generate + send professional status update email to this lead",
        type: "boolean",
        default: false,
      })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()

    const token = await requireAuth()
    if (!token) {
      prompts.outro("Done")
      return
    }

    let leadId = Number(args.id)

    // Resolve name/email → ID (same logic as leads get)
    if (isNaN(leadId)) {
      const spinner = prompts.spinner()
      spinner.start(`Looking up "${args.id}"…`)
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
          prompts.outro("Done")
          return
        }
        if (matches.length === 1) {
          leadId = matches[0].id
          spinner.stop(`Found: ${matches[0].name ?? matches[0].email ?? `#${leadId}`}`)
        } else if (isNonInteractive()) {
          // Non-TTY / parallel context — auto-pick first match with warning (#55742)
          leadId = matches[0].id
          spinner.stop(
            `${matches.length} matches — auto-selected: ${matches[0].name ?? matches[0].email ?? `#${leadId}`}`,
          )
          prompts.log.warn("Multiple matches found. Using first result. Other matches:")
          for (const m of matches.slice(1)) {
            prompts.log.info(
              `  #${m.id}  ${m.name ?? m.email ?? "Unknown"}${m.company ? `  ${m.company}` : ""}  ${m.status ?? ""}`,
            )
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
          if (prompts.isCancel(choice)) {
            prompts.cancel("Cancelled")
            return
          }
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
      if (!ok) {
        spinner.stop("Failed", 1)
        process.exitCode = 1
        prompts.outro("Done")
        return
      }

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

      // Resolve ALL known emails for this lead (primary + contact_info.emails + nurture_email)
      const allEmails: string[] = []
      if (email) allEmails.push(email.toLowerCase())
      const ci = lead.contact_info ?? {}
      if (ci.nurture_email && !allEmails.includes(ci.nurture_email.toLowerCase())) allEmails.push(ci.nurture_email.toLowerCase())
      if (Array.isArray(ci.emails)) {
        for (const e of ci.emails) {
          if (e && !allEmails.includes(String(e).toLowerCase())) allEmails.push(String(e).toLowerCase())
        }
      }

      spinner.stop(bold(name))
      printDivider()
      printKV("ID", lead.id)
      printKV("Email", email || dim("(none)"))
      if (allEmails.length > 1) printKV("Alt Emails", dim(allEmails.slice(1).join(", ")))
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
      } catch {
        /* non-fatal — render without the score */
      }

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
          const sparkline = recent.map((h) => blocks[Math.min(7, Math.max(0, Math.floor(h.score / 12.5)))]).join("")
          printKV("Trend", `${dim(sparkline)}  ${dim(`(${history.length} snapshots)`)}`)
        }

        // Per-signal breakdown — color-coded with effective weights.
        const sigs = pulseReadiness.signals ?? {}
        const weights = pulseReadiness.weights_applied ?? {}

        // Color a score value: green ≥75, yellow 40-74, red <40, gray null
        const fmtScore = (v: number | null | undefined, label?: string) => {
          if (v === null || v === undefined) return dim("—")
          const text = label ?? `${v}/100`
          if (v >= 75) return `${UI.Style.TEXT_SUCCESS}${text}${UI.Style.TEXT_NORMAL}`
          if (v >= 40) return `${UI.Style.TEXT_WARNING}${text}${UI.Style.TEXT_NORMAL}`
          return `${UI.Style.TEXT_DANGER}${text}${UI.Style.TEXT_NORMAL}`
        }

        const reqS = sigs.requirements?.score
        const liveS = sigs.liveness?.score
        const commsS = sigs.comms_freshness?.score
        const dealS = sigs.deal_health?.score
        const cfgS = sigs.config?.score
        const kbSig = sigs.knowledge_completeness
        const kbScore = kbSig?.score
        const kbLabel = kbSig ? `KB ${fmtScore(kbScore, `${kbSig.docs_count ?? 0}/${kbSig.docs_total ?? 8}`)}` : `KB ${dim("—")}`
        const meetSig = sigs.meeting_engagement
        const meetS = meetSig?.score
        const meetExtra = meetSig?.details ? ` ${dim(meetSig.details)}` : ""
        const delivSig = sigs.deliverable_completeness
        const delivS = delivSig?.score
        const delivExtra = delivSig ? ` ${dim(`${delivSig.passed ?? 0}/${delivSig.total ?? 8}`)}` : ""

        const sigLine = [
          `req ${fmtScore(reqS)}`,
          `live ${fmtScore(liveS)}`,
          `comms ${fmtScore(commsS)}`,
          `deal ${fmtScore(dealS)}`,
          `cfg ${fmtScore(cfgS)}`,
          kbLabel,
          `meet ${fmtScore(meetS)}${meetExtra}`,
          `deliv ${fmtScore(delivS)}${delivExtra}`,
        ].join(dim(" · "))
        printKV("Signals", sigLine)

        // Fix-it hints — actionable commands for each weak signal (<50)
        type FixHint = { signal: string; score: number | null | undefined; reason: string; fix: string }
        const fixHints: FixHint[] = []

        // Comms freshness
        if (commsS !== null && commsS !== undefined && commsS < 50) {
          const daysSince = sigs.comms_freshness?.days_since_inbound
          const reason = daysSince ? `no inbound in ${daysSince}d` : "no recent messages"
          fixHints.push({ signal: "comms", score: commsS, reason, fix: `iris leads note ${leadId} "called — discussed next steps"` })
        }

        // Deal health
        if (dealS !== null && dealS !== undefined && dealS < 50) {
          const checks = sigs.deal_health?.checks ?? {}
          if (!checks.has_payment_gate) {
            fixHints.push({ signal: "deal", score: dealS, reason: "no payment gate", fix: `iris leads payment-gate ${leadId} -a 500` })
          } else if (!checks.payment_received) {
            fixHints.push({ signal: "deal", score: dealS, reason: "payment gate unpaid", fix: `iris leads pulse ${leadId} --hydrate` })
          } else {
            fixHints.push({ signal: "deal", score: dealS, reason: "missing contract/proposal", fix: `iris leads upload ${leadId} ./proposal.pdf` })
          }
        }

        // Knowledge completeness
        if (kbScore !== null && kbScore !== undefined && kbScore < 50) {
          const count = kbSig?.docs_count ?? 0
          fixHints.push({ signal: "KB", score: kbScore, reason: `${count}/8 docs`, fix: `iris leads kb ${leadId} add ./doc.md` })
        }

        // Meeting engagement
        if (meetS !== null && meetS !== undefined && meetS < 50) {
          fixHints.push({ signal: "meet", score: meetS, reason: "no upcoming meetings", fix: `iris leads meet ${leadId} --at "next Tuesday 2pm"` })
        }

        // Deliverable completeness
        if (delivS !== null && delivS !== undefined && delivS < 50) {
          const passed = delivSig?.passed ?? 0
          const total = delivSig?.total ?? 8
          fixHints.push({ signal: "deliv", score: delivS, reason: `${passed}/${total} deliverables`, fix: `iris leads upload ${leadId} ./deliverable.pdf` })
        }

        // Task completion
        const taskS = sigs.task_completion?.score
        if (taskS !== null && taskS !== undefined && taskS < 50) {
          fixHints.push({ signal: "tasks", score: taskS, reason: "overdue or incomplete tasks", fix: `iris leads tasks ${leadId}` })
        }

        // Config
        if (cfgS !== null && cfgS !== undefined && cfgS < 50) {
          const missing: string[] = []
          const cc = sigs.config?.checks ?? {}
          if (!cc.has_email) missing.push("email")
          if (!cc.has_company) missing.push("company")
          if (!cc.has_bloq) missing.push("bloq")
          fixHints.push({ signal: "cfg", score: cfgS, reason: `missing ${missing.join(", ") || "config"}`, fix: `iris leads edit ${leadId}` })
        }

        // Requirements
        if (reqS !== null && reqS !== undefined && reqS < 50) {
          fixHints.push({ signal: "req", score: reqS, reason: "failing requirements", fix: `iris leads requirements ${leadId}` })
        }

        // Content output
        const contentS = sigs.content_output?.score
        if (contentS !== null && contentS !== undefined && contentS < 50) {
          fixHints.push({ signal: "content", score: contentS, reason: "low content output (30d)", fix: `iris leads content-engine create ${leadId}` })
        }

        // Response time
        const respS = sigs.response_time?.score
        if (respS !== null && respS !== undefined && respS < 50) {
          const avg = sigs.response_time?.avg_response_minutes
          const avgLabel = avg ? `avg reply ${Math.round(avg / 60)}h` : "slow replies"
          fixHints.push({ signal: "response", score: respS, reason: avgLabel, fix: `iris leads note ${leadId} "responded to inquiry"` })
        }

        if (fixHints.length > 0) {
          console.log()
          console.log(`  ${bold("Fix It")}  ${dim(`(${fixHints.length} signals below 50)`)}`)
          for (const h of fixHints) {
            const scoreLabel = h.score !== null && h.score !== undefined ? `${h.score}/100` : "—"
            const ew = weights[h.signal === "meet" ? "meeting_engagement" : h.signal === "deliv" ? "deliverable_completeness" : h.signal === "KB" ? "knowledge_completeness" : h.signal === "cfg" ? "config" : h.signal === "req" ? "requirements" : h.signal === "tasks" ? "task_completion" : h.signal === "content" ? "content_output" : h.signal === "response" ? "response_time" : h.signal]
            const ewLabel = ew ? dim(` (${Math.round(ew * 100)}%)`) : ""
            console.log(`    ${UI.Style.TEXT_DANGER}⚠${UI.Style.TEXT_NORMAL} ${h.signal} ${UI.Style.TEXT_DANGER}${scoreLabel}${UI.Style.TEXT_NORMAL}${ewLabel} — ${h.reason} → ${dim(h.fix)}`)
          }
        }
      }

      // Onboarding progress — compact inline display
      try {
        const obRes = await irisFetch(`/api/v1/leads/${leadId}/onboarding`)
        if (obRes.ok) {
          const obData = ((await obRes.json()) as any)?.data
          if (obData?.applied) {
            const obPct = obData.percent ?? 0
            const obColor = obPct >= 80 ? UI.Style.TEXT_SUCCESS : obPct >= 40 ? UI.Style.TEXT_WARNING : UI.Style.TEXT_DANGER
            const nextLabel = obData.next_incomplete ? ` — Next: ${obData.next_incomplete}` : ""
            printKV("Onboarding", `${obColor}${obData.completed}/${obData.total} (${obPct}%)${UI.Style.TEXT_NORMAL}${dim(nextLabel)}`)
          }
        }
      } catch { /* non-fatal */ }

      // Duplicate detection — search for leads with same email/phone/name
      let duplicateLeadIds: number[] = []
      try {
        const dupSearches: Promise<any[]>[] = []
        if (email)
          dupSearches.push(
            irisFetch(`/api/v1/leads?search=${encodeURIComponent(email)}&per_page=5`)
              .then(async (r) => (r.ok ? (((await r.json()) as any)?.data ?? []) : []))
              .catch(() => []),
          )
        if (phone)
          dupSearches.push(
            irisFetch(`/api/v1/leads?search=${encodeURIComponent(phone)}&per_page=5`)
              .then(async (r) => (r.ok ? (((await r.json()) as any)?.data ?? []) : []))
              .catch(() => []),
          )
        if (name && name !== `Lead #${leadId}`)
          dupSearches.push(
            irisFetch(`/api/v1/leads?search=${encodeURIComponent(name)}&per_page=5`)
              .then(async (r) => (r.ok ? (((await r.json()) as any)?.data ?? []) : []))
              .catch(() => []),
          )
        const results = await Promise.all(dupSearches)
        const allMatches = results.flat().filter((l: any) => l.id !== leadId)
        // Deduplicate by ID and require at least one concrete identifier match
        // (email or phone) to avoid false positives from fuzzy name search
        const seen = new Set<number>()
        for (const m of allMatches) {
          if (seen.has(m.id)) continue
          const emailMatch = email && m.email && m.email.toLowerCase() === email.toLowerCase()
          const phoneMatch = phone && m.phone && m.phone.replace(/\D/g, "") === phone.replace(/\D/g, "")
          if (!emailMatch && !phoneMatch) continue
          seen.add(m.id)
          duplicateLeadIds.push(m.id)
        }
        if (duplicateLeadIds.length > 0) {
          // #57685: Rank duplicates by data richness to suggest best master record
          const uniqueDups = allMatches.filter(
            (v: any, i: number, a: any[]) => a.findIndex((x: any) => x.id === v.id) === i,
          )
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
          console.log(
            `  ${UI.Style.TEXT_WARNING}⚠ Possible duplicates${UI.Style.TEXT_NORMAL}  ${dim(`(${duplicateLeadIds.length})`)}`,
          )
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
      } catch {
        /* non-fatal */
      }

      // CRM notes summary
      const notes: any[] = Array.isArray(lead.notes) ? lead.notes : []
      if (notes.length > 0) {
        console.log()
        console.log(`  ${bold("CRM Notes")}  ${dim(`(${notes.length})`)}`)
        // #57684: Mask credentials/tokens/passwords in note previews
        const maskSecrets = (text: string): string =>
          text
            .replace(
              /(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret)\s*[:=]\s*\S+/gi,
              (m) => m.split(/[:=]/)[0] + ": ●●●●●●●●",
            )
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

      // Deal Health section (#57649/#57665) — fetch deal-status + stripe-payments + score + activities + outreach + workflows in parallel
      let dealHealth: any = null
      let stripeData: any = null
      let leadTasks: any[] = []
      let leadScore: any = null
      let activities: any[] = []
      let outreachSteps: any[] = []
      let leadWorkflows: any[] = []
      let productUsage: any = null
      let leadOpportunities: any[] = []
      {
        const userId = await resolveUserId()
        const bloqId = (lead.bloq_ids ?? [])[0]
        const [dealRes, stripeRes, tasksRes, scoreRes, activityRes, outreachRes, workflowsRes, usageRes, oppsRes] = await Promise.allSettled([
          irisFetch(`/api/v1/leads/${leadId}/deal-status`),
          irisFetch(`/api/v1/leads/${leadId}/stripe-payments`),
          irisFetch(`/api/v1/leads/${leadId}/tasks`),
          irisFetch(`/api/v1/leads/${leadId}/score`),
          irisFetch(`/api/v1/leads/${leadId}/activities?limit=20`),
          irisFetch(`/api/v1/leads/${leadId}/outreach-steps`),
          bloqId && userId ? irisFetch(`/api/v1/users/${userId}/bloqs/workflows?bloq_id=${bloqId}&per_page=20`) : Promise.resolve(null),
          irisFetch(`/api/v1/leads/${leadId}/usage`),
          irisFetch(`/api/v1/marketplace/opportunities?lead_id=${leadId}&limit=10`),
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
        // Parse outreach steps
        if (outreachRes.status === "fulfilled" && outreachRes.value?.ok) {
          const od = ((await outreachRes.value.json()) as any)?.data
          outreachSteps = Array.isArray(od) ? od : (od?.steps ?? [])
        }
        // Parse workflows for this lead's bloq
        if (workflowsRes.status === "fulfilled" && workflowsRes.value?.ok) {
          const wd = ((await workflowsRes.value.json()) as any)?.data
          leadWorkflows = Array.isArray(wd) ? wd : []
        }
        // Parse product usage data
        if (usageRes.status === "fulfilled" && usageRes.value?.ok) {
          productUsage = ((await usageRes.value.json()) as any)?.data ?? null
        }
        // Parse opportunities linked to this lead
        if (oppsRes.status === "fulfilled" && oppsRes.value?.ok) {
          const od = ((await oppsRes.value.json()) as any)?.data?.data
          leadOpportunities = Array.isArray(od) ? od : []
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
          } catch {
            /* non-fatal */
          }
        }
      }

      // #71782: Engagement Score — composite score from backend LeadScoringService
      if (leadScore) {
        const s = leadScore.score ?? 0
        const scoreLabel =
          s >= 70
            ? success(`${s}/100`)
            : s >= 40
              ? `${UI.Style.TEXT_WARNING}${s}/100${UI.Style.TEXT_NORMAL}`
              : `${UI.Style.TEXT_DANGER}${s}/100${UI.Style.TEXT_NORMAL}`
        const hotBadge = leadScore.is_hot_lead ? `  ${success("HOT")}` : ""
        printKV("Engagement", `${scoreLabel}${hotBadge}`)
      }

      // Render Deal Health — always show (#57659)
      console.log()
      console.log(`  ${bold("Deal Health")}`)
      if (dealHealth?.has_payment_gate) {
        const gateStatus = dealHealth.payment_received
          ? success("Paid")
          : dealHealth.status === "sent" || dealHealth.status === "awaiting_payment"
            ? dim("Sent — awaiting payment")
            : dim(dealHealth.status ?? "Draft")
        printKV("  Payment Gate", gateStatus)
        if (dealHealth.amount) printKV("  Amount", `$${Number(dealHealth.amount).toFixed(2)}`)
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
        printKV(
          "  Stripe Received",
          totalPaid > 0 ? success(`$${Number(totalPaid).toFixed(2)}`) + stripeDupNote : dim("$0"),
        )
        if (s.total_invoices > 0) {
          printKV(
            "  Stripe Invoices",
            `${s.total_invoices} (${s.paid_invoices} paid${s.pending_invoices > 0 ? `, ${s.pending_invoices} pending` : ""})`,
          )
        } else {
          printKV("  Stripe Invoices", dim("None"))
        }
        // #57691: Show subscription details (MRR + next billing)
        if (s.active_subscriptions > 0) {
          const subs = stripeData.subscriptions ?? []
          const activeSubs = subs.filter((sub: any) => sub.status === "active" || sub.status === "trialing")
          if (activeSubs.length > 0) {
            for (const sub of activeSubs) {
              const amt = sub.amount ? `$${Number(sub.amount).toFixed(2)}` : (sub.plan_name ?? "active")
              const interval = sub.interval ? `/${sub.interval}` : ""
              const nextBill = sub.current_period_end ? dim(` · next: ${sub.current_period_end}`) : ""
              printKV("  Subscription", `${success(amt + interval)}${nextBill}`)
            }
          } else {
            printKV("  Subscriptions", `${s.active_subscriptions} active`)
          }
        }
        if (s.past_due_subscriptions > 0)
          printKV(
            "  Past Due",
            `${UI.Style.TEXT_DANGER}${s.past_due_subscriptions} subscription(s)${UI.Style.TEXT_NORMAL}`,
          )
        if (s.pending_sessions > 0) printKV("  Checkout", dim(`${s.pending_sessions} pending session(s)`))
      } else if (!stripeData?.has_stripe_customer) {
        printKV("  Stripe", dim("No Stripe customer"))
      } else {
        printKV("  Stripe", dim("Connected — no payments yet"))
      }

      // Deal-status extras (contracts, proposals)
      const contracts = dealHealth?.contracts ?? []
      printKV(
        "  Contracts",
        contracts.length > 0
          ? `${contracts.length} (${contracts.filter((c: any) => c.signed_at).length} signed)`
          : dim("None"),
      )
      const proposals = dealHealth?.proposals ?? []
      printKV("  Proposals", proposals.length > 0 ? `${proposals.length}` : dim("None"))

      // Content engine check — from config signal (has_content_engine) + deal_health signal (has_content_agent)
      const dealChecks = pulseReadiness?.signals?.deal_health?.checks ?? {}
      const configChecks = pulseReadiness?.signals?.config?.checks ?? {}
      const hasEngine = configChecks.has_content_engine === true || dealChecks.has_content_agent === true
      if (hasEngine) {
        printKV("  Content Engine", success("Active"))
      } else if (lead.status === "Won" || lead.status === "Active" || lead.status === "Converted") {
        printKV(
          "  Content Engine",
          `${UI.Style.TEXT_WARNING}Not configured${UI.Style.TEXT_NORMAL}  ${dim(`iris leads content-engine create ${leadId}`)}`,
        )
      } else if (dealChecks.has_content_agent === false) {
        printKV("  Content Agent", dim("Not configured"))
      }

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
          const overdueMark =
            t.due_date && new Date(t.due_date) < now ? ` ${UI.Style.TEXT_DANGER}OVERDUE${UI.Style.TEXT_NORMAL}` : ""
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

      // Opportunities linked to this lead
      if (leadOpportunities.length > 0) {
        console.log()
        console.log(`  ${bold("Opportunities")}  ${dim(`(${leadOpportunities.length})`)}`)
        for (const opp of leadOpportunities.slice(0, 5)) {
          const title = opp.public_title ?? opp.title ?? "Untitled"
          const parts: string[] = []
          if (opp.funding_goal_cents) parts.push(`$${(opp.funding_goal_cents / 100).toFixed(0)} goal`)
          if (opp.total_raised_cents) parts.push(`$${(opp.total_raised_cents / 100).toFixed(0)} raised`)
          if (opp.applications_count) parts.push(`${opp.applications_count} apps`)
          if (opp.investment_interests_count) parts.push(`${opp.investment_interests_count} investors`)
          console.log(`    ${dim(`#${opp.id}`)}  ${title}  ${dim(parts.join(" · "))}`)
        }
        if (leadOpportunities.length > 5)
          console.log(`    ${dim(`…and ${leadOpportunities.length - 5} more`)}`)
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
            const statusText =
              rs.failing > 0
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
          const who = act.is_system_generated
            ? dim(" [system]")
            : act.user_name && act.user_name !== "Unknown User"
              ? dim(` [${act.user_name}]`)
              : ""
          console.log(`    ${icon} ${highlight(type.padEnd(18))}${content}${dateStr}${who}`)
        }
        if (activities.length > 8)
          console.log(`    ${dim(`…and ${activities.length - 8} more — iris leads activities ${leadId}`)}`)
      }

      // Step 2: Integration pre-flight checks (#57677)
      console.log()
      console.log(`  ${bold("Integration Health")}`)
      const healthChecks = await runChannelHealthChecks()
      for (const hc of healthChecks) {
        const icon = hc.ok
          ? success("✓")
          : hc.status === "not_connected"
            ? dim("—")
            : `${UI.Style.TEXT_DANGER}✗${UI.Style.TEXT_NORMAL}`
        const statusText = hc.ok
          ? success("connected + verified")
          : hc.status === "not_connected"
            ? dim("not connected")
            : `${UI.Style.TEXT_DANGER}${hc.error}${UI.Style.TEXT_NORMAL}`
        const hint = !hc.ok && hc.hint ? dim(` — ${hc.hint}`) : ""
        console.log(`  ${icon} ${highlight(hc.name.padEnd(18))}${statusText}${hint}`)
      }

      // Step 2.5: Requirements (automated tests for this lead's deliverables)
      try {
        const reqRes = await irisFetch(`/api/v1/leads/${leadId}/requirements`)
        if (reqRes.ok) {
          const reqBody = await reqRes.json().catch(() => ({}))
          const reqs: any[] = reqBody.data ?? []
          if (reqs.length > 0) {
            const passing = reqs.filter((r) => r.last_status === "passed" || r.last_status === "completed").length
            const failing = reqs.filter((r) => r.last_status === "failed").length
            const untested = reqs.length - passing - failing
            const headerColor = failing > 0 ? highlight : untested === reqs.length ? dim : success

            console.log()
            console.log(
              `  ${bold("Requirements")}  ${headerColor(`${passing}/${reqs.length} passing`)}${failing > 0 ? highlight(` · ${failing} FAILING`) : ""}${untested > 0 ? dim(` · ${untested} untested`) : ""}`,
            )
            for (const r of reqs.slice(0, 5)) {
              const icon =
                r.last_status === "passed" || r.last_status === "completed"
                  ? success("✓")
                  : r.last_status === "failed"
                    ? `${UI.Style.TEXT_DANGER}✗${UI.Style.TEXT_NORMAL}`
                    : dim("○")
              const lastRun = r.last_run_at ? dim(r.last_run_at.split("T")[0]) : dim("never run")
              console.log(`  ${icon} ${highlight(r.name.padEnd(28))}${lastRun}`)
            }
            if (reqs.length > 5)
              console.log(dim(`  …and ${reqs.length - 5} more — iris leads requirements list ${leadId}`))
            if (untested > 0) console.log(dim(`  Run all: iris leads requirements run ${leadId}`))
          }
        }
      } catch (e) {
        /* requirements section is best-effort */
      }

      // Step 3: Search channels in parallel
      console.log()
      const channelSpinner = prompts.spinner()
      channelSpinner.start("Scanning channels…")

      const days = args.days as number
      const channels: { name: string; messages: any[]; error?: string }[] = []

      // Timeout wrapper — prevents any single channel fetch from hanging the entire pulse (#104244)
      const withTimeout = <T>(promise: Promise<T>, ms: number, label: string): Promise<T> => {
        return Promise.race([
          promise,
          new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms)),
        ])
      }
      const CHANNEL_TIMEOUT = 15000 // 15s per channel

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
            withTimeout(irisFetch(`/api/v1/leads/${leadId}/gmail-threads`), CHANNEL_TIMEOUT, "Gmail")
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
                  // Filter to only threads involving ANY of the lead's emails (#55723)
                  const filtered = msgs.filter((m: any) => {
                    if (!m.from) return true // keep if no from info
                    const fromLower = m.from.toLowerCase()
                    return allEmails.some((e) => fromLower.includes(e))
                  })
                  channels.push({ name: "Gmail", messages: filtered })
                } else {
                  // Fallback: try Apple Mail-style search via bridge as Gmail backup
                  const body = await r.text().catch(() => "")
                  let errorMsg = `HTTP ${r.status}`
                  try {
                    errorMsg = JSON.parse(body)?.error ?? JSON.parse(body)?.message ?? errorMsg
                  } catch {}
                  channels.push({ name: "Gmail", messages: [], error: errorMsg })
                }
              })
              .catch((e) => {
                channels.push({ name: "Gmail", messages: [], error: e.message })
              }),
          )
        }

        // iMessage (via local bridge daemon) — 1:1 by phone/email handle or contact name
        const handle = phone || email
        if (handle) {
          fetches.push(
            withTimeout(fetch(
              `${BRIDGE_BASE}/api/imessage/search?handle=${encodeURIComponent(handle)}&days=${days}&limit=${msgLimit}`,
              { headers: bridgeHeaders() },
            ), CHANNEL_TIMEOUT, "iMessage")
              .then(async (r) => {
                if (r.ok) {
                  const d = (await r.json()) as any
                  channels.push({ name: "iMessage", messages: d?.messages ?? [] })
                } else {
                  const body = await r.text().catch(() => "")
                  channels.push({ name: "iMessage", messages: [], error: body || `HTTP ${r.status}` })
                }
              })
              .catch((e) => {
                channels.push({ name: "iMessage", messages: [], error: e.message })
              }),
          )
        } else if (name) {
          // Fallback: search by contact name via Contacts.app resolution
          fetches.push(
            withTimeout(fetch(
              `${BRIDGE_BASE}/api/imessage/search?name=${encodeURIComponent(name)}&days=${days}&limit=${msgLimit}`,
              { headers: bridgeHeaders() },
            ), CHANNEL_TIMEOUT, "iMessage")
              .then(async (r) => {
                if (r.ok) {
                  const d = (await r.json()) as any
                  channels.push({ name: "iMessage", messages: d?.messages ?? [] })
                } else {
                  const body = await r.text().catch(() => "")
                  channels.push({ name: "iMessage", messages: [], error: body || `HTTP ${r.status}` })
                }
              })
              .catch((e) => {
                channels.push({ name: "iMessage", messages: [], error: e.message })
              }),
          )
        } else {
          channels.push({
            name: "iMessage",
            messages: [],
            error: `No phone, email, or name — add with: iris leads update ${leadId} --phone "..."`,
          })
        }

        // #71781: iMessage group chats — scan linked chat IDs or auto-discover via bridge
        let chatIds: string[] = Array.isArray(lead.contact_info?.chat_ids) ? lead.contact_info.chat_ids : []
        // Auto-discover group chats if none linked and we have a handle
        if (chatIds.length === 0 && handle) {
          fetches.push(
            fetch(`${BRIDGE_BASE}/api/imessage/group-chats?handle=${encodeURIComponent(handle)}&days=${days}&limit=5`, {
              headers: bridgeHeaders(),
            })
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
                    fetch(
                      `${BRIDGE_BASE}/api/imessage/search?handle=${encodeURIComponent(chatId)}&days=${days}&limit=${msgLimit}`,
                      { headers: bridgeHeaders() },
                    )
                      .then(async (r2) => {
                        if (r2.ok) {
                          const d2 = (await r2.json()) as any
                          const label =
                            groups.find((g: any) => g.chat_identifier === chatId)?.display_name || chatId.slice(0, 12)
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
              fetch(
                `${BRIDGE_BASE}/api/imessage/search?handle=${encodeURIComponent(chatId)}&days=${days}&limit=${msgLimit}`,
                { headers: bridgeHeaders() },
              )
                .then(async (r) => {
                  if (r.ok) {
                    const d = (await r.json()) as any
                    channels.push({ name: `iMessage Group (${chatId.slice(0, 12)}…)`, messages: d?.messages ?? [] })
                  } else {
                    channels.push({
                      name: `iMessage Group`,
                      messages: [],
                      error: `Chat ${chatId.slice(0, 20)} — HTTP ${r.status}`,
                    })
                  }
                })
                .catch((e) => {
                  channels.push({ name: `iMessage Group`, messages: [], error: e.message })
                }),
            )
          }
        }

        // Apple Mail (via local bridge daemon) — scan ALL known emails
        for (const scanEmail of allEmails.length > 0 ? allEmails : (email ? [email] : [])) {
          fetches.push(
            withTimeout(fetch(
              `${BRIDGE_BASE}/api/mail/search?from=${encodeURIComponent(scanEmail)}&days=${days}&limit=${msgLimit}&include_body=0&include_attachments=1`,
              { headers: bridgeHeaders() },
            ), CHANNEL_TIMEOUT, `Apple Mail (${scanEmail})`)
              .then(async (r) => {
                if (r.ok) {
                  const d = (await r.json()) as any
                  const msgs = d?.messages ?? []
                  // Merge into existing Apple Mail channel or create new
                  const existing = channels.find((ch) => ch.name === "Apple Mail")
                  if (existing) {
                    // Dedup by date+subject
                    for (const m of msgs) {
                      if (!existing.messages.some((e: any) => e.date === m.date && e.subject === m.subject)) {
                        existing.messages.push(m)
                      }
                    }
                  } else {
                    channels.push({ name: "Apple Mail", messages: msgs })
                  }
                } else {
                  const body = await r.text().catch(() => "")
                  if (!channels.find((ch) => ch.name === "Apple Mail")) {
                    channels.push({ name: "Apple Mail", messages: [], error: body || `HTTP ${r.status}` })
                  }
                }
              })
              .catch((e) => {
                if (!channels.find((ch) => ch.name === "Apple Mail")) {
                  channels.push({ name: "Apple Mail", messages: [], error: e.message })
                }
              }),
          )
        }

        // Google Calendar meetings (search by lead name/email)
        fetches.push(
          withTimeout(fetchLeadCalendarEvents({ name, email, emails: allEmails, id: leadId }, { days, futureDays: 90 }), CHANNEL_TIMEOUT, "Calendar")
            .then(({ past, upcoming }) => {
              const allEvents = [...upcoming, ...past].map((ev) => ({
                summary: ev.summary || "(no title)",
                date: ev.start || ev.start_time || "",
                status: new Date(ev.start || ev.start_time || "") >= new Date() ? "upcoming" : "past",
                location: ev.location || "",
              }))
              channels.push({ name: "Meetings", messages: allEvents })
            })
            .catch((e) => {
              channels.push({ name: "Meetings", messages: [], error: e.message })
            }),
        )

        await Promise.allSettled(fetches)

        const totalMessages = channels.reduce((sum, ch) => sum + ch.messages.length, 0)
        channelSpinner.stop(`${totalMessages} message(s) across ${channels.length} channel(s)`)

        // Persist-after: fire-and-forget write to lead_comms for history (#57657)
        // Maps live-scan results → atlas:comms ingest format. Dedup hash prevents duplicates.
        const channelMap: Record<string, string> = {
          Gmail: "gmail",
          iMessage: "imessage",
          "Apple Mail": "apple_mail",
          Meetings: "calendar",
        }
        for (const ch of channels) {
          const channelKey = channelMap[ch.name]
          if (!channelKey || ch.messages.length === 0) continue
          const items = ch.messages
            .map((msg: any) => {
              if (ch.name === "iMessage") {
                return {
                  direction: msg.from_me ? "outbound" : "inbound",
                  from_identifier: msg.from_me ? "me" : phone || email,
                  body: msg.text ?? "",
                  sent_at: msg.ts ?? msg.date ?? null,
                  metadata: { source: "pulse_scan" },
                }
              } else if (ch.name === "Gmail") {
                return {
                  direction: (msg.from ?? "").toLowerCase().includes(email.toLowerCase()) ? "inbound" : "outbound",
                  from_identifier: msg.from ?? "",
                  subject: msg.subject ?? "",
                  body: msg.snippet ?? msg.subject ?? "",
                  sent_at: msg.date ?? null,
                  metadata: { gmail_thread_id: msg.thread_id, source: "pulse_scan" },
                }
              } else if (ch.name === "Apple Mail") {
                return {
                  direction: "inbound",
                  from_identifier: email,
                  subject: msg.subject ?? "",
                  body: msg.body ?? msg.subject ?? "",
                  sent_at: msg.date ?? msg.ts ?? null,
                  metadata: { source: "pulse_scan" },
                }
              } else if (ch.name === "Meetings") {
                return {
                  direction: "outbound",
                  from_identifier: "me",
                  subject: msg.summary ?? "",
                  body: `Meeting: ${msg.summary ?? ""}${msg.location ? ` @ ${msg.location}` : ""}`,
                  sent_at: msg.date ?? null,
                  metadata: { event_status: msg.status, source: "pulse_scan" },
                }
              }
              return null
            })
            .filter(Boolean)
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
        console.log(
          JSON.stringify(
            { lead, dealHealth, stripeData, tasks: leadTasks, score: leadScore, activities, outreachSteps, workflows: leadWorkflows, productUsage, channels },
            null,
            2,
          ),
        )
        prompts.outro("Done")
        return
      }

      // Step 3: Display channel results
      for (const ch of channels) {
        console.log()
        const count = ch.messages.length
        const label = ch.error ? `${ch.name}  ${dim(`⚠ ${ch.error}`)}` : `${ch.name}  ${dim(`(${count})`)}`
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

      // ── NEW: Communication Intelligence ──
      // Sentiment analysis + response time metrics (#104244: per-section try-catch)
      try {
      if (channels.length > 0) {
        const allMessages: Array<{ text: string; date: string; isOutbound: boolean; channel: string }> = []

        for (const ch of channels) {
          for (const msg of ch.messages) {
            const text = msg.text ?? msg.subject ?? msg.body ?? msg.summary ?? ""
            const date = msg.ts ?? msg.date ?? ""
            const isOutbound =
              ch.name === "iMessage"
                ? msg.from_me
                : ch.name === "Gmail"
                  ? !(msg.from ?? "").toLowerCase().includes(email.toLowerCase())
                  : ch.name === "Meetings"
                    ? msg.status === "upcoming" || msg.status === "past"
                    : false

            if (text && date) {
              allMessages.push({ text, date, isOutbound, channel: ch.name })
            }
          }
        }

        // Sort by date ascending for response time calc
        allMessages.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())

        // Sentiment Analysis — dual-model A/B (gpt-4o-mini vs grok-3-fast)
        type SentimentResult = { score: number; label: string; summary: string; model: string; latencyMs: number }
        const sentimentResults: SentimentResult[] = []
        {
          const recentMsgs = allMessages.slice(-10)
          if (recentMsgs.length > 0) {
            const digest = recentMsgs.map((m) => `[${m.isOutbound ? "YOU" : "THEM"}] ${m.text.slice(0, 200)}`).join("\n")
            const sysPrompt = `You analyze business communication sentiment. Return ONLY valid JSON, no markdown fences.
Format: {"score": <-1.0 to 1.0>, "label": "<positive|neutral|negative|mixed>", "summary": "<1 sentence describing the relationship tone and trajectory>"}
Score meaning: -1.0 = hostile/churning, -0.5 = frustrated, 0 = neutral/transactional, 0.5 = warm/engaged, 1.0 = enthusiastic/advocate.
Consider context: "fixed the DNS issue" is positive (problem solved), not negative. Focus on relationship health, not topic negativity.`
            const userPrompt = `Analyze the sentiment of this recent conversation between a business and their client:\n\n${digest}`

            let openaiKey: string | null = process.env.OPENAI_API_KEY ?? null
            let xaiKey: string | null = process.env.XAI_API_KEY ?? null
            try {
              for (const ep of [join(homedir(), ".iris", "sdk", ".env"), join(homedir(), "Sites", "freelabel", "fl-docker-dev", "fl-api", ".env")]) {
                if (openaiKey && xaiKey) break
                const f = Bun.file(ep)
                if (await f.exists()) {
                  for (const line of (await f.text()).split("\n")) {
                    if (!openaiKey) { const m = line.match(/^OPENAI_API_KEY\s*=\s*(.+)/); if (m?.[1]) openaiKey = m[1].trim() }
                    if (!xaiKey) { const m = line.match(/^XAI_API_KEY\s*=\s*(.+)/); if (m?.[1]) xaiKey = m[1].trim() }
                  }
                }
              }
            } catch {}

            const callModel = async (url: string, key: string, model: string, label: string, extra?: Record<string, unknown>): Promise<SentimentResult | null> => {
              const t0 = Date.now()
              try {
                const res = await fetch(url, {
                  method: "POST",
                  headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
                  body: JSON.stringify({ model, max_completion_tokens: 200, messages: [{ role: "system", content: sysPrompt }, { role: "user", content: userPrompt }], ...extra }),
                })
                const ms = Date.now() - t0
                if (!res.ok) return null
                const data = (await res.json()) as any
                const raw = (data?.choices?.[0]?.message?.content ?? "").replace(/```json\s*|```\s*/g, "").trim()
                const p = JSON.parse(raw)
                return { score: typeof p.score === "number" ? p.score : 0, label: p.label ?? "neutral", summary: p.summary ?? "", model: label, latencyMs: ms }
              } catch { return null }
            }

            if (openaiKey) {
              const r = await callModel("https://api.openai.com/v1/chat/completions", openaiKey, "gpt-5-nano", "gpt-5-nano", { reasoning_effort: "low" })
              if (r) sentimentResults.push(r)
            }
          }
        }

        // Response time metrics — business hours aware
        // Counts only Mon-Fri 8am-6pm hours between messages (excludes overnight + weekends)
        const businessHoursBetween = (startDate: Date, endDate: Date): number => {
          if (endDate <= startDate) return 0
          let hours = 0
          const cursor = new Date(startDate)
          while (cursor < endDate) {
            const day = cursor.getDay() // 0=Sun, 6=Sat
            const hour = cursor.getHours()
            if (day >= 1 && day <= 5 && hour >= 8 && hour < 18) {
              hours += 1
            }
            cursor.setTime(cursor.getTime() + 3600000) // advance 1 hour
            // Safety: cap at 500 iterations (3 weeks of hours)
            if (hours > 500) break
          }
          return hours
        }

        const yourResponses: number[] = []
        const theirResponses: number[] = []
        const yourBizResponses: number[] = []
        const theirBizResponses: number[] = []
        for (let i = 1; i < allMessages.length; i++) {
          const prev = allMessages[i - 1]
          const curr = allMessages[i]
          if (prev.isOutbound !== curr.isOutbound) {
            const prevDate = new Date(prev.date)
            const currDate = new Date(curr.date)
            const wallHours = (currDate.getTime() - prevDate.getTime()) / (1000 * 60 * 60)
            if (wallHours > 0 && wallHours < 7 * 24) {
              const bizHours = businessHoursBetween(prevDate, currDate)
              if (curr.isOutbound) {
                yourResponses.push(wallHours)
                yourBizResponses.push(bizHours)
              } else {
                theirResponses.push(wallHours)
                theirBizResponses.push(bizHours)
              }
            }
          }
        }

        const avg = (arr: number[]) => arr.length > 0 ? arr.reduce((s, v) => s + v, 0) / arr.length : null
        const avgYourResponse = avg(yourResponses)
        const avgTheirResponse = avg(theirResponses)
        const avgYourBiz = avg(yourBizResponses)
        const avgTheirBiz = avg(theirBizResponses)

        console.log()
        console.log(`  ${bold("Communication Intelligence")}`)

        // Sentiment
        if (sentimentResults.length > 0) {
          const r = sentimentResults[0]
          const lbl = r.score > 0.3 ? success(r.label) : r.score < -0.3 ? `${UI.Style.TEXT_DANGER}${r.label}${UI.Style.TEXT_NORMAL}` : r.label === "mixed" ? `${UI.Style.TEXT_WARNING}${r.label}${UI.Style.TEXT_NORMAL}` : dim(r.label)
          printKV("  Sentiment", `${lbl} ${dim(`(${r.score.toFixed(1)})`)}`)
          if (r.summary) console.log(`    ${dim(r.summary)}`)
        }

        // Response times
        const fmtH = (h: number) => h < 1 ? `${Math.round(h * 60)}m` : h < 24 ? `${h.toFixed(1)}h` : `${(h / 24).toFixed(1)}d`
        if (avgYourResponse !== null) {
          const bizNote = avgYourBiz !== null ? dim(` (${fmtH(avgYourBiz)} biz hrs)`) : ""
          printKV("  Your Avg Response", `${fmtH(avgYourResponse)}${bizNote}`)
        }
        if (avgTheirResponse !== null) {
          const theirColor = avgTheirResponse > 48 ? UI.Style.TEXT_WARNING : ""
          const theirNormal = avgTheirResponse > 48 ? UI.Style.TEXT_NORMAL : ""
          const bizNote = avgTheirBiz !== null ? dim(` (${fmtH(avgTheirBiz)} biz hrs)`) : ""
          printKV("  Their Avg Response", `${theirColor}${fmtH(avgTheirResponse)}${theirNormal}${bizNote}`)
        }
      }
      } catch (sectionErr) {
        console.log(`  ${dim(`Communication Intelligence: ${sectionErr instanceof Error ? sectionErr.message : String(sectionErr)}`)}`)
      }

      // ── Team Context — who else is working with this lead ──
      try {
      {
        // Extract unique team members from activities + outreach steps + tasks
        const teamMembers = new Map<string, { name: string; roles: Set<string>; lastActive: string }>()

        // From activities
        for (const act of activities) {
          if (act.user_name && act.user_name !== "Unknown User" && !act.is_system_generated) {
            const existing = teamMembers.get(act.user_name)
            if (existing) {
              existing.roles.add(act.activity_type ?? "activity")
              if (act.created_at > existing.lastActive) existing.lastActive = act.created_at
            } else {
              teamMembers.set(act.user_name, {
                name: act.user_name,
                roles: new Set([act.activity_type ?? "activity"]),
                lastActive: act.created_at ?? "",
              })
            }
          }
        }

        // From outreach steps
        for (const step of outreachSteps) {
          const sender = step.sent_by_name ?? step.assigned_to_name
          if (sender) {
            const existing = teamMembers.get(sender)
            if (existing) {
              existing.roles.add("outreach")
              if (step.completed_at && step.completed_at > existing.lastActive) existing.lastActive = step.completed_at
            } else {
              teamMembers.set(sender, {
                name: sender,
                roles: new Set(["outreach"]),
                lastActive: step.completed_at ?? step.created_at ?? "",
              })
            }
          }
        }

        // From tasks
        for (const task of leadTasks) {
          const assignee = task.assigned_to_name ?? task.assignee_name
          if (assignee) {
            const existing = teamMembers.get(assignee)
            if (existing) {
              existing.roles.add("tasks")
            } else {
              teamMembers.set(assignee, {
                name: assignee,
                roles: new Set(["tasks"]),
                lastActive: task.updated_at ?? task.created_at ?? "",
              })
            }
          }
        }

        // From CRM notes — track unique user_ids who contributed (non-system)
        const noteUserIds = new Set<number>()
        const crmNotes: any[] = Array.isArray(lead.notes) ? lead.notes : []
        for (const n of crmNotes) {
          if (typeof n === "object" && n.user_id && !n.is_system_generated) {
            noteUserIds.add(n.user_id)
            const key = `user:${n.user_id}`
            const existing = teamMembers.get(key)
            if (existing) {
              existing.roles.add("notes")
              if (n.created_at && n.created_at > existing.lastActive) existing.lastActive = n.created_at
            } else {
              teamMembers.set(key, { name: n.created_by_name ?? n.author_name ?? n.user_name ?? `User #${n.user_id}`, roles: new Set(["notes"]), lastActive: n.created_at ?? "" })
            }
          }
        }

        // Lead owner / assigned_to — use user_id as fallback key
        const ownerId = lead.assigned_to ?? lead.owner_id ?? lead.user_id
        const ownerName = lead.assigned_to_name ?? lead.owner_name
        if (ownerId) {
          const key = ownerName ?? `user:${ownerId}`
          const existing = teamMembers.get(key)
          if (existing) {
            existing.roles.add("owner")
          } else {
            teamMembers.set(key, { name: ownerName ?? `User #${ownerId}`, roles: new Set(["owner"]), lastActive: "" })
          }
        }

        if (teamMembers.size > 0) {
          console.log()
          console.log(`  ${bold("Team Context")}  ${dim(`(${teamMembers.size})`)}`)
          const sorted = [...teamMembers.values()].sort((a, b) => {
            if (a.roles.has("owner") && !b.roles.has("owner")) return -1
            if (!a.roles.has("owner") && b.roles.has("owner")) return 1
            return (b.lastActive || "").localeCompare(a.lastActive || "")
          })
          for (const member of sorted.slice(0, 6)) {
            const roleList = [...member.roles].join(", ")
            const lastDate = member.lastActive ? dim(` · last: ${member.lastActive.split("T")[0]}`) : ""
            const ownerBadge = member.roles.has("owner") ? ` ${success("OWNER")}` : ""
            console.log(`    ${highlight(member.name.padEnd(20))}${dim(roleList)}${ownerBadge}${lastDate}`)
          }
          if (sorted.length > 6) console.log(`    ${dim(`…and ${sorted.length - 6} more`)}`)
        }
      }
      } catch (sectionErr) {
        console.log(`  ${dim(`Team Context: ${sectionErr instanceof Error ? sectionErr.message : String(sectionErr)}`)}`)
      }

      // ── Workflow & Outreach Status — sequences/automations running for this lead ──
      try {
      {
        // Outreach steps (sequences)
        if (outreachSteps.length > 0) {
          const completed = outreachSteps.filter((s: any) => s.status === "completed" || s.completed_at)
          const pending = outreachSteps.filter((s: any) => s.status === "pending" || (!s.completed_at && s.status !== "skipped"))
          const skipped = outreachSteps.filter((s: any) => s.status === "skipped")

          console.log()
          console.log(`  ${bold("Outreach Sequence")}  ${dim(`(${outreachSteps.length} steps)`)}`)
          printKV("  Completed", completed.length > 0 ? success(String(completed.length)) : dim("0"))
          printKV("  Pending", pending.length > 0 ? `${UI.Style.TEXT_WARNING}${pending.length}${UI.Style.TEXT_NORMAL}` : dim("0"))
          if (skipped.length > 0) printKV("  Skipped", dim(String(skipped.length)))

          // Show next pending step
          // Assign fallback step numbers from array index when API returns null
          const withIndex = (arr: any[]) => arr.map((s: any, i: number) => ({ ...s, _stepNum: s.step_number ?? i + 1 }))
          const pendingIndexed = withIndex(pending).sort((a: any, b: any) => a._stepNum - b._stepNum)
          const nextStep = pendingIndexed[0]
          if (nextStep) {
            const stepChannel = nextStep.channel ?? nextStep.type ?? "email"
            const dueDate = nextStep.due_date ? dim(` · due ${nextStep.due_date.split("T")[0]}`) : ""
            const overdue = nextStep.due_date && new Date(nextStep.due_date) < new Date() ? ` ${UI.Style.TEXT_DANGER}OVERDUE${UI.Style.TEXT_NORMAL}` : ""
            printKV("  Next Step", `${highlight(`#${nextStep._stepNum} ${stepChannel}`)}${dueDate}${overdue}`)
            if (nextStep.subject) console.log(`    ${dim(`Subject: ${nextStep.subject.slice(0, 80)}`)}`)
          }

          // Show last completed step
          const completedIndexed = withIndex(completed).sort((a: any, b: any) => b._stepNum - a._stepNum)
          const lastCompleted = completedIndexed[0]
          if (lastCompleted) {
            const completedDate = lastCompleted.completed_at ? dim(lastCompleted.completed_at.split("T")[0]) : ""
            const replied = lastCompleted.replied_at ? success(" REPLIED") : ""
            printKV("  Last Completed", `${dim(`#${lastCompleted._stepNum} ${lastCompleted.channel ?? "email"}`)} ${completedDate}${replied}`)
          }
        }

        // Workflows linked to this lead's bloq
        if (leadWorkflows.length > 0) {
          console.log()
          console.log(`  ${bold("Automations")}  ${dim(`(${leadWorkflows.length} workflows)`)}`)
          for (const wf of leadWorkflows.slice(0, 5)) {
            const statusIcon = wf.is_active ? success("active") : dim("inactive")
            const lastRun = wf.last_run_at ? dim(` · last: ${wf.last_run_at.split("T")[0]}`) : ""
            const wfType = wf.type ? dim(` [${wf.type}]`) : ""
            console.log(`    ${dim(`#${wf.id}`)} ${highlight((wf.name ?? "Unnamed").slice(0, 30).padEnd(30))}${statusIcon}${wfType}${lastRun}`)
          }
          if (leadWorkflows.length > 5) console.log(`    ${dim(`…and ${leadWorkflows.length - 5} more — iris workflows list`)}`)
        }
      }
      } catch (sectionErr) {
        console.log(`  ${dim(`Workflow Status: ${sectionErr instanceof Error ? sectionErr.message : String(sectionErr)}`)}`)
      }

      // ── Product Usage — login frequency, feature adoption ──
      if (productUsage) {
        console.log()
        console.log(`  ${bold("Product Usage")}`)
        if (productUsage.last_login) {
          const lastLogin = new Date(productUsage.last_login)
          const daysSince = Math.floor((Date.now() - lastLogin.getTime()) / (1000 * 60 * 60 * 24))
          const loginColor = daysSince > 14 ? UI.Style.TEXT_DANGER : daysSince > 7 ? UI.Style.TEXT_WARNING : ""
          const loginNormal = daysSince > 7 ? UI.Style.TEXT_NORMAL : ""
          printKV("  Last Login", `${loginColor}${productUsage.last_login.split("T")[0]} (${daysSince}d ago)${loginNormal}`)
        }
        if (productUsage.login_count !== undefined) printKV("  Logins (30d)", String(productUsage.login_count))
        if (productUsage.api_calls !== undefined) printKV("  API Calls (30d)", String(productUsage.api_calls))
        if (productUsage.features_used) {
          const features = Array.isArray(productUsage.features_used) ? productUsage.features_used : []
          if (features.length > 0) {
            printKV("  Features", features.slice(0, 5).join(", "))
          }
        }
        if (productUsage.storage_used_mb) printKV("  Storage", `${productUsage.storage_used_mb}MB`)
      }

      // ── Next Best Action — AI recommendation based on all signals ──
      {
        // Build a compact signal summary for AI reasoning
        const signals: string[] = []
        const pulseScore = pulseReadiness?.score
        const pulseBand = pulseReadiness?.band

        // Pulse score context
        if (pulseScore !== undefined) signals.push(`Pulse: ${pulseScore}/100 (${pulseBand})`)

        // Deal health
        if (dealHealth?.has_payment_gate) {
          signals.push(dealHealth.payment_received ? "Payment: received" : "Payment gate: UNPAID")
        }
        if (stripeData?.total_paid > 0) signals.push(`Stripe paid: $${stripeData.total_paid}`)

        // Communication freshness
        const commsSignal = pulseReadiness?.signals?.comms_freshness
        if (commsSignal?.last_inbound_at) {
          const daysSinceInbound = Math.floor((Date.now() - new Date(commsSignal.last_inbound_at).getTime()) / (1000 * 60 * 60 * 24))
          signals.push(`Last inbound: ${daysSinceInbound}d ago`)
        }
        if (commsSignal?.last_outbound_at) {
          const daysSinceOutbound = Math.floor((Date.now() - new Date(commsSignal.last_outbound_at).getTime()) / (1000 * 60 * 60 * 24))
          signals.push(`Last outbound: ${daysSinceOutbound}d ago`)
        }

        // Tasks
        const overdueTasks = leadTasks.filter((t: any) => !t.is_completed && t.due_date && new Date(t.due_date) < new Date())
        if (overdueTasks.length > 0) signals.push(`Overdue tasks: ${overdueTasks.length}`)
        const pendingTasks = leadTasks.filter((t: any) => !t.is_completed)
        if (pendingTasks.length > 0) signals.push(`Pending tasks: ${pendingTasks.length}`)

        // Outreach
        const pendingOutreach = outreachSteps.filter((s: any) => !s.completed_at && s.status !== "skipped")
        if (pendingOutreach.length > 0) signals.push(`Pending outreach steps: ${pendingOutreach.length}`)
        const hasReply = outreachSteps.some((s: any) => s.replied_at)
        if (hasReply) signals.push("Has replied to outreach")

        // Requirements
        const reqSignal = pulseReadiness?.signals?.requirements
        if (reqSignal?.score !== undefined && reqSignal.score < 100) {
          signals.push(`Requirements: ${reqSignal.score}/100`)
        }

        // Status
        signals.push(`Status: ${lead.status ?? "Unknown"}`)

        // Determine next best action using rule-based logic (no API call needed)
        let nextAction = ""
        let actionPriority: "high" | "medium" | "low" = "medium"

        // Priority 1: Unpaid gate + stale comms
        // Skip if Stripe shows payment received (subscription or invoice paid) even if gate flag is stale
        const stripeHasPaid = (stripeData?.total_paid ?? 0) > 0 || (stripeData?.summary?.active_subscriptions ?? 0) > 0
        if (dealHealth?.has_payment_gate && !dealHealth.payment_received && !stripeHasPaid) {
          const lastOutbound = commsSignal?.last_outbound_at ? new Date(commsSignal.last_outbound_at) : null
          const hoursSince = lastOutbound ? (Date.now() - lastOutbound.getTime()) / (1000 * 60 * 60) : Infinity
          if (hoursSince > 48) {
            nextAction = `Send payment follow-up — gate unpaid, last outreach ${hoursSince === Infinity ? "never" : `${Math.floor(hoursSince)}h ago`}`
            actionPriority = "high"
          } else {
            nextAction = `Wait for payment — follow-up sent ${Math.floor(hoursSince)}h ago (next eligible in ${Math.ceil(24 - hoursSince)}h)`
            actionPriority = "low"
          }
        }
        // Priority 2: Overdue tasks
        else if (overdueTasks.length > 0) {
          nextAction = `Complete ${overdueTasks.length} overdue task(s): "${overdueTasks[0].title}"`
          actionPriority = "high"
        }
        // Priority 3: Pending outreach steps that are due
        else if (pendingOutreach.length > 0) {
          const nextStep = pendingOutreach.map((s: any, i: number) => ({ ...s, _n: s.step_number ?? i + 1 })).sort((a: any, b: any) => a._n - b._n)[0]
          const isOverdue = nextStep.due_date && new Date(nextStep.due_date) < new Date()
          nextAction = isOverdue
            ? `Execute overdue outreach step #${nextStep._n} (${nextStep.channel ?? "email"})`
            : `Pending outreach step #${nextStep._n} — ${nextStep.channel ?? "email"}${nextStep.due_date ? ` due ${nextStep.due_date.split("T")[0]}` : ""}`
          actionPriority = isOverdue ? "high" : "medium"
        }
        // Priority 4: No recent inbound (ghost lead)
        else if (commsSignal?.last_inbound_at) {
          const daysSinceInbound = Math.floor((Date.now() - new Date(commsSignal.last_inbound_at).getTime()) / (1000 * 60 * 60 * 24))
          if (daysSinceInbound > 14) {
            nextAction = `Re-engage — no inbound communication in ${daysSinceInbound} days`
            actionPriority = "high"
          } else if (daysSinceInbound > 7) {
            nextAction = `Check in — ${daysSinceInbound} days since last response`
            actionPriority = "medium"
          }
        }
        // Priority 5: Failing requirements
        else if (reqSignal?.score !== undefined && reqSignal.score < 50) {
          nextAction = `Fix deliverables — requirements score ${reqSignal.score}/100`
          actionPriority = "high"
        }
        // Priority 6: No payment gate and deal in progress
        else if (!dealHealth?.has_payment_gate && (lead.status === "Won" || lead.status === "Active")) {
          nextAction = `Create payment gate — active lead with no billing set up`
          actionPriority = "medium"
        }
        // Default: Everything looks good
        else if (pulseScore && pulseScore >= 80) {
          nextAction = "On track — maintain regular check-ins"
          actionPriority = "low"
        }

        if (nextAction) {
          console.log()
          console.log(`  ${bold("Next Best Action")}`)
          const priorityLabel = actionPriority === "high"
            ? `${UI.Style.TEXT_DANGER}HIGH${UI.Style.TEXT_NORMAL}`
            : actionPriority === "medium"
              ? `${UI.Style.TEXT_WARNING}MEDIUM${UI.Style.TEXT_NORMAL}`
              : dim("LOW")
          console.log(`    [${priorityLabel}] ${nextAction}`)

          // Quick action hints
          if (nextAction.includes("payment follow-up")) {
            console.log(`    ${dim(`Run: iris leads pulse ${leadId} --hydrate`)}`)
          } else if (nextAction.includes("overdue task")) {
            console.log(`    ${dim(`Run: iris leads tasks ${leadId}`)}`)
          } else if (nextAction.includes("outreach step")) {
            console.log(`    ${dim(`Run: iris outreach send --lead ${leadId}`)}`)
          } else if (nextAction.includes("Re-engage") || nextAction.includes("Check in")) {
            console.log(`    ${dim(`Run: iris leads meet ${leadId} --at …  or  iris leads note ${leadId} "…"`)}`)
          } else if (nextAction.includes("payment gate")) {
            console.log(`    ${dim(`Run: iris leads payment-gate ${leadId} -a 500`)}`)
          } else if (nextAction.includes("deliverables")) {
            console.log(`    ${dim(`Run: iris leads requirements run ${leadId}`)}`)
          }
        }
      }

      // ── Hydration: auto-send payment follow-up if gate is unpaid + 24h since last outreach ──
      const HYDRATION_WINDOW_HOURS = 24
      const stripeHasPaidForHydration = (stripeData?.total_paid ?? 0) > 0 || (stripeData?.summary?.active_subscriptions ?? 0) > 0
      if (dealHealth?.has_payment_gate && !dealHealth.payment_received && !stripeHasPaidForHydration && !dealHealth.deal_complete && email) {
        // Determine last outreach timestamp
        let lastOutreachAt: Date | null = null

        // Check comms signal for last outbound
        const commsSignal = pulseReadiness?.signals?.comms_freshness ?? {}
        if (commsSignal.last_outbound_at) {
          lastOutreachAt = new Date(commsSignal.last_outbound_at)
        }

        // Also check channel scan results for most recent outbound
        if (channels) {
          for (const ch of channels) {
            for (const msg of ch.messages ?? []) {
              const isOutbound =
                ch.name === "iMessage"
                  ? msg.from_me
                  : ch.name === "Gmail"
                    ? !(msg.from ?? "").toLowerCase().includes(email.toLowerCase())
                    : false
              if (isOutbound) {
                const msgDate = new Date(msg.ts ?? msg.date ?? 0)
                if (!lastOutreachAt || msgDate > lastOutreachAt) lastOutreachAt = msgDate
              }
            }
          }
        }

        // Check gate creation date as fallback
        if (!lastOutreachAt && dealHealth.created_at) {
          lastOutreachAt = new Date(dealHealth.created_at)
        }

        const hoursSinceLast = lastOutreachAt ? (Date.now() - lastOutreachAt.getTime()) / (1000 * 60 * 60) : Infinity

        console.log()
        const forceHydrate = !!(args as any).force
        if (hoursSinceLast >= HYDRATION_WINDOW_HOURS || forceHydrate) {
          console.log(`  ${bold("Hydration")}`)
          console.log(
            `  ${UI.Style.TEXT_WARNING}Last outreach: ${lastOutreachAt ? `${Math.floor(hoursSinceLast)}h ago` : "never"}${UI.Style.TEXT_NORMAL}  ${dim(`(${HYDRATION_WINDOW_HOURS}h window)`)}`,
          )

          if (!(args as any).hydrate) {
            // Dry run — show what would happen
            const firstName = (lead.name ?? lead.first_name ?? "").split(" ")[0] || "there"
            const scopeShort = (dealHealth.scope ?? "our services").slice(0, 80)
            console.log(`  ${dim("Would send follow-up to")} ${email} ${dim(`re: ${scopeShort}`)}`)
            console.log(`  ${dim("Run with --hydrate to send")}`)
          } else {
            // Step 1: AI-generate a personalized follow-up using lead context
            try {
              const scopeShort = (dealHealth.scope ?? "our services").slice(0, 120)
              const proposalLink = dealHealth.proposal_url ?? ""
              const contractLink = dealHealth.contract_signing_url ?? ""
              const amount = dealHealth.amount ?? ""

              const aiPrompt = [
                `Write a personalized follow-up email about their pending agreement.`,
                `Project: ${scopeShort}`,
                `Amount: $${amount}`,
                proposalLink ? `Proposal link to include: ${proposalLink}` : "",
                contractLink ? `Contract signing link to include: ${contractLink}` : "",
                `Summarize what we've been working on together and why signing the agreement helps us keep momentum.`,
                `Reference specific recent work or conversations if possible.`,
                `Be warm, professional, and direct. End with a clear CTA to review and sign.`,
                `Sign off as "IRIS AI — on behalf of the IRIS team"`,
              ]
                .filter(Boolean)
                .join("\n")

              // Generate AI email — pass bloq_id + strategy_template_id directly
              const bloqId = (lead.bloq_ids ?? [])[0] ?? 40
              const genRes = await irisFetch(`/api/v1/leads/${leadId}/outreach/generate-email`, {
                method: "POST",
                body: JSON.stringify({
                  prompt: aiPrompt,
                  tone: "professional",
                  include_cta: true,
                  max_length: "short",
                  bloq_id: bloqId,
                  strategy_template_id: 37,
                }),
              })

              if (!genRes.ok) {
                const errBody = await genRes.json().catch(() => ({}))
                console.log(`  ${dim(`AI generation failed: ${errBody.message ?? errBody.error ?? genRes.status}`)}`)
              } else {
                const genData = (await genRes.json()) as any
                const draft = genData.draft ?? genData.data?.draft ?? genData.data ?? genData
                const emailSubject = draft.subject ?? `Following up — ${scopeShort}`
                const emailBody = draft.body ?? draft.message ?? draft.content ?? ""

                if (!emailBody) {
                  console.log(`  ${dim("AI returned empty draft — skipping")}`)
                } else {
                  const sendTo = (args as any).to ?? email
                  const isRedirected = !!(args as any).to

                  // Preview the generated email
                  console.log(
                    `  ${dim("To:")} ${sendTo}${isRedirected ? `  ${highlight("(redirected from " + email + ")")}` : ""}`,
                  )
                  console.log(`  ${dim("Subject:")} ${emailSubject}`)
                  console.log(`  ${dim("─".repeat(50))}`)
                  for (const line of emailBody.split("\n")) {
                    console.log(`  ${dim(line)}`)
                  }
                  console.log(`  ${dim("─".repeat(50))}`)
                  console.log()

                  if ((args as any)["dry-run"] || (args as any).dryRun) {
                    console.log(`  ${highlight("DRY RUN — email NOT sent")}`)
                    console.log(`  ${dim("Remove --dry-run to send")}`)
                  } else {
                    // Send via quicksend (test_email override if --to is set)
                    const qsBody: Record<string, unknown> = {
                      channel: "email",
                      message: emailBody,
                      subject: emailSubject,
                      bloq_id: bloqId,
                      strategy_template_id: 37,
                    }
                    if (isRedirected) qsBody.test_email = sendTo

                    const qsRes = await irisFetch(`/api/v1/leads/${leadId}/outreach/quicksend`, {
                      method: "POST",
                      body: JSON.stringify(qsBody),
                    })

                    if (qsRes.ok) {
                      const qsData = (await qsRes.json()) as any
                      if (qsData.success || qsData.message_id) {
                        console.log(`  ${success("Sent AI follow-up")}  ${dim("to " + sendTo)}`)
                      } else if (qsData.status === "pending_approval") {
                        console.log(
                          `  ${highlight("AI draft queued for approval")}  ${dim("review: iris leads outreach approve")}`,
                        )
                      } else {
                        console.log(`  ${dim("Follow-up queued")}`)
                      }
                    } else {
                      const errBody = await qsRes.json().catch(() => ({}))
                      console.log(`  ${dim(`Send failed: ${errBody.message ?? qsRes.status}`)}`)
                    }
                  }
                }
              }
            } catch (e: any) {
              console.log(`  ${dim(`Hydration error: ${e.message}`)}`)
            }
          }
        } else {
          const nextIn = Math.ceil(HYDRATION_WINDOW_HOURS - hoursSinceLast)
          console.log(
            `  ${dim(`Hydration: last outreach ${Math.floor(hoursSinceLast)}h ago — next eligible in ${nextIn}h`)}`,
          )
        }
      }

      // ── Recap: professional status update email for any lead with email ──
      const RECAP_WINDOW_HOURS = 72 // 3 days
      if (email && !email.endsWith("@instagram.com") && !email.endsWith("@twitter.com")) {
        // Determine last outreach timestamp (same logic as hydrate)
        let lastRecapOutreach: Date | null = null
        const commsSignalRecap = pulseReadiness?.signals?.comms_freshness ?? {}
        if (commsSignalRecap.last_outbound_at) {
          lastRecapOutreach = new Date(commsSignalRecap.last_outbound_at)
        }
        if (channels) {
          for (const ch of channels) {
            for (const msg of ch.messages ?? []) {
              const isOutbound =
                ch.name === "iMessage"
                  ? msg.from_me
                  : ch.name === "Gmail"
                    ? !(msg.from ?? "").toLowerCase().includes(email.toLowerCase())
                    : false
              if (isOutbound) {
                const msgDate = new Date(msg.ts ?? msg.date ?? 0)
                if (!lastRecapOutreach || msgDate > lastRecapOutreach) lastRecapOutreach = msgDate
              }
            }
          }
        }

        const hoursSinceLastRecap = lastRecapOutreach ? (Date.now() - lastRecapOutreach.getTime()) / (1000 * 60 * 60) : Infinity
        const forceRecap = !!(args as any).force

        if ((args as any).recap) {
          console.log()
          if (hoursSinceLastRecap >= RECAP_WINDOW_HOURS || forceRecap) {
            console.log(`  ${bold("Recap")}`)
            console.log(
              `  ${UI.Style.TEXT_WARNING}Last outreach: ${lastRecapOutreach ? `${Math.floor(hoursSinceLastRecap)}h ago` : "never"}${UI.Style.TEXT_NORMAL}  ${dim(`(${RECAP_WINDOW_HOURS}h window)`)}`,
            )

            try {
              // Fetch extra context for recap
              const [onboardRes, reqSummaryRes] = await Promise.allSettled([
                irisFetch(`/api/v1/leads/${leadId}/onboarding`),
                irisFetch(`/api/v1/leads/${leadId}/requirements/summary`),
              ])

              const onboardData = onboardRes.status === "fulfilled" && onboardRes.value?.ok
                ? ((await onboardRes.value.json()) as any)?.data ?? null
                : null
              const reqData = reqSummaryRes.status === "fulfilled" && reqSummaryRes.value?.ok
                ? ((await reqSummaryRes.value.json()) as any)?.data ?? null
                : null

              // Build recap sections
              const firstName = (lead.name ?? lead.first_name ?? "").split(" ")[0] || "there"
              const scopeShort = (dealHealth?.scope ?? "our services").slice(0, 120)
              const amount = dealHealth?.amount ?? ""
              const proposalLink = dealHealth?.proposal_url ?? ""
              const contractLink = dealHealth?.contract_signing_url ?? ""

              // Onboarding summary
              let onboardingSummary = ""
              if (onboardData) {
                const steps = onboardData.steps ?? onboardData.items ?? []
                const done = steps.filter((s: any) => s.completed || s.status === "complete")
                const total = steps.length
                const doneNames = done.map((s: any) => s.name ?? s.title ?? "").filter(Boolean).slice(0, 5).join(", ")
                onboardingSummary = total > 0
                  ? `Onboarding ${Math.round((done.length / total) * 100)}% complete (${done.length}/${total}). Done: ${doneNames || "N/A"}.`
                  : ""
              }

              // Requirements summary
              let reqSummary = ""
              if (reqData) {
                const passing = reqData.passing ?? reqData.passed ?? 0
                const total = reqData.total ?? 0
                reqSummary = total > 0 ? `Deliverables: ${passing}/${total} passing.` : ""
              }

              // KB summary from pulse
              const kbSignal = pulseReadiness?.signals?.knowledge_completeness ?? {}
              const kbDocs = kbSignal.docs_count ?? 0
              const kbTotal = kbSignal.total_expected ?? 8
              const kbSummary = `Knowledge base: ${kbDocs}/${kbTotal} sections populated.`

              // Tasks summary
              const completedTasks = leadTasks.filter((t: any) => t.status === "completed" || t.completed)
              const pendingTasks = leadTasks.filter((t: any) => t.status === "pending" || t.status === "in_progress" || (!t.completed && t.status !== "completed"))
              const pendingNames = pendingTasks.slice(0, 3).map((t: any) => `'${(t.title ?? t.name ?? "").slice(0, 40)}'`).join(", ")
              const tasksSummary = leadTasks.length > 0
                ? `Tasks: ${completedTasks.length} completed, ${pendingTasks.length} pending.${pendingNames ? ` Pending: ${pendingNames}` : ""}`
                : ""

              // Recent notes (from activities)
              const noteActivities = activities.filter((a: any) => a.type === "note" || a.activity_type === "note").slice(0, 3)
              const recentNotes = noteActivities.map((n: any) => (n.title ?? n.description ?? n.content ?? "").slice(0, 60)).filter(Boolean).join("; ")

              const aiPrompt = [
                `Production status update email to ${firstName} re: "${scopeShort}".`,
                `Client: ${name} (${lead.company ?? ""}).`,
                onboardingSummary,
                reqSummary,
                kbSummary,
                tasksSummary,
                recentNotes ? `Notes: ${recentNotes}` : "",
                `Focus ONLY on production progress — what we built, what's next, what we need from them.`,
                `Do NOT mention pricing, payments, invoices, billing, or agreements.`,
                `Under 300 words. Warm but professional.`,
                `No pulse scores or internal metrics. Sign off as "IRIS AI — on behalf of the IRIS team"`,
              ].filter(Boolean).join("\n").slice(0, 995)

              const bloqId = (lead.bloq_ids ?? [])[0] ?? 40
              const genRes = await irisFetch(`/api/v1/leads/${leadId}/outreach/generate-email`, {
                method: "POST",
                body: JSON.stringify({
                  prompt: aiPrompt,
                  tone: "professional",
                  include_cta: true,
                  max_length: "short",
                  bloq_id: bloqId,
                  strategy_template_id: 37,
                }),
              })

              if (!genRes.ok) {
                const errBody = await genRes.json().catch(() => ({}))
                console.log(`  ${dim(`AI generation failed: ${errBody.message ?? errBody.error ?? genRes.status}`)}`)
              } else {
                const genData = (await genRes.json()) as any
                const draft = genData.draft ?? genData.data?.draft ?? genData.data ?? genData
                const emailSubject = draft.subject ?? `Project Update — ${scopeShort}`
                const emailBody = draft.body ?? draft.message ?? draft.content ?? ""

                if (!emailBody) {
                  console.log(`  ${dim("AI returned empty draft — skipping")}`)
                } else {
                  const sendTo = (args as any).to ?? email
                  const isRedirected = !!(args as any).to

                  // Preview
                  console.log(
                    `  ${dim("To:")} ${sendTo}${isRedirected ? `  ${highlight("(redirected from " + email + ")")}` : ""}`,
                  )
                  console.log(`  ${dim("Subject:")} ${emailSubject}`)
                  console.log(`  ${dim("─".repeat(50))}`)
                  for (const line of emailBody.split("\n")) {
                    console.log(`  ${dim(line)}`)
                  }
                  console.log(`  ${dim("─".repeat(50))}`)
                  console.log()

                  if ((args as any)["dry-run"] || (args as any).dryRun) {
                    console.log(`  ${highlight("DRY RUN — recap email NOT sent")}`)
                    console.log(`  ${dim("Remove --dry-run to send")}`)
                  } else {
                    const qsBody: Record<string, unknown> = {
                      channel: "email",
                      message: emailBody,
                      subject: emailSubject,
                      bloq_id: bloqId,
                      strategy_template_id: 37,
                    }
                    if (isRedirected) qsBody.test_email = sendTo

                    const qsRes = await irisFetch(`/api/v1/leads/${leadId}/outreach/quicksend`, {
                      method: "POST",
                      body: JSON.stringify(qsBody),
                    })

                    if (qsRes.ok) {
                      const qsData = (await qsRes.json()) as any
                      if (qsData.success || qsData.message_id) {
                        console.log(`  ${success("Sent recap email")}  ${dim("to " + sendTo)}`)
                      } else if (qsData.status === "pending_approval") {
                        console.log(
                          `  ${highlight("Recap draft queued for approval")}  ${dim("review: iris leads outreach approve")}`,
                        )
                      } else {
                        console.log(`  ${dim("Recap queued")}`)
                      }
                    } else {
                      const errBody = await qsRes.json().catch(() => ({}))
                      console.log(`  ${dim(`Send failed: ${errBody.message ?? qsRes.status}`)}`)
                    }
                  }
                }
              }
            } catch (e: any) {
              console.log(`  ${dim(`Recap error: ${e.message}`)}`)
            }
          } else {
            const nextIn = Math.ceil(RECAP_WINDOW_HOURS - hoursSinceLastRecap)
            console.log()
            console.log(
              `  ${dim(`Recap: last outreach ${Math.floor(hoursSinceLastRecap)}h ago — next eligible in ${nextIn}h`)}  ${dim("(use --force to override)")}`,
            )
          }
        }
      }

      console.log()
      printDivider()
      prompts.outro(
        `${dim(`iris leads pulse ${leadId} --recap`)}  ·  ${dim(`iris leads meet ${leadId} --at …`)}  ·  ${dim(`iris leads note ${leadId} "…"`)}`,
      )
    } catch (err) {
      spinner.stop("Error", 1)
      const errMsg = err instanceof Error ? err.message : String(err)
      const errStack = err instanceof Error && err.stack ? `\n${err.stack}` : ""
      prompts.log.error(errMsg)
      // Always print stack trace so MCP/piped contexts don't swallow errors (#104244)
      if (errStack) console.error(dim(errStack))
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
      .option("no-calendar", {
        type: "boolean",
        default: false,
        describe: "skip Google Calendar sync (note + task only)",
      })
      .option("account", { type: "string", describe: "Google account email (multi-account)" })
      .option("integration-id", { type: "number", describe: "specific integration record ID" })
      .option("calendar", { type: "string", describe: "calendar name or ID (e.g. 'Meetings', 'primary')", demandOption: "specify --calendar (name or ID)" })
      .option("attendees", { type: "array", string: true, describe: "additional attendee emails" })
      .option("notify", { type: "boolean", default: false, describe: "send meeting invite email to the lead (opt-in)" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    if (!(await requireAuth())) {
      prompts.outro("Done")
      return
    }

    const resolved = await resolveLeadId(String(args.id))
    if (!resolved) {
      process.exitCode = 1
      prompts.outro("Done")
      return
    }
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
    ]
      .filter(Boolean)
      .join("\n")

    prompts.intro(`◈  Schedule Meeting — ${leadName}`)
    const spinner = prompts.spinner()

    let calendarResult: any = null
    let resolvedCalendarName: string | undefined
    let calendarId: string | undefined
    const attendeeList: string[] = []
    if (lead.email) attendeeList.push(lead.email)
    if (args.attendees) attendeeList.push(...(args.attendees as string[]))

    if (!args["no-calendar"]) {
      spinner.start("Creating calendar event…")
      try {
        const accountOpts: { integrationId?: number; account?: string } = {}
        if (args.integrationId ?? args["integration-id"]) accountOpts.integrationId = Number(args.integrationId ?? args["integration-id"])
        if (args.account) accountOpts.account = args.account as string

        // Resolve calendar name → ID (e.g. "Meetings" → "abc123@group.calendar.google.com")
        if (args.calendar) {
          const calInput = args.calendar as string
          // If it looks like an ID already (contains @ or is "primary"), use directly
          if (calInput === "primary" || calInput.includes("@")) {
            calendarId = calInput
          } else {
            // Resolve by display name
            try {
              const calsResult = await calExec("get_calendars", {}, accountOpts)
              const cals: any[] = calsResult?.calendars ?? calsResult?.data?.calendars ?? []
              const match = cals.find((c: any) => (c.name ?? "").toLowerCase() === calInput.toLowerCase())
              if (match) {
                calendarId = match.id
                resolvedCalendarName = match.name
              } else {
                // Fuzzy: partial match
                const fuzzy = cals.find((c: any) => (c.name ?? "").toLowerCase().includes(calInput.toLowerCase()))
                if (fuzzy) {
                  calendarId = fuzzy.id
                  resolvedCalendarName = fuzzy.name
                } else {
                  spinner.stop(`Calendar "${calInput}" not found`)
                  const available = cals.map((c: any) => `  ${c.name ?? c.id}`).join("\n")
                  if (available) prompts.log.info(`Available calendars:\n${available}`)
                  prompts.outro("Done")
                  return
                }
              }
            } catch {
              // Fallback: treat input as raw ID
              calendarId = calInput
            }
          }
        }

        calendarResult = await calExec("create_event", {
          title,
          start_time: startTime,
          end_time: endTime,
          description,
          location: args.location ?? undefined,
          timezone: "America/Chicago",
          ...(attendeeList.length > 0 ? { attendees: attendeeList } : {}),
          ...(calendarId ? { calendar_id: calendarId } : {}),
        }, accountOpts)
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
        body: JSON.stringify({
          message: noteMsg,
          type: "meeting_scheduled",
          activity_type: "meeting",
          activity_icon: "calendar",
          activity_data: JSON.stringify({
            calendar_event_id: calendarResult?.event_id ?? calendarResult?.id ?? null,
            calendar_id: calendarId ?? null,
            calendar_name: resolvedCalendarName ?? null,
            event_url: calendarResult?.event_url ?? calendarResult?.htmlLink ?? null,
            account: (args.account as string) ?? null,
            start_time: startTime,
            end_time: endTime,
            title,
            attendees: attendeeList,
            location: (args.location as string) ?? null,
          }),
        }),
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

    // Send meeting invite email to lead (opt-in via --notify)
    let emailSent = false
    if (args.notify && lead.email) {
      try {
        const eventUrl = calendarResult?.event_url ?? calendarResult?.data?.response_data?.htmlLink ?? ""
        const emailBody = [
          `Hi ${lead.first_name ?? lead.name ?? "there"},`,
          "",
          `A meeting has been scheduled:`,
          "",
          `**${title}**`,
          `Date: ${formatDate(startTime)} at ${formatTime(startTime)}`,
          `Duration: ${args.duration} minutes`,
          args.location ? `Location: ${args.location}` : "",
          eventUrl ? `Calendar link: ${eventUrl}` : "",
          args.notes ? `\nAgenda:\n${args.notes}` : "",
          "",
          "Looking forward to it!",
        ].filter(Boolean).join("\n")

        await irisFetch(`/api/v1/leads/${leadId}/email`, {
          method: "POST",
          body: JSON.stringify({
            to: lead.email,
            subject: title,
            body: emailBody,
            type: "meeting_invite",
          }),
        })
        emailSent = true
      } catch {}
    }

    if (args.json) {
      console.log(
        JSON.stringify(
          { lead_id: leadId, title, start: startTime, end: endTime, calendar: calendarResult ?? null, email_sent: emailSent },
          null,
          2,
        ),
      )
    } else {
      printDivider()
      printKV("Lead", `#${leadId} ${leadName}`)
      printKV("Title", title)
      printKV("When", `${formatDate(startTime)} ${formatTime(startTime)}`)
      printKV("Duration", `${args.duration} min`)
      if (args.location) printKV("Location", args.location as string)
      if (resolvedCalendarName) printKV("Calendar", resolvedCalendarName)
      else if (args.calendar) printKV("Calendar", args.calendar as string)
      if (args.account) printKV("Account", args.account as string)
      if (calendarResult?.event_url) printKV("Link", calendarResult.event_url)
      printKV(
        "Synced",
        args["no-calendar"] ? dim("skipped") : calendarResult ? success("✓ Google Calendar") : dim("failed"),
      )
      printKV("Note", success("✓ saved"))
      printKV("Task", success("✓ created"))
      if (args.notify) {
        printKV("Email", emailSent ? success(`✓ sent to ${lead.email}`) : lead.email ? dim("failed") : dim("no email on lead"))
      }
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
    if (!(await requireAuth())) {
      prompts.outro("Done")
      return
    }

    const resolved = await resolveLeadId(String(args.id))
    if (!resolved) {
      process.exitCode = 1
      prompts.outro("Done")
      return
    }
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
          console.log(
            `    ${success("▸")} ${formatDate(start)} ${formatTime(start)}  ${bold(ev.summary || "(no title)")}`,
          )
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
// Sync Calendar — import untracked calendar events as lead notes
// ============================================================================

const LeadsSyncCalendarCommand = cmd({
  command: "sync-calendar <id>",
  aliases: ["cal-sync"],
  describe: "import untracked Google Calendar events as lead notes (feeds Pulse scoring)",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "lead ID, name, or email", type: "string", demandOption: true })
      .option("days", { type: "number", default: 90, describe: "look-back window in days" })
      .option("future-days", { type: "number", default: 30, describe: "look-ahead window in days" })
      .option("account", { type: "string", describe: "Google account email (multi-account)" })
      .option("calendar", { type: "string", describe: "calendar name or ID", demandOption: "specify --calendar (name or ID)" })
      .option("dry-run", { type: "boolean", default: false, describe: "show what would be imported without creating notes" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    if (!(await requireAuth())) {
      prompts.outro("Done")
      return
    }

    const resolved = await resolveLeadId(String(args.id))
    if (!resolved) {
      process.exitCode = 1
      prompts.outro("Done")
      return
    }
    const { leadId, lead } = resolved
    const leadName = lead.name ?? lead.first_name ?? `Lead #${leadId}`
    const leadEmail = lead.email

    if (!leadEmail) {
      prompts.log.error(`Lead #${leadId} has no email — cannot match calendar events`)
      process.exitCode = 1
      prompts.outro("Done")
      return
    }

    prompts.intro(`◈  Sync Calendar — ${leadName}`)
    const spinner = prompts.spinner()
    spinner.start("Fetching calendar events…")

    try {
      const days = args.days as number
      const futureDays = args["future-days"] as number
      const { past, upcoming } = await fetchLeadCalendarEvents(
        { name: leadName, email: leadEmail, id: leadId },
        { days, futureDays },
      )
      const allEvents = [...upcoming, ...past]
      spinner.stop(`${allEvents.length} matching events found`)

      if (allEvents.length === 0) {
        prompts.log.info("No calendar events found for this lead.")
        prompts.outro("Done")
        return
      }

      // Fetch existing notes to dedup by calendar_event_id
      spinner.start("Checking existing notes…")
      const leadRes = await irisFetch(`/api/v1/leads/${leadId}`)
      const leadData = leadRes.ok ? (await leadRes.json() as any)?.data : null
      const existingNotes: any[] = leadData?.notes ?? []
      const trackedIds = new Set<string>()
      for (const note of existingNotes) {
        try {
          const ad = typeof note.activity_data === "string" ? JSON.parse(note.activity_data) : note.activity_data
          if (ad?.calendar_event_id) trackedIds.add(ad.calendar_event_id)
        } catch { /* skip unparseable */ }
      }
      spinner.stop(`${trackedIds.size} events already tracked`)

      // Filter out already-tracked events
      const toImport = allEvents.filter((ev: any) => {
        const evId = ev.id ?? ev.event_id
        return evId && !trackedIds.has(evId)
      })

      if (toImport.length === 0) {
        prompts.log.info(success("All calendar events already tracked."))
        prompts.outro("Done")
        return
      }

      if (args["dry-run"]) {
        console.log()
        console.log(`  ${bold("Would import")} ${highlight(String(toImport.length))} events:`)
        for (const ev of toImport) {
          const start = ev.start || ev.start_time || ""
          const attendees = (ev.attendees ?? []).map((a: any) => a.email ?? a).filter(Boolean)
          console.log(`    ${success("+")} ${formatDate(start)} ${formatTime(start)}  ${ev.summary || ev.title || "(no title)"}`)
          if (attendees.length > 0) console.log(`      ${dim(attendees.join(", "))}`)
        }
        console.log()
        printDivider()
        prompts.log.info(`${toImport.length} events would be imported, ${allEvents.length - toImport.length} already tracked`)
        prompts.outro(`Remove --dry-run to import`)
        return
      }

      // Import events as notes
      spinner.start(`Importing ${toImport.length} events…`)
      let imported = 0
      let failed = 0
      for (const ev of toImport) {
        const evId = ev.id ?? ev.event_id
        const evTitle = ev.summary || ev.title || "(no title)"
        const start = ev.start || ev.start_time || ""
        const end = ev.end || ev.end_time || ""
        const attendees = (ev.attendees ?? []).map((a: any) => a.email ?? a).filter(Boolean)
        const noteMsg = [
          `Calendar event: ${evTitle}`,
          `Date: ${formatDate(start)} ${formatTime(start)}`,
          attendees.length > 0 ? `Attendees: ${attendees.join(", ")}` : null,
          ev.location ? `Location: ${ev.location}` : null,
        ].filter(Boolean).join("\n")

        try {
          await irisFetch(`/api/v1/leads/${leadId}/notes`, {
            method: "POST",
            body: JSON.stringify({
              message: noteMsg,
              type: "calendar_discovery",
              activity_type: "meeting",
              activity_icon: "calendar",
              activity_data: JSON.stringify({
                calendar_event_id: evId,
                start_time: start,
                end_time: end,
                title: evTitle,
                attendees,
                event_url: ev.html_link ?? ev.htmlLink ?? null,
                source: "sync-calendar",
              }),
            }),
          })
          imported++
        } catch {
          failed++
        }
      }
      spinner.stop(`${success("✓")} ${imported} imported${failed > 0 ? `, ${failed} failed` : ""}`)

      if (args.json) {
        console.log(JSON.stringify({
          lead_id: leadId,
          events_found: allEvents.length,
          already_tracked: allEvents.length - toImport.length,
          imported,
          failed,
        }, null, 2))
      } else {
        printDivider()
        printKV("Events found", String(allEvents.length))
        printKV("Already tracked", String(allEvents.length - toImport.length))
        printKV("Imported", success(String(imported)))
        if (failed > 0) printKV("Failed", String(failed))
        printDivider()
      }

      prompts.outro(`${dim(`iris leads pulse ${leadId}`)}`)
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
      .option("interval", {
        alias: "i",
        describe: "billing interval",
        type: "string",
        choices: ["one-time", "month", "quarter", "year"],
      })
      .option("term", { alias: "t", describe: "duration in months (for recurring)", type: "number" })
      .option("deposit", { describe: "deposit percentage (0-100)", type: "number" })
      .option("list-price", { describe: "original list price (shows strikethrough discount)", type: "number" })
      .option("discount", { describe: "discount percentage (0-100)", type: "number" })
      .option("fee", { describe: "processing fee % passed to client (e.g. 2.5)", type: "number" })
      .option("fee-flat", { describe: "flat fee per payment in dollars (e.g. 0.30)", type: "number" })
      .option("absorb-fees", { describe: "absorb fees instead of passing to client", type: "boolean", default: false })
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
    if (args.fee != null || args["fee-flat"] != null) {
      body.processing_fee = {
        percent: args.fee ?? 2.9,
        flat: args["fee-flat"] ?? 0.3,
        mode: args["absorb-fees"] ? "absorb" : "pass_to_client",
      }
    }

    const res = await irisFetch(`/api/v1/leads/${args.id}/payment-gate`, {
      method: "POST",
      body: JSON.stringify(body),
    })
    if (!(await handleApiError(res, "Create payment gate"))) return

    const data = await res.json().catch(() => ({}))

    if (args.json) {
      console.log(JSON.stringify(data, null, 2))
      return
    }

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
      .option("billing-type", { alias: "b", describe: "billing type", type: "string", choices: ["one_time", "monthly", "quarterly", "yearly"] })
      .option("json", { describe: "JSON output", type: "boolean" }),
  async handler(args) {
    if (!(await requireAuth())) return

    if (!args.amount && !args.scope && !args.billingType) {
      prompts.log.error("Provide at least --amount, --scope, or --billing-type to update")
      return
    }

    const body: Record<string, unknown> = {}
    if (args.amount) body.amount = args.amount
    if (args.scope) body.scope = args.scope
    if (args.billingType) body.billing_type = args.billingType

    const res = await irisFetch(`/api/v1/leads/${args.id}/payment-gate`, {
      method: "PUT",
      body: JSON.stringify(body),
    })
    if (!(await handleApiError(res, "Update payment gate"))) return

    const data = await res.json().catch(() => ({}))
    if (args.json) {
      console.log(JSON.stringify(data, null, 2))
      return
    }

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
    if (args.json) {
      console.log(JSON.stringify(data, null, 2))
      return
    }

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

    if (args.json) {
      console.log(JSON.stringify(status, null, 2))
      return
    }

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

    if (args.json) {
      console.log(JSON.stringify(packages, null, 2))
      return
    }

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
      console.log(
        `  ${dim(`#${pkg.id}`)}  ${bold(pkg.name)}  ${success(`$${Number(pkg.price ?? 0).toFixed(2)}`)}${billing}${active}`,
      )
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
      .option("billing", {
        alias: "b",
        describe: "billing type",
        type: "string",
        choices: ["one_time", "monthly", "yearly", "milestone"],
        default: "monthly",
      })
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

    if (args.json) {
      console.log(JSON.stringify(data, null, 2))
      return
    }

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
      .option("billing", {
        alias: "b",
        describe: "billing type",
        type: "string",
        choices: ["one_time", "monthly", "yearly", "milestone"],
      })
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

    if (args.json) {
      console.log(JSON.stringify(data, null, 2))
      return
    }

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

    // Extract short code from the checkout URL
    const url = String(status.stripe_checkout_url)
    const shortCode = url.split("/checkout/").pop()

    if (!shortCode) {
      prompts.log.error("Could not extract short code from checkout URL: " + url)
      return
    }

    // Use the force-regenerate API endpoint (bypasses 23h stale check)
    prompts.log.info(`Regenerating checkout ${dim(shortCode)}...`)

    try {
      const res = await irisFetch(`/api/v1/checkout/${shortCode}/regenerate`, { method: "POST" })

      if (args.json) {
        const data = await res.json().catch(() => ({}))
        console.log(JSON.stringify(data, null, 2))
        return
      }

      if (res.ok) {
        const data = await res.json().catch(() => ({}))
        console.log("")
        console.log(success("Checkout session regenerated"))
        printDivider()
        printKV("Short URL", data.short_url ?? url)
        printKV("Fresh Stripe URL", (data.destination_url ?? "").length > 80 ? (data.destination_url ?? "").slice(0, 80) + "..." : (data.destination_url ?? "unknown"))
        printKV("Regeneration #", String(data.regeneration_count ?? "?"))
        printDivider()
      } else if (res.status === 404) {
        prompts.log.error("Checkout redirect not found. Create a new payment gate.")
      } else {
        const body = await res.text().catch(() => "")
        prompts.log.error(`Regeneration failed (${res.status}): ${body}`)
      }
    } catch (err) {
      prompts.log.error(err instanceof Error ? err.message : String(err))
    }
  },
})

// ============================================================================
// Subscription Update — change a lead's Stripe subscription price
// ============================================================================

const LeadsSubscriptionUpdateCommand = cmd({
  command: "subscription-update <id>",
  aliases: ["sub-update", "upgrade"],
  describe: "update a lead's Stripe subscription price (e.g. $39 → $102.50)",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "lead ID", type: "number", demandOption: true })
      .option("amount", { alias: "a", describe: "new monthly amount", type: "number", demandOption: true })
      .option("prorate", {
        describe: "prorate immediately (default: next billing cycle)",
        type: "boolean",
        default: false,
      })
      .option("json", { describe: "JSON output", type: "boolean" }),
  async handler(args) {
    if (!(await requireAuth())) return

    // Show current subscription first
    const pulseRes = await irisFetch(`/api/v1/leads/${args.id}`)
    const lead = pulseRes.ok ? ((await pulseRes.json()) as any)?.data : null
    const name = lead?.name ?? lead?.first_name ?? `Lead #${args.id}`

    console.log()
    console.log(`  ${bold(name)}`)

    // Confirm
    if (!isNonInteractive()) {
      const confirmed = await prompts.confirm({
        message: `Update subscription to $${args.amount}/mo${args.prorate ? " (prorated immediately)" : " (next billing cycle)"}?`,
      })
      if (prompts.isCancel(confirmed) || !confirmed) {
        prompts.cancel("Cancelled")
        return
      }
    }

    const res = await irisFetch(`/api/v1/leads/${args.id}/subscription/update-price`, {
      method: "PATCH",
      body: JSON.stringify({
        amount: args.amount,
        prorate: args.prorate,
      }),
    })

    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      prompts.log.error(err.message ?? err.error ?? `Failed (${res.status})`)
      return
    }

    const data = (await res.json()) as any
    if (args.json) {
      console.log(JSON.stringify(data, null, 2))
      return
    }

    const result = data.data ?? data
    console.log(`  ${success("Subscription updated")}`)
    printKV("  Old", `$${result.old_amount}/mo`)
    printKV("  New", `$${result.new_amount}/mo`)
    printKV("  Effective", result.effective === "immediately" ? "Immediately (prorated)" : "Next billing cycle")
    printDivider()
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
    if (!(await requireAuth())) {
      prompts.outro("Done")
      return
    }
    const spinner = prompts.spinner()
    spinner.start("Loading tasks…")
    try {
      const res = await irisFetch(`/api/v1/leads/${args.id}/tasks`)
      const ok = await handleApiError(res, "List tasks")
      if (!ok) {
        spinner.stop("Failed", 1)
        prompts.outro("Done")
        return
      }
      const data = ((await res.json()) as any)?.data
      const tasks: any[] = data?.tasks ?? data ?? []
      spinner.stop(`${tasks.length} task(s)`)
      if (args.json) {
        console.log(JSON.stringify(tasks, null, 2))
        return
      }
      if (tasks.length === 0) {
        prompts.log.info("No tasks yet")
        prompts.outro(dim(`iris leads tasks create ${args.id} --title "Follow up"`))
        return
      }
      printDivider()
      for (const t of tasks) {
        const check = t.is_completed ? success("✓") : "○"
        const due = t.due_date ? dim(` due ${String(t.due_date).split("T")[0]}`) : ""
        const overdue =
          !t.is_completed && t.due_date && new Date(t.due_date) < new Date()
            ? ` ${UI.Style.TEXT_DANGER}OVERDUE${UI.Style.TEXT_NORMAL}`
            : ""
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
    if (!(await requireAuth())) {
      prompts.outro("Done")
      return
    }
    const spinner = prompts.spinner()
    spinner.start("Creating task…")
    try {
      const body: Record<string, unknown> = { title: args.title }
      if (args.description) body.description = args.description
      if (args.due) body.due_date = args.due
      if (args["agent-id"]) body.agent_id = args["agent-id"]
      const res = await irisFetch(`/api/v1/leads/${args.id}/tasks`, { method: "POST", body: JSON.stringify(body) })
      const ok = await handleApiError(res, "Create task")
      if (!ok) {
        spinner.stop("Failed", 1)
        prompts.outro("Done")
        return
      }
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
    if (!(await requireAuth())) {
      prompts.outro("Done")
      return
    }
    const spinner = prompts.spinner()
    spinner.start("Completing…")
    try {
      const res = await irisFetch(`/api/v1/leads/${args["lead-id"]}/tasks/${args["task-id"]}`, {
        method: "PUT",
        body: JSON.stringify({ is_completed: true }),
      })
      const ok = await handleApiError(res, "Complete task")
      if (!ok) {
        spinner.stop("Failed", 1)
        prompts.outro("Done")
        return
      }
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
    if (!(await requireAuth())) {
      prompts.outro("Done")
      return
    }
    const spinner = prompts.spinner()
    spinner.start("Deleting…")
    try {
      const res = await irisFetch(`/api/v1/leads/${args["lead-id"]}/tasks/${args["task-id"]}`, { method: "DELETE" })
      const ok = await handleApiError(res, "Delete task")
      if (!ok) {
        spinner.stop("Failed", 1)
        prompts.outro("Done")
        return
      }
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
// Enrich — dispatch a Hive `leadgen` task that calls fl-api enrich endpoints
// for N leads in a bloq. Pure SDK, no Playwright, no IG sessions.
// ============================================================================

const LeadsEnrichCommand = cmd({
  command: "enrich",
  describe: "enrich leads in a bloq via API (no Playwright/browser needed)",
  builder: (yargs) =>
    yargs
      .option("bloq", { alias: "b", describe: "bloq id to enrich leads from", type: "number", demandOption: true })
      .option("limit", { alias: "n", describe: "max leads to enrich", type: "number", default: 20 })
      .option("user-id", { describe: "user id (defaults to ~/.iris/sdk/.env)", type: "number" })
      .option("queue", { describe: "fire and forget — print task id and exit", type: "boolean", default: true })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(argv) {
    const { requireUserId } = await import("./iris-api")
    const token = await requireAuth()
    if (!token) {
      process.exitCode = 1
      return
    }
    const userId = await requireUserId(argv["user-id"] as number | undefined)
    if (!userId) {
      process.exitCode = 1
      return
    }

    const bloqId = argv.bloq as number
    const limit = argv.limit as number
    const irisApiBase = process.env.IRIS_API_URL ?? "https://freelabel.net"

    // Pre-flight: warn if daemon isn't running (task will be created but won't execute)
    try {
      const daemonCheck = await fetch("http://localhost:3200/health", { signal: AbortSignal.timeout(2000) })
      if (!daemonCheck.ok) {
        console.log(
          `⚠ Hive daemon is not healthy (HTTP ${daemonCheck.status}). Task will be queued but may not execute.`,
        )
        console.log(dim(`  Start it: iris-daemon start`))
      }
    } catch {
      console.log(
        `⚠ Hive daemon is not running on localhost:3200. Task will be queued but won't execute until a node connects.`,
      )
      console.log(dim(`  Start it: iris-daemon start`))
      console.log("")
    }

    // Validate the bloq exists and belongs to the user before dispatching
    const bloqCheck = await irisFetch(`/api/v1/user/${userId}/bloqs/${bloqId}`)
    if (!bloqCheck.ok) {
      const msg = `Bloq ${bloqId} not found or not accessible. Use ${dim("iris bloqs list")} to find your bloq IDs.`
      if (argv.json) console.log(JSON.stringify({ ok: false, error: msg }))
      else console.error(msg)
      process.exitCode = 1
      return
    }

    const prompt = `enrich bloq_id=${bloqId} limit=${limit}`
    const title = `leadgen enrich bloq=${bloqId} limit=${limit}`

    const res = await irisFetch(
      `/api/v6/nodes/tasks`,
      {
        method: "POST",
        body: JSON.stringify({
          user_id: userId,
          title,
          type: "leadgen",
          prompt,
        }),
      },
      irisApiBase,
    )

    if (!res.ok) {
      const body = await res.text()
      if (argv.json) console.log(JSON.stringify({ ok: false, status: res.status, error: body }))
      else console.error(`Task creation failed: ${res.status} ${body}`)
      process.exitCode = 1
      return
    }

    const created = (await res.json()) as { task: { id: string; status: string }; dispatched?: boolean }
    const taskId = created.task?.id
    const status = created.task?.status

    if (argv.json) {
      console.log(
        JSON.stringify({ ok: true, task_id: taskId, status, dispatched: created.dispatched ?? null }, null, 2),
      )
      return
    }

    if (created.dispatched === false) {
      console.log(`⚠ Task ${highlight(taskId)} created but no daemon node is connected to execute it.`)
      console.log(dim(`  Start the daemon: iris daemon start`))
      console.log(dim(`  Task will execute when a node connects.`))
    } else {
      console.log(`${success("✓")} dispatched ${bold("leadgen")} task ${highlight(taskId)} (status=${status})`)
    }
    console.log(dim(`  prompt:  ${prompt}`))
    console.log(dim(`  monitor: iris hive tasks --task ${taskId}`))
  },
})

// ============================================================================
// gate-all — batch-create payment gates for Won leads missing them
// ============================================================================

const LeadsGateAllCommand = cmd({
  command: "gate-all",
  aliases: ["enforce-terms"],
  describe: "create payment gates for all Won leads that don't have one",
  builder: (yargs) =>
    yargs
      .option("amount", { alias: "a", describe: "default amount per gate", type: "number", demandOption: true })
      .option("scope", {
        alias: "s",
        describe: "default scope of work",
        type: "string",
        default: "IRIS Platform Services",
      })
      .option("bloq", { alias: "b", describe: "filter by bloq ID", type: "number" })
      .option("interval", {
        alias: "i",
        describe: "billing interval",
        type: "string",
        choices: ["one-time", "month", "quarter", "year"],
        default: "month",
      })
      .option("term", { alias: "t", describe: "duration in months", type: "number" })
      .option("dry-run", { describe: "show what would be created without creating", type: "boolean", default: false })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    if (!(await requireAuth())) return

    const spinner = prompts.spinner()
    spinner.start("Finding Won leads without payment gates...")

    try {
      // Fetch all Won leads
      const params = new URLSearchParams({ status: "Won", per_page: "200" })
      if (args.bloq) params.set("bloq_id", String(args.bloq))
      const res = await irisFetch(`/api/v1/leads?${params}`)
      if (!res.ok) {
        spinner.stop("Failed to fetch leads", 1)
        return
      }
      const body = (await res.json()) as { data?: any[] }
      const allWon: any[] = body?.data ?? []

      // Filter: skip leads without email, already-gated, and self
      const needsGate: any[] = []
      const skipped: Array<{ lead: any; reason: string }> = []

      for (const lead of allWon) {
        // Skip leads without email (can't send reminders)
        if (!lead.email) {
          skipped.push({ lead, reason: "no email" })
          continue
        }

        // Skip instagram/social-only emails
        if (lead.email.endsWith("@instagram.com") || lead.email.endsWith("@twitter.com")) {
          skipped.push({ lead, reason: "social email" })
          continue
        }

        try {
          const dsRes = await irisFetch(`/api/v1/leads/${lead.id}/deal-status`)
          if (dsRes.ok) {
            const dsBody = (await dsRes.json()) as any
            const ds = dsBody?.data ?? dsBody // handle { success, data } wrapper
            if (ds.has_payment_gate) {
              skipped.push({ lead, reason: "already has gate" })
              continue
            }
            // Skip leads with active Stripe subscriptions
            if ((ds.stripe_received ?? 0) > 0) {
              skipped.push({ lead, reason: `already paid ($${ds.stripe_received})` })
              continue
            }
          }
        } catch {
          // If deal-status fails, include lead (safe default)
        }

        needsGate.push(lead)
      }

      spinner.stop(`${allWon.length} Won leads, ${needsGate.length} need gates, ${skipped.length} skipped`)

      if (skipped.length > 0) {
        console.log("")
        console.log(dim("  Skipped:"))
        for (const { lead, reason } of skipped) {
          const name = lead.name ?? lead.first_name ?? `Lead #${lead.id}`
          console.log(`    ${dim(`#${lead.id}`)}  ${dim(name)}  ${dim(`(${reason})`)}`)
        }
      }

      if (needsGate.length === 0) {
        console.log("")
        console.log(success("  All eligible Won leads have payment gates!"))
        return
      }

      // Show what needs gates
      console.log("")
      printDivider()
      for (const lead of needsGate) {
        const name = lead.name ?? lead.first_name ?? `Lead #${lead.id}`
        const company = lead.company ? `  ${dim(lead.company)}` : ""
        const email = lead.email ? `  ${dim(lead.email)}` : ""
        console.log(`  ${dim(`#${lead.id}`)}  ${bold(name)}${company}${email}`)
      }
      printDivider()

      if (args.dryRun || args["dry-run"]) {
        console.log(
          dim(`\n  Dry run — would create ${needsGate.length} payment gate(s) at $${args.amount}/${args.interval}`),
        )
        console.log(dim(`  Run without --dry-run to execute`))
        return
      }

      // Confirm
      if (!isNonInteractive()) {
        const confirmed = await prompts.confirm({
          message: `Create payment gates for ${needsGate.length} leads at $${args.amount}/${args.interval}?`,
        })
        if (prompts.isCancel(confirmed) || !confirmed) {
          prompts.cancel("Cancelled")
          return
        }
      }

      // Execute
      const results: Array<{ lead_id: number; name: string; success: boolean; proposal_url?: string; error?: string }> =
        []
      for (const lead of needsGate) {
        const gateBody: Record<string, unknown> = {
          amount: args.amount,
          scope: args.scope,
          auto_send_reminders: true,
        }
        if (args.bloq) gateBody.bloq_id = args.bloq
        if (args.interval) gateBody.interval = args.interval
        if (args.term) gateBody.duration_months = args.term

        try {
          const gRes = await irisFetch(`/api/v1/leads/${lead.id}/payment-gate`, {
            method: "POST",
            body: JSON.stringify(gateBody),
          })
          const gData = (await gRes.json()) as any
          const name = lead.name ?? lead.first_name ?? `Lead #${lead.id}`
          if (gData.success) {
            results.push({ lead_id: lead.id, name, success: true, proposal_url: gData.proposal_url })
            console.log(`  ${success("+")}  ${bold(name)}  ${dim(gData.proposal_url ?? "")}`)
          } else {
            results.push({ lead_id: lead.id, name, success: false, error: gData.message ?? "failed" })
            console.log(`  ${highlight("x")}  ${bold(name)}  ${dim(gData.message ?? "failed")}`)
          }
        } catch (e: any) {
          const name = lead.name ?? `Lead #${lead.id}`
          results.push({ lead_id: lead.id, name, success: false, error: e.message })
          console.log(`  ${highlight("x")}  ${bold(name)}  ${dim(e.message)}`)
        }
      }

      const created = results.filter((r) => r.success).length
      console.log("")
      console.log(success(`  ${created}/${needsGate.length} payment gates created`))

      if (args.json) {
        console.log(JSON.stringify(results, null, 2))
      }
    } catch (e: any) {
      spinner.stop("Error", 1)
      console.error(e.message)
    }
  },
})

// ============================================================================
// kb — Lead Knowledge Base (AI-generated sales intelligence docs)
// ============================================================================

const LeadsKBCommand = cmd({
  command: "kb <id>",
  describe: "view or generate AI knowledge base docs for a lead",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "lead ID", type: "number", demandOption: true })
      .option("section", { alias: "s", describe: "show full content of one section", type: "string" })
      .option("generate", { alias: "g", describe: "generate all 8 KB sections", type: "boolean", default: false })
      .option("regenerate", { alias: "r", describe: "regenerate one section (by slug)", type: "string" })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    const token = await requireAuth()
    if (!token) return

    const leadId = args.id as number

    // --generate: dispatch async generation
    if (args.generate) {
      const spinner = prompts.spinner()
      spinner.start("Dispatching KB generation...")
      try {
        const res = await irisFetch(`/api/v1/leads/${leadId}/knowledge-base/generate`, {
          method: "POST",
          body: JSON.stringify({}),
        })
        if (res.ok) {
          spinner.stop(success("KB generation queued — check back in ~30s"))
        } else {
          spinner.stop("Failed to dispatch", 1)
        }
      } catch {
        spinner.stop("Error", 1)
      }
      return
    }

    // --regenerate: regenerate one section
    if (args.regenerate) {
      const spinner = prompts.spinner()
      spinner.start(`Regenerating ${args.regenerate}...`)
      try {
        const res = await irisFetch(`/api/v1/leads/${leadId}/knowledge-base/${args.regenerate}/regenerate`, {
          method: "POST",
        })
        if (res.ok) {
          const body = (await res.json()) as any
          spinner.stop(success(`Regenerated: ${body?.data?.title ?? args.regenerate}`))
        } else {
          const err = await res.json().catch(() => ({})) as any
          spinner.stop(err?.error ?? "Regeneration failed", 1)
        }
      } catch {
        spinner.stop("Error", 1)
      }
      return
    }

    // Default: list all KB docs
    const spinner = prompts.spinner()
    spinner.start("Loading knowledge base...")

    try {
      const res = await irisFetch(`/api/v1/leads/${leadId}/knowledge-base`)
      if (!res.ok) {
        spinner.stop("Failed to load KB", 1)
        return
      }

      const body = (await res.json()) as any
      const docs: any[] = body?.data ?? []
      const completeness = body?.completeness ?? { count: docs.length, total: 8 }

      spinner.stop(`${completeness.count}/${completeness.total} sections`)

      if (args.json) {
        console.log(JSON.stringify(body, null, 2))
        return
      }

      if (docs.length === 0) {
        console.log()
        console.log(`  ${dim("No KB docs yet.")}  Run: ${highlight(`iris leads kb ${leadId} --generate`)}`)
        return
      }

      // --section: show one section's full content
      if (args.section) {
        const doc = docs.find((d: any) => d.section === args.section)
        if (!doc) {
          console.log(`  ${dim(`Section "${args.section}" not found.`)}`)
          console.log(`  ${dim("Available:")} ${docs.map((d: any) => d.section).join(", ")}`)
          return
        }
        console.log()
        console.log(bold(`  ${doc.title}`))
        console.log()
        console.log(doc.content)
        return
      }

      // Summary table
      console.log()
      const sections = body?.sections ?? {}
      const allSlugs = Object.keys(sections)

      for (const slug of allSlugs) {
        const doc = docs.find((d: any) => d.section === slug)
        if (doc) {
          const words = (doc.content ?? "").split(/\s+/).length
          const date = doc.updated_at ? new Date(doc.updated_at).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : ""
          console.log(`  ${success("\u2713")} ${sections[slug].padEnd(25)} ${dim(`${words} words`)}  ${dim(date)}`)
        } else {
          console.log(`  ${dim("\u2717")} ${dim((sections[slug] ?? slug).padEnd(25))} ${dim("missing")}`)
        }
      }
      console.log()
      prompts.outro(dim(`iris leads kb ${leadId} --section icp  \u00b7  iris leads kb ${leadId} --generate`))
    } catch (e: any) {
      spinner.stop("Error", 1)
      console.error(e.message)
    }
  },
})

// ============================================================================
// pulse-all — bulk pulse scorecard for all Won + Active leads
// ============================================================================

const LeadsPulseAllCommand = cmd({
  command: "pulse-all",
  aliases: ["scorecard", "health"],
  describe: "run pulse on all Won, Active & In Negotiation leads — scorecard with deal health, gates, and gaps",
  builder: (yargs) =>
    yargs
      .option("status", { describe: "filter by status (comma-separated, e.g. Won,Active,In Negotiation)", type: "string", default: "Won,Active,In Negotiation,Negotiating" })
      .option("bloq", { alias: "b", describe: "filter by bloq ID", type: "number" })
      .option("hydrate", {
        describe: "auto-send follow-ups to eligible leads (past 24h throttle)",
        type: "boolean",
        default: false,
      })
      .option("dry-run", {
        describe: "with --hydrate/--recap: preview emails without sending",
        type: "boolean",
        default: false,
      })
      .option("recap", {
        describe: "send professional status update emails to all eligible leads",
        type: "boolean",
        default: false,
      })
      .option("to", { describe: "with --hydrate/--recap: redirect all emails to this address (for testing)", type: "string" })
      .option("force", { describe: "with --hydrate/--recap: ignore throttle window", type: "boolean", default: false })
      .option("prepare", {
        describe: "list lowest-pulse leads with top action items",
        type: "boolean",
        default: false,
      })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    if (!(await requireAuth())) return

    const spinner = prompts.spinner()
    const statuses = args.status.split(",").map((s: string) => s.trim())
    spinner.start(`Loading ${statuses.join(" + ")} leads...`)

    try {
      // Fetch each status in parallel and merge
      const fetches = statuses.map(async (status: string) => {
        const params = new URLSearchParams({ status, per_page: "200" })
        if (args.bloq) params.set("bloq_id", String(args.bloq))
        const res = await irisFetch(`/api/v1/leads?${params}`)
        if (!res.ok) return []
        const body = (await res.json()) as { data?: any[] }
        return body?.data ?? []
      })
      const results = await Promise.all(fetches)
      const leads: any[] = results.flat()

      // Skip junk leads (no email, social emails, self)
      // Exception: Negotiating leads with phone numbers are always eligible (hand-picked, not scraped)
      const eligible = leads.filter((l) => {
        if (!l.email && !l.phone) return false
        const isSocialEmail = l.email?.endsWith("@instagram.com") || l.email?.endsWith("@twitter.com")
        const isNegotiating = l.status === "Negotiating" || l.status === "In Negotiation"
        if (isSocialEmail && !(isNegotiating && l.phone)) return false
        if (l.name === `Lead #${l.id}`) return false
        return true
      })

      spinner.stop(`${leads.length} ${statuses.join(" + ")} leads (${eligible.length} eligible)`)

      // Fetch pulse data for each lead
      type PulseRow = {
        id: number
        name: string
        email: string
        company: string
        pulse: number
        band: string
        deal: number | null
        hasGate: boolean
        amount: number | null
        contentAgent: boolean
        comms: number | null
        lastOutreach: string | null
        hydrationEligible: boolean
        billingStatus: "active" | "past_due" | "pending" | "no_sub" | "no_gate"
        monthlyAmount: number | null
        nextPaymentDate: string | null
        daysUntil: number | null
        totalPaid: number
        proposalUrl: string | null
        kbCount: number
        recapEligible: boolean
        tasksPending: number
        tasksOverdue: number
        tasksCompleted: number
        reqPassing: number
        reqTotal: number
        meetingScore: number | null
      }
      const rows: PulseRow[] = []

      for (const lead of eligible) {
        try {
          // Fetch readiness + deal status + stripe payments in parallel
          const [readRes, dealRes, stripeRes] = await Promise.all([
            irisFetch(`/api/v1/leads/${lead.id}/readiness`).catch(() => null),
            irisFetch(`/api/v1/leads/${lead.id}/deal-status`).catch(() => null),
            irisFetch(`/api/v1/leads/${lead.id}/stripe-payments`).catch(() => null),
          ])

          const readData = readRes?.ok ? ((await readRes.json()) as any)?.data : null
          const dealBody = dealRes?.ok ? ((await dealRes.json()) as any) : null
          const deal = dealBody?.data ?? dealBody
          const stripe = stripeRes?.ok ? (((await stripeRes.json()) as any)?.data ?? {}) : {}

          // Extra fetches for --prepare (tasks + requirements)
          let tasksPending = 0, tasksOverdue = 0, tasksCompleted = 0
          let reqPassing = 0, reqTotal = 0
          if (args.prepare) {
            const [tasksRes, reqRes] = await Promise.allSettled([
              irisFetch(`/api/v1/leads/${lead.id}/tasks`),
              irisFetch(`/api/v1/leads/${lead.id}/requirements/summary`),
            ])
            if (tasksRes.status === "fulfilled" && tasksRes.value?.ok) {
              const td = ((await tasksRes.value.json()) as any)?.data ?? []
              const tasks: any[] = Array.isArray(td) ? td : (td?.tasks ?? [])
              const now = new Date()
              tasksCompleted = tasks.filter((t: any) => t.status === "completed" || t.completed).length
              const pending = tasks.filter((t: any) => t.status !== "completed" && !t.completed)
              tasksOverdue = pending.filter((t: any) => t.due_date && new Date(t.due_date) < now).length
              tasksPending = pending.length
            }
            if (reqRes.status === "fulfilled" && reqRes.value?.ok) {
              const rd = (await reqRes.value.json()) as any
              const rData = rd?.data ?? rd ?? {}
              reqPassing = rData.passing ?? rData.passed ?? 0
              reqTotal = rData.total ?? 0
            }
          }

          const sigs = readData?.signals ?? {}
          const dealChecks = sigs.deal_health?.checks ?? {}
          const commsScore = sigs.comms_freshness?.score ?? null
          const lastOut = sigs.comms_freshness?.last_outbound_at ?? null

          // Compute billing status from Stripe data
          const subs = stripe.subscriptions ?? []
          const activeSub = subs.find((s: any) => s.status === "active" || s.status === "trialing")
          const pastDueSub = subs.find((s: any) => s.status === "past_due")
          const hasGate = deal?.has_payment_gate ?? false

          let billingStatus: PulseRow["billingStatus"] = "no_gate"
          if (activeSub) billingStatus = "active"
          else if (pastDueSub) billingStatus = "past_due"
          else if (hasGate)
            billingStatus =
              stripe.summary?.active_subscriptions > 0
                ? "active"
                : stripe.summary?.pending_sessions > 0
                  ? "pending"
                  : "no_sub"
          else billingStatus = "no_gate"

          // Extract monthly amount + next date from active/past_due sub
          const billingSub = activeSub ?? pastDueSub
          const monthlyAmount = billingSub?.amount
            ? Number(billingSub.amount)
            : deal?.amount
              ? Number(deal.amount)
              : null
          const nextDate = billingSub?.current_period_end ?? null
          let daysUntil: number | null = null
          if (nextDate) {
            const next = new Date(nextDate)
            const now = new Date()
            daysUntil = Math.ceil((next.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
          }

          rows.push({
            id: lead.id,
            name: (lead.name ?? lead.first_name ?? `Lead #${lead.id}`).slice(0, 22),
            email: lead.email ?? "",
            company: (lead.company ?? "").slice(0, 20),
            pulse: readData?.score ?? 0,
            band: readData?.band ?? "unknown",
            deal: sigs.deal_health?.score ?? null,
            hasGate,
            amount: deal?.amount ?? null,
            contentAgent: dealChecks.has_content_agent ?? false,
            comms: commsScore,
            lastOutreach: lastOut,
            hydrationEligible:
              (hasGate && !deal?.payment_received && !deal?.deal_complete && billingStatus !== "active") ?? false,
            billingStatus,
            monthlyAmount,
            nextPaymentDate: nextDate,
            daysUntil,
            totalPaid: stripe.total_paid ?? 0,
            proposalUrl: deal?.proposal_url ?? null,
            kbCount: sigs.knowledge_completeness?.docs_count ?? 0,
            recapEligible: !!(lead.email && !lead.email.endsWith("@instagram.com") && !lead.email.endsWith("@twitter.com")),
            tasksPending,
            tasksOverdue,
            tasksCompleted,
            reqPassing,
            reqTotal,
            meetingScore: sigs.meeting_engagement?.score ?? null,
          })
        } catch {
          rows.push({
            id: lead.id,
            name: (lead.name ?? `#${lead.id}`).slice(0, 22),
            email: lead.email ?? "",
            company: "",
            pulse: 0,
            band: "error",
            deal: null,
            hasGate: false,
            amount: null,
            contentAgent: false,
            comms: null,
            lastOutreach: null,
            hydrationEligible: false,
            billingStatus: "no_gate",
            monthlyAmount: null,
            nextPaymentDate: null,
            daysUntil: null,
            totalPaid: 0,
            proposalUrl: null,
            kbCount: 0,
            recapEligible: !!(lead.email && !lead.email.endsWith("@instagram.com") && !lead.email.endsWith("@twitter.com")),
            tasksPending: 0,
            tasksOverdue: 0,
            tasksCompleted: 0,
            reqPassing: 0,
            reqTotal: 0,
            meetingScore: null,
          })
        }
      }

      // Sort by pulse score descending
      rows.sort((a, b) => b.pulse - a.pulse)

      // --prepare: detailed lowest-pulse list with tasks, requirements, and 3 action items
      if (args.prepare) {
        const sorted = [...rows].sort((a, b) => a.pulse - b.pulse) // ascending (worst first)
        console.log()
        console.log(`  ${bold("Prepare — Lowest Pulse Leads")} ${dim(`(${sorted.length} leads)`)}`)
        console.log(dim("  " + "=".repeat(100)))

        for (const r of sorted) {
          const pulseColor =
            r.pulse >= 90 ? UI.Style.TEXT_SUCCESS : r.pulse >= 50 ? UI.Style.TEXT_WARNING : UI.Style.TEXT_DANGER
          const pulseStr = `${pulseColor}${r.pulse}/100${UI.Style.TEXT_NORMAL}`

          // Billing badge
          let billingBadge = ""
          switch (r.billingStatus) {
            case "active": billingBadge = `${UI.Style.TEXT_SUCCESS}Active${UI.Style.TEXT_NORMAL}`; break
            case "past_due": billingBadge = `${UI.Style.TEXT_DANGER}PAST DUE${UI.Style.TEXT_NORMAL}`; break
            case "pending": billingBadge = `${UI.Style.TEXT_WARNING}Pending${UI.Style.TEXT_NORMAL}`; break
            case "no_sub": billingBadge = `${UI.Style.TEXT_DANGER}NO SUB${UI.Style.TEXT_NORMAL}`; break
            default: billingBadge = `${UI.Style.TEXT_DANGER}No Gate${UI.Style.TEXT_NORMAL}`
          }

          // Stats line
          const taskStr = r.tasksPending > 0
            ? `${r.tasksOverdue > 0 ? `${UI.Style.TEXT_DANGER}${r.tasksOverdue} overdue${UI.Style.TEXT_NORMAL} · ` : ""}${r.tasksPending} pending · ${r.tasksCompleted} done`
            : dim("no tasks")
          const reqStr = r.reqTotal > 0
            ? `${r.reqPassing === r.reqTotal ? UI.Style.TEXT_SUCCESS : r.reqPassing === 0 ? UI.Style.TEXT_DANGER : UI.Style.TEXT_WARNING}${r.reqPassing}/${r.reqTotal} passing${UI.Style.TEXT_NORMAL}`
            : dim("no reqs")
          const kbStr = r.kbCount > 0
            ? `${r.kbCount >= 8 ? UI.Style.TEXT_SUCCESS : UI.Style.TEXT_WARNING}${r.kbCount}/8 KB${UI.Style.TEXT_NORMAL}`
            : `${UI.Style.TEXT_DANGER}0/8 KB${UI.Style.TEXT_NORMAL}`
          const meetStr = r.meetingScore !== null
            ? `${r.meetingScore >= 80 ? UI.Style.TEXT_SUCCESS : UI.Style.TEXT_WARNING}mtg ${r.meetingScore}${UI.Style.TEXT_NORMAL}`
            : dim("no mtg")

          // Build top 3 actions
          const actions: string[] = []
          if (r.kbCount === 0) actions.push(`iris leads kb ${r.id} --generate`)
          if (r.billingStatus === "no_sub" || r.billingStatus === "no_gate") actions.push(`iris leads payment-gate ${r.id} -a …`)
          if (r.billingStatus === "past_due") actions.push(`iris leads pulse ${r.id} --hydrate`)
          if (r.reqTotal === 0) actions.push(`iris leads requirements run ${r.id}`)
          else if (r.reqPassing < r.reqTotal) actions.push(`iris leads requirements run ${r.id}`)
          if (!r.contentAgent) actions.push(`iris leads content-engine create ${r.id}`)
          if (r.comms !== null && r.comms < 30) actions.push(`iris leads pulse ${r.id} --recap`)
          if (r.meetingScore === null) actions.push(`iris leads meet ${r.id} --at …`)
          if (r.tasksOverdue > 0) actions.push(`iris leads tasks ${r.id}`)
          if (r.hydrationEligible) actions.push(`iris leads pulse ${r.id} --hydrate`)
          // Deduplicate and take top 3
          const uniqueActions = [...new Set(actions)].slice(0, 3)

          // Render
          console.log()
          console.log(`  ${dim(`#${r.id}`.padEnd(8))}${bold(r.name)}  ${pulseStr}  ${billingBadge}`)
          console.log(`  ${"".padEnd(8)}${dim("Tasks:")} ${taskStr}  ${dim("|")}  ${dim("Reqs:")} ${reqStr}  ${dim("|")}  ${kbStr}  ${dim("|")}  ${meetStr}`)
          if (uniqueActions.length > 0) {
            for (let i = 0; i < uniqueActions.length; i++) {
              console.log(`  ${"".padEnd(8)}${UI.Style.TEXT_WARNING}${i + 1}.${UI.Style.TEXT_NORMAL} ${dim(uniqueActions[i]!)}`)
            }
          } else {
            console.log(`  ${"".padEnd(8)}${UI.Style.TEXT_SUCCESS}On track${UI.Style.TEXT_NORMAL}`)
          }
        }

        console.log()
        console.log(dim("  " + "-".repeat(100)))
        const avgPulse = rows.length > 0 ? Math.round(rows.reduce((s, r) => s + r.pulse, 0) / rows.length) : 0
        const failing = rows.filter((r) => r.band === "failing").length
        const totalOverdue = rows.reduce((s, r) => s + r.tasksOverdue, 0)
        const totalPending = rows.reduce((s, r) => s + r.tasksPending, 0)
        console.log(`  Avg Pulse: ${avgPulse}/100  |  ${UI.Style.TEXT_DANGER}${failing} failing${UI.Style.TEXT_NORMAL}  |  Tasks: ${totalPending} pending${totalOverdue > 0 ? `, ${UI.Style.TEXT_DANGER}${totalOverdue} overdue${UI.Style.TEXT_NORMAL}` : ""}`)
        console.log()
        printDivider()
        prompts.outro(dim("iris leads pulse-all --recap --dry-run  ·  iris leads pulse-all --hydrate"))
        return
      }

      // Compute billing summary
      const activeSubs = rows.filter((r) => r.billingStatus === "active")
      const pastDueRows = rows.filter((r) => r.billingStatus === "past_due")
      const notOnStripe = rows.filter((r) => r.billingStatus === "no_sub" || r.billingStatus === "no_gate")
      const mrr = activeSubs.reduce((s, r) => s + (r.monthlyAmount ?? 0), 0)
      const totalCollected = rows.reduce((s, r) => s + r.totalPaid, 0)

      if (args.json) {
        console.log(
          JSON.stringify(
            {
              rows,
              summary: {
                mrr,
                totalCollected,
                activeSubs: activeSubs.length,
                pastDue: pastDueRows.length,
                notOnStripe: notOnStripe.map((r) => ({ id: r.id, name: r.name, proposalUrl: r.proposalUrl })),
              },
            },
            null,
            2,
          ),
        )
        return
      }

      // Render scorecard
      console.log()
      console.log(`  ${bold("IRIS Pulse Scorecard")} ${dim(`— ${rows.length} ${args.status} leads`)}`)
      console.log(dim("  " + "=".repeat(94)))

      // Header
      console.log(
        `  ${dim("ID".padEnd(8))}${"Name".padEnd(22)}${"Pulse".padEnd(7)}${"Billing".padEnd(12)}${"$/mo".padEnd(10)}${"Next Due".padEnd(13)}${"Days".padEnd(7)}${"Paid".padEnd(10)}`,
      )
      console.log(dim("  " + "-".repeat(94)))

      for (const r of rows) {
        const pulseColor =
          r.pulse >= 90 ? UI.Style.TEXT_SUCCESS : r.pulse >= 50 ? UI.Style.TEXT_WARNING : UI.Style.TEXT_DANGER
        const pulseStr = `${pulseColor}${String(r.pulse).padEnd(4)}${UI.Style.TEXT_NORMAL}`

        // Billing status with color
        let billingStr: string
        switch (r.billingStatus) {
          case "active":
            billingStr = `${UI.Style.TEXT_SUCCESS}Active${UI.Style.TEXT_NORMAL}`
            break
          case "past_due":
            billingStr = `${UI.Style.TEXT_DANGER}PAST DUE${UI.Style.TEXT_NORMAL}`
            break
          case "pending":
            billingStr = `${UI.Style.TEXT_WARNING}Pending${UI.Style.TEXT_NORMAL}`
            break
          case "no_sub":
            billingStr = `${UI.Style.TEXT_DANGER}${bold("NO SUB")}${UI.Style.TEXT_NORMAL}`
            break
          default:
            billingStr = `${UI.Style.TEXT_DANGER}No Gate${UI.Style.TEXT_NORMAL}`
        }
        // Pad to 12 visible chars (accounting for ANSI codes)
        const billingPad =
          billingStr +
          " ".repeat(
            Math.max(
              0,
              12 -
                (r.billingStatus === "past_due"
                  ? 8
                  : r.billingStatus === "no_sub"
                    ? 6
                    : r.billingStatus === "no_gate"
                      ? 7
                      : r.billingStatus === "pending"
                        ? 7
                        : 6),
            ),
          )

        const amountStr = r.monthlyAmount ? `$${r.monthlyAmount}`.padEnd(10) : dim("--".padEnd(10))
        const nextStr = r.nextPaymentDate
          ? (r.nextPaymentDate.split("T")[0] ?? r.nextPaymentDate).padEnd(13)
          : dim("--".padEnd(13))

        let daysStr: string
        if (r.daysUntil !== null) {
          const dColor =
            r.daysUntil <= 0 ? UI.Style.TEXT_DANGER : r.daysUntil <= 7 ? UI.Style.TEXT_WARNING : UI.Style.TEXT_SUCCESS
          const dLabel = r.daysUntil <= 0 ? "NOW" : `${r.daysUntil}d`
          daysStr = `${dColor}${dLabel}${UI.Style.TEXT_NORMAL}` + " ".repeat(Math.max(0, 7 - dLabel.length))
        } else {
          daysStr = dim("--".padEnd(7))
        }

        const paidStr = r.totalPaid > 0 ? success(`$${r.totalPaid}`) : dim("$0")

        console.log(
          `  ${dim(`#${r.id}`.padEnd(8))}${r.name.padEnd(22)}${pulseStr}   ${billingPad}${amountStr}${nextStr}${daysStr}${paidStr}`,
        )
      }

      console.log(dim("  " + "-".repeat(94)))

      // Billing summary
      console.log()
      console.log(`  ${bold("Billing")}`)
      console.log(
        `  MRR: ${success(`$${mrr.toFixed(2)}`)}  |  Total Collected: ${success(`$${totalCollected.toFixed(2)}`)}`,
      )
      console.log(
        `  ${success(`${activeSubs.length} active sub${activeSubs.length !== 1 ? "s" : ""}`)}  |  ${pastDueRows.length > 0 ? `${UI.Style.TEXT_DANGER}${pastDueRows.length} past due${UI.Style.TEXT_NORMAL}` : dim("0 past due")}`,
      )

      if (notOnStripe.length > 0) {
        console.log()
        console.log(`  ${UI.Style.TEXT_DANGER}${bold(`${notOnStripe.length} NOT ON STRIPE`)}${UI.Style.TEXT_NORMAL}`)
        for (const r of notOnStripe) {
          const url = r.proposalUrl ? dim(`  ${r.proposalUrl}`) : ""
          console.log(`    ${UI.Style.TEXT_DANGER}!${UI.Style.TEXT_NORMAL}  ${dim(`#${r.id}`)}  ${r.name}${url}`)
        }
      }

      // Pulse summary
      const avgPulse = rows.length > 0 ? Math.round(rows.reduce((s, r) => s + r.pulse, 0) / rows.length) : 0
      const healthy = rows.filter((r) => r.band === "healthy").length
      const failing = rows.filter((r) => r.band === "failing").length

      const kbComplete = rows.filter((r) => r.kbCount >= 8).length
      const kbMissing = rows.filter((r) => r.kbCount === 0).length

      console.log()
      console.log(`  ${bold("Health")}`)
      console.log(
        `  Avg Pulse: ${avgPulse}/100  |  ${success(`${healthy} healthy`)}  ${UI.Style.TEXT_DANGER}${failing} failing${UI.Style.TEXT_NORMAL}`,
      )
      console.log(
        `  KB: ${success(`${kbComplete} complete`)}  ${kbMissing > 0 ? `${UI.Style.TEXT_WARNING}${kbMissing} missing${UI.Style.TEXT_NORMAL}` : dim("0 missing")}  ${dim(`(iris leads kb <id> --generate)`)}`,
      )

      // Onboarding summary — fetch heartbeat for each lead to check onboarding progress
      // (lightweight: only uses cached heartbeat data already computed above)
      const onboardingComplete = rows.filter((r) => r.pulse >= 60).length
      const onboardingStuck = rows.filter((r) => r.pulse < 60 && r.pulse > 0)
      if (onboardingStuck.length > 0) {
        console.log()
        console.log(`  ${bold("Onboarding")}  ${success(`${onboardingComplete} ready`)}  ${UI.Style.TEXT_WARNING ?? ""}${onboardingStuck.length} stuck${UI.Style.TEXT_NORMAL}`)
        for (const r of onboardingStuck.slice(0, 5)) {
          // Show the worst signal for this lead based on deal health
          const stuckOn = r.deal !== null && r.deal < 60 ? "billing" : r.kbCount === 0 ? "knowledge_base" : r.comms !== null && r.comms < 30 ? "comms" : "setup"
          console.log(`    ${dim(`#${r.id}`)}  ${r.name.padEnd(22)}${UI.Style.TEXT_WARNING ?? ""}stuck: ${stuckOn}${UI.Style.TEXT_NORMAL}`)
        }
        if (onboardingStuck.length > 5) console.log(`    ${dim(`... +${onboardingStuck.length - 5} more`)}`)
      }

      // Hydration summary
      const hydrationReady = rows.filter((r) => r.hydrationEligible)
      if (hydrationReady.length > 0) {
        console.log()
        console.log(`  ${bold("Hydration ready")} ${dim(`(${hydrationReady.length} leads with unpaid gates)`)}`)
        for (const r of hydrationReady) {
          console.log(`    ${dim(`#${r.id}`)}  ${r.name}  ${dim(`$${r.amount ?? "?"}`)}`)
        }
        if (!args.hydrate) {
          console.log(`  ${dim("Run with --hydrate to send follow-ups (or --hydrate --dry-run to preview)")}`)
        }
      }

      // If --hydrate, run pulse hydration on each eligible lead
      if (args.hydrate && hydrationReady.length > 0) {
        console.log()
        console.log(`  ${bold("Hydrating...")}`)
        for (const r of hydrationReady) {
          try {
            // Delegate to individual pulse command logic by calling the API directly
            const genRes = await irisFetch(`/api/v1/leads/${r.id}/outreach/generate-email`, {
              method: "POST",
              body: JSON.stringify({
                prompt: `Write a personalized follow-up email about their pending agreement.\nProject: ${r.company}\nAmount: $${r.amount}\nBe warm, professional, and direct. End with a clear CTA to review and sign.\nSign off as "IRIS AI — on behalf of the IRIS team"`,
                tone: "professional",
                include_cta: true,
                max_length: "short",
                bloq_id: 40,
                strategy_template_id: 37,
              }),
            })
            if (!genRes.ok) {
              console.log(`    ${dim(`#${r.id}`)}  ${r.name}  ${dim("AI generation failed")}`)
              continue
            }
            const genData = (await genRes.json()) as any
            const draft = genData.draft ?? genData.data?.draft ?? genData.data ?? genData
            const subject = draft.subject ?? `Following up — ${r.company}`
            const emailBody = draft.body ?? draft.message ?? draft.content ?? ""

            if (!emailBody) {
              console.log(`    ${dim(`#${r.id}`)}  ${r.name}  ${dim("Empty draft")}`)
              continue
            }

            if (args["dry-run"] || args.dryRun) {
              console.log(`    ${dim(`#${r.id}`)}  ${r.name}  ${highlight("DRY RUN")}  ${dim(subject.slice(0, 60))}`)
            } else {
              const qsRes = await irisFetch(`/api/v1/leads/${r.id}/outreach/quicksend`, {
                method: "POST",
                body: JSON.stringify({
                  channel: "email",
                  message: emailBody,
                  subject,
                  bloq_id: 40,
                  strategy_template_id: 37,
                }),
              })
              if (qsRes.ok) {
                console.log(`    ${success("+")}  ${r.name}  ${dim(subject.slice(0, 60))}`)
              } else {
                console.log(`    ${dim(`#${r.id}`)}  ${r.name}  ${dim("Send failed")}`)
              }
            }
          } catch (e: any) {
            console.log(`    ${dim(`#${r.id}`)}  ${r.name}  ${dim(e.message?.slice(0, 40))}`)
          }
        }
      }

      // Recap summary + execution
      const RECAP_WINDOW_HOURS = 72
      const recapReady = rows.filter((r) => r.recapEligible)
      if (recapReady.length > 0) {
        console.log()
        console.log(`  ${bold("Recap ready")} ${dim(`(${recapReady.length} leads with email)`)}`)
        for (const r of recapReady.slice(0, 10)) {
          console.log(`    ${dim(`#${r.id}`)}  ${r.name}  ${dim(r.email)}`)
        }
        if (recapReady.length > 10) console.log(`    ${dim(`... and ${recapReady.length - 10} more`)}`)
        if (!args.recap) {
          console.log(`  ${dim("Run with --recap to send status updates (or --recap --dry-run to preview)")}`)
        }
      }

      // If --recap, send recap emails to each eligible lead
      if (args.recap && recapReady.length > 0) {
        console.log()
        console.log(`  ${bold("Sending recaps...")}`)
        for (const r of recapReady) {
          try {
            // Check throttle via comms signal
            const readRes = await irisFetch(`/api/v1/leads/${r.id}/readiness`).catch(() => null)
            const readData = readRes?.ok ? ((await readRes.json()) as any)?.data : null
            const lastOut = readData?.signals?.comms_freshness?.last_outbound_at
            const hoursSince = lastOut ? (Date.now() - new Date(lastOut).getTime()) / (1000 * 60 * 60) : Infinity

            if (hoursSince < RECAP_WINDOW_HOURS && !args.force) {
              const nextIn = Math.ceil(RECAP_WINDOW_HOURS - hoursSince)
              console.log(`    ${dim(`#${r.id}`)}  ${r.name}  ${dim(`next eligible in ${nextIn}h`)}`)
              continue
            }

            // Fetch extra context
            const [onboardRes, reqSummaryRes] = await Promise.allSettled([
              irisFetch(`/api/v1/leads/${r.id}/onboarding`),
              irisFetch(`/api/v1/leads/${r.id}/requirements/summary`),
            ])
            const onboardData = onboardRes.status === "fulfilled" && onboardRes.value?.ok
              ? ((await onboardRes.value.json()) as any)?.data ?? null
              : null
            const reqData = reqSummaryRes.status === "fulfilled" && reqSummaryRes.value?.ok
              ? ((await reqSummaryRes.value.json()) as any)?.data ?? null
              : null

            // Build condensed recap prompt
            let onboardingSummary = ""
            if (onboardData) {
              const steps = onboardData.steps ?? onboardData.items ?? []
              const done = steps.filter((s: any) => s.completed || s.status === "complete")
              onboardingSummary = steps.length > 0 ? `Onboarding: ${done.length}/${steps.length} complete.` : ""
            }
            let reqSummary = ""
            if (reqData) {
              const passing = reqData.passing ?? reqData.passed ?? 0
              const total = reqData.total ?? 0
              reqSummary = total > 0 ? `Deliverables: ${passing}/${total} passing.` : ""
            }
            const kbDocs = readData?.signals?.knowledge_completeness?.docs_count ?? 0

            const aiPrompt = [
              `Production status update email to ${r.name.split(" ")[0] || "there"} about their project.`,
              `Client: ${r.name} (${r.company})`,
              onboardingSummary,
              reqSummary,
              `KB: ${kbDocs} sections populated.`,
              `Focus ONLY on production progress — what we built, what's next, what we need from them.`,
              `Do NOT mention pricing, payments, invoices, billing, or agreements.`,
              `Under 300 words. Warm but professional. No pulse scores or internal metrics.`,
              `Sign off as "IRIS AI — on behalf of the IRIS team"`,
            ].filter(Boolean).join("\n")

            const genRes = await irisFetch(`/api/v1/leads/${r.id}/outreach/generate-email`, {
              method: "POST",
              body: JSON.stringify({
                prompt: aiPrompt,
                tone: "professional",
                include_cta: true,
                max_length: "short",
                bloq_id: 40,
                strategy_template_id: 37,
              }),
            })
            if (!genRes.ok) {
              console.log(`    ${dim(`#${r.id}`)}  ${r.name}  ${dim("AI generation failed")}`)
              continue
            }
            const genData = (await genRes.json()) as any
            const draft = genData.draft ?? genData.data?.draft ?? genData.data ?? genData
            const subject = draft.subject ?? `Project Update — ${r.company || r.name}`
            const emailBody = draft.body ?? draft.message ?? draft.content ?? ""

            if (!emailBody) {
              console.log(`    ${dim(`#${r.id}`)}  ${r.name}  ${dim("Empty draft")}`)
              continue
            }

            if (args["dry-run"] || args.dryRun) {
              console.log(`    ${dim(`#${r.id}`)}  ${r.name}  ${highlight("DRY RUN")}  ${dim(subject.slice(0, 60))}`)
            } else {
              const sendTo = args.to ?? r.email
              const qsBody: Record<string, unknown> = {
                channel: "email",
                message: emailBody,
                subject,
                bloq_id: 40,
                strategy_template_id: 37,
              }
              if (args.to) qsBody.test_email = sendTo

              const qsRes = await irisFetch(`/api/v1/leads/${r.id}/outreach/quicksend`, {
                method: "POST",
                body: JSON.stringify(qsBody),
              })
              if (qsRes.ok) {
                console.log(`    ${success("+")}  ${r.name}  ${dim(subject.slice(0, 60))}`)
              } else {
                console.log(`    ${dim(`#${r.id}`)}  ${r.name}  ${dim("Send failed")}`)
              }
            }
          } catch (e: any) {
            console.log(`    ${dim(`#${r.id}`)}  ${r.name}  ${dim(e.message?.slice(0, 40))}`)
          }
        }
      }

      console.log()
      printDivider()
      prompts.outro(dim("iris leads pulse <id>  ·  iris leads pulse-all --recap --dry-run  ·  iris leads gate-all -a 125"))
    } catch (e: any) {
      spinner.stop("Error", 1)
      console.error(e.message)
    }
  },
})

// ============================================================================
// Onboarding Checklist — structured client setup tracking
// ============================================================================

const LeadsOnboardCommand = cmd({
  command: "onboard <id>",
  aliases: ["onboarding"],
  describe: "show/manage onboarding checklist for a lead",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "lead ID", type: "string", demandOption: true })
      .option("apply", { describe: "apply default onboarding template", type: "boolean", default: false })
      .option("sync", { describe: "auto-detect completed items", type: "boolean", default: false })
      .option("check", { describe: "mark item N as complete", type: "number" })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    if (!(await requireAuth())) return

    let leadId = Number(args.id)
    if (isNaN(leadId)) {
      const params = new URLSearchParams({ search: String(args.id), per_page: "5" })
      const searchRes = await irisFetch(`/api/v1/leads?${params}`)
      if (!searchRes.ok) { prompts.log.error("Search failed"); return }
      const matches: any[] = ((await searchRes.json()) as any)?.data ?? []
      if (matches.length === 0) { prompts.log.error(`No lead found for "${args.id}"`); return }
      leadId = matches[0].id
    }

    const spinner = prompts.spinner()

    // --apply: apply template first
    if (args.apply) {
      spinner.start("Applying onboarding checklist...")
      const applyRes = await irisFetch(`/api/v1/leads/${leadId}/onboarding/apply`, { method: "POST" })
      if (!(await handleApiError(applyRes, "Apply onboarding"))) { spinner.stop("Failed", 1); return }
      const applyData = ((await applyRes.json()) as any)?.data
      if (applyData?.already_applied) {
        spinner.stop("Already applied")
      } else {
        spinner.stop(success("Onboarding checklist applied"))
      }
    }

    // --sync: auto-detect completed items
    if (args.sync) {
      spinner.start("Syncing onboarding status...")
      const syncRes = await irisFetch(`/api/v1/leads/${leadId}/onboarding/sync`, { method: "POST" })
      if (!(await handleApiError(syncRes, "Sync onboarding"))) { spinner.stop("Failed", 1); return }
      const syncData = ((await syncRes.json()) as any)?.data
      spinner.stop(success(`Synced: ${syncData?.synced ?? 0} items auto-detected`))
    }

    // --check N: mark item complete
    if (args.check !== undefined) {
      spinner.start(`Marking item #${args.check} complete...`)
      const checkRes = await irisFetch(`/api/v1/leads/${leadId}/onboarding/check/${args.check}`, { method: "POST" })
      if (!(await handleApiError(checkRes, "Mark complete"))) { spinner.stop("Failed", 1); return }
      spinner.stop(success(`Item #${args.check} marked complete`))
    }

    // Always show status
    spinner.start("Loading onboarding status...")
    const statusRes = await irisFetch(`/api/v1/leads/${leadId}/onboarding`)
    if (!(await handleApiError(statusRes, "Get onboarding"))) { spinner.stop("Failed", 1); return }
    const data = ((await statusRes.json()) as any)?.data

    spinner.stop("")

    if (args.json) {
      console.log(JSON.stringify(data, null, 2))
      return
    }

    if (!data?.applied) {
      prompts.log.info(`No onboarding checklist applied for lead #${leadId}`)
      console.log(dim(`  Apply: iris leads onboard ${leadId} --apply`))
      return
    }

    // Fetch lead name
    const leadRes = await irisFetch(`/api/v1/leads/${leadId}`)
    const leadName = leadRes.ok ? ((await leadRes.json()) as any)?.data?.name ?? `Lead #${leadId}` : `Lead #${leadId}`

    const pct = data.percent ?? 0
    const filled = Math.round(pct / 10)
    const bar = "=".repeat(filled) + "-".repeat(10 - filled)

    console.log()
    console.log(`  ${bold(`Onboarding: Lead #${leadId} — ${leadName}`)}`)
    console.log(`  Progress: ${data.completed}/${data.total} (${pct}%) [${bar}]`)
    console.log()

    for (const item of data.items ?? []) {
      const check = item.is_completed ? success("[x]") : "[ ]"
      const orderStr = `${item.order}.`.padEnd(4)
      const titleStr = item.title.padEnd(35)
      let meta = ""
      if (item.is_completed && item.completed_at) {
        const d = new Date(item.completed_at)
        meta = dim(`(auto  ${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })})`)
      } else if (item.due_date) {
        const d = new Date(item.due_date)
        const isOverdue = item.is_overdue
        const label = `(${isOverdue ? "overdue " : "due "}${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })})`
        meta = isOverdue ? `${UI.Style.TEXT_DANGER}${label}${UI.Style.TEXT_NORMAL}` : dim(label)
      }
      const next = !item.is_completed && item.title === data.next_incomplete ? `  ${highlight("<-- NEXT")}` : ""
      console.log(`  ${check} ${orderStr}${titleStr} ${meta}${next}`)
    }

    console.log()
    if (pct < 100) {
      console.log(dim(`  Sync: iris leads onboard ${leadId} --sync`))
      console.log(dim(`  Mark: iris leads onboard ${leadId} --check <n>`))
    }
    prompts.outro(dim(`iris leads pulse ${leadId}`))
  },
})

const LeadsOnboardAllCommand = cmd({
  command: "onboard-all",
  aliases: ["onboarding-all"],
  describe: "batch onboarding status for all Won leads",
  builder: (yargs) =>
    yargs
      .option("status", { describe: "filter by status", type: "string", default: "Won" })
      .option("apply", { describe: "batch-apply to leads missing checklist", type: "boolean", default: false })
      .option("sync", { describe: "batch sync all applied checklists", type: "boolean", default: false })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    if (!(await requireAuth())) return

    const spinner = prompts.spinner()
    spinner.start(`Loading ${args.status} leads...`)

    try {
      const params = new URLSearchParams({ status: args.status, per_page: "200" })
      const res = await irisFetch(`/api/v1/leads?${params}`)
      if (!res.ok) { spinner.stop("Failed", 1); return }
      const leads: any[] = ((await res.json()) as any)?.data ?? []
      const eligible = leads.filter((l) => l.email && !l.email.endsWith("@instagram.com") && !l.email.endsWith("@twitter.com"))
      spinner.stop(`${leads.length} ${args.status} leads (${eligible.length} eligible)`)

      type OnboardRow = { id: number; name: string; completed: number; total: number; percent: number; nextAction: string; dueDate: string; applied: boolean }
      const rows: OnboardRow[] = []

      for (const lead of eligible) {
        try {
          // Apply if requested and not yet applied
          if (args.apply) {
            await irisFetch(`/api/v1/leads/${lead.id}/onboarding/apply`, { method: "POST" }).catch(() => null)
          }
          // Sync if requested
          if (args.sync) {
            await irisFetch(`/api/v1/leads/${lead.id}/onboarding/sync`, { method: "POST" }).catch(() => null)
          }

          const obRes = await irisFetch(`/api/v1/leads/${lead.id}/onboarding`).catch(() => null)
          const obData = obRes?.ok ? ((await obRes.json()) as any)?.data : null

          if (!obData?.applied) {
            rows.push({ id: lead.id, name: (lead.name ?? `Lead #${lead.id}`).slice(0, 22), completed: 0, total: 0, percent: 0, nextAction: "[not applied]", dueDate: "--", applied: false })
          } else {
            const nextItem = (obData.items ?? []).find((i: any) => !i.is_completed)
            const dueStr = nextItem?.due_date ? new Date(nextItem.due_date).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "--"
            const isOverdue = nextItem?.is_overdue
            rows.push({
              id: lead.id,
              name: (lead.name ?? `Lead #${lead.id}`).slice(0, 22),
              completed: obData.completed,
              total: obData.total,
              percent: obData.percent,
              nextAction: nextItem?.title ?? "Complete",
              dueDate: isOverdue ? `${dueStr} (overdue!)` : dueStr,
              applied: true,
            })
          }
        } catch {
          rows.push({ id: lead.id, name: (lead.name ?? `Lead #${lead.id}`).slice(0, 22), completed: 0, total: 0, percent: 0, nextAction: "[error]", dueDate: "--", applied: false })
        }
      }

      if (args.json) {
        console.log(JSON.stringify(rows, null, 2))
        return
      }

      console.log()
      console.log(`  ${bold("Onboarding Scorecard")} ${dim(`— ${rows.length} ${args.status} leads`)}`)
      console.log(dim("  " + "=".repeat(90)))
      console.log(`  ${dim("ID".padEnd(8))}${"Name".padEnd(24)}${"Onboard".padEnd(10)}${"Progress".padEnd(10)}${"Next Action".padEnd(28)}${"Due"}`)
      console.log(dim("  " + "-".repeat(90)))

      for (const r of rows) {
        const idStr = dim(`#${r.id}`.padEnd(8))
        const nameStr = r.name.padEnd(24)
        let onbStr: string
        if (!r.applied) {
          onbStr = dim("--".padEnd(10))
        } else {
          onbStr = `${r.completed}/${r.total}`.padEnd(10)
        }
        const pctColor = r.percent >= 80 ? UI.Style.TEXT_SUCCESS : r.percent >= 40 ? UI.Style.TEXT_WARNING : UI.Style.TEXT_DANGER
        const pctStr = r.applied ? `${pctColor}${(r.percent + "%").padEnd(10)}${UI.Style.TEXT_NORMAL}` : dim("--".padEnd(10))
        const nextStr = (r.applied ? r.nextAction : dim(r.nextAction)).toString().slice(0, 27).padEnd(28)
        const dueStr = r.dueDate.includes("overdue") ? `${UI.Style.TEXT_DANGER}${r.dueDate}${UI.Style.TEXT_NORMAL}` : dim(r.dueDate)

        console.log(`  ${idStr}${nameStr}${onbStr}${pctStr}${nextStr}${dueStr}`)
      }

      console.log(dim("  " + "-".repeat(90)))

      const applied = rows.filter((r) => r.applied)
      const notApplied = rows.filter((r) => !r.applied)
      const avgPct = applied.length > 0 ? Math.round(applied.reduce((s, r) => s + r.percent, 0) / applied.length) : 0
      console.log()
      console.log(`  ${bold("Summary")}`)
      console.log(`  Applied: ${applied.length}/${rows.length}  |  Avg progress: ${avgPct}%  |  Not applied: ${notApplied.length}`)

      if (notApplied.length > 0 && !args.apply) {
        console.log(`  ${dim("Run with --apply to batch-apply checklists to unapplied leads")}`)
      }

      console.log()
      prompts.outro(dim("iris leads onboard <id>  ·  iris leads onboard-all --apply --sync"))
    } catch (e: any) {
      spinner.stop("Error", 1)
      console.error(e.message)
    }
  },
})

// ============================================================================
// Disposition command
// ============================================================================

const LeadsDispositionCommand = cmd({
  command: "disposition <id> <status>",
  aliases: ["disp"],
  describe: "record a call disposition for a lead",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "lead ID", type: "number", demandOption: true })
      .positional("status", {
        describe: "disposition status",
        type: "string",
        choices: ["meeting_booked", "call_back_later", "not_interested", "wrong_person", "no_contact", "voicemail_left"],
        demandOption: true,
      })
      .option("note", { alias: "n", describe: "call notes", type: "string" })
      .option("duration", { alias: "d", describe: "call duration in seconds", type: "number" }),
  async handler(args) {
    UI.empty()
    const token = await requireAuth()
    if (!token) return

    const userId = await resolveUserId()
    if (!userId) {
      prompts.log.error("Could not resolve user ID")
      return
    }

    const spinner = prompts.spinner()
    spinner.start("Recording disposition...")

    try {
      // Save outreach step
      const res = await irisFetch(`/api/v1/users/${userId}/leads/${args.id}/outreach-steps`, {
        method: "POST",
        body: JSON.stringify({
          type: "call",
          status: "completed",
          data: {
            disposition: args.status,
            notes: args.note || "",
            call_duration: args.duration || 0,
            source: "cli_dialer",
          },
        }),
      })

      if (!(await handleApiError(res, "Save disposition"))) {
        spinner.stop("Failed", 1)
        return
      }

      // Also save as note if note provided
      if (args.note) {
        await irisFetch(`/api/v1/users/${userId}/leads/${args.id}/notes`, {
          method: "POST",
          body: JSON.stringify({
            message: `[Dialer] ${args.status.replace(/_/g, " ")}: ${args.note}`,
            type: "call_note",
          }),
        })
      }

      spinner.stop(success(`Disposition saved: ${args.status.replace(/_/g, " ")}`))
      prompts.outro(dim(`iris leads pulse ${args.id}`))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
    }
  },
})

// ============================================================================
// Content Engine — distributable content agent factory
// ============================================================================

const CONTENT_ENGINE_CONFIG = {
  heartbeat_mode: "autonomous",
  heartbeat_tools: ["manageBloqItems", "httpRequest", "agent_memory"],
  max_iterations: 10,
  model: "gpt-4o-mini",
  schedule_frequency: "every_8_hours",
  schedule_time: "09:00",
  schedule_timezone: "America/New_York",
} as const

function buildContentPrompt(lead: { company?: string; name?: string; industry?: string; bloq_id: number }): { system: string; initial: string } {
  const company = lead.company || lead.name || "the client"
  const industry = lead.industry || "their industry"

  return {
    system: `You are a newsletter content writer for ${company}. Your ONLY job is to produce one article per run and save it. You MUST call manageBloqItems every single run. Do not assess, plan, or evaluate. Just: search, write, save.`,
    initial: [
      `STEP 1: Call httpRequest to search for recent news about ${company} or ${industry}.`,
      `STEP 2: Write a 400-word article about what you found. Include source URLs and specific details.`,
      `STEP 3: Call manageBloqItems with action=create, bloq_id=${lead.bloq_id}, title=your article title, body=your full 400-word article text.`,
      `Do steps 1-2-3 in order. Do NOT skip step 3. Do NOT end without saving.`,
    ].join("\n"),
  }
}

const ContentEngineCreateCommand = cmd({
  command: "create <id>",
  describe: "create a content engine (agent + schedule) for a lead",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "lead ID, name, or email", type: "string", demandOption: true })
      .option("frequency", { describe: "schedule frequency", type: "string", default: "every_8_hours", choices: ["daily", "every_8_hours", "every_12_hours"] })
      .option("model", { describe: "AI model", type: "string", default: "gpt-4o-mini", choices: ["gpt-4o-mini", "gpt-4.1-nano", "gpt-5-nano"] })
      .option("topics", { describe: "override search topics", type: "string" })
      .option("dry-run", { describe: "show config without creating", type: "boolean", default: false })
      .option("skip-verify", { describe: "don't wait for first run verification", type: "boolean", default: false })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("Content Engine")

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const resolved = await resolveLeadId(String(args.id))
    if (!resolved) { prompts.outro("Done"); return }
    const { leadId, lead } = resolved
    const userId = await resolveUserId()
    if (!userId) { prompts.log.error("Could not resolve user ID"); prompts.outro("Done"); return }

    const name = lead.name ?? lead.first_name ?? `Lead #${leadId}`
    const company = lead.company ?? name
    let bloqIds: number[] = Array.isArray(lead.bloq_ids) ? lead.bloq_ids : lead.bloq_id ? [lead.bloq_id] : []

    // Step 1: Resolve bloq — GET /leads/{id} doesn't always include bloq_ids, fallback to search
    const spinner = prompts.spinner()
    if (bloqIds.length === 0) {
      spinner.start("Resolving bloq…")
      try {
        const searchRes = await irisFetch(`/api/v1/leads?search=${encodeURIComponent(lead.email ?? name)}&per_page=5`)
        if (searchRes.ok) {
          const searchData = (await searchRes.json()) as { data?: any[] }
          const match = (searchData?.data ?? []).find((l: any) => l.id === leadId)
          if (match?.bloq_ids && Array.isArray(match.bloq_ids)) {
            bloqIds = match.bloq_ids.filter((id: number) => id !== 40) // exclude shared platform bloq
            if (bloqIds.length === 0) bloqIds = match.bloq_ids // fallback to all if only shared bloq
          }
        }
      } catch { /* non-fatal */ }
      spinner.stop(bloqIds.length > 0 ? `Bloq: #${bloqIds[0]}` : "No bloq found")
    }

    let bloqId: number
    if (bloqIds.length > 0) {
      bloqId = bloqIds[0]
    } else {
      prompts.log.error(`Lead #${leadId} has no linked bloq. Create one first: iris bloqs create --name "${company}"`)
      prompts.outro("Done")
      return
    }

    // Build config
    const prompt = buildContentPrompt({
      company,
      name,
      industry: args.topics || lead.industry,
      bloq_id: bloqId,
    })
    const agentName = `${company} Content Agent`
    const model = args.model ?? CONTENT_ENGINE_CONFIG.model

    const config = {
      agent: {
        name: agentName,
        description: `Autonomous content engine for ${company}`,
        model,
        bloq_id: bloqId,
        type: "content",
        initial_prompt: prompt.system,
        heartbeat_mode: CONTENT_ENGINE_CONFIG.heartbeat_mode,
        heartbeat_tools: CONTENT_ENGINE_CONFIG.heartbeat_tools,
        settings: {
          max_iterations: CONTENT_ENGINE_CONFIG.max_iterations,
          model, // ensure model is in settings (HeartbeatExecutorService reads from here)
          system_prompt: prompt.system,
          initial_prompt: prompt.initial,
          heartbeat_tools: CONTENT_ENGINE_CONFIG.heartbeat_tools,
        },
      },
      schedule: {
        task_name: `${company} Content Generation`,
        prompt: prompt.initial,
        frequency: args.frequency ?? CONTENT_ENGINE_CONFIG.schedule_frequency,
        time: CONTENT_ENGINE_CONFIG.schedule_time,
        timezone: CONTENT_ENGINE_CONFIG.schedule_timezone,
        data: { type: "heartbeat", mode: "autonomous" },
      },
    }

    if (args["dry-run"]) {
      if (args.json) {
        console.log(JSON.stringify(config, null, 2))
      } else {
        console.log()
        console.log(`  ${bold("Agent Config")}`)
        printKV("  Name", agentName)
        printKV("  Model", model)
        printKV("  Bloq", `#${bloqId}`)
        printKV("  Heartbeat", CONTENT_ENGINE_CONFIG.heartbeat_mode)
        printKV("  Tools", CONTENT_ENGINE_CONFIG.heartbeat_tools.join(", "))
        printKV("  Max Iterations", String(CONTENT_ENGINE_CONFIG.max_iterations))
        console.log()
        console.log(`  ${bold("Schedule Config")}`)
        printKV("  Frequency", config.schedule.frequency)
        printKV("  Time", CONTENT_ENGINE_CONFIG.schedule_time)
        printKV("  Type", "heartbeat")
        console.log()
        console.log(`  ${bold("Prompts")}`)
        console.log(`    ${dim("System:")} ${prompt.system.slice(0, 120)}…`)
        console.log(`    ${dim("Initial:")} ${prompt.initial.slice(0, 120)}…`)
        printDivider()
      }
      prompts.outro(dim("Dry run — no changes made. Remove --dry-run to create."))
      return
    }

    // Step 2: Create agent
    spinner.start(`Creating agent "${agentName}"…`)
    try {
      const agentRes = await irisFetch(`/api/v1/users/${userId}/bloqs/agents`, {
        method: "POST",
        body: JSON.stringify(config.agent),
      })
      if (!(await handleApiError(agentRes, "Create agent"))) {
        spinner.stop("Failed to create agent", 1)
        prompts.outro("Done")
        return
      }
      const agentData = (await agentRes.json()) as { data?: any }
      const agent = agentData?.data ?? agentData
      const agentId = agent.id
      spinner.stop(`${success("Agent created:")} ${bold(agentName)} #${agentId}`)

      // Step 3: Create schedule
      const schedSpinner = prompts.spinner()
      schedSpinner.start(`Creating schedule (${config.schedule.frequency})…`)
      const schedRes = await irisFetch(`/api/v1/users/${userId}/bloqs/scheduled-jobs`, {
        method: "POST",
        body: JSON.stringify({
          ...config.schedule,
          agent_id: agentId,
          bloq_id: bloqId,
        }),
      })
      if (!(await handleApiError(schedRes, "Create schedule"))) {
        schedSpinner.stop("Failed to create schedule", 1)
        prompts.log.warn(`Agent #${agentId} was created but schedule failed. Create manually:`)
        prompts.log.info(dim(`iris schedules create --agent ${agentId} --frequency ${config.schedule.frequency} --type heartbeat`))
        prompts.outro("Done")
        return
      }
      const schedData = (await schedRes.json()) as { data?: any }
      const schedule = schedData?.data ?? schedData
      const scheduleId = schedule.id
      schedSpinner.stop(`${success("Schedule created:")} #${scheduleId} (${config.schedule.frequency})`)

      // Step 4: Trigger first run (optional)
      if (!args["skip-verify"]) {
        const runSpinner = prompts.spinner()
        runSpinner.start("Triggering first run…")
        try {
          const runRes = await irisFetch(`/api/v1/users/${userId}/bloqs/scheduled-jobs/${scheduleId}/run`, {
            method: "POST",
            body: JSON.stringify({}),
          })
          if (runRes.ok) {
            runSpinner.stop(success("First run dispatched"))

            // Wait and check for execution
            const verifySpinner = prompts.spinner()
            verifySpinner.start("Waiting for execution (up to 90s)…")
            let verified = false
            for (let i = 0; i < 18; i++) {
              await new Promise((r) => setTimeout(r, 5000))
              try {
                const execRes = await irisFetch(
                  `/api/v1/users/${userId}/bloqs/scheduled-jobs/${scheduleId}/executions?per_page=1`,
                )
                if (execRes.ok) {
                  const execData = (await execRes.json()) as { data?: any[] }
                  const execs = execData?.data ?? []
                  if (execs.length > 0) {
                    const exec = execs[0]
                    const toolsUsed = exec.tools_used ?? exec.metadata?.tools_used ?? []
                    const hasManageBloq = Array.isArray(toolsUsed) &&
                      toolsUsed.some((t: string) => t.toLowerCase().includes("managebloq"))
                    if (hasManageBloq) {
                      verifySpinner.stop(success("ManageBloqItemsTool called — article saved"))
                      verified = true
                    } else if (exec.status === "completed" || exec.status === "success") {
                      verifySpinner.stop(`${success("Execution completed")} ${dim("(check bloq for article)")}`)
                      verified = true
                    } else if (exec.status === "failed") {
                      verifySpinner.stop(`${UI.Style.TEXT_DANGER}Execution failed${UI.Style.TEXT_NORMAL}`)
                      verified = true
                    }
                    if (verified) break
                  }
                }
              } catch { /* polling — non-fatal */ }
            }
            if (!verified) {
              verifySpinner.stop(dim("Still running — check status later"))
            }
          } else {
            runSpinner.stop(dim("Trigger failed — schedule will run at next interval"))
          }
        } catch {
          runSpinner.stop(dim("Trigger failed — schedule will run at next interval"))
        }
      }

      // Step 5: Auto-publish first article to Genesis page (if verification ran)
      let publishedPage: { id: number; slug: string; url: string } | null = null
      if (!args["skip-verify"]) {
        const pageSpinner = prompts.spinner()
        pageSpinner.start("Publishing article to Genesis page…")
        try {
          // Wait a moment for bloq item to be committed
          await new Promise((r) => setTimeout(r, 3000))
          const bloqRes = await irisFetch(`/api/v1/user/${userId}/bloqs/${bloqId}`)
          if (bloqRes.ok) {
            const bd = (await bloqRes.json()) as { data?: any }
            const bloqObj = bd?.data?.bloq ?? bd?.data ?? bd
            const allLists: any[] = bloqObj.lists ?? bd?.data?.lists ?? []
            for (const list of allLists) {
              const ln = (list.name ?? "").toLowerCase()
              if (ln.includes("deliverable") || ln.includes("article") || ln.includes("content")) {
                for (const item of list.items ?? []) {
                  if (item.content && item.title) {
                    publishedPage = await createArticlePage({
                      company,
                      title: item.title,
                      body: item.content,
                      bloqId,
                      homeSlug: slugify(company),
                    })
                    if (publishedPage) break
                  }
                }
                if (publishedPage) break
              }
            }
          }
        } catch { /* non-fatal */ }
        if (publishedPage) {
          pageSpinner.stop(`${success("Page published:")} ${publishedPage.url}`)
        } else {
          pageSpinner.stop(dim("No article found yet — publish later with: iris leads ce publish " + leadId))
        }
      }

      // Summary
      if (args.json) {
        console.log(JSON.stringify({ agent_id: agent.id, schedule_id: scheduleId, bloq_id: bloqId, lead_id: leadId, page: publishedPage }, null, 2))
      } else {
        console.log()
        printDivider()
        printKV("Lead", `${name} (#${leadId})`)
        printKV("Bloq", `#${bloqId}`)
        printKV("Agent", `${agentName} (#${agent.id})`)
        printKV("Schedule", `#${scheduleId} (${config.schedule.frequency})`)
        printKV("Next Run", schedule.next_run_at ?? "pending")
        if (publishedPage) printKV("Article", publishedPage.url)
        printDivider()
        console.log()
        prompts.log.info(dim(`iris leads content-engine publish ${leadId}  — publish new articles`))
        prompts.log.info(dim(`iris leads content-engine status ${leadId}   — check health`))
        prompts.log.info(dim(`iris leads content-engine doctor ${leadId}   — diagnose issues`))
        prompts.outro(success("Content engine ready"))
      }
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const ContentEngineStatusCommand = cmd({
  command: "status <id>",
  describe: "check content engine health for a lead",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "lead ID, name, or email", type: "string", demandOption: true })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("Content Engine Status")

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const resolved = await resolveLeadId(String(args.id))
    if (!resolved) { prompts.outro("Done"); return }
    const { leadId, lead } = resolved
    const userId = await resolveUserId()
    if (!userId) { prompts.log.error("Could not resolve user ID"); prompts.outro("Done"); return }

    const name = lead.name ?? lead.first_name ?? `Lead #${leadId}`
    const bloqIds: number[] = Array.isArray(lead.bloq_ids) ? lead.bloq_ids : lead.bloq_id ? [lead.bloq_id] : []

    if (bloqIds.length === 0) {
      prompts.log.warn(`Lead #${leadId} has no linked bloq — no content engine possible`)
      prompts.outro("Done")
      return
    }

    const spinner = prompts.spinner()
    spinner.start("Checking content engine…")

    try {
      // Fetch agents for this lead's bloq
      const bloqId = bloqIds[0]
      const agentsRes = await irisFetch(`/api/v1/users/${userId}/bloqs/agents?bloq_id=${bloqId}&per_page=50`)
      if (!(await handleApiError(agentsRes, "Fetch agents"))) {
        spinner.stop("Failed", 1); prompts.outro("Done"); return
      }
      const agentsData = (await agentsRes.json()) as { data?: any[] }
      const agents: any[] = agentsData?.data ?? []

      // Find content agents (match by name keywords or heartbeat_tools containing manageBloqItems)
      const contentAgents = agents.filter((a: any) => {
        const nameMatch = /newsletter|content|article|blog|writer/i.test(a.name ?? "")
        const toolsMatch = Array.isArray(a.heartbeat_tools) && a.heartbeat_tools.some((t: string) => /managebloq/i.test(t))
        const settingsToolsMatch = Array.isArray(a.settings?.heartbeat_tools) && a.settings.heartbeat_tools.some((t: string) => /managebloq/i.test(t))
        return (nameMatch || toolsMatch || settingsToolsMatch) && a.active
      })

      if (contentAgents.length === 0) {
        spinner.stop(dim("No content engine found"))
        prompts.log.warn(`No active content agent for ${name}`)
        prompts.log.info(dim(`Create one: iris leads content-engine create ${leadId}`))
        prompts.outro("Done")
        return
      }

      // For each content agent, fetch schedule + recent executions
      const results: any[] = []
      for (const agent of contentAgents) {
        const [schedRes, execRes] = await Promise.allSettled([
          irisFetch(`/api/v1/users/${userId}/bloqs/scheduled-jobs?agent_id=${agent.id}&per_page=5`),
          irisFetch(`/api/v1/users/${userId}/bloqs/scheduled-jobs?agent_id=${agent.id}&per_page=1`).then(async (r) => {
            if (!r.ok) return []
            const d = (await r.json()) as { data?: any[] }
            const jobs = d?.data ?? []
            if (jobs.length === 0) return []
            const jobId = jobs[0].id
            const eRes = await irisFetch(`/api/v1/users/${userId}/bloqs/scheduled-jobs/${jobId}/executions?per_page=5`)
            if (!eRes.ok) return []
            return ((await eRes.json()) as { data?: any[] })?.data ?? []
          }),
        ])

        const schedules = schedRes.status === "fulfilled" && schedRes.value.ok
          ? ((await schedRes.value.json()) as { data?: any[] })?.data ?? []
          : []
        const executions = execRes.status === "fulfilled" ? (execRes.value as any[]) : []
        const activeSchedule = schedules.find((s: any) => s.status === "scheduled" || s.status === "active")

        // Count articles in last 7 days from executions
        const weekAgo = Date.now() - 7 * 86400000
        const recentExecs = executions.filter((e: any) => new Date(e.created_at ?? 0).getTime() > weekAgo)
        const articlesProduced = recentExecs.filter((e: any) => {
          const tools = e.tools_used ?? e.metadata?.tools_used ?? []
          return Array.isArray(tools) && tools.some((t: string) => /managebloq/i.test(t))
        }).length

        results.push({ agent, schedule: activeSchedule, executions, recentExecs, articlesProduced })
      }

      spinner.stop(`${contentAgents.length} content agent(s) found`)

      if (args.json) {
        console.log(JSON.stringify(results.map((r) => ({
          agent_id: r.agent.id, agent_name: r.agent.name, model: r.agent.model,
          schedule_id: r.schedule?.id, schedule_status: r.schedule?.status,
          next_run: r.schedule?.next_run_at, articles_7d: r.articlesProduced,
          recent_executions: r.recentExecs.length,
        })), null, 2))
        prompts.outro("Done")
        return
      }

      for (const r of results) {
        console.log()
        printKV("Agent", `#${r.agent.id} ${bold(r.agent.name)} ${dim(`(${r.agent.model ?? "unknown"})`)}`)
        printKV("Heartbeat", r.agent.heartbeat_mode ?? r.agent.settings?.heartbeat_mode ?? dim("not set"))

        if (r.schedule) {
          const statusLabel = r.schedule.status === "scheduled" ? success(r.schedule.status) : dim(r.schedule.status)
          printKV("Schedule", `#${r.schedule.id} ${r.schedule.frequency ?? ""} ${statusLabel}`)
          printKV("Next Run", r.schedule.next_run_at ?? dim("unknown"))
        } else {
          printKV("Schedule", `${UI.Style.TEXT_WARNING}None active${UI.Style.TEXT_NORMAL}`)
        }

        printKV("Articles (7d)", r.articlesProduced > 0 ? success(String(r.articlesProduced)) : `${UI.Style.TEXT_WARNING}0${UI.Style.TEXT_NORMAL}`)
        printKV("Executions (7d)", String(r.recentExecs.length))

        if (r.recentExecs.length > 0) {
          const last = r.recentExecs[0]
          const tools = last.tools_used ?? last.metadata?.tools_used ?? []
          printKV("Last Run", last.created_at?.split("T")[0] ?? dim("unknown"))
          if (Array.isArray(tools) && tools.length > 0) printKV("Tools Used", tools.join(", "))
        }
      }

      printDivider()
      prompts.log.info(dim(`iris leads content-engine doctor ${leadId}  — diagnose issues`))
      prompts.outro("Done")
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const ContentEngineDoctorCommand = cmd({
  command: "doctor <id>",
  aliases: ["diagnose"],
  describe: "diagnose content engine issues for a lead",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "lead ID, name, or email", type: "string", demandOption: true })
      .option("fix", { describe: "auto-repair detected issues", type: "boolean", default: false })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("Content Engine Doctor")

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const resolved = await resolveLeadId(String(args.id))
    if (!resolved) { prompts.outro("Done"); return }
    const { leadId, lead } = resolved
    const userId = await resolveUserId()
    if (!userId) { prompts.log.error("Could not resolve user ID"); prompts.outro("Done"); return }

    const name = lead.name ?? lead.first_name ?? `Lead #${leadId}`
    const bloqIds: number[] = Array.isArray(lead.bloq_ids) ? lead.bloq_ids : lead.bloq_id ? [lead.bloq_id] : []

    if (bloqIds.length === 0) {
      prompts.log.error(`Lead #${leadId} has no linked bloq — cannot run diagnostics`)
      prompts.log.info(dim(`Create a bloq first: iris bloqs create --name "${lead.company ?? name}"`))
      prompts.outro("Done")
      return
    }

    const spinner = prompts.spinner()
    spinner.start("Running diagnostics…")

    try {
      const bloqId = bloqIds[0]
      const agentsRes = await irisFetch(`/api/v1/users/${userId}/bloqs/agents?bloq_id=${bloqId}&per_page=50`)
      if (!(await handleApiError(agentsRes, "Fetch agents"))) {
        spinner.stop("Failed", 1); prompts.outro("Done"); return
      }
      const agentsData = (await agentsRes.json()) as { data?: any[] }
      const agents: any[] = agentsData?.data ?? []

      const contentAgents = agents.filter((a: any) => {
        const nameMatch = /newsletter|content|article|blog|writer/i.test(a.name ?? "")
        const toolsMatch = Array.isArray(a.heartbeat_tools) && a.heartbeat_tools.some((t: string) => /managebloq/i.test(t))
        const settingsToolsMatch = Array.isArray(a.settings?.heartbeat_tools) && a.settings.heartbeat_tools.some((t: string) => /managebloq/i.test(t))
        return nameMatch || toolsMatch || settingsToolsMatch
      })

      if (contentAgents.length === 0) {
        spinner.stop(`${UI.Style.TEXT_DANGER}No content agent found${UI.Style.TEXT_NORMAL}`)
        prompts.log.error(`No content agent for ${name}`)
        prompts.log.info(dim(`Create one: iris leads content-engine create ${leadId}`))
        prompts.outro("Done")
        return
      }

      const agent = contentAgents[0]
      const heartbeatTools: string[] = agent.heartbeat_tools ?? agent.settings?.heartbeat_tools ?? []
      const heartbeatMode = agent.heartbeat_mode ?? agent.settings?.heartbeat_mode ?? ""
      const maxIterations = agent.settings?.max_iterations ?? 5

      // Fetch schedule
      const schedRes = await irisFetch(`/api/v1/users/${userId}/bloqs/scheduled-jobs?agent_id=${agent.id}&per_page=5`)
      let schedules: any[] = []
      if (schedRes.ok) {
        schedules = ((await schedRes.json()) as { data?: any[] })?.data ?? []
      }
      const activeSchedule = schedules.find((s: any) => s.status === "scheduled" || s.status === "active")

      // Fetch recent executions
      let recentExecs: any[] = []
      if (activeSchedule) {
        try {
          const execRes = await irisFetch(`/api/v1/users/${userId}/bloqs/scheduled-jobs/${activeSchedule.id}/executions?per_page=10`)
          if (execRes.ok) {
            recentExecs = ((await execRes.json()) as { data?: any[] })?.data ?? []
          }
        } catch { /* non-fatal */ }
      }

      spinner.stop(`Diagnosing agent #${agent.id} ${bold(agent.name ?? "")}`)

      // Run checks
      type Check = { name: string; pass: boolean; detail: string; fix?: string }
      const checks: Check[] = []

      // Check 1: heartbeat_tools includes manageBloqItems
      const hasManageBloq = heartbeatTools.some((t) => /managebloq/i.test(t))
      checks.push({
        name: "heartbeat_tools includes manageBloqItems",
        pass: hasManageBloq,
        detail: hasManageBloq ? heartbeatTools.join(", ") : `Current: [${heartbeatTools.join(", ")}]`,
        fix: "update agent settings to include manageBloqItems in heartbeat_tools",
      })

      // Check 2: heartbeat_mode = autonomous
      const isAutonomous = heartbeatMode === "autonomous"
      checks.push({
        name: "heartbeat_mode = autonomous",
        pass: isAutonomous,
        detail: isAutonomous ? "autonomous" : `Current: ${heartbeatMode || "not set"}`,
        fix: "set heartbeat_mode to autonomous",
      })

      // Check 3: max_iterations >= 10
      const hasEnoughIter = maxIterations >= 10
      checks.push({
        name: "max_iterations >= 10",
        pass: hasEnoughIter,
        detail: `${maxIterations}`,
        fix: "set settings.max_iterations = 10",
      })

      // Check 4: agent is active
      checks.push({
        name: "agent is active",
        pass: !!agent.active,
        detail: agent.active ? "active" : "inactive",
        fix: "activate the agent",
      })

      // Check 5: schedule type = heartbeat
      const schedData = activeSchedule?.data ?? {}
      const schedType = schedData.type ?? ""
      const isHeartbeatType = schedType === "heartbeat"
      checks.push({
        name: "schedule type = heartbeat",
        pass: !!activeSchedule && isHeartbeatType,
        detail: activeSchedule ? `${schedType || "unknown"}` : "no active schedule",
        fix: activeSchedule ? "convert schedule to heartbeat type" : "create a heartbeat schedule",
      })

      // Check 6: schedule has recent runs
      const weekAgo = Date.now() - 7 * 86400000
      const hasRecentRuns = recentExecs.some((e: any) => new Date(e.created_at ?? 0).getTime() > weekAgo)
      checks.push({
        name: "schedule has recent runs (7 days)",
        pass: hasRecentRuns,
        detail: hasRecentRuns ? `${recentExecs.filter((e: any) => new Date(e.created_at ?? 0).getTime() > weekAgo).length} runs` : "0 runs in 7 days",
        fix: "check if schedule is active and next_run_at is set",
      })

      // Check 7: ManageBloqItemsTool in tools_used (last run)
      const lastExec = recentExecs[0]
      const lastTools: string[] = lastExec?.tools_used ?? lastExec?.metadata?.tools_used ?? []
      const manageBloqUsed = Array.isArray(lastTools) && lastTools.some((t) => /managebloq/i.test(t))
      checks.push({
        name: "ManageBloqItemsTool in last run",
        pass: manageBloqUsed || recentExecs.length === 0,
        detail: recentExecs.length === 0 ? "no executions yet" : (manageBloqUsed ? `tools: ${lastTools.join(", ")}` : `tools: [${lastTools.join(", ")}] — missing ManageBloqItemsTool`),
        fix: "planner may be active — ensure manageBloqItems in heartbeat_tools to bypass",
      })

      // Check 8: Articles produced in last 7 days
      const articlesProduced = recentExecs.filter((e: any) => {
        const tools = e.tools_used ?? e.metadata?.tools_used ?? []
        return new Date(e.created_at ?? 0).getTime() > weekAgo &&
          Array.isArray(tools) && tools.some((t: string) => /managebloq/i.test(t))
      }).length
      checks.push({
        name: "articles produced in last 7 days",
        pass: articlesProduced > 0 || recentExecs.length === 0,
        detail: `${articlesProduced}`,
        fix: recentExecs.length > 0 ? "ManageBloqItemsTool not in tools_used — planner may be active" : "trigger a run: iris schedules run <schedule_id>",
      })

      if (args.json) {
        const passing = checks.filter((c) => c.pass).length
        console.log(JSON.stringify({
          agent_id: agent.id, agent_name: agent.name,
          schedule_id: activeSchedule?.id, healthy: passing === checks.length,
          checks: checks.map((c) => ({ ...c })),
          passing, total: checks.length,
        }, null, 2))
        prompts.outro("Done")
        return
      }

      // Render
      console.log()
      printKV("Agent", `#${agent.id} ${bold(agent.name ?? "")} ${agent.active ? dim("(active)") : `${UI.Style.TEXT_DANGER}(inactive)${UI.Style.TEXT_NORMAL}`}`)
      if (activeSchedule) {
        printKV("Schedule", `#${activeSchedule.id} ${activeSchedule.frequency ?? ""} ${dim(`(${activeSchedule.status})`)} next: ${activeSchedule.next_run_at ?? "?"}`)
      } else {
        printKV("Schedule", `${UI.Style.TEXT_WARNING}None active${UI.Style.TEXT_NORMAL}`)
      }

      console.log()
      console.log(`  ${bold("Checks")}`)
      let passing = 0
      const fixItems: string[] = []
      for (const c of checks) {
        if (c.pass) {
          passing++
          console.log(`    ${success("+")} ${c.name}`)
        } else {
          console.log(`    ${UI.Style.TEXT_DANGER}x${UI.Style.TEXT_NORMAL} ${c.name}`)
          console.log(`      ${dim(c.detail)}`)
          if (c.fix) {
            console.log(`      ${dim("Fix:")} ${c.fix}`)
            fixItems.push(c.fix)
          }
        }
      }

      console.log()
      if (passing === checks.length) {
        console.log(`  ${success("HEALTHY")} ${dim(`${passing}/${checks.length} checks passed`)}`)
      } else {
        console.log(`  ${UI.Style.TEXT_WARNING}ISSUES FOUND${UI.Style.TEXT_NORMAL} ${dim(`${passing}/${checks.length} checks passed`)}`)
      }

      // Auto-fix if --fix
      if (args.fix && fixItems.length > 0) {
        console.log()
        const fixSpinner = prompts.spinner()
        fixSpinner.start("Applying fixes…")

        const patches: Record<string, unknown> = {}
        if (!hasManageBloq) patches.heartbeat_tools = CONTENT_ENGINE_CONFIG.heartbeat_tools
        if (!isAutonomous) patches.heartbeat_mode = CONTENT_ENGINE_CONFIG.heartbeat_mode
        if (!hasEnoughIter) patches.settings = { ...(agent.settings ?? {}), max_iterations: CONTENT_ENGINE_CONFIG.max_iterations }
        if (!agent.active) patches.active = true

        if (Object.keys(patches).length > 0) {
          const patchRes = await irisFetch(`/api/v1/users/${userId}/bloqs/agents/${agent.id}`, {
            method: "PATCH",
            body: JSON.stringify(patches),
          })
          if (patchRes.ok) {
            fixSpinner.stop(success(`Agent #${agent.id} updated`))
          } else {
            fixSpinner.stop("Agent update failed")
          }
        } else {
          fixSpinner.stop(dim("No agent patches needed"))
        }

        // If no active schedule, create one
        if (!activeSchedule) {
          const schedSpinner = prompts.spinner()
          schedSpinner.start("Creating missing schedule…")
          const company = lead.company ?? name
          const prompt = buildContentPrompt({ company, name, industry: lead.industry, bloq_id: bloqId })
          const schedRes = await irisFetch(`/api/v1/users/${userId}/bloqs/scheduled-jobs`, {
            method: "POST",
            body: JSON.stringify({
              agent_id: agent.id,
              bloq_id: bloqId,
              task_name: `${company} Content Generation`,
              prompt: prompt.initial,
              frequency: CONTENT_ENGINE_CONFIG.schedule_frequency,
              time: CONTENT_ENGINE_CONFIG.schedule_time,
              timezone: CONTENT_ENGINE_CONFIG.schedule_timezone,
              data: { type: "heartbeat", mode: "autonomous" },
            }),
          })
          if (schedRes.ok) {
            const sd = (await schedRes.json()) as { data?: any }
            schedSpinner.stop(success(`Schedule #${sd?.data?.id ?? "?"} created`))
          } else {
            schedSpinner.stop("Schedule creation failed")
          }
        }
      }

      printDivider()
      if (passing < checks.length && !args.fix) {
        prompts.log.info(dim(`iris leads content-engine doctor ${leadId} --fix  — auto-repair`))
      }
      prompts.outro("Done")
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

/**
 * Parse markdown body into sections split by ### headings.
 * Returns array of { heading, body } pairs.
 */
function parseArticleSections(body: string): Array<{ heading: string; body: string }> {
  const lines = body.split("\n")
  const sections: Array<{ heading: string; body: string }> = []
  let currentHeading = ""
  let currentLines: string[] = []

  for (const line of lines) {
    const headingMatch = line.match(/^#{1,3}\s+(.+)/)
    if (headingMatch) {
      if (currentLines.length > 0 || currentHeading) {
        sections.push({ heading: currentHeading, body: currentLines.join("\n").trim() })
      }
      currentHeading = headingMatch[1].replace(/^\d+\.\s*/, "").trim() // strip "1. " prefix
      currentLines = []
    } else {
      currentLines.push(line)
    }
  }
  if (currentLines.length > 0 || currentHeading) {
    sections.push({ heading: currentHeading, body: currentLines.join("\n").trim() })
  }
  return sections.filter((s) => s.body.length > 0)
}

/**
 * Extract a quotable sentence from text — looks for emphatic/insightful sentences.
 */
function extractPullQuote(text: string): string | null {
  const sentences = text.replace(/\n/g, " ").split(/(?<=[.!?])\s+/)
  // Prefer longer sentences that feel quotable
  const candidates = sentences
    .filter((s) => s.length > 40 && s.length < 200)
    .filter((s) => !s.startsWith("Look for") && !s.startsWith("Think") && !s.startsWith("Apps "))
  return candidates.length > 0 ? candidates[Math.floor(candidates.length / 2)] : null
}

/**
 * Build a rich Genesis article page with visual components between sections:
 * Nav → Hero → Intro → Image → Section1 → QuoteBlock → Section2 → StatsCounter →
 * Section3 → FeatureGrid (takeaways) → Newsletter → Footer
 */
function buildArticlePageJson(opts: {
  company: string; title: string; subtitle?: string; body: string;
  label?: string; accentColor?: string; homeSlug?: string; industry?: string;
}): Record<string, unknown> {
  const { company, title, subtitle, body, label, accentColor, homeSlug, industry } = opts
  const color = accentColor ?? "purple"
  const home = homeSlug ? `/p/${homeSlug}` : "#"
  const searchTerm = encodeURIComponent(industry || company)

  const sections = parseArticleSections(body)
  const introSection = sections[0]
  const contentSections = sections.slice(1)

  // Extract a pull quote from the middle of the article
  const quoteSource = contentSections.length > 0 ? contentSections[Math.floor(contentSections.length / 2)].body : body
  const pullQuote = extractPullQuote(quoteSource)

  // Build the component array
  const components: Record<string, unknown>[] = []

  // 1. Navigation
  components.push({
    type: "SiteNavigation",
    props: { logo: { text: company, url: home }, themeMode: "light", accentColor: color, links: [{ label: "Home", url: home }] },
  })

  // 2. Hero
  components.push({
    type: "Hero",
    props: {
      themeMode: "dark",
      title,
      subtitle: subtitle ?? "",
      labelText: label ?? "ARTICLE",
      labelColor: color,
      backgroundColor: "#1a1a2e",
      backgroundImage: `https://images.unsplash.com/photo-1560066984-138dadb4c035?w=1600&q=80`,
      alignment: "center",
      paddingY: "100px",
    },
  })

  // 3. Intro section (if exists)
  if (introSection) {
    components.push({
      type: "EditorialSection",
      props: {
        themeMode: "light",
        backgroundColor: "#ffffff",
        showTopRule: true,
        headingSize: "lg",
        paddingY: "48px",
        maxWidth: "740px",
        label: new Date().toLocaleDateString("en-US", { month: "long", year: "numeric" }).toUpperCase(),
        heading: introSection.heading || title,
        body: introSection.body,
      },
    })
  }

  // 4. Feature image — side-by-side with a teaser
  if (contentSections.length > 0) {
    const firstContent = contentSections[0]
    components.push({
      type: "SplitContent",
      props: {
        themeMode: "light",
        heading: firstContent.heading,
        content: firstContent.body,
        imageUrl: `https://images.unsplash.com/photo-1596462502278-27bfdc403348?w=800&q=80`,
        imagePosition: "right",
      },
    })
  }

  // 5. Pull quote (if extracted)
  if (pullQuote) {
    components.push({
      type: "QuoteBlock",
      props: {
        themeMode: "light",
        quote: pullQuote,
        attribution: company,
        labelText: "INSIGHT",
        labelColor: color,
      },
    })
  }

  // 6. Middle sections as editorial blocks with alternating themes
  for (let i = 1; i < contentSections.length; i++) {
    const section = contentSections[i]
    const isEven = i % 2 === 0
    components.push({
      type: "EditorialSection",
      props: {
        themeMode: "light",
        backgroundColor: isEven ? "#ffffff" : "#f9fafb",
        showTopRule: false,
        headingSize: "md",
        paddingY: "40px",
        maxWidth: "740px",
        stepNumber: String(i + 1),
        accentColor: color,
        heading: section.heading,
        body: section.body,
      },
    })

    // Insert an image after the second content section
    if (i === 1) {
      components.push({
        type: "ImageBlock",
        props: {
          themeMode: "light",
          imageUrl: `https://images.unsplash.com/photo-1522335789203-aabd1fc54bc9?w=1200&q=80`,
          alt: `${company} — ${section.heading || industry || "beauty"}`,
          caption: `Photo: ${company}`,
          maxWidth: "740px",
        },
      })
    }
  }

  // 7. Stats counter — industry stats add credibility
  components.push({
    type: "StatsCounter",
    props: {
      themeMode: "dark",
      accentColor: color,
      stats: [
        { value: "$580B", label: "Global Beauty Market (2026)" },
        { value: "73%", label: "Consumers Want Sustainable Products" },
        { value: "4.2x", label: "ROI on Content Marketing" },
      ],
    },
  })

  // 8. Key takeaways as feature grid
  const takeaways = contentSections.slice(0, 3).map((s, idx) => ({
    icon: ["sparkles", "leaf", "cpu"][idx % 3],
    title: s.heading || `Trend ${idx + 1}`,
    description: s.body.split(".")[0].replace(/\*\*/g, "").trim() + ".",
    accentColor: ["#ec4899", "#10b981", "#6366f1"][idx % 3],
  }))

  if (takeaways.length > 0) {
    components.push({
      type: "FeatureGrid",
      props: {
        themeMode: "light",
        title: "Key Takeaways",
        subtitle: `The trends shaping ${company}'s future`,
        labelText: "SUMMARY",
        columns: Math.min(takeaways.length, 3),
        accentColor: color,
        features: takeaways,
      },
    })
  }

  // 9. Newsletter signup
  components.push({
    type: "NewsletterSignup",
    props: {
      themeMode: "light",
      heading: `${company} Newsletter`,
      subheading: `Stay up to date with the latest from ${company}. Fresh articles delivered automatically.`,
      buttonText: "Subscribe",
      backgroundColor: "#fdf2f8",
      accentColor: "#ec4899",
    },
  })

  // 10. Footer
  components.push({
    type: "SiteFooter",
    props: { companyName: company, themeMode: "light", links: [{ label: "Home", url: home }], copyright: `${new Date().getFullYear()} ${company}` },
  })

  return { components }
}

function slugifyArticle(title: string): string {
  const d = new Date()
  const datePart = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`
  return `${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 60)}-${datePart}`
}

/**
 * Fetch brand design tokens by slug — the canonical source for logo, colors, typography, nav.
 * Returns null if brand doesn't exist or has no design tokens.
 */
async function fetchBrandTokens(brandSlug: string): Promise<Record<string, any> | null> {
  try {
    // Search brands by slug
    const res = await irisFetch(`/api/v1/brands?per_page=50`)
    if (!res.ok) return null
    const bd = (await res.json()) as { data?: any[] | { data?: any[] } }
    const brands: any[] = Array.isArray(bd.data) ? bd.data : (bd.data as any)?.data ?? []
    const brand = brands.find((b: any) => b.slug === brandSlug)
    if (!brand) return null
    const dt = brand.metadata?.design_tokens
    if (!dt || Object.keys(dt).length === 0) return null
    return dt
  } catch {
    return null
  }
}

/**
 * Build SiteNavigation props from brand design tokens.
 */
function brandTokensToNav(tokens: Record<string, any>, homeSlug: string): Record<string, unknown> {
  const logo = tokens.logo ?? {}
  const brand = tokens.brand ?? {}
  const colors = tokens.colors ?? {}
  const nav = tokens.navigation ?? {}
  return {
    themeMode: "light",
    logo: {
      text: brand.name ?? "",
      accentDot: true,
      imageUrl: logo.url ?? "",
      textColor: colors.primary ?? "#000",
    },
    links: [{ label: "Home", url: `/p/${homeSlug}` }],
    ctaButton: nav.ctaText ? { text: nav.ctaText, url: nav.ctaUrl ?? "#" } : undefined,
    ctaColor: nav.ctaColor ?? colors.primary,
    ctaFilled: true,
    ctaTextColor: nav.ctaTextColor ?? "#FFFFFF",
    transparent: false,
    linkColor: nav.linkColor ?? colors.text ?? "#1A1418",
    textColor: nav.textColor ?? colors.text ?? "#1A1418",
    backgroundColor: nav.backgroundColor ?? colors.background ?? "#ffffff",
    hideThemeToggle: nav.hideThemeToggle ?? true,
  }
}

/**
 * Build SiteFooter props from brand design tokens.
 */
function brandTokensToFooter(tokens: Record<string, any>, homeSlug: string): Record<string, unknown> {
  const brand = tokens.brand ?? {}
  return {
    companyName: brand.name ?? "",
    themeMode: "light",
    links: [{ label: "Home", url: `/p/${homeSlug}` }],
    copyright: `${new Date().getFullYear()} ${brand.name ?? ""}${brand.region ? ` — ${brand.region}` : ""}`,
  }
}

/**
 * Fallback: look up existing Genesis home page and extract SiteNavigation + SiteFooter props.
 */
async function fetchPageChrome(homeSlug: string): Promise<{ nav?: Record<string, unknown>; footer?: Record<string, unknown> } | null> {
  try {
    const res = await irisFetch(`/api/v1/pages?per_page=200`)
    if (!res.ok) return null
    const pd = (await res.json()) as { data?: { data?: any[] } }
    const pages = pd?.data?.data ?? pd?.data ?? []
    if (!Array.isArray(pages)) return null
    const homePage = pages.find((p: any) => p.slug === homeSlug)
    if (!homePage) return null

    const pageRes = await irisFetch(`/api/v1/pages/${homePage.id}`)
    if (!pageRes.ok) return null
    const pageData = (await pageRes.json()) as { data?: any }
    const page = pageData?.data ?? pageData
    let jc = page.json_content
    if (typeof jc === "string") try { jc = JSON.parse(jc) } catch { return null }
    if (!jc?.components) return null

    const nav = jc.components.find((c: any) => c.type === "SiteNavigation")
    const footer = jc.components.find((c: any) => c.type === "SiteFooter")
    return { nav: nav?.props, footer: footer?.props }
  } catch {
    return null
  }
}

async function createArticlePage(opts: {
  company: string; title: string; body: string; bloqId: number;
  seoDescription?: string; accentColor?: string; homeSlug?: string; industry?: string;
}): Promise<{ id: number; slug: string; url: string } | null> {
  const slug = slugifyArticle(opts.title)
  const subtitle = opts.body.split("\n").find((l) => l.trim().length > 20 && !l.startsWith("#"))?.trim().slice(0, 160) ?? ""

  // 1. Try brand kit design tokens (canonical source for logo, colors, nav)
  // 2. Fall back to existing Genesis home page chrome
  let navProps: Record<string, unknown> | undefined
  let footerProps: Record<string, unknown> | undefined
  let brandColors: Record<string, string> | undefined

  if (opts.homeSlug) {
    const tokens = await fetchBrandTokens(opts.homeSlug)
    if (tokens?.logo?.url) {
      navProps = brandTokensToNav(tokens, opts.homeSlug)
      footerProps = brandTokensToFooter(tokens, opts.homeSlug)
      brandColors = tokens.colors
      // Use brand accent color if not explicitly set
      if (!opts.accentColor && tokens.colors?.accent) opts.accentColor = tokens.colors.accent
    } else {
      // Fallback: clone from existing home page
      const chrome = await fetchPageChrome(opts.homeSlug)
      if (chrome?.nav) navProps = chrome.nav
      if (chrome?.footer) footerProps = chrome.footer
    }
  }

  const pageJson = buildArticlePageJson({
    company: opts.company,
    title: opts.title,
    subtitle,
    body: opts.body,
    accentColor: opts.accentColor,
    homeSlug: opts.homeSlug,
    industry: opts.industry,
  })

  // Override nav/footer with brand-sourced props
  const comps = (pageJson as any).components as any[]
  if (navProps) {
    const navIdx = comps.findIndex((c: any) => c.type === "SiteNavigation")
    if (navIdx >= 0) comps[navIdx].props = navProps
  }
  if (footerProps) {
    const footerIdx = comps.findIndex((c: any) => c.type === "SiteFooter")
    if (footerIdx >= 0) comps[footerIdx].props = footerProps
  }

  const payload = {
    slug,
    title: opts.title,
    seo_title: `${opts.title} | ${opts.company}`,
    seo_description: opts.seoDescription ?? subtitle.slice(0, 160),
    status: "published",
    owner_type: "bloq",
    owner_id: opts.bloqId,
    json_content: pageJson,
  }

  const res = await irisFetch("/api/v1/pages", { method: "POST", body: JSON.stringify(payload) })
  if (!res.ok) return null
  const data = (await res.json()) as { data?: any }
  const page = data?.data ?? data
  // Auto-publish if created as draft
  if (page.status === "draft" && page.id) {
    await irisFetch(`/api/v1/pages/${page.id}`, { method: "PUT", body: JSON.stringify({ status: "published" }) }).catch(() => {})
  }
  return { id: page.id, slug: page.slug, url: page.public_url ?? `https://heyiris.io/p/${page.slug}` }
}

const ContentEnginePublishCommand = cmd({
  command: "publish <id>",
  describe: "convert unpublished bloq articles into Genesis pages",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "lead ID, name, or email", type: "string", demandOption: true })
      .option("accent-color", { describe: "page accent color", type: "string", default: "blue" })
      .option("all", { describe: "publish all unpublished articles", type: "boolean", default: false })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("Content Engine Publish")

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const resolved = await resolveLeadId(String(args.id))
    if (!resolved) { prompts.outro("Done"); return }
    const { leadId, lead } = resolved
    const userId = await resolveUserId()
    if (!userId) { prompts.log.error("Could not resolve user ID"); prompts.outro("Done"); return }

    const name = lead.name ?? lead.first_name ?? `Lead #${leadId}`
    const company = lead.company ?? name

    // Resolve bloq (same fallback as create)
    let bloqIds: number[] = Array.isArray(lead.bloq_ids) ? lead.bloq_ids : lead.bloq_id ? [lead.bloq_id] : []
    if (bloqIds.length === 0) {
      try {
        const searchRes = await irisFetch(`/api/v1/leads?search=${encodeURIComponent(lead.email ?? name)}&per_page=5`)
        if (searchRes.ok) {
          const sd = (await searchRes.json()) as { data?: any[] }
          const match = (sd?.data ?? []).find((l: any) => l.id === leadId)
          if (match?.bloq_ids) bloqIds = match.bloq_ids.filter((id: number) => id !== 40)
          if (bloqIds.length === 0 && match?.bloq_ids) bloqIds = match.bloq_ids
        }
      } catch {}
    }
    if (bloqIds.length === 0) {
      prompts.log.error("No bloq found for this lead")
      prompts.outro("Done")
      return
    }
    const bloqId = bloqIds[0]

    const spinner = prompts.spinner()
    spinner.start("Fetching bloq articles…")

    try {
      // Fetch bloq with items
      const bloqRes = await irisFetch(`/api/v1/user/${userId}/bloqs/${bloqId}`)
      if (!(await handleApiError(bloqRes, "Fetch bloq"))) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const bloqData = (await bloqRes.json()) as { data?: any }
      const bloq = bloqData?.data?.bloq ?? bloqData?.data ?? bloqData
      const lists: any[] = bloq.lists ?? bloqData?.data?.lists ?? []

      // Collect all items from Agent Deliverables and other content lists
      const items: any[] = []
      for (const list of lists) {
        const listName = (list.name ?? "").toLowerCase()
        if (listName.includes("deliverable") || listName.includes("article") || listName.includes("content") || listName.includes("completed")) {
          for (const item of list.items ?? []) {
            if (item.content && item.title) items.push(item)
          }
        }
      }

      // Fetch existing pages for this bloq to avoid duplicates
      const pagesRes = await irisFetch(`/api/v1/pages?per_page=200`)
      let existingPageSlugs: string[] = []
      if (pagesRes.ok) {
        const pd = (await pagesRes.json()) as { data?: { data?: any[] } }
        const allPages = pd?.data?.data ?? pd?.data ?? []
        if (Array.isArray(allPages)) {
          existingPageSlugs = allPages.map((p: any) => p.slug ?? "").filter(Boolean)
        }
      }

      // Filter to unpublished items (no matching page slug)
      const unpublished = items.filter((item) => {
        const wouldSlug = slugifyArticle(item.title)
        return !existingPageSlugs.some((s) => s.includes(wouldSlug.split("-").slice(0, 3).join("-")))
      })

      spinner.stop(`${items.length} articles found, ${unpublished.length} unpublished`)

      if (unpublished.length === 0) {
        prompts.log.info("All articles already have Genesis pages")
        prompts.outro("Done")
        return
      }

      const toPublish = args.all ? unpublished : unpublished.slice(0, 1)
      const homeSlug = slugify(company)
      const results: any[] = []

      for (const item of toPublish) {
        const pubSpinner = prompts.spinner()
        pubSpinner.start(`Publishing "${item.title.slice(0, 50)}…"`)

        const page = await createArticlePage({
          company,
          title: item.title,
          body: item.content,
          bloqId,
          accentColor: args["accent-color"],
          homeSlug,
        })

        if (page) {
          pubSpinner.stop(`${success("Published:")} ${page.url}`)
          results.push(page)
        } else {
          pubSpinner.stop(`${UI.Style.TEXT_DANGER}Failed${UI.Style.TEXT_NORMAL} — ${item.title.slice(0, 50)}`)
        }
      }

      if (args.json) {
        console.log(JSON.stringify(results, null, 2))
      } else if (results.length > 0) {
        console.log()
        for (const r of results) {
          printKV("Page", `#${r.id} ${r.url}`)
        }
        printDivider()
      }

      prompts.outro(results.length > 0 ? success(`${results.length} page(s) published`) : "Done")
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const LeadsContentEngineCommand = cmd({
  command: "content-engine <command>",
  aliases: ["ce"],
  describe: "manage content engines (auto-article agents) for leads",
  builder: (yargs) =>
    yargs
      .command(ContentEngineCreateCommand)
      .command(ContentEngineStatusCommand)
      .command(ContentEngineDoctorCommand)
      .command(ContentEnginePublishCommand)
      .demandCommand(),
  async handler() {},
})

// ============================================================================
// ensureRequirementsForPages — shared by demo-video and review --full
// ============================================================================

/**
 * Ensure every page in matchingPages has a corresponding requirement.
 * Creates missing requirements with auto-generated Playwright specs.
 * Returns all requirements (existing + newly created) with script_content.
 */
async function ensureRequirementsForPages(
  leadId: number,
  leadName: string,
  matchingPages: Array<{ slug: string; title?: string }>,
): Promise<{ created: number; total: number; requirements: Array<{ id: number; name: string; script_content: string }> }> {
  const BASE_URL = "https://freelabel.net"

  // 1. Fetch existing requirements
  const reqListRes = await irisFetch(`/api/v1/leads/${leadId}/requirements`)
  const reqListData = reqListRes.ok ? ((await reqListRes.json()) as any) : { data: [] }
  const existingReqs: any[] = reqListData.data || []

  // 2. For each page, check if a requirement already exists (exact slug match)
  let created = 0
  for (const p of matchingPages) {
    const slugLower = p.slug.toLowerCase()
    const titleLower = (p.title || "").toLowerCase()
    const alreadyExists = existingReqs.some((r: any) => {
      const rn = r.name?.toLowerCase() || ""
      // Exact match: "QA: {slug}" or "QA: {title}" — not substring
      return rn === `qa: ${slugLower}` || rn === `qa: ${titleLower}` || rn === slugLower
    })
    if (alreadyExists) continue

    const pageUrl = `${BASE_URL}/p/${p.slug}`
    const reqName = `QA: ${p.slug}`
    const scriptContent = generateRequirementSpec(leadName, leadId, pageUrl)

    const createRes = await irisFetch(`/api/v1/leads/${leadId}/requirements`, {
      method: "POST",
      body: JSON.stringify({ name: reqName, script_content: scriptContent }),
    })
    if (createRes.ok) created++
  }

  // 3. Re-fetch all requirements, then fetch script_content individually
  const freshListRes = await irisFetch(`/api/v1/leads/${leadId}/requirements`)
  const freshListData = freshListRes.ok ? ((await freshListRes.json()) as any) : { data: [] }
  const allReqs: any[] = freshListData.data || []

  const requirements: Array<{ id: number; name: string; script_content: string }> = []
  for (const req of allReqs) {
    const detailRes = await irisFetch(`/api/v1/leads/${leadId}/requirements/${req.id}`)
    if (detailRes.ok) {
      const detail = (await detailRes.json()) as any
      const script = detail.data?.script_content
      if (script) {
        requirements.push({ id: req.id, name: req.name, script_content: script })
      }
    }
  }

  return { created, total: requirements.length, requirements }
}

// ============================================================================
// ============================================================================
// iris leads demo-video — record Playwright walkthrough videos for a lead
// ============================================================================

/**
 * Find video.webm files in a directory tree, returning the most recent one
 * produced within the last 5 minutes.
 */
function findRecentWebm(searchDir: string): string {
  const { readdirSync, statSync } = require("fs")
  let webmFile = ""
  const walkDir = (dir: string) => {
    try {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry)
        const st = statSync(full)
        if (st.isDirectory()) walkDir(full)
        else if (entry === "video.webm") {
          const age = Date.now() - st.mtimeMs
          if (age < 300000) webmFile = full
        }
      }
    } catch {}
  }
  walkDir(searchDir)
  return webmFile
}

/**
 * Convert a webm to MP4 via ffmpeg. Falls back to copying webm if ffmpeg unavailable.
 */
function convertToMp4(webmFile: string, mp4Path: string): { mp4Path: string | null; webmPath: string | null } {
  const { copyFileSync, existsSync: fsExists } = require("fs")

  // Ensure source file still exists (Playwright may clean up failed test artifacts)
  if (!fsExists(webmFile)) {
    return { mp4Path: null, webmPath: null }
  }

  // Ensure output directory exists
  mkdirSync(require("path").dirname(mp4Path), { recursive: true })

  const ff = spawnSync("ffmpeg", [
    "-y", "-i", webmFile,
    "-c:v", "libx264", "-preset", "fast", "-crf", "23", "-movflags", "+faststart",
    mp4Path,
  ], { stdio: "pipe", timeout: 120000 })

  if (ff.status === 0) {
    return { mp4Path, webmPath: null }
  } else {
    try {
      const webmOut = mp4Path.replace(/\.mp4$/, ".webm")
      copyFileSync(webmFile, webmOut)
      return { mp4Path: null, webmPath: webmOut }
    } catch {
      return { mp4Path: null, webmPath: null }
    }
  }
}

/**
 * Record a Playwright walkthrough video (synthetic scroll-through of pages) and convert to MP4.
 * Used by `demo-video` standalone command.
 */
async function recordDemoWalkthrough(opts: {
  slugPrefix: string
  matchingPages: Array<{ slug: string; title?: string }>
  leadName: string
  root: string
  slowMo?: number
  width?: number
  height?: number
}): Promise<{ mp4Path: string | null; webmPath: string | null; error: string | null }> {
  const { slugPrefix, matchingPages, leadName, root } = opts
  const slowMo = opts.slowMo ?? 600
  const w = opts.width ?? 1440
  const h = opts.height ?? 900
  const BASE_URL = "https://freelabel.net"
  const outputDir = `test-results/demo-videos/${slugPrefix}`
  const outFullDir = join(root, outputDir)

  const scenes = matchingPages.map((p: any, i: number) => {
    const idx = String(i + 1).padStart(2, "0")
    return `
  // Scene ${i + 1}: ${p.title || p.slug}
  console.log('Scene ${i + 1}: ${p.slug}');
  await page.goto('${BASE_URL}/p/${p.slug}', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: '${outputDir}/screenshots/${idx}-${p.slug}.png', fullPage: true });
  await page.evaluate(() => window.scrollBy({ top: 500, behavior: 'smooth' }));
  await page.waitForTimeout(1500);
  await page.evaluate(() => window.scrollBy({ top: 500, behavior: 'smooth' }));
  await page.waitForTimeout(1500);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
  await page.waitForTimeout(800);`
  }).join("\n")

  const specContent = `import { test } from '@playwright/test';
test.use({
  video: { mode: 'on', size: { width: ${w}, height: ${h} } },
  viewport: { width: ${w}, height: ${h} },
  launchOptions: { slowMo: ${slowMo} },
});
test('${leadName} — Site Walkthrough', async ({ page }) => {
  test.setTimeout(${matchingPages.length * 30} * 1000);
${scenes}
  console.log('Recording complete');
});
`
  const specPath = join(root, "tests/e2e/_demo-video-temp.spec.ts")
  mkdirSync(join(outFullDir, "screenshots"), { recursive: true })
  writeFileSync(specPath, specContent)

  const pw = spawnSync("npx", ["playwright", "test", specPath, "--reporter=list"], {
    cwd: root,
    stdio: "inherit",
    timeout: matchingPages.length * 45 * 1000,
  })

  if (pw.status !== 0) {
    try { unlinkSync(specPath) } catch {}
    return { mp4Path: null, webmPath: null, error: "Playwright recording failed" }
  }

  // Wait for video file
  let webmFile = ""
  for (let attempt = 0; attempt < 20; attempt++) {
    webmFile = findRecentWebm(join(root, "test-results"))
    if (webmFile) break
    spawnSync("sleep", ["0.5"])
  }

  try { unlinkSync(specPath) } catch {}

  if (!webmFile) {
    return { mp4Path: null, webmPath: null, error: "No video file found in test-results/" }
  }

  const mp4Path = join(outFullDir, `${slugPrefix}-walkthrough.mp4`)
  const converted = convertToMp4(webmFile, mp4Path)
  return { ...converted, error: null }
}

/**
 * Run actual Playwright requirement specs with video recording enabled.
 * The video IS the proof that the specs passed — sourced directly from requirements.
 * Returns pass/fail results alongside the video path.
 */
async function runRequirementsWithVideo(opts: {
  leadId: number
  leadName: string
  slugPrefix: string
  root: string
  requirements: Array<{ id: number; name: string; script_content: string }>
  width?: number
  height?: number
}): Promise<{
  mp4Path: string | null
  webmPath: string | null
  passed: boolean
  results: Array<{ name: string; passed: boolean }>
  error: string | null
}> {
  const { leadId, leadName, slugPrefix, root, requirements } = opts
  const w = opts.width ?? 1440
  const h = opts.height ?? 900
  const outputDir = `test-results/requirements-video/${slugPrefix}`
  const outFullDir = join(root, outputDir)
  mkdirSync(outFullDir, { recursive: true })

  // Build a combined spec that wraps each requirement's script_content
  // with video recording enabled, so the video proves the specs ran
  const specParts: string[] = []
  specParts.push(`import { test, expect } from '@playwright/test';`)
  specParts.push(``)
  specParts.push(`test.use({`)
  specParts.push(`  video: { mode: 'on', size: { width: ${w}, height: ${h} } },`)
  specParts.push(`  viewport: { width: ${w}, height: ${h} },`)
  specParts.push(`});`)
  specParts.push(``)

  for (const req of requirements) {
    // Extract only the test bodies from the script_content.
    // If the script has its own imports/describe blocks, we inline the test blocks.
    // Strip import lines and test.describe wrappers — we manage those ourselves.
    let body = req.script_content

    // Remove import lines (we provide our own)
    body = body.replace(/^import\s+.*;\s*$/gm, "")
    // Remove test.use blocks (we provide our own with video)
    body = body.replace(/test\.use\(\{[\s\S]*?\}\);/g, "")

    // If the script has test.describe, keep it (it nests fine)
    // If it's bare test() calls, wrap in describe
    const hasDescribe = /test\.describe\s*\(/.test(body)
    if (hasDescribe) {
      specParts.push(body.trim())
    } else {
      specParts.push(`test.describe('${req.name.replace(/'/g, "\\'")}', () => {`)
      specParts.push(body.trim())
      specParts.push(`});`)
    }
    specParts.push(``)
  }

  const specContent = specParts.join("\n")
  const specPath = join(root, "tests/e2e/_requirements-video-temp.spec.ts")
  writeFileSync(specPath, specContent)

  // Run Playwright with JSON reporter for structured results + list for console
  const totalTimeout = requirements.length * 60 * 1000 // 60s per requirement
  const pw = spawnSync("npx", [
    "playwright", "test", specPath,
    "--reporter=list",
  ], {
    cwd: root,
    stdio: "inherit",
    timeout: Math.max(totalTimeout, 120000),
  })

  const allPassed = pw.status === 0

  // Build result summary from exit code (detailed per-test results would need JSON reporter)
  const results = requirements.map(r => ({
    name: r.name,
    passed: allPassed, // all-or-nothing from exit code; individual results in console output
  }))

  // Wait for video file
  let webmFile = ""
  for (let attempt = 0; attempt < 20; attempt++) {
    webmFile = findRecentWebm(join(root, "test-results"))
    if (webmFile) break
    spawnSync("sleep", ["0.5"])
  }

  try { unlinkSync(specPath) } catch {}

  if (!webmFile) {
    return {
      mp4Path: null, webmPath: null, passed: allPassed, results,
      error: allPassed ? "Tests passed but no video captured" : "Tests failed — no video captured",
    }
  }

  const mp4Path = join(outFullDir, `${slugPrefix}-requirements-proof.mp4`)
  const converted = convertToMp4(webmFile, mp4Path)
  return { ...converted, passed: allPassed, results, error: null }
}

const LeadsDemoVideoCommand = cmd({
  command: "demo-video <lead-id>",
  describe: "record walkthrough videos of a lead's Genesis pages (MP4, ready to share)",
  aliases: ["video", "record"],
  builder: (yargs) =>
    yargs
      .positional("lead-id", { type: "number", demandOption: true })
      .option("slug", { type: "string", describe: "override page slug prefix (default: derived from company name)" })
      .option("open", { type: "boolean", default: true, describe: "open output folder in Finder" })
      .option("note", { type: "boolean", default: true, describe: "add a note to the lead with video details" })
      .option("slow-mo", { type: "number", default: 600, describe: "milliseconds between actions (lower = faster)" })
      .option("width", { type: "number", default: 1440, describe: "viewport width" })
      .option("height", { type: "number", default: 900, describe: "viewport height" }),
  async handler(args) {
    await requireAuth()
    const leadId = args["lead-id"]

    // ── 1. Resolve lead + pages ──
    const spinner = prompts.spinner()
    spinner.start("Fetching lead details...")

    const leadRes = await irisFetch(`/api/v1/leads/${leadId}`)
    if (!leadRes.ok) { spinner.stop("Failed to fetch lead"); return }
    const leadData = (await leadRes.json()) as any
    const lead = leadData.data || leadData
    const leadName = lead.name || lead.full_name || `Lead #${leadId}`
    const company = lead.company || leadName

    let slugPrefix = args.slug || company
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")

    spinner.start(`Finding pages matching "${slugPrefix}"...`)

    const pagesRes = await irisFetch("/api/v1/pages?per_page=200")
    if (!pagesRes.ok) { spinner.stop("Failed to fetch pages"); return }
    const pagesData = (await pagesRes.json()) as any
    const rawData = pagesData.data || pagesData
    const allPages = Array.isArray(rawData) ? rawData : (rawData.data || [])
    const matchingPages = allPages
      .filter((p: any) => p.slug?.startsWith(slugPrefix) && p.status === "published")
      .map((p: any) => ({ slug: p.slug, title: p.title }))

    if (matchingPages.length === 0) {
      spinner.stop(`No published pages matching "${slugPrefix}"`)
      console.log(dim(`  Try: iris leads demo-video ${leadId} --slug <prefix>`))
      return
    }

    spinner.stop(`Found ${matchingPages.length} pages for ${leadName}`)
    for (const p of matchingPages) {
      console.log(dim(`  ${p.slug} — ${p.title || ""}`))
    }

    // ── 2. Find project root ──
    let root = process.cwd()
    for (let i = 0; i < 10; i++) {
      if (existsSync(join(root, "fl-docker-dev"))) break
      const p = join(root, "..")
      if (p === root) break
      root = p
    }

    // ── 3. Auto-create requirements for pages ──
    spinner.start("Ensuring requirements exist for each page...")
    const ensured = await ensureRequirementsForPages(leadId, leadName, matchingPages)
    if (ensured.created > 0) {
      spinner.stop(success(`${ensured.created} requirements auto-created (${ensured.total} total)`))
    } else {
      spinner.stop(success(`${ensured.total} requirements ready (none needed creating)`))
    }

    // ── 4. Run requirement specs with video (preferred) or fallback to walkthrough ──
    const requirementsWithScripts = ensured.requirements
    let videoFile: string | null = null
    let outputDir = `test-results/demo-videos/${slugPrefix}`
    let outFullDir = join(root, outputDir)

    if (requirementsWithScripts.length > 0) {
      spinner.start(`Running ${requirementsWithScripts.length} requirement specs (video recording)...`)
      const result = await runRequirementsWithVideo({
        leadId, leadName, slugPrefix, root,
        requirements: requirementsWithScripts,
        width: args.width, height: args.height,
      })

      const passLabel = result.passed ? "ALL PASSED" : "SOME FAILED"

      if (result.error) {
        spinner.stop(dim(`Spec video: ${result.error}`))
      } else {
        videoFile = result.mp4Path || result.webmPath
        outputDir = `test-results/requirements-video/${slugPrefix}`
        outFullDir = join(root, outputDir)
        if (videoFile) {
          const { statSync } = require("fs")
          const size = (statSync(videoFile).size / (1024 * 1024)).toFixed(1)
          spinner.stop(success(`QA Proof video saved (${passLabel}) — ${size} MB`))
        } else {
          spinner.stop(`Specs ran (${passLabel}) but no video captured`)
        }
      }

      // Report status back to API
      for (const r of result.results) {
        const reqMatch = requirementsWithScripts.find(rq => rq.name === r.name)
        if (reqMatch) {
          await irisFetch(`/api/v1/leads/${leadId}/requirements/${reqMatch.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              last_status: r.passed ? "passed" : "failed",
              last_run_at: new Date().toISOString(),
            }),
          }).catch(() => {})
        }
      }
    } else {
      // Fallback: no scripts, use walkthrough
      spinner.start("Recording video walkthrough (no requirement scripts)...")
      const result = await recordDemoWalkthrough({
        slugPrefix, matchingPages, leadName, root,
        slowMo: args["slow-mo"], width: args.width, height: args.height,
      })
      if (result.error) {
        spinner.stop(result.error)
        return
      }
      videoFile = result.mp4Path || result.webmPath
      if (videoFile) {
        const { statSync } = require("fs")
        const size = (statSync(videoFile).size / (1024 * 1024)).toFixed(1)
        spinner.stop(`Video saved: ${videoFile} (${size} MB)`)
      } else {
        spinner.stop("No video file produced")
      }
    }

    // ── 5. Open in Finder ──
    if (args.open) {
      spawnSync("open", [outFullDir])
    }

    // ── 6. Add lead note ──
    if (args.note) {
      const pageList = matchingPages.map((p: any) => p.slug).join(", ")
      const noteBody = `QA proof video recorded: ${matchingPages.length} pages (${pageList}), ${requirementsWithScripts.length} requirement specs. Output: ${outputDir}/`
      const noteRes = await irisFetch(`/api/v1/leads/${leadId}/notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: noteBody }),
      })
      if (noteRes.ok) {
        console.log(success(`  Note added to lead #${leadId}`))
      }
    }

    console.log(dim(`\n  iris leads demo-video ${leadId} --slug ${slugPrefix}`))
  },
})

// ============================================================================
// ============================================================================
// iris leads review — generate client review page
// ============================================================================

const LeadsReviewCommand = cmd({
  command: "review <lead-id>",
  describe: "generate a client-facing review page from deliverables",
  builder: (yargs) =>
    yargs
      .positional("lead-id", { type: "number", demandOption: true })
      .option("full", { type: "boolean", describe: "autonomous: detect pages, record video, generate review" })
      .option("slug", { type: "string", describe: "override page slug prefix (default: from company name)" })
      .option("skip-video", { type: "boolean", describe: "skip video recording (faster, link deliverables only)" })
      .option("send", { type: "boolean", describe: "email the review link to the client" })
      .option("open", { type: "boolean", describe: "open the review page in your browser" })
      .option("slides", { type: "boolean", describe: "generate branded carousel slides as deliverables" })
      .option("brand", { type: "string", default: "heyiris", describe: "brand slug for carousel theming" })
      .option("mode", { type: "string", default: "feature", describe: "carousel content mode (feature|recruit)" }),
  async handler(args) {
    await requireAuth()
    const leadId = args["lead-id"]

    const spinner = prompts.spinner()

    try {
      // ── Autonomous --full pipeline ──
      if (args.full) {
        const checklist: string[] = []

        // Phase 1: Fetch lead + resolve slug
        spinner.start("Fetching lead details...")
        const leadRes = await irisFetch(`/api/v1/leads/${leadId}`)
        if (!leadRes.ok) { spinner.stop("Failed to fetch lead"); return }
        const leadData = (await leadRes.json()) as any
        const lead = leadData.data || leadData
        const leadName = lead.name || lead.full_name || `Lead #${leadId}`
        const company = lead.company || leadName

        let slugPrefix = (args.slug as string) || company
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/(^-|-$)/g, "")

        if (!slugPrefix) {
          spinner.stop("No company name on lead — use --slug to specify")
          return
        }
        spinner.stop(success(`Lead: ${leadName} | slug prefix: ${slugPrefix}`))

        // Phase 2: Discover pages
        spinner.start(`Finding pages matching "${slugPrefix}"...`)
        const pagesRes = await irisFetch("/api/v1/pages?per_page=200")
        if (!pagesRes.ok) { spinner.stop("Failed to fetch pages"); return }
        const pagesData = (await pagesRes.json()) as any
        const rawPData = pagesData.data || pagesData
        const allPages = Array.isArray(rawPData) ? rawPData : (rawPData.data || [])
        const matchingPages = allPages
          .filter((p: any) => p.slug?.startsWith(slugPrefix) && p.status === "published")
          .map((p: any) => ({ slug: p.slug, title: p.title }))

        if (matchingPages.length === 0) {
          spinner.stop(`No published pages matching "${slugPrefix}"`)
          checklist.push(`No pages found for "${slugPrefix}" — use --slug to override`)
        } else {
          spinner.stop(`Found ${matchingPages.length} pages`)
        }

        // Phase 3: Auto-create requirements for pages + run specs with video
        let requirementsWithScripts: Array<{ id: number; name: string; script_content: string }> = []
        let root = process.cwd()
        for (let i = 0; i < 10; i++) {
          if (existsSync(join(root, "fl-docker-dev"))) break
          const p = join(root, "..")
          if (p === root) break
          root = p
        }

        if (matchingPages.length > 0) {
          spinner.start("Ensuring requirements exist for each page...")
          const ensured = await ensureRequirementsForPages(leadId, leadName, matchingPages)
          requirementsWithScripts = ensured.requirements

          if (ensured.created > 0) {
            spinner.stop(success(`${ensured.created} requirements auto-created (${ensured.total} total)`))
          } else {
            spinner.stop(success(`${ensured.total} requirements ready`))
          }

          if (requirementsWithScripts.length > 0 && !args["skip-video"]) {
            spinner.start(`Running ${requirementsWithScripts.length} requirement specs (video recording)...`)
            const videoResult = await runRequirementsWithVideo({
              leadId, leadName, slugPrefix, root,
              requirements: requirementsWithScripts,
            })

            if (videoResult.error) {
              spinner.stop(dim(`Video: ${videoResult.error}`))
              checklist.push(`Video from specs failed — run manually: iris leads requirements run ${leadId}`)
            } else {
              const videoFile = videoResult.mp4Path || videoResult.webmPath
              const passLabel = videoResult.passed ? "ALL PASSED" : "SOME FAILED"

              let proofVideoUrl: string | null = null
              if (videoFile) {
                spinner.start("Uploading requirements proof video as deliverable...")
                const form = new FormData()
                form.append("type", "file")
                form.append("title", `${leadName} — QA Proof (${passLabel})`)
                form.append("file", Bun.file(videoFile))
                const uploadRes = await irisFetch(`/api/v1/leads/${leadId}/deliverables`, {
                  method: "POST",
                  body: form,
                })
                if (uploadRes.ok) {
                  const uploadData = (await uploadRes.json().catch(() => ({}))) as any
                  proofVideoUrl = uploadData?.data?.deliverable?.url || uploadData?.data?.deliverable?.external_url || null
                  spinner.stop(success(`QA proof video uploaded (${passLabel})`))
                } else {
                  spinner.stop(dim("Video upload failed"))
                  checklist.push(`Video upload failed — file at: ${videoFile}`)
                }
              }

              if (!videoResult.passed) {
                checklist.push(`Requirements specs FAILED — fix issues before sharing: iris leads requirements list ${leadId}`)
              }

              // Report status + proof video URL back to API
              for (const r of videoResult.results) {
                const reqMatch = requirementsWithScripts.find(rq => rq.name === r.name)
                if (reqMatch) {
                  const patchBody: Record<string, any> = {
                    last_status: r.passed ? "passed" : "failed",
                    last_run_at: new Date().toISOString(),
                  }
                  if (proofVideoUrl) patchBody.proof_video_url = proofVideoUrl
                  await irisFetch(`/api/v1/leads/${leadId}/requirements/${reqMatch.id}`, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(patchBody),
                  }).catch(() => {})
                }
              }
            }
          } else if (args["skip-video"]) {
            console.log(dim("  Skipping video (--skip-video)"))
          } else if (requirementsWithScripts.length === 0) {
            checklist.push(`No requirement scripts found — add specs: iris leads reqs create ${leadId} --name "QA" --url "https://..."`)
          }
        }

        // Phase 4: Create link deliverables for each page (deduplicated, with requirement_id)
        if (matchingPages.length > 0) {
          const existingDelRes = await irisFetch(`/api/v1/leads/${leadId}/deliverables`)
          const existingDelData = existingDelRes.ok ? ((await existingDelRes.json()) as any) : { data: { deliverables: [] } }
          const existingDels = existingDelData.data?.deliverables || existingDelData.data || []
          const existingUrls = new Set((Array.isArray(existingDels) ? existingDels : []).map((d: any) => d.external_url).filter(Boolean))

          spinner.start("Creating link deliverables...")
          let pagesAdded = 0
          let pagesSkipped = 0
          let pagesFailed = 0
          for (const p of matchingPages) {
            const pageUrl = `https://freelabel.net/p/${p.slug}`
            if (existingUrls.has(pageUrl)) { pagesSkipped++; continue }
            const body: Record<string, any> = {
              type: "link",
              title: p.title || p.slug,
              external_url: pageUrl,
            }
            // Link deliverable to its requirement (exact slug match)
            const matchingReq = requirementsWithScripts.find(r => r.name?.toLowerCase() === `qa: ${p.slug.toLowerCase()}`)
            if (matchingReq) body.requirement_id = matchingReq.id
            let addRes = await irisFetch(`/api/v1/leads/${leadId}/deliverables`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            })
            // Retry without requirement_id if column doesn't exist yet (migration pending)
            if (!addRes.ok && body.requirement_id) {
              const { requirement_id: _, ...bodyWithout } = body
              addRes = await irisFetch(`/api/v1/leads/${leadId}/deliverables`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(bodyWithout),
              })
            }
            if (addRes.ok) {
              pagesAdded++
            } else {
              pagesFailed++
              if (pagesFailed === 1) {
                const errBody = await addRes.json().catch(() => ({}))
                console.log(dim(`  Deliverable create failed (${addRes.status}): ${(errBody as any).message || addRes.statusText}`))
              }
            }
          }
          const parts = [`${pagesAdded} new`]
          if (pagesSkipped > 0) parts.push(`${pagesSkipped} existed`)
          if (pagesFailed > 0) parts.push(`${pagesFailed} failed`)
          spinner.stop(pagesAdded > 0 || pagesSkipped > 0 ? success(parts.join(", ")) : dim(parts.join(", ")))
        }

        // Phase 5: Pulse check
        spinner.start("Checking pulse score...")
        const pulseRes = await irisFetch(`/api/v1/leads/${leadId}/readiness`)
        if (pulseRes.ok) {
          const pulseData = (await pulseRes.json()) as any
          const score = pulseData.data?.score ?? pulseData.score
          if (score !== undefined && score < 40) {
            checklist.push(`Pulse score ${score}/100 — address signals before sharing`)
          }
        }
        spinner.stop(success("Pulse checked"))

        // Phase 6: Generate review page
        spinner.start("Generating review page...")
        const reviewRes = await irisFetch(`/api/v1/leads/${leadId}/review-page`, { method: "POST" })
        if (!reviewRes.ok) {
          const err = await reviewRes.json().catch(() => ({}))
          spinner.stop("Review page generation failed")
          console.error(`  Error: ${(err as any).message || reviewRes.statusText}`)
          checklist.push("Review page failed — ensure deliverables exist, then retry without --full")
        } else {
          const reviewBody = (await reviewRes.json()) as any
          const reviewUrl = reviewBody.data?.review_url
          const count = reviewBody.data?.deliverable_count || 0
          spinner.stop(success(`Review page ready (${count} deliverables)`))
          console.log()
          console.log(`  ${bold("Review URL:")} ${reviewUrl}`)
          console.log()

          if (args.open && reviewUrl) {
            spawnSync("open", [reviewUrl], { stdio: "ignore" })
          }
          if (args.send && reviewUrl) {
            const sendRes = await irisFetch(`/api/v1/leads/${leadId}/deliverables/send`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                deliverable_ids: [],
                message_mode: "ai",
                custom_context: `Please review your deliverables at: ${reviewUrl}`,
                subject: "Your Project Review is Ready",
              }),
            })
            if (sendRes.ok) {
              console.log(success("  Review link emailed to client"))
            } else {
              console.log(dim("  (email send failed — " + sendRes.status + ")"))
            }
          }
        }

        // Phase 7: Checklist output
        if (checklist.length > 0) {
          console.log()
          console.log(bold("  TODO (items that need attention):"))
          for (const item of checklist) {
            console.log(`  ${dim("•")} ${item}`)
          }
          console.log()
        }

        return
      }

      // ── Optional: Generate branded carousel slides ──
      if (args.slides) {
        // 1. Fetch lead details for context
        spinner.start("Fetching lead details...")
        const leadRes = await irisFetch(`/api/v1/leads/${leadId}`)
        if (!leadRes.ok) {
          spinner.stop("Failed to fetch lead")
          return
        }
        const leadData = (await leadRes.json()) as any
        const lead = leadData.data || leadData
        const leadName = lead.name || lead.full_name || `Lead #${leadId}`

        // Fetch existing deliverables for context
        const delRes = await irisFetch(`/api/v1/leads/${leadId}/deliverables`)
        const delData = delRes.ok ? ((await delRes.json()) as any) : { data: [] }
        const deliverables = delData.data || []
        const deliverableTitles = deliverables
          .map((d: any) => d.title || d.file_name)
          .filter(Boolean)
          .join(", ")

        // Fetch recent notes
        const notesRes = await irisFetch(`/api/v1/leads/${leadId}/notes?per_page=5`)
        const notesData = notesRes.ok ? ((await notesRes.json()) as any) : { data: [] }
        const recentNotes = (notesData.data || [])
          .map((n: any) => n.body || n.content || "")
          .filter(Boolean)
          .join("\n")

        const context = [
          `Client: ${leadName}`,
          deliverableTitles ? `Deliverables: ${deliverableTitles}` : "",
          recentNotes ? `Project notes:\n${recentNotes}` : "",
        ].filter(Boolean).join("\n\n")

        spinner.stop(success(`Lead: ${leadName} (${deliverables.length} deliverables)`))

        // 2. Resolve brand tokens
        const brand = args.brand as string
        const builtIn = ["freelabel", "discover", "heyiris", "beatbox", "emc_radio", "capital_collective"]
        let brandOverrides: Record<string, string> = {}

        if (!builtIn.includes(brand)) {
          spinner.start(`Resolving ${brand} design tokens...`)
          const tokenData = await fetchBrandTokens(brand)
          if (tokenData) {
            const semantic = (tokenData as any).semantic ?? {}
            if (semantic.bg_page) brandOverrides.bgOverride = semantic.bg_page
            if (semantic.bg_brand) brandOverrides.accentOverride = semantic.bg_brand
            if (semantic.fg_primary) brandOverrides.textOverride = semantic.fg_primary
            brandOverrides.handleOverride = `@${brand}`
            spinner.stop(success(`Brand tokens: ${Object.keys(brandOverrides).length} overrides`))
          } else {
            spinner.stop(dim("No brand tokens found, using defaults"))
          }
        }

        // 3. AI generates carousel content
        const mode = (args.mode as string) === "recruit" ? "recruit" : "feature"
        spinner.start(`AI writing carousel content (${mode} mode)...`)
        const carouselProps = await aiGenerateCarouselProps(context, brand, mode as any)
        if (!carouselProps) {
          spinner.stop("AI generation failed")
          prompts.outro("Done")
          return
        }
        carouselProps.brand = builtIn.includes(brand) ? brand : "freelabel"
        Object.assign(carouselProps, brandOverrides)
        spinner.stop(success("Carousel content generated"))

        // 4. Render 9 slides via Remotion
        const rDir = resolveRemotionDir()
        const outDir = join(rDir, `review-slides-${leadId}-${Date.now()}`)
        mkdirSync(outDir, { recursive: true })

        spinner.start("Rendering 9 carousel slides...")
        let renderFailed = false
        for (let i = 0; i < 9; i++) {
          const outFile = join(outDir, `slide-${i}.png`)
          const slideProps = { ...carouselProps, slideIndex: i }
          const propsFile = join(outDir, `_props-${i}.json`)
          writeFileSync(propsFile, JSON.stringify(slideProps))
          const result = spawnSync(
            "npx",
            ["remotion", "still", `CarouselSlide${i}`, outFile, `--props=${propsFile}`],
            { stdio: "pipe", env: process.env, cwd: rDir },
          )
          if (result.status !== 0) {
            prompts.log.error(`Slide ${i}: ${result.stderr?.toString().slice(0, 200) ?? "unknown error"}`)
            spinner.stop(`Slide ${i} failed`)
            renderFailed = true
            break
          }
        }
        // Cleanup temp props files
        for (let i = 0; i < 9; i++) { try { unlinkSync(join(outDir, `_props-${i}.json`)) } catch {} }

        if (renderFailed) {
          prompts.outro("Slide rendering failed — skipping upload")
          return
        }
        spinner.stop(success("9 slides rendered"))

        // 5. Upload each slide as a deliverable
        spinner.start("Uploading slides as deliverables...")
        let uploaded = 0
        for (let i = 0; i < 9; i++) {
          const slidePath = join(outDir, `slide-${i}.png`)
          if (!existsSync(slidePath)) continue

          const form = new FormData()
          form.append("type", "file")
          form.append("title", `Project Update - Slide ${i + 1} of 9`)
          form.append("file", Bun.file(slidePath))

          const uploadRes = await irisFetch(`/api/v1/leads/${leadId}/deliverables`, {
            method: "POST",
            body: form,
          })
          if (uploadRes.ok) uploaded++
        }
        spinner.stop(success(`${uploaded} slides uploaded as deliverables`))

        // Cleanup rendered files
        for (let i = 0; i < 9; i++) { try { unlinkSync(join(outDir, `slide-${i}.png`)) } catch {} }
        try { require("fs").rmSync(outDir, { recursive: true, force: true }) } catch {}
      }

      // ── Generate review page (picks up new slide deliverables automatically) ──
      spinner.start("Generating review page...")
      const res = await irisFetch(`/api/v1/leads/${leadId}/review-page`, { method: "POST" })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        spinner.stop("Failed")
        console.error(`  Error: ${(err as any).message || res.statusText}`)
        return
      }

      const body = await res.json() as any
      const reviewUrl = body.data?.review_url
      const count = body.data?.deliverable_count || 0

      spinner.stop(`Review page ready (${count} deliverables)`)
      console.log()
      console.log(`  ${bold("Review URL:")} ${reviewUrl}`)
      console.log()

      if (args.open && reviewUrl) {
        spawnSync("open", [reviewUrl], { stdio: "ignore" })
        console.log(dim("  Opening in browser..."))
      }

      if (args.send) {
        console.log(dim("  Sending review link via deliverables email..."))
        const sendRes = await irisFetch(`/api/v1/leads/${leadId}/deliverables/send`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            deliverable_ids: [],
            message_mode: "ai",
            custom_context: `Please review your deliverables at: ${reviewUrl}`,
            subject: "Your Project Review is Ready",
          }),
        })
        if (sendRes.ok) {
          console.log(success("  Review link emailed to client"))
        } else {
          console.log(dim("  (email send failed — " + sendRes.status + ")"))
        }
      }
    } catch (err: any) {
      spinner.stop("Failed")
      console.error(`  Error: ${err.message}`)
    }
  },
})

// ============================================================================
// Attach / Detach bloq
// ============================================================================

const LeadsAttachBloqCommand = cmd({
  command: "attach-bloq <lead-id> <bloq-id>",
  aliases: ["add-bloq"],
  describe: "attach a lead to a bloq project",
  builder: (yargs) =>
    yargs
      .positional("lead-id", { describe: "lead ID", type: "number", demandOption: true })
      .positional("bloq-id", { describe: "bloq ID", type: "number", demandOption: true }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Attach Lead #${args["lead-id"]} → Bloq #${args["bloq-id"]}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Attaching…")

    try {
      const res = await irisFetch(`/api/v1/leads/${args["lead-id"]}/attach-bloq`, {
        method: "POST",
        body: JSON.stringify({ bloq_id: args["bloq-id"] }),
      })
      if (!res.ok) {
        spinner.stop("Failed", 1)
        await handleApiError(res, "Attach bloq")
        prompts.outro("Done")
        return
      }

      spinner.stop(`${success("✓")} Lead #${args["lead-id"]} attached to Bloq #${args["bloq-id"]}`)
      prompts.outro(dim(`iris leads get ${args["lead-id"]}`))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const LeadsDetachBloqCommand = cmd({
  command: "detach-bloq <lead-id> <bloq-id>",
  aliases: ["remove-bloq"],
  describe: "detach a lead from a bloq project",
  builder: (yargs) =>
    yargs
      .positional("lead-id", { describe: "lead ID", type: "number", demandOption: true })
      .positional("bloq-id", { describe: "bloq ID", type: "number", demandOption: true }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Detach Lead #${args["lead-id"]} from Bloq #${args["bloq-id"]}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Detaching…")

    try {
      const res = await irisFetch(`/api/v1/leads/${args["lead-id"]}/detach-bloq`, {
        method: "POST",
        body: JSON.stringify({ bloq_id: args["bloq-id"] }),
      })
      if (!res.ok) {
        spinner.stop("Failed", 1)
        await handleApiError(res, "Detach bloq")
        prompts.outro("Done")
        return
      }

      spinner.stop(`${success("✓")} Lead #${args["lead-id"]} detached from Bloq #${args["bloq-id"]}`)
      prompts.outro(dim(`iris leads get ${args["lead-id"]}`))
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
      .command(LeadsSyncCalendarCommand)
      .command(LeadsNotesCommand)
      .command(LeadsNoteCommand)
      .command(LeadsOutreachCommand)
      .command(LeadsTasksCommand)
      .command(LeadsPaymentGateCommand)
      .command(LeadsUpdatePaymentGateCommand)
      .command(LeadsDeletePaymentGateCommand)
      .command(LeadsDealStatusCommand)
      .command(LeadsPackagesCommand)
      .command(LeadsCreatePackageCommand)
      .command(LeadsUpdatePackageCommand)
      .command(LeadsRegenCheckoutCommand)
      .command(LeadsSubscriptionUpdateCommand)
      .command(LeadsCollectCommand)
      .command(LeadsSegmentCommand)
      .command(LeadsRequirementsCommand)
      .command(LeadsEnrichCommand)
      .command(LeadsGateAllCommand)
      .command(LeadsKBCommand)
      .command(LeadsPulseAllCommand)
      .command(LeadsOnboardCommand)
      .command(LeadsOnboardAllCommand)
      .command(LeadsDispositionCommand)
      .command(LeadsContentEngineCommand)
      .command(LeadsDemoVideoCommand)
      .command(LeadsReviewCommand)
      .command(LeadsAttachBloqCommand)
      .command(LeadsDetachBloqCommand)
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

    if (args.json) {
      console.log(JSON.stringify(data, null, 2))
      return
    }

    if (!deals.length) {
      prompts.log.info("No active deals found")
      console.log(dim('Create one: iris leads payment-gate <lead-id> -a 500 -s "Scope"'))
      return
    }

    console.log("")
    console.log(
      bold(`Active Deals — ${deals.length} total | Pipeline: $${Number(data.pipeline_value ?? 0).toFixed(2)}`),
    )
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

    if (args.json) {
      console.log(JSON.stringify(status, null, 2))
      return
    }

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

    if (args.json) {
      console.log(JSON.stringify(result, null, 2))
      return
    }

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
      .option("interval", {
        alias: "i",
        describe: "billing interval",
        type: "string",
        choices: ["one-time", "month", "quarter", "year"],
      })
      .option("pass-fees", {
        describe: "pass Stripe processing fees to the client (default 2.9% + $0.30)",
        type: "boolean",
      })
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

    if (args.json) {
      console.log(JSON.stringify(result, null, 2))
      return
    }

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

    if (args.json) {
      console.log(JSON.stringify(result, null, 2))
      return
    }

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
      .option("interval", {
        alias: "i",
        describe: "billing interval",
        type: "string",
        choices: ["one-time", "month", "quarter", "year"],
      })
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
      const mapped = { monthly: "month", quarterly: "quarter", yearly: "year", one_time: "one-time" } as Record<
        string,
        string
      >
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

    if (args.json) {
      console.log(JSON.stringify(result, null, 2))
      return
    }

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
      .option("interval", {
        describe: "subscription interval",
        type: "string",
        choices: ["month", "year"] as const,
        default: "month",
      })
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
        if (!args.json)
          console.log(highlight(`  ⚠ Mark paid failed: ${markBody?.error ?? markBody?.message ?? "unknown"}`))
      }

      if (args.json) {
        console.log(JSON.stringify(results, null, 2))
        return
      }
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

    if (args.json) {
      console.log(JSON.stringify({ ...results, invoice_id: invoiceId }, null, 2))
      return
    }
    printDivider()
    if (results.checkout_url) printKV("Payment Link", String(results.checkout_url))
    console.log(dim(`  Track: iris deals status ${leadId}`))
  },
})

// ============================================================================
// Segment — saved filters for lead groups
// ============================================================================

// ============================================================================
// Segments — stored in platform DB (lead_segments table), synced across team
// ============================================================================

async function fetchSegments(bloqId?: number): Promise<any[]> {
  const userId = await resolveUserId()
  if (!userId) return []
  const path = bloqId
    ? `/api/v1/users/${userId}/bloqs/${bloqId}/lead-segments`
    : `/api/v1/users/${userId}/lead-segments`
  const res = await irisFetch(path)
  if (!res.ok) return []
  const data = await res.json().catch(() => ({}))
  return data?.segments ?? []
}

const SegmentListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list saved segments",
  builder: (yargs) =>
    yargs
      .option("bloq-id", { describe: "filter by bloq/project ID", type: "number" })
      .option("json", { describe: "JSON output", type: "boolean" }),
  async handler(args) {
    if (!(await requireAuth())) return

    const segments = await fetchSegments(args["bloq-id"] as number | undefined)
    if ((args as any).json) {
      console.log(JSON.stringify(segments, null, 2))
      return
    }
    if (segments.length === 0) {
      prompts.log.info("No segments saved yet")
      console.log(dim('Create one: iris leads segment create "Won Retainers" --status=Won'))
      return
    }
    console.log("")
    console.log(bold(`Lead Segments (${segments.length})`))
    printDivider()
    for (const seg of segments) {
      const summary =
        seg.filter_summary ||
        Object.entries(seg.filters || {})
          .map(([k, v]: [string, any]) => `${k}=${v}`)
          .join(", ")
      const bloqTag = seg.bloq_id ? dim(` [bloq #${seg.bloq_id}]`) : dim(" [global]")
      const countTag = seg.lead_count != null ? dim(` (${seg.lead_count} leads)`) : ""
      console.log(`  ${bold(seg.name)}  ${dim(summary)}${bloqTag}${countTag}`)
    }
    printDivider()
  },
})

const SegmentCreateCommand = cmd({
  command: "create <name>",
  aliases: ["add", "save"],
  describe: "create a named segment with filters (stored in platform DB)",
  builder: (yargs) =>
    yargs
      .positional("name", { describe: "segment name", type: "string", demandOption: true })
      .option("status", { describe: "filter by status (Won, Active, In Negotiation, etc.)", type: "string" })
      .option("search", { describe: "search query (name/email/company)", type: "string" })
      .option("bloq-id", { describe: "scope segment to a bloq/project ID", type: "number" })
      .option("min-price", { describe: "minimum price_bid", type: "number" })
      .option("max-price", { describe: "maximum price_bid", type: "number" })
      .option("tag", { describe: "filter by tag", type: "string" })
      .option("shared", { describe: "make visible to team members", type: "boolean", default: false })
      .option("json", { describe: "JSON output", type: "boolean" }),
  async handler(args) {
    if (!(await requireAuth())) return

    const filters: Record<string, any> = {}
    if (args.status) filters.status = String(args.status)
    if (args.search) filters.search = String(args.search)
    if (args["min-price"]) filters.value_range = { ...(filters.value_range || {}), min: Number(args["min-price"]) }
    if (args["max-price"]) filters.value_range = { ...(filters.value_range || {}), max: Number(args["max-price"]) }
    if (args.tag) filters.tags = [String(args.tag)]

    if (Object.keys(filters).length === 0) {
      prompts.log.error("At least one filter required (--status, --search, --bloq-id, --min-price, --tag)")
      return
    }

    const userId = await resolveUserId()
    if (!userId) {
      prompts.log.error("Could not resolve user ID")
      return
    }

    const bloqId = args["bloq-id"] as number | undefined
    const path = bloqId
      ? `/api/v1/users/${userId}/bloqs/${bloqId}/lead-segments`
      : `/api/v1/users/${userId}/lead-segments`

    const res = await irisFetch(path, {
      method: "POST",
      body: JSON.stringify({
        name: String(args.name),
        filters,
        is_shared: args.shared,
      }),
    })

    if (!(await handleApiError(res, "Create segment"))) return

    const data = await res.json().catch(() => ({}))
    const seg = data?.segment

    if ((args as any).json) {
      console.log(JSON.stringify(seg, null, 2))
      return
    }
    prompts.log.success(`Segment "${args.name}" created (ID: ${seg?.id})`)
    if (seg?.filter_summary) console.log(dim(`  Filters: ${seg.filter_summary}`))
    if (seg?.lead_count != null) console.log(dim(`  Matching leads: ${seg.lead_count}`))
    console.log(dim(`  View: iris leads segment view ${seg?.id}`))
  },
})

const SegmentViewCommand = cmd({
  command: "view <id>",
  aliases: ["show", "run"],
  describe: "run a saved segment and show matching leads",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "segment ID or name", type: "string", demandOption: true })
      .option("limit", { describe: "max results", type: "number", default: 50 })
      .option("json", { describe: "JSON output", type: "boolean" }),
  async handler(args) {
    if (!(await requireAuth())) return

    const userId = await resolveUserId()
    if (!userId) {
      prompts.log.error("Could not resolve user ID")
      return
    }

    // Resolve by ID or name
    let segmentId = args.id
    if (isNaN(Number(segmentId))) {
      // Look up by name
      const segments = await fetchSegments()
      const match = segments.find((s: any) => s.name.toLowerCase() === String(segmentId).toLowerCase())
      if (!match) {
        prompts.log.error(`Segment "${segmentId}" not found`)
        const names = segments.map((s: any) => s.name).join(", ")
        if (names) console.log(dim(`  Available: ${names}`))
        return
      }
      segmentId = String(match.id)
    }

    // Fetch leads via the segment's dedicated leads endpoint
    const res = await irisFetch(`/api/v1/users/${userId}/lead-segments/${segmentId}/leads?per_page=${args.limit}`)
    if (!(await handleApiError(res, "Fetch segment leads"))) return

    const data = await res.json().catch(() => ({}))
    const leads: any[] = data?.leads ?? data?.data ?? []
    const seg = data?.segment

    if ((args as any).json) {
      console.log(JSON.stringify({ segment: seg, leads, count: leads.length }, null, 2))
      return
    }

    console.log("")
    console.log(bold(`Segment: ${seg?.name ?? segmentId} — ${leads.length} leads`))
    if (seg?.filter_summary) console.log(dim(`  Filters: ${seg.filter_summary}`))
    printDivider()

    if (leads.length === 0) {
      prompts.log.info("No leads match this segment")
      return
    }
    for (const l of leads) printLead(l)
    printDivider()
  },
})

const SegmentDeleteCommand = cmd({
  command: "delete <id>",
  aliases: ["rm", "remove"],
  describe: "delete a saved segment",
  builder: (yargs) => yargs.positional("id", { describe: "segment ID", type: "number", demandOption: true }),
  async handler(args) {
    if (!(await requireAuth())) return

    const userId = await resolveUserId()
    if (!userId) {
      prompts.log.error("Could not resolve user ID")
      return
    }

    const res = await irisFetch(`/api/v1/users/${userId}/lead-segments/${args.id}`, { method: "DELETE" })
    if (!(await handleApiError(res, "Delete segment"))) return

    prompts.log.success(`Segment #${args.id} deleted`)
  },
})

// One-time migration: push local segments to platform DB
const SegmentMigrateCommand = cmd({
  command: "migrate",
  aliases: ["sync-local"],
  describe: "migrate local ~/.iris/lead-segments.json to platform DB (one-time)",
  builder: (yargs) =>
    yargs
      .option("bloq-id", { describe: "target bloq ID for migrated segments", type: "number" })
      .option("dry-run", { describe: "show what would be migrated without saving", type: "boolean" }),
  async handler(args) {
    if (!(await requireAuth())) return

    const localPath = join(homedir(), ".iris", "lead-segments.json")
    if (!existsSync(localPath)) {
      prompts.log.info("No local segments file found at ~/.iris/lead-segments.json")
      return
    }

    let localSegments: Array<{ name: string; filters: Record<string, string>; created: string }> = []
    try {
      localSegments = JSON.parse(readFileSync(localPath, "utf-8"))
    } catch {
      prompts.log.error("Failed to parse local segments file")
      return
    }

    if (localSegments.length === 0) {
      prompts.log.info("No local segments to migrate")
      return
    }

    console.log("")
    console.log(bold(`Migrating ${localSegments.length} local segment(s) to platform DB`))
    printDivider()

    if (args["dry-run"]) {
      for (const seg of localSegments) {
        console.log(
          `  ${bold(seg.name)}  ${dim(
            Object.entries(seg.filters)
              .map(([k, v]) => `${k}=${v}`)
              .join(", "),
          )}`,
        )
      }
      console.log("")
      console.log(dim("Dry run — no changes made. Remove --dry-run to migrate."))
      return
    }

    const userId = await resolveUserId()
    if (!userId) {
      prompts.log.error("Could not resolve user ID")
      return
    }

    const bloqId = args["bloq-id"] as number | undefined
    const path = bloqId
      ? `/api/v1/users/${userId}/bloqs/${bloqId}/lead-segments`
      : `/api/v1/users/${userId}/lead-segments`

    let ok = 0
    let fail = 0
    for (const seg of localSegments) {
      // Convert flat string filters to API format
      const filters: Record<string, any> = { ...seg.filters }
      if (filters.min_price) {
        filters.value_range = { ...(filters.value_range || {}), min: Number(filters.min_price) }
        delete filters.min_price
      }
      if (filters.max_price) {
        filters.value_range = { ...(filters.value_range || {}), max: Number(filters.max_price) }
        delete filters.max_price
      }
      if (filters.tag) {
        filters.tags = [filters.tag]
        delete filters.tag
      }

      const res = await irisFetch(path, {
        method: "POST",
        body: JSON.stringify({ name: seg.name, filters }),
      })
      if (res.ok) {
        const data = await res.json().catch(() => ({}))
        console.log(`  ${success("+")} ${seg.name} → ID #${data?.segment?.id}`)
        ok++
      } else {
        console.log(`  ${dim("x")} ${seg.name} — failed (HTTP ${res.status})`)
        fail++
      }
    }

    printDivider()
    console.log(`  ${ok} migrated, ${fail} failed`)
    if (ok > 0 && fail === 0) {
      console.log(dim(`  Local file kept at ${localPath} — safe to delete once verified`))
    }
  },
})

export const LeadsSegmentCommand = cmd({
  command: "segment",
  aliases: ["segments", "seg"],
  describe: "manage lead segments — named filters stored in platform DB (shared across team)",
  builder: (yargs) =>
    yargs
      .command(SegmentListCommand)
      .command(SegmentCreateCommand)
      .command(SegmentViewCommand)
      .command(SegmentDeleteCommand)
      .command(SegmentMigrateCommand)
      .demandCommand(),
  async handler() {},
})

// ============================================================================
// Requirements — automated deliverable testing via Hive/Playwright
// ============================================================================

function generateRequirementSpec(leadName: string, leadId: number, url: string): string {
  // Extract slug from URL for unique describe block titles
  const slug = url.replace(/.*\/p\//, "").replace(/[?#].*/, "") || url
  return `// Auto-generated requirements for: ${leadName} (#${leadId})
// URL: ${url}
// Generated: ${new Date().toISOString().split("T")[0]}
import { test, expect } from '@playwright/test';

test.describe('QA: ${slug}', () => {
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

  test('no console errors (excluding 3rd-party)', async ({ page }) => {
    // Ignore noise from analytics, ads, tracking pixels, browser extensions
    const ignore = [
      'google', 'facebook', 'fbevents', 'analytics', 'gtag', 'gtm',
      'doubleclick', 'adsense', 'adsbygoogle', 'hotjar', 'clarity',
      'sentry', 'segment', 'mixpanel', 'intercom', 'drift', 'hubspot',
      'tiktok', 'twitter', 'twimg', 'pinterest', 'linkedin',
      'chrome-extension', 'moz-extension', 'safari-extension',
      'favicon', 'robots.txt', 'sw.js', 'service-worker',
    ];
    const errors: string[] = [];
    page.on('console', m => {
      if (m.type() !== 'error') return;
      const txt = m.text().toLowerCase();
      if (ignore.some(k => txt.includes(k))) return;
      errors.push(m.text());
    });
    await page.goto(URL, { waitUntil: 'networkidle', timeout: 60000 });
    expect(errors).toHaveLength(0);
  });

  test('no broken assets (excluding 3rd-party)', async ({ page }) => {
    // Ignore 404s from analytics, ad networks, tracking pixels, CDN prefetch
    const ignoreUrls = [
      'google', 'facebook', 'fbevents', 'analytics', 'gtag', 'gtm',
      'doubleclick', 'adsense', 'hotjar', 'clarity', 'sentry',
      'segment', 'mixpanel', 'intercom', 'drift', 'hubspot',
      'tiktok', 'twitter', 'pinterest', 'linkedin',
      'favicon.ico', 'robots.txt', 'sw.js', 'service-worker',
      'chrome-extension', 'moz-extension',
    ];
    const broken: string[] = [];
    page.on('response', r => {
      if (r.status() < 400) return;
      const url = r.url().toLowerCase();
      if (ignoreUrls.some(k => url.includes(k))) return;
      broken.push(r.url());
    });
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
      const filePath = isAbsolute(String(args["script-file"]))
        ? String(args["script-file"])
        : join(process.cwd(), String(args["script-file"]))
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

    if ((args as any).json) {
      console.log(JSON.stringify(body, null, 2))
      return
    }

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

    if ((args as any).json) {
      console.log(JSON.stringify(reqs, null, 2))
      return
    }

    if (reqs.length === 0) {
      prompts.log.info(`No requirements for lead #${args.leadId}`)
      console.log(dim(`Create one: iris leads requirements create ${args.leadId} --name "QA" --url "https://..."`))
      return
    }

    console.log("")
    console.log(bold(`Requirements — Lead #${args.leadId} (${reqs.length})`))
    printDivider()
    for (const r of reqs) {
      const statusIcon =
        r.last_status === "passed" || r.last_status === "completed"
          ? success("✓")
          : r.last_status === "failed"
            ? highlight("✗")
            : dim("○")
      const lastRun = r.last_run_at ? dim(r.last_run_at.split("T")[0]) : dim("never run")
      console.log(`  ${statusIcon}  ${bold(r.name)}  ${dim(`#${r.id}`)}  ${lastRun}`)
      if (r.last_output && r.last_status === "failed") {
        const output = String(r.last_output)
          .split("\n")
          .slice(0, 5)
          .map((l: string) => `       ${dim(l)}`)
          .join("\n")
        console.log(output)
      }
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
        const match = Array.isArray(reqs)
          ? reqs.find((r: any) => (r.name ?? r.title ?? "").toLowerCase() === String(args.name).toLowerCase())
          : null
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

    if ((args as any).json) {
      console.log(JSON.stringify(body, null, 2))
      return
    }

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

    if ((args as any).json) {
      console.log(JSON.stringify(s, null, 2))
      return
    }

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
    if ((args as any).json) {
      console.log(JSON.stringify(body, null, 2))
      return
    }
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
      .option("status", {
        alias: "s",
        describe: "filter by status",
        type: "string",
        choices: ["passed", "failed", "untested"],
      })
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
    if ((args as any).json) {
      console.log(JSON.stringify(body, null, 2))
      return
    }

    const items: any[] = body.data ?? []
    const pg = body.pagination ?? {}

    if (items.length === 0) {
      prompts.log.info(`No requirements found${args.status ? ` (status=${args.status})` : ""}`)
      return
    }

    console.log("")
    console.log(
      bold(
        `Active Requirements — ${pg.total ?? items.length} total · page ${pg.current_page ?? 1}/${pg.last_page ?? 1}`,
      ),
    )
    printDivider()

    for (const r of items) {
      const status = r.last_status
      const icon =
        status === "passed" || status === "completed" ? success("✓") : status === "failed" ? highlight("✗") : dim("○")
      const lead = r.lead
        ? `${r.lead.name ?? "?"}${r.lead.company ? dim(" — " + r.lead.company) : ""}`
        : dim("(no lead)")
      const lastRun = r.last_run_at ? dim(r.last_run_at.split("T")[0]) : dim("never")
      const counts = r.pass_count || r.fail_count ? dim(` ${r.pass_count}✓ / ${r.fail_count}✗`) : ""
      console.log(`  ${icon}  ${bold(r.name)}${counts}`)
      console.log(`     ${dim(`#${r.id} · lead #${r.lead?.id ?? "?"}`)} ${lead}  ${lastRun}`)
    }

    printDivider()
    if (pg.last_page && pg.last_page > 1) {
      const next =
        (pg.current_page ?? 1) < pg.last_page
          ? `iris leads requirements all --page ${(pg.current_page ?? 1) + 1}`
          : null
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
        choices: [
          "hourly",
          "every_2_hours",
          "every_4_hours",
          "every_6_hours",
          "every_8_hours",
          "every_12_hours",
          "daily",
          "weekly",
        ],
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
    if ((args as any).json) {
      console.log(JSON.stringify(result, null, 2))
      return
    }

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

// ============================================================================
// iris pulse — top-level convenience wrapper
// Combines diary digest + pulse-all scorecard + ungated leads
// ============================================================================

// ── Pulse Alert Rules ─────────────────────────────────────────────────────────

const PulseAlertsListCommand = cmd({
  command: "list",
  describe: "list your pulse alert rules",
  builder: (yargs) => yargs,
  async handler() {
    if (!(await requireAuth())) return
    const spinner = prompts.spinner()
    spinner.start("Loading alert rules…")
    const res = await irisFetch("/api/v1/pulse/alerts")
    if (!res.ok) { spinner.stop("Failed"); await handleApiError(res, "list alerts"); return }
    const body = (await res.json()) as any
    const rules = body?.data ?? []
    spinner.stop(dim("loaded"))
    if (rules.length === 0) {
      console.log(`\n  ${dim("No alert rules configured.")}`)
      console.log(`  ${dim("Create one:")} iris pulse alerts add --signal comms_freshness --below 40`)
      return
    }
    console.log()
    console.log(`  ${bold("Pulse Alert Rules")}  ${dim(`(${rules.length})`)}`)
    for (const r of rules) {
      const status = r.enabled ? success("ON") : dim("OFF")
      const fired = r.last_fired_at ? dim(` last: ${r.last_fired_at}`) : ""
      console.log(`    ${dim(`#${r.id}`)}  ${r.signal} ${r.operator}${r.threshold}  ×${r.consecutive}  → ${r.notify_channel}  ${status}${fired}`)
    }
    console.log()
  },
})

const PulseAlertsAddCommand = cmd({
  command: "add",
  describe: "add a pulse alert rule",
  builder: (yargs) =>
    yargs
      .option("signal", { alias: "s", type: "string", demandOption: true, describe: "signal name (e.g. comms_freshness, deal_health)" })
      .option("below", { type: "number", describe: "alert when signal drops below this value" })
      .option("above", { type: "number", describe: "alert when signal rises above this value" })
      .option("for", { type: "number", default: 1, describe: "consecutive snapshots required" })
      .option("channel", { alias: "c", type: "string", default: "discord", describe: "notification channel (discord|imessage|log)" }),
  async handler(args) {
    if (!(await requireAuth())) return

    const threshold = args.below ?? args.above
    if (threshold === undefined) {
      prompts.log.error("Specify --below <N> or --above <N>")
      return
    }
    const operator = args.below !== undefined ? "<" : ">"

    const spinner = prompts.spinner()
    spinner.start("Creating alert rule…")
    const res = await irisFetch("/api/v1/pulse/alerts", {
      method: "POST",
      body: JSON.stringify({
        signal: args.signal,
        operator,
        threshold,
        consecutive: args.for,
        notify_channel: args.channel,
      }),
    })
    if (!res.ok) {
      spinner.stop("Failed")
      const err = await res.json().catch(() => ({})) as any
      prompts.log.error(err?.message ?? `API returned ${res.status}`)
      return
    }
    const body = (await res.json()) as any
    const rule = body?.data
    spinner.stop(success("Alert rule created"))
    console.log(`    ${dim(`#${rule.id}`)}  ${rule.signal} ${rule.operator}${rule.threshold}  ×${rule.consecutive}  → ${rule.notify_channel}`)
    console.log()
  },
})

const PulseAlertsRemoveCommand = cmd({
  command: "remove <id>",
  describe: "remove a pulse alert rule",
  builder: (yargs) => yargs.positional("id", { type: "number", demandOption: true }),
  async handler(args) {
    if (!(await requireAuth())) return
    const res = await irisFetch(`/api/v1/pulse/alerts/${args.id}`, { method: "DELETE" })
    if (!res.ok) { await handleApiError(res, "remove alert"); return }
    console.log(success(`  Alert rule #${args.id} removed`))
  },
})

const PulseAlertsCommand = cmd({
  command: "alerts",
  describe: "manage pulse signal alert rules",
  builder: (yargs) =>
    yargs
      .command(PulseAlertsListCommand)
      .command(PulseAlertsAddCommand)
      .command(PulseAlertsRemoveCommand)
      .demandCommand(1, "specify: list, add, or remove"),
  handler() {},
})

export const PlatformPulseCommand = cmd({
  command: "pulse",
  aliases: ["daily"],
  describe: "account health (default: your account) — use --admin for agency view",
  builder: (yargs) =>
    yargs
      .command(PulseAlertsCommand)
      .option("admin", { describe: "agency view: diary digest + lead scorecard + ungated leads", type: "boolean", default: false })
      .option("status", { describe: "filter by lead status (admin mode)", type: "string", default: "Won,Active,In Negotiation,Negotiating" })
      .option("bloq", { alias: "b", describe: "filter by bloq ID (admin mode)", type: "number" })
      .option("notify", { describe: "send pulse summary to yourself via iMessage", type: "boolean", default: false })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    if (!(await requireAuth())) return

    // ── Default: User-first pulse (YOUR account health) ──────────
    if (!args.admin) {
      const userId = await resolveUserId()
      if (!userId) {
        prompts.log.error("Could not resolve user ID. Run `iris auth login` first.")
        return
      }

      const spinner = prompts.spinner()
      spinner.start("Loading your account health...")

      try {
        const ac = new AbortController()
        const timer = setTimeout(() => ac.abort(), 15000)
        const res = await irisFetch(`/api/v1/users/${userId}/readiness?include=copy`, { signal: ac.signal })
        clearTimeout(timer)
        if (!res.ok) {
          spinner.stop("Failed to load readiness")
          console.error(`  API returned ${res.status}`)
          return
        }
        const body = await res.json().catch(() => ({}))
        const data = body?.data ?? {}
        spinner.stop(dim("ready"))

        const score = data.score ?? 0
        const band = data.band ?? "unknown"
        const bandLabel: Record<string, string> = { healthy: "Healthy", attention: "Attention", at_risk: "At Risk", failing: "Failing" }
        const bandColor = (b: string, s: number) => b === "healthy" ? success(`${s}/100`) : b === "attention" ? highlight(`${s}/100`) : `${s}/100`

        console.log()
        console.log(`  ${bold("IRIS Health")}                              Score: ${bandColor(band, score)} [${bandLabel[band] || band}]`)
        console.log(dim("  ─────────────────────────────────────────────"))

        const signals = data.signals ?? {}
        const signalLabels: Record<string, string> = {
          requirements: "Setup",
          liveness: "AI Agent",
          comms_freshness: "Comms",
          deal_health: "Billing",
          config: "Integrations",
          scripts: "Outreach",
          task_completion: "Tasks",
          content_output: "Content",
          knowledge_completeness: "Knowledge Base",
          meeting_engagement: "Meetings",
          response_time: "Response Time",
          referral_network: "Network",
          deliverable_completeness: "Deliverables",
          opportunities: "Opportunities",
        }

        const lines: string[] = []
        for (const [name, signal] of Object.entries(signals)) {
          if (!signal || typeof signal !== "object") continue
          const s = signal as any
          const label = (signalLabels[name] || name).padEnd(18)
          const sigScore = s.score ?? 0
          const copy = s.client_copy || s.admin_copy || ""
          const scoreStr = String(sigScore).padStart(3)
          const emoji = sigScore >= 70 ? success(scoreStr) : sigScore >= 40 ? highlight(scoreStr) : scoreStr
          console.log(`  ${label} ${copy.padEnd(45)} ${emoji}/100`)
          lines.push(`${signalLabels[name] || name}: ${sigScore}/100 — ${copy}`)
        }

        console.log()

        // Next step suggestion
        const worstSignal = Object.entries(signals)
          .filter(([, v]) => v && typeof v === "object" && (v as any).score !== undefined)
          .sort(([, a], [, b]) => ((a as any).score ?? 100) - ((b as any).score ?? 100))[0]

        if (worstSignal) {
          const ws = worstSignal[1] as any
          if ((ws.score ?? 100) < 60 && ws.client_copy) {
            console.log(`  ${bold("Next step:")} ${ws.client_copy}`)
            console.log()
          }
        }

        // Init progress hint
        try {
          const { existsSync: ex, readFileSync: rf } = await import("fs")
          const { join: pj } = await import("path")
          const { homedir: hd } = await import("os")
          const initPath = pj(hd(), ".iris", "init-progress.json")
          if (ex(initPath)) {
            const initData = JSON.parse(rf(initPath, "utf8"))
            const steps = initData?.steps ?? {}
            const done = Object.values(steps).filter((s: any) => s?.completed).length
            if (done < 8) {
              console.log(`  ${dim("Setup:")} ${done}/8 steps — run ${highlight("iris init")} to continue`)
              console.log()
            }
          } else {
            console.log(`  ${dim("Tip:")} Run ${highlight("iris init")} to complete your setup checklist`)
            console.log()
          }
        } catch { /* ignore */ }

        console.log(`  ${dim("Agency view:")} Run ${highlight("iris pulse --admin")} to see your clients`)

        // --notify
        if (args.notify && lines.length > 0) {
          const summary = `IRIS Health — ${score}/100 [${bandLabel[band] || band}]\n\n${lines.join("\n")}`
          try {
            const bridgeUrl = BRIDGE_URL || "http://localhost:3200"
            const bridgeKey = getBridgeToken()
            const notifyRes = await fetch(`${bridgeUrl}/api/imessage/direct-send`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                ...(bridgeKey ? { "X-Bridge-Key": bridgeKey } : {}),
              },
              body: JSON.stringify({ handle: "self", text: summary }),
              signal: AbortSignal.timeout(10000),
            })
            if (notifyRes.ok) console.log(success("\n  Pulse summary sent to your iMessage"))
            else console.log(dim(`\n  (notify failed: ${notifyRes.status})`))
          } catch (err: any) {
            console.log(dim(`\n  (notify failed: ${err.message})`))
          }
        }

        if (args.json) {
          console.log(JSON.stringify({ scope: "user", user_id: userId, score, band, signals, timestamp: new Date().toISOString() }, null, 2))
        }
        return
      } catch (err: any) {
        const isTimeout = err.name === "AbortError" || err.message?.includes("aborted")
        if (!isTimeout) {
          spinner.stop("Failed")
          console.error(`  Error: ${err.message}`)
          return
        }

        // Fallback: aggregate per-lead scores (each is fast ~1s)
        spinner.stop(dim("user endpoint slow — falling back to lead aggregation"))
        const fallbackSpinner = prompts.spinner()
        fallbackSpinner.start("Computing from your leads...")

        try {
          const meRes = await irisFetch("/api/v1/me")
          const me = meRes.ok ? await meRes.json().catch(() => ({})) : {}
          const leadsRes = await irisFetch(`/api/v1/leads?user_id=${userId}&per_page=50`)
          const leadsBody = leadsRes.ok ? await leadsRes.json().catch(() => ({})) : {}
          const myLeads: any[] = (leadsBody?.data ?? []).slice(0, 20)

          if (myLeads.length === 0) {
            fallbackSpinner.stop(dim("no leads found"))
            console.log()
            console.log(`  ${dim("No leads found for your account.")}`)
            console.log(`  ${dim("Get started:")} ${highlight("iris init")}`)
            return
          }

          const leadScores: Array<{ name: string; score: number; band: string; copy: Record<string, string> }> = []
          const batchSize = 5
          for (let i = 0; i < myLeads.length; i += batchSize) {
            const batch = myLeads.slice(i, i + batchSize)
            const results = await Promise.all(batch.map(async (lead: any) => {
              try {
                const r = await irisFetch(`/api/v1/leads/${lead.id}/readiness?include=copy`)
                if (!r.ok) return null
                const b = await r.json().catch(() => ({}))
                const d = b?.data ?? {}
                const sigs = d.signals ?? {}
                const clientCopies: Record<string, string> = {}
                for (const [k, v] of Object.entries(sigs)) {
                  if (v && typeof v === "object" && (v as any).client_copy) {
                    clientCopies[k] = (v as any).client_copy
                  }
                }
                return { name: lead.full_name || lead.company || `#${lead.id}`, score: d.score ?? 0, band: d.band ?? "unknown", copy: clientCopies }
              } catch { return null }
            }))
            leadScores.push(...results.filter(Boolean) as any[])
          }

          fallbackSpinner.stop(dim(`${leadScores.length} leads scored`))

          // Average score across leads
          const avgScore = leadScores.length > 0
            ? Math.round(leadScores.reduce((s, l) => s + l.score, 0) / leadScores.length)
            : 0
          const avgBand = avgScore >= 90 ? "healthy" : avgScore >= 75 ? "attention" : avgScore >= 50 ? "at_risk" : "failing"
          const bandLabel: Record<string, string> = { healthy: "Healthy", attention: "Attention", at_risk: "At Risk", failing: "Failing" }
          const bandColor = (b: string, s: number) => b === "healthy" ? success(`${s}/100`) : b === "attention" ? highlight(`${s}/100`) : `${s}/100`

          console.log()
          console.log(`  ${bold("IRIS Health")}                              Score: ${bandColor(avgBand, avgScore)} [${bandLabel[avgBand] || avgBand}]`)
          console.log(dim("  ─────────────────────────────────────────────"))

          // Collect unique signal copies from the worst-scoring lead
          const worst = [...leadScores].sort((a, b) => a.score - b.score)[0]
          if (worst) {
            const signalLabels: Record<string, string> = {
              requirements: "Setup", liveness: "AI Agent", comms_freshness: "Comms", deal_health: "Billing",
              config: "Integrations", scripts: "Outreach", task_completion: "Tasks", content_output: "Content",
              knowledge_completeness: "Knowledge Base", meeting_engagement: "Meetings",
            }
            for (const [k, copy] of Object.entries(worst.copy)) {
              const label = (signalLabels[k] || k).padEnd(18)
              console.log(`  ${label} ${copy}`)
            }
          }

          console.log()
          // Per-lead breakdown
          const scoreEmoji = (s: number) => s >= 70 ? "🟢" : s >= 40 ? "🟡" : "🔴"
          for (const l of leadScores.sort((a, b) => a.score - b.score).slice(0, 10)) {
            console.log(`  ${scoreEmoji(l.score)} ${String(l.score).padStart(3)}/100  ${l.name}`)
          }

          if (worst && worst.score < 60) {
            const firstCopy = Object.values(worst.copy)[0]
            if (firstCopy) {
              console.log()
              console.log(`  ${bold("Next step:")} ${firstCopy}`)
            }
          }
          console.log()
          console.log(`  ${dim("Tip:")} Run ${highlight("iris init")} to complete your setup checklist`)
        } catch (fallbackErr: any) {
          fallbackSpinner.stop("Fallback failed")
          console.error(`  Error: ${fallbackErr.message}`)
        }
        return
      }
    }

    // ── --admin: Agency view (original behavior) ─────────────────
    const lines: string[] = []

    // ── 1. Daily diary digest ──────────────────────────────────────
    try {
      const { readdirSync, readFileSync: readF } = await import("fs")
      const { join: pJoin } = await import("path")

      const diaryDir = pJoin(process.cwd(), "daily-diary")
      let diaryFiles: string[] = []
      try {
        diaryFiles = readdirSync(diaryDir).filter((f: string) => f.endsWith(".md")).sort().reverse()
      } catch { /* no diary dir */ }

      // Last 2 days of diary entries
      const now = new Date()
      const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000)
      const cutoff = twoDaysAgo.toISOString().slice(0, 10)

      const recentFiles = diaryFiles.filter((f: string) => f.slice(0, 10) >= cutoff).slice(0, 5)

      if (recentFiles.length > 0) {
        console.log(bold("\n  Recent Work"))
        console.log(dim("  ─────────────────────────────────"))

        for (const file of recentFiles) {
          const content = readF(pJoin(diaryDir, file), "utf8")
          const titleMatch = content.match(/^#\s+(.+)/m)
          const title = titleMatch?.[1] || file.replace(/\.md$/, "")

          const summaryMatch = content.match(/##\s*Summary\s*\n([\s\S]*?)(?=\n##|\n$)/i)
          let summary = ""
          if (summaryMatch) {
            summary = summaryMatch[1].trim().split("\n").slice(0, 2).join(" ").trim()
          } else {
            const paragraphs = content.split("\n\n").filter((p: string) => p.trim() && !p.startsWith("#"))
            summary = (paragraphs[0] || "").trim().split("\n").slice(0, 2).join(" ").slice(0, 120)
          }

          const datePrefix = file.slice(0, 10)
          console.log(`  ${highlight(datePrefix)}  ${title}`)
          if (summary) console.log(`    ${dim(summary.slice(0, 120))}`)
          lines.push(`${datePrefix}: ${title}`)
        }
        console.log()
      }
    } catch (err: any) {
      console.log(dim(`  (diary unavailable: ${err.message})`))
    }

    // ── 2. Pulse-all scorecard ─────────────────────────────────────
    console.log(bold("  Lead Pulse Scorecard"))
    console.log(dim("  ─────────────────────────────────"))

    const spinner = prompts.spinner()
    const statuses = args.status.split(",").map((s: string) => s.trim())
    spinner.start(`Loading ${statuses.join(" + ")} leads...`)

    try {
      const fetches = statuses.map(async (status: string) => {
        const params = new URLSearchParams({ status, per_page: "200" })
        if (args.bloq) params.set("bloq_id", String(args.bloq))
        const res = await irisFetch(`/api/v1/leads?${params}`)
        if (!res.ok) return []
        const body = await res.json().catch(() => ({}))
        return body?.data ?? []
      })
      const batches = await Promise.all(fetches)
      const allLeads: any[] = batches.flat()

      const seen = new Set<number>()
      const leads = allLeads.filter((l: any) => {
        if (seen.has(l.id)) return false
        seen.add(l.id)
        if (!l.email && !l.phone) return false
        if (!l.full_name && !l.company) return false
        return true
      })

      spinner.stop(`${leads.length} leads loaded`)

      if (leads.length === 0) {
        console.log(dim("  No active leads found."))
      } else {
        const pulseResults: Array<{ id: number; name: string; pulse: number; band: string }> = []
        const batchSize = 10
        for (let i = 0; i < leads.length; i += batchSize) {
          const batch = leads.slice(i, i + batchSize)
          const results = await Promise.all(batch.map(async (lead: any) => {
            try {
              const res = await irisFetch(`/api/v1/leads/${lead.id}/readiness?include=copy`)
              if (!res.ok) return { id: lead.id, name: lead.full_name || lead.company || `#${lead.id}`, pulse: 0, band: "unknown" }
              const body = await res.json().catch(() => ({}))
              const data = body?.data ?? {}
              return { id: lead.id, name: lead.full_name || lead.company || `#${lead.id}`, pulse: data.score ?? 0, band: data.band ?? "unknown" }
            } catch {
              return { id: lead.id, name: lead.full_name || lead.company || `#${lead.id}`, pulse: 0, band: "error" }
            }
          }))
          pulseResults.push(...results)
        }

        pulseResults.sort((a, b) => a.pulse - b.pulse)

        const bandEmoji: Record<string, string> = { failing: "🔴", warning: "🟡", healthy: "🟢" }
        const scoreEmoji = (s: number) => s >= 70 ? "🟢" : s >= 40 ? "🟡" : "🔴"
        for (const r of pulseResults.slice(0, 20)) {
          const marker = bandEmoji[r.band] || scoreEmoji(r.pulse)
          const score = String(r.pulse).padStart(3)
          console.log(`  ${marker} ${score}/100  ${r.name} (#${r.id})`)
          lines.push(`${marker} ${r.pulse}/100 ${r.name}`)
        }
        if (pulseResults.length > 20) {
          console.log(dim(`  ... and ${pulseResults.length - 20} more`))
        }
      }
    } catch (err: any) {
      spinner.stop("Failed to load leads")
      console.error(`  Error: ${err.message}`)
    }

    // ── 3. Ungated leads ─────────────────────────────────────────
    console.log()
    console.log(bold("  Ungated Leads"))
    console.log(dim("  ─────────────────────────────────"))

    try {
      const gateRes = await irisFetch(`/api/v1/deals/active?per_page=200`)
      if (gateRes.ok) {
        const gateBody = await gateRes.json().catch(() => ({}))
        const deals: any[] = gateBody?.data?.deals ?? []
        const ungated = deals.filter((d: any) => !d.has_gate)
        if (ungated.length > 0) {
          for (const d of ungated.slice(0, 10)) {
            console.log(`  ⚠️  ${d.lead_name || `Lead #${d.lead_id}`} — no payment gate`)
            lines.push(`⚠️ ${d.lead_name || `Lead #${d.lead_id}`} — ungated`)
          }
        } else {
          console.log(dim("  All active deals are gated."))
        }
      } else {
        console.log(dim("  (deals endpoint unavailable)"))
      }
    } catch {
      console.log(dim("  (deals check skipped)"))
    }

    console.log()

    // ── 4. --notify: send summary via iMessage ─────────────────────
    if (args.notify && lines.length > 0) {
      const summary = `📊 IRIS Pulse — ${new Date().toLocaleDateString()}\n\n${lines.join("\n")}`
      try {
        const bridgeUrl = BRIDGE_URL || "http://localhost:3200"
        const bridgeKey = getBridgeToken()
        const notifyRes = await fetch(`${bridgeUrl}/api/imessage/direct-send`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(bridgeKey ? { "X-Bridge-Key": bridgeKey } : {}),
          },
          body: JSON.stringify({ handle: "self", text: summary }),
          signal: AbortSignal.timeout(10000),
        })
        if (notifyRes.ok) {
          console.log(success("  Pulse summary sent to your iMessage"))
        } else {
          console.log(dim("  (notify failed: bridge returned " + notifyRes.status + ")"))
        }
      } catch (err: any) {
        console.log(dim(`  (notify failed: ${err.message})`))
      }
    }

    if (args.json) {
      console.log(JSON.stringify({ diary: lines.slice(0, 5), timestamp: new Date().toISOString() }, null, 2))
    }
  },
})
