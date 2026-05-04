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

      const raw = (await res.json()) as any
      const items: any[] = raw?.data?.data ?? raw?.data ?? (Array.isArray(raw) ? raw : [])
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
      .option("deadline", { describe: "deadline (YYYY-MM-DD)", type: "string" })
      .option("funding-goal", { describe: "crowdfunding goal in dollars (e.g. 100000 for $100K)", type: "number" })
      .option("equity-pool-pct", { describe: "equity pool percentage (e.g. 5 for 5%)", type: "number" })
      .option("roles-file", { describe: "path to roles JSON array (key/title/count/pay_type/pay_amount/equity_bps/description)", type: "string" })
      .option("pitch-file", { describe: "path to pitch sections JSON array ({heading, body})", type: "string" })
      .option("preview", { describe: "create in preview mode (banner shown, applications/investments disabled)", type: "boolean" }),
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

    let description = args.description
    if (!description) {
      description = (await prompts.text({ message: "Description", validate: (x) => (x && x.length > 0 ? undefined : "Required") })) as string
      if (prompts.isCancel(description)) { prompts.outro("Cancelled"); return }
    }

    let skills = args.skills
    if (!skills) {
      const skillsInput = (await prompts.text({ message: "Skills (comma-separated, or leave empty)", defaultValue: "" })) as string
      if (prompts.isCancel(skillsInput)) { prompts.outro("Cancelled"); return }
      skills = skillsInput || undefined
    }

    const spinner = prompts.spinner()
    spinner.start("Creating…")

    try {
      const payload: Record<string, unknown> = { title, description }
      if (skills) payload.skills_required = skills.split(",").map((s: string) => s.trim())
      if (args["min-budget"]) payload.price_min = args["min-budget"]
      if (args["max-budget"]) payload.price_max = args["max-budget"]
      if (args.deadline) payload.application_deadline = args.deadline
      if (args["funding-goal"] !== undefined) payload.funding_goal_cents = Math.round(Number(args["funding-goal"]) * 100)
      if (args["equity-pool-pct"] !== undefined) payload.equity_pool_bps = Math.round(Number(args["equity-pool-pct"]) * 100)
      if (args["roles-file"]) {
        const rolesPath = String(args["roles-file"])
        if (!existsSync(rolesPath)) { spinner.stop("Failed", 1); prompts.log.error(`Roles file not found: ${rolesPath}`); prompts.outro("Done"); return }
        payload.roles = JSON.parse(readFileSync(rolesPath, "utf-8"))
      }
      if (args["pitch-file"]) {
        const pitchPath = String(args["pitch-file"])
        if (!existsSync(pitchPath)) { spinner.stop("Failed", 1); prompts.log.error(`Pitch file not found: ${pitchPath}`); prompts.outro("Done"); return }
        payload.pitch_sections = JSON.parse(readFileSync(pitchPath, "utf-8"))
      }
      if (args.preview) payload.preview_mode = true

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
        title: entity.title, description: entity.description, skills_required: entity.skills_required ?? entity.skills,
        price_min: entity.price_min ?? entity.min_budget, price_max: entity.price_max ?? entity.max_budget, application_deadline: entity.application_deadline ?? entity.deadline,
        funding_goal_cents: entity.funding_goal_cents, equity_pool_bps: entity.equity_pool_bps,
        roles: entity.roles, pitch_sections: entity.pitch_sections,
        preview_mode: entity.preview_mode, is_public: entity.is_public,
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

      const fields = [
        "title", "description", "status",
        "price_min", "price_max", "application_deadline",
        "funding_goal_cents", "equity_pool_bps", "roles", "pitch_sections",
        "preview_mode", "is_public",
      ]
      const changes: { field: string; live: unknown; local: unknown }[] = []

      for (const f of fields) {
        if (JSON.stringify(live[f] ?? null) !== JSON.stringify(local[f] ?? null)) {
          changes.push({ field: f, live: live[f], local: local[f] })
        }
      }
      const liveSkills = live.skills_required ?? live.skills
      const localSkills = local.skills_required ?? local.skills
      if (JSON.stringify(liveSkills ?? null) !== JSON.stringify(localSkills ?? null)) {
        changes.push({ field: "skills_required", live: liveSkills, local: localSkills })
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

const PreviewCommand = cmd({
  command: "preview <id>",
  describe: "toggle preview_mode on an opportunity (banner shown, applications/investments disabled)",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "opportunity ID", type: "number", demandOption: true })
      .option("on", { describe: "enable preview mode", type: "boolean" })
      .option("off", { describe: "disable preview mode (go live)", type: "boolean" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Preview Mode #${args.id}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    let nextValue: boolean
    if (args.on) nextValue = true
    else if (args.off) nextValue = false
    else {
      const spinnerLookup = prompts.spinner()
      spinnerLookup.start("Fetching current state…")
      const liveRes = await irisFetch(`/api/v1/marketplace/opportunities/${args.id}`)
      const liveOk = await handleApiError(liveRes, "Fetch opportunity")
      if (!liveOk) { spinnerLookup.stop("Failed", 1); prompts.outro("Done"); return }
      const liveData = (await liveRes.json()) as { data?: any }
      const liveEntity = liveData?.data ?? liveData
      const current = Boolean(liveEntity.preview_mode)
      spinnerLookup.stop(`Currently: ${current ? bold("PREVIEW") : bold("LIVE")}`)
      nextValue = !current
    }

    const spinner = prompts.spinner()
    spinner.start(`Setting preview_mode=${nextValue}…`)

    try {
      const res = await irisFetch(`/api/v1/marketplace/opportunities/${args.id}`, {
        method: "PUT",
        body: JSON.stringify({ preview_mode: nextValue }),
      })
      const ok = await handleApiError(res, "Update opportunity")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      spinner.stop(`${success("✓")} ${nextValue ? "Preview mode ON" : "LIVE — applications & investments enabled"}`)
      prompts.outro(dim(`iris opportunities get ${args.id}`))
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
// Investment interest subcommands
// ============================================================================

function formatAmount(n: unknown): string {
  const num = Number(n)
  if (!isFinite(num)) return "$?"
  return `$${num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function printInterest(i: Record<string, unknown>): void {
  const name = bold(String(i.investor_name ?? "Anonymous"))
  const id = dim(`#${i.id}`)
  const amount = highlight(formatAmount(i.amount_usd))
  const status = `  ${dim(String(i.status ?? "new"))}`
  console.log(`  ${amount}  ${name}  ${id}${status}`)
  if (i.investor_email) console.log(`    ${dim(String(i.investor_email))}`)
  if (i.opportunity_title) console.log(`    ${dim("→ " + String(i.opportunity_title))}`)
  if (i.note) console.log(`    ${dim('"' + String(i.note).slice(0, 120) + '"')}`)
}

const InterestListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list investment interests (all opportunities by default)",
  builder: (yargs) =>
    yargs
      .option("opportunity-id", { describe: "filter by opportunity ID", type: "number" })
      .option("status", { describe: "filter by status (new, contacted, qualified, committed, funded, declined, withdrawn)", type: "string" })
      .option("limit", { describe: "max results per page", type: "number", default: 25 }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Investment Interests")

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Loading…")

    try {
      const params = new URLSearchParams({ limit: String(args.limit) })
      if (args.status) params.set("status", String(args.status))

      const url = args["opportunity-id"]
        ? `/api/v1/marketplace/opportunities/${args["opportunity-id"]}/investment-interests?${params}`
        : `/api/v1/marketplace/investment-interests?${params}`

      const res = await irisFetch(url)
      const ok = await handleApiError(res, "List investment interests")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const raw = (await res.json()) as any
      const items: any[] = raw?.data?.data ?? raw?.data ?? []
      const meta: any = raw?.data?.meta ?? raw?.meta ?? {}
      const total: number = meta.total ?? items.length
      const totalAmount: number | undefined = meta.total_amount_usd

      spinner.stop(`${total} interest(s)${totalAmount !== undefined ? `  ·  ${formatAmount(totalAmount)} total` : ""}`)

      if (items.length === 0) { prompts.log.warn("No investment interests yet"); prompts.outro("Done"); return }

      printDivider()
      for (const i of items) { printInterest(i); console.log() }
      printDivider()

      prompts.outro(dim("iris opportunities interest show <id>"))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const InterestShowCommand = cmd({
  command: "show <id>",
  describe: "show full investment interest details",
  builder: (yargs) =>
    yargs.positional("id", { describe: "investment interest ID", type: "number", demandOption: true }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Investment Interest #${args.id}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Loading…")

    try {
      const res = await irisFetch(`/api/v1/marketplace/investment-interests?limit=200`)
      const ok = await handleApiError(res, "Fetch investment interest")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const raw = (await res.json()) as any
      const items: any[] = raw?.data?.data ?? raw?.data ?? []
      const interest = items.find((i) => Number(i.id) === Number(args.id))

      if (!interest) { spinner.stop("Not found", 1); prompts.log.error(`Interest #${args.id} not found`); prompts.outro("Done"); return }

      spinner.stop(String(interest.investor_name ?? `#${interest.id}`))

      printDivider()
      printKV("ID", interest.id)
      printKV("Opportunity", interest.opportunity_title ? `${interest.opportunity_title} (#${interest.opportunity_id})` : `#${interest.opportunity_id}`)
      printKV("Investor", interest.investor_name)
      printKV("Email", interest.investor_email)
      printKV("Amount", formatAmount(interest.amount_usd))
      printKV("Status", interest.status)
      printKV("Submitted", interest.created_at)
      if (interest.contacted_at) printKV("Contacted", interest.contacted_at)
      if (interest.note) { console.log(); console.log(`  ${dim("Note:")}`); console.log(`  ${String(interest.note)}`) }
      console.log()
      printDivider()

      prompts.outro("Done")
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const InterestCommand = cmd({
  command: "interest",
  aliases: ["interests", "investors"],
  describe: "view and manage investment interests on opportunities",
  builder: (yargs) =>
    yargs
      .command(InterestListCommand)
      .command(InterestShowCommand)
      .demandCommand(),
  async handler() {},
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
      .command(PreviewCommand)
      .command(DeleteCommand)
      .command(InterestCommand)
      .demandCommand(),
  async handler() {},
})
