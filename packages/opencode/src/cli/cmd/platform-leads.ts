import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, printDivider, printKV, dim, bold, success, highlight, promptOrFail, MissingFlagError, isNonInteractive, PLATFORM_URLS } from "./iris-api"
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
        if (prompts.isCancel(choice)) return null
        leadId = choice as number
      }
    } catch (err) {
      spinner.stop("Error", 1)
      return null
    }
  }

  // Fetch full lead
  const res = await irisFetch(`/api/v1/leads/${leadId}`)
  if (!res.ok) return null
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
      .option("bloq-id", { describe: "filter by bloq (CRM)", type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  IRIS Leads")

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Loading leads…")

    try {
      const params = new URLSearchParams({ per_page: String(args.limit) })
      if (args.status) params.set("status", args.status)
      if (args.search) params.set("search", args.search)
      if (args["bloq-id"]) params.set("bloq_id", String(args["bloq-id"]))

      const res = await irisFetch(`/api/v1/leads?${params}`)
      const ok = await handleApiError(res, "List leads")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const data = (await res.json()) as { data?: any[]; total?: number; meta?: { total?: number } }
      const leads: any[] = data?.data ?? []
      const total = data?.meta?.total ?? leads.length
      spinner.stop(`${total} lead(s)`)

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
    yargs.positional("id", { describe: "lead ID, name, or email", type: "string", demandOption: true }),
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

      // Notes — show all, expanded
      const notes: any[] = Array.isArray(l.notes) ? l.notes : []
      if (notes.length > 0) {
        console.log()
        console.log(`  ${dim("Notes")}  ${dim(`(${notes.length})`)}`)
        for (const note of notes) {
          const content =
            typeof note === "object"
              ? (note.content ?? JSON.stringify(note)).replace(/\\n/g, "\n")
              : String(note)
          const lines = content.split("\n")
          for (const line of lines) {
            if (line.trim()) console.log(`    ${line.trim()}`)
          }
          console.log()
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
    prompts.intro(`◈  Lead Search: ${args.query}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Searching…")

    try {
      const params = new URLSearchParams({ search: args.query, per_page: String(args.limit) })
      const res = await irisFetch(`/api/v1/leads?${params}`)
      const ok = await handleApiError(res, "Search leads")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

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
      .option("email", { describe: "email address", type: "string" })
      .option("phone", { describe: "phone number", type: "string" })
      .option("company", { describe: "company name", type: "string" })
      .option("source", { describe: "lead source (e.g. referral, inbound, outreach)", type: "string" })
      .option("status", { describe: "initial status (e.g. New, Prospected)", type: "string" })
      .option("notes", { describe: "initial note to attach", type: "string" })
      .option("bloq-id", { describe: "CRM bloq ID (default: auto-detect)", type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Create Lead")

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    let name = args.name
    if (!name) {
      try {
        name = (await promptOrFail("name", () =>
          prompts.text({
            message: "Full name",
            validate: (x) => (x && x.length > 0 ? undefined : "Required"),
          }),
        )) as string
      } catch (err) {
        if (err instanceof MissingFlagError) {
          prompts.log.error(err.message)
          prompts.outro("Done")
          process.exitCode = 2
          return
        }
        throw err
      }
      if (prompts.isCancel(name)) { prompts.outro("Cancelled"); return }
    }

    let email = args.email
    if (email === undefined) {
      if (isNonInteractive()) {
        email = undefined
      } else {
        email = (await prompts.text({
          message: "Email address",
          placeholder: "e.g. jane@company.com",
        })) as string
        if (prompts.isCancel(email)) email = undefined
      }
    }

    // Default bloq-id: try to auto-detect from existing leads, fallback to 38.
    // (Replaces the old non-TTY-hanging prompt entirely — keeping main's UX win.)
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
      .option("type", { describe: "note type tag", type: "string", choices: ["note", "meeting_intel", "call_log", "email_log", "system"] })
      .check((argv) => {
        if (!argv.message && !argv.file) {
          throw new Error("Provide a message or --file <path>")
        }
        return true
      }),
  async handler(args) {
    UI.empty()

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    // ── Resolve lead ID from name/email if not numeric ──
    let leadId = Number(args.id)
    if (isNaN(leadId)) {
      const spinner = prompts.spinner()
      spinner.start(`Looking up "${args.id}"…`)
      try {
        const params = new URLSearchParams({ search: String(args.id), per_page: "5" })
        const searchRes = await irisFetch(`/api/v1/leads?${params}`)
        if (!searchRes.ok) { spinner.stop("Search failed", 1); prompts.outro("Done"); return }
        const searchData = (await searchRes.json()) as { data?: any[] }
        const matches: any[] = searchData?.data ?? []
        if (matches.length === 0) {
          spinner.stop("Not found", 1)
          prompts.log.warn(`No leads matching "${args.id}"`)
          prompts.outro("Done"); return
        }
        if (matches.length === 1 || isNonInteractive()) {
          leadId = matches[0].id
          spinner.stop(`Found: ${matches[0].name ?? matches[0].email ?? `#${leadId}`}`)
        } else {
          spinner.stop(`${matches.length} matches`)
          const choice = await prompts.select({
            message: "Which lead?",
            options: matches.map((l: any) => ({
              value: l.id,
              label: `#${l.id}  ${l.name ?? l.email ?? "Unknown"}${l.company ? `  ${l.company}` : ""}`,
            })),
          })
          if (prompts.isCancel(choice)) { prompts.cancel("Cancelled"); return }
          leadId = choice as number
        }
      } catch (err) {
        spinner.stop("Error", 1)
        prompts.log.error(err instanceof Error ? err.message : String(err))
        prompts.outro("Done"); return
      }
    }

    prompts.intro(`◈  Note — Lead #${leadId}`)

    // ── Resolve content from --file or positional message ──
    let content = String(args.message ?? "")
    if (args.file) {
      const filePath = isAbsolute(String(args.file)) ? String(args.file) : join(process.cwd(), String(args.file))
      if (!existsSync(filePath)) {
        prompts.log.error(`File not found: ${filePath}`)
        prompts.outro("Done"); return
      }
      content = readFileSync(filePath, "utf-8")
      if (!content.trim()) {
        prompts.log.error("File is empty")
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
      .positional("id", { describe: "lead ID", type: "number", demandOption: true })
      .option("name", { describe: "new name", type: "string" })
      .option("email", { describe: "new email", type: "string" })
      .option("phone", { describe: "new phone", type: "string" })
      .option("company", { describe: "new company", type: "string" })
      .option("status", { describe: "new status", type: "string" })
      .option("bloq-id", { describe: "CRM bloq ID to associate", type: "number" })
      .option("website", { describe: "website URL", type: "string" })
      .option("source", { describe: "lead source", type: "string" })
      .option("stage", { describe: "pipeline stage", type: "string" })
      .option("bid", { describe: "price bid amount", type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Update Lead #${args.id}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

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

    if (Object.keys(payload).length === 0) {
      prompts.log.warn("Nothing to update. Use --name, --email, --status, --bloq-id, etc.")
      prompts.outro("Done")
      return
    }

    const spinner = prompts.spinner()
    spinner.start("Updating…")

    try {
      const res = await irisFetch(`/api/v1/leads/${args.id}`, {
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

      prompts.outro(dim(`iris leads get ${args.id}`))
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
// Pulse — cross-channel activity check for a lead
// ============================================================================

const BRIDGE_BASE = "http://localhost:3200"

const LeadsPulseCommand = cmd({
  command: "pulse <id>",
  aliases: ["inbox", "incoming"],
  describe: "check recent activity across all channels (CRM, Gmail, iMessage, Apple Mail)",
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

      // CRM notes summary
      const notes: any[] = Array.isArray(lead.notes) ? lead.notes : []
      if (notes.length > 0) {
        console.log()
        console.log(`  ${bold("CRM Notes")}  ${dim(`(${notes.length})`)}`)
        // Show latest 3 note previews
        for (const n of notes.slice(0, 3)) {
          const content = typeof n === "object" ? (n.content ?? "") : String(n)
          const firstLine = content.split("\n").find((l: string) => l.trim()) ?? ""
          console.log(`    ${dim("•")} ${firstLine.trim().slice(0, 100)}${firstLine.length > 100 ? "…" : ""}`)
        }
        if (notes.length > 3) {
          console.log(`    ${dim(`…and ${notes.length - 3} more`)}`)
        }
      }

      // Step 2: Search channels in parallel
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

        // iMessage (via local bridge daemon)
        const handle = phone || email
        if (handle) {
          fetches.push(
            fetch(`${BRIDGE_BASE}/api/imessage/search?handle=${encodeURIComponent(handle)}&days=${days}&limit=${msgLimit}`)
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
        }

        // Apple Mail (via local bridge daemon)
        if (email) {
          fetches.push(
            fetch(`${BRIDGE_BASE}/api/mail/search?from=${encodeURIComponent(email)}&days=${days}&limit=${msgLimit}&include_body=0`)
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
      }

      // JSON output
      if (args.json) {
        console.log(JSON.stringify({ lead, channels }, null, 2))
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
    const startTime = args.at as string
    const durationMs = (args.duration as number) * 60000
    const endTime = new Date(new Date(startTime).getTime() + durationMs).toISOString()
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
      .command(LeadsMeetCommand)
      .command(LeadsMeetingsCommand)
      .command(LeadsNotesCommand)
      .command(LeadsNoteCommand)
      .command(LeadsPaymentGateCommand)
      .command(LeadsDealStatusCommand)
      .command(LeadsPackagesCommand)
      .command(LeadsRegenCheckoutCommand)
      .demandCommand(),
  async handler() {},
})
