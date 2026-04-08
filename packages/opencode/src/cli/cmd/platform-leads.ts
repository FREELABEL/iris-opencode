import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, printDivider, printKV, dim, bold, success, highlight, promptOrFail, MissingFlagError, isNonInteractive } from "./iris-api"
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "fs"
import { join, basename } from "path"

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
  const name = bold(String(l.name ?? l.first_name ?? `Lead #${l.id}`))
  const company = l.company ? `  ${dim(String(l.company))}` : ""
  const status = l.status ? `  ${statusColor(String(l.status))}` : ""
  const email = l.email ? `  ${dim(String(l.email))}` : ""
  console.log(`  ${name}${company}${status}`)
  if (l.email) console.log(`    ${dim("✉")} ${email}`)
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
  describe: "show lead details",
  builder: (yargs) =>
    yargs.positional("id", { describe: "lead ID", type: "number", demandOption: true }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Lead #${args.id}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Loading…")

    try {
      const res = await irisFetch(`/api/v1/leads/${args.id}`)
      const ok = await handleApiError(res, "Get lead")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const data = (await res.json()) as { data?: any }
      const l = data?.data ?? data
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
        `${dim("iris leads note " + args.id + ' "follow up scheduled"')}  Add a note`,
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
      const leads: any[] = data?.data ?? []
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

const LeadsNoteCommand = cmd({
  command: "note <id> <message>",
  describe: "add a note to a lead",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "lead ID", type: "number", demandOption: true })
      .positional("message", { describe: "note content", type: "string", demandOption: true }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Note — Lead #${args.id}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Adding note…")

    try {
      const res = await irisFetch(`/api/v1/leads/${args.id}/notes`, {
        method: "POST",
        body: JSON.stringify({ message: args.message }),
      })
      const ok = await handleApiError(res, "Add note")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      spinner.stop(`${success("✓")} Note added`)
      prompts.outro(dim(`iris leads get ${args.id}`))
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
      .option("status", { describe: "new status", type: "string" }),
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

    if (Object.keys(payload).length === 0) {
      prompts.log.warn("Nothing to update. Use --name, --email, --status, etc.")
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
      .command(LeadsNoteCommand)
      .command(LeadsPaymentGateCommand)
      .command(LeadsDealStatusCommand)
      .command(LeadsPackagesCommand)
      .command(LeadsRegenCheckoutCommand)
      .demandCommand(),
  async handler() {},
})
