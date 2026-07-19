import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, printDivider, printKV, dim, bold, success, highlight, isNonInteractive } from "./iris-api"
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
    yargs
      .option("limit", { describe: "max results", type: "number", default: 20 })
      .option("profile-id", { describe: "filter by profile PK", type: "number" })
      .option("bounties", { describe: "show only clip campaigns (bounties)", type: "boolean" })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()

    const token = await requireAuth()
    if (!token) { if (!args.json) prompts.outro("Done"); return }

    if (!args.json) prompts.intro("◈  Marketplace Opportunities")
    const spinner = args.json ? null : prompts.spinner()
    if (spinner) spinner.start("Loading…")

    try {
      const params = new URLSearchParams({ per_page: String(args.limit) })
      if (args["profile-id"]) params.set("profile_id", String(args["profile-id"]))
      if (args.bounties) params.set("bounty_type", "video_views")
      const res = await irisFetch(`/api/v1/marketplace/opportunities?${params}`)
      const ok = await handleApiError(res, "List opportunities")
      if (!ok) { if (spinner) spinner.stop("Failed", 1); if (!args.json) prompts.outro("Done"); return }

      const raw = (await res.json()) as any
      const items: any[] = raw?.data?.data ?? raw?.data ?? (Array.isArray(raw) ? raw : [])

      if (args.json) { console.log(JSON.stringify(items, null, 2)); return }

      spinner!.stop(`${items.length} opportunity(ies)`)

      if (items.length === 0) { prompts.log.warn("No opportunities found"); prompts.outro("Done"); return }

      printDivider()
      for (const o of items) { printOpportunity(o); console.log() }
      printDivider()

      prompts.outro(dim("iris opportunities get <id>  |  iris opportunities pull <id>"))
    } catch (err) {
      if (spinner) spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      if (!args.json) prompts.outro("Done")
    }
  },
})

const GetCommand = cmd({
  command: "get <id>",
  describe: "show opportunity details",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "opportunity ID", type: "number", demandOption: true })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()

    const token = await requireAuth()
    if (!token) { if (!args.json) prompts.outro("Done"); return }

    if (!args.json) prompts.intro(`◈  Opportunity #${args.id}`)
    const spinner = args.json ? null : prompts.spinner()
    if (spinner) spinner.start("Loading…")

    try {
      const res = await irisFetch(`/api/v1/marketplace/opportunities/${args.id}`)
      const ok = await handleApiError(res, "Get opportunity")
      if (!ok) { if (spinner) spinner.stop("Failed", 1); if (!args.json) prompts.outro("Done"); return }

      const data = (await res.json()) as { data?: any }
      const o = data?.data ?? data

      if (args.json) { console.log(JSON.stringify(o, null, 2)); return }

      spinner!.stop(String(o.title ?? `#${o.id}`))

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
      if (spinner) spinner.stop("Error", 1)
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
      .option("preview", { describe: "create in preview mode (banner shown, applications/investments disabled)", type: "boolean" })
      .option("profile-id", { describe: "attach to a profile (PK)", type: "number" })
      .option("profile", { describe: "attach to a profile (slug — resolves to PK)", type: "string" })
      // Membership gate — restrict applications to a program's confirmed members. #166095.
      .option("program-id", { describe: "gate applications to a program's confirmed members (membership gate)", type: "number" })
      // Bounty / Clip Campaign fields
      .option("bounty", { describe: "create as a clip campaign (bounty)", type: "boolean" })
      .option("bounty-type", { describe: "bounty type (video_views, audio_streams, social_impressions, ugc_views)", type: "string", default: "video_views", choices: ["video_views", "audio_streams", "social_impressions", "ugc_views"] })
      .option("rate-per-mille", { describe: "pay rate per 1K views in cents (e.g. 500 = $5)", type: "number" })
      .option("budget", { describe: "total campaign budget in dollars (e.g. 10000)", type: "number" })
      .option("per-creator-cap", { describe: "max payout per creator in dollars (e.g. 500)", type: "number" })
      .option("json", { describe: "JSON output (implies non-interactive)", type: "boolean", default: false }),
  async handler(args) {
    const token = await requireAuth()
    if (!token) { if (!args.json) prompts.outro("Done"); return }

    // Headless-safe: title/description are the only required fields. Prompt for them in a
    // TTY, but fail loud (don't hang, don't half-prompt) when --json or non-interactive
    // and they're missing. #165986 — previously the skills prompt fired even when
    // title/description came from flags.
    let title = args.title
    let description = args.description
    const headless = args.json || isNonInteractive()
    if ((!title || !description) && headless) {
      const missing = !title ? "--title" : "--description"
      const msg = `${missing} is required in non-interactive mode.`
      if (args.json) console.log(JSON.stringify({ success: false, error: msg }))
      else prompts.log.error(msg)
      process.exitCode = 2
      return
    }

    if (!args.json) { UI.empty(); prompts.intro("◈  Create Opportunity") }

    if (!title) {
      title = (await prompts.text({ message: "Title", validate: (x) => (x && x.length > 0 ? undefined : "Required") })) as string
      if (prompts.isCancel(title)) { prompts.outro("Cancelled"); return }
    }
    if (!description) {
      description = (await prompts.text({ message: "Description", validate: (x) => (x && x.length > 0 ? undefined : "Required") })) as string
      if (prompts.isCancel(description)) { prompts.outro("Cancelled"); return }
    }

    // Skills are optional — only prompt in an interactive session, never headless. #165986.
    let skills = args.skills
    if (!skills && !headless) {
      const skillsInput = (await prompts.text({ message: "Skills (comma-separated, or leave empty)", defaultValue: "" })) as string
      if (prompts.isCancel(skillsInput)) { prompts.outro("Cancelled"); return }
      skills = skillsInput || undefined
    }

    // Resolve profile slug → PK if --profile provided
    let profilePk: number | undefined = args["profile-id"] as number | undefined
    if (!profilePk && args.profile) {
      const profileRes = await irisFetch(`/api/v1/profile/${args.profile}`)
      if (profileRes.ok) {
        const pd = (await profileRes.json()) as any
        const p = pd?.data ?? pd
        profilePk = p?.pk
        if (profilePk && !args.json) prompts.log.info(`Profile: ${p.name} (pk ${profilePk})`)
      }
      if (!profilePk) {
        const msg = `Profile '${args.profile}' not found`
        if (args.json) console.log(JSON.stringify({ success: false, error: msg }))
        else { prompts.log.error(msg); prompts.outro("Done") }
        process.exitCode = 1
        return
      }
    }

    const spinner = args.json ? null : prompts.spinner()
    if (spinner) spinner.start("Creating…")

    try {
      const payload: Record<string, unknown> = { title, description }
      if (profilePk) payload.profile_id = profilePk
      if (args["program-id"]) payload.program_id = Number(args["program-id"])
      if (skills) payload.skills_required = skills.split(",").map((s: string) => s.trim())
      if (args["min-budget"]) payload.price_min = args["min-budget"]
      if (args["max-budget"]) payload.price_max = args["max-budget"]
      if (args.deadline) payload.application_deadline = args.deadline
      if (args["funding-goal"] !== undefined) payload.funding_goal_cents = Math.round(Number(args["funding-goal"]) * 100)
      if (args["equity-pool-pct"] !== undefined) payload.equity_pool_bps = Math.round(Number(args["equity-pool-pct"]) * 100)
      if (args["roles-file"]) {
        const rolesPath = String(args["roles-file"])
        if (!existsSync(rolesPath)) { if (spinner) spinner.stop("Failed", 1); prompts.log.error(`Roles file not found: ${rolesPath}`); if (!args.json) prompts.outro("Done"); process.exitCode = 1; return }
        payload.roles = JSON.parse(readFileSync(rolesPath, "utf-8"))
      }
      if (args["pitch-file"]) {
        const pitchPath = String(args["pitch-file"])
        if (!existsSync(pitchPath)) { if (spinner) spinner.stop("Failed", 1); prompts.log.error(`Pitch file not found: ${pitchPath}`); if (!args.json) prompts.outro("Done"); process.exitCode = 1; return }
        payload.pitch_sections = JSON.parse(readFileSync(pitchPath, "utf-8"))
      }
      if (args.preview) payload.preview_mode = true

      // Bounty / Clip Campaign fields
      if (args.bounty) {
        payload.bounty_type = args["bounty-type"] || "video_views"
        payload.is_public = true
        if (args["rate-per-mille"]) payload.rate_per_mille_cents = Number(args["rate-per-mille"])
        if (args.budget) payload.budget_pool_cents = Math.round(Number(args.budget) * 100)
        if (args["per-creator-cap"]) payload.per_creator_cap_cents = Math.round(Number(args["per-creator-cap"]) * 100)
      }

      const res = await irisFetch("/api/v1/marketplace/opportunities", { method: "POST", body: JSON.stringify(payload) })
      const ok = await handleApiError(res, "Create opportunity")
      if (!ok) { if (spinner) spinner.stop("Failed", 1); if (!args.json) prompts.outro("Done"); process.exitCode = 1; return }

      const data = (await res.json()) as any
      const o = data?.data?.opportunity ?? data?.opportunity ?? data?.data ?? data

      if (args.json) { console.log(JSON.stringify(data, null, 2)); return }

      spinner!.stop(`${success("✓")} Created: ${bold(String(o.title ?? o.id ?? "opportunity"))}`)

      printDivider()
      printKV("ID", o.id)
      printKV("Title", o.title)
      if (o.program_id) printKV("Gated to program", o.program_id)
      printDivider()

      prompts.outro(dim(`iris opportunities get ${o.id}`))
    } catch (err) {
      if (spinner) spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      if (!args.json) prompts.outro("Done")
      process.exitCode = 1
    }
  },
})

// #176521 — single source of truth for what pull/diff/push agree on.
//
// These lists used to be inline and divergent, and BOTH omitted every money and
// linkage field. Result: edit a contest's prize table locally → `diff` reports
// "No differences" → `push` reports "Pushed" → nothing was sent, leaving a
// placement bounty with no reward_tiers, i.e. one that pays every winner $0.
const SYNC_FIELDS = [
  "title", "description", "status",
  "price_min", "price_max", "application_deadline",
  "funding_goal_cents", "equity_pool_bps", "roles", "pitch_sections",
  "preview_mode", "is_public", "lead_id",
  // money / payout — omitting these is how prize tables got silently dropped
  "bounty_type", "reward_tiers", "rate_per_mille_cents",
  "per_creator_cap_cents", "budget_pool_cents",
  // linkage
  "event_id", "program_id", "profile_id",
] as const

// The API serializes reward_tiers as a {rank: amount_cents} map (toPublicArray →
// rewardTiers()), while the local file may hold the authoring shape
// [{rank, amount_cents}, …] or a bare [amount_cents, …]. Compare on the
// normalized map so we don't report a false difference.
function normalizeForCompare(field: string, value: unknown): string {
  if (field === "reward_tiers" && value != null) {
    const map: Record<string, number> = {}
    if (Array.isArray(value)) {
      value.forEach((t: any, i: number) => {
        const rank = Number(t?.rank ?? i + 1)
        const amount = Number(t?.amount_cents ?? (typeof t === "number" ? t : 0))
        if (rank >= 1 && amount > 0) map[String(rank)] = amount
      })
    } else if (typeof value === "object") {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        const rank = Number(k)
        const amount = Number(v)
        if (rank >= 1 && amount > 0) map[String(rank)] = amount
      }
    }
    return JSON.stringify(map)
  }
  return JSON.stringify(value ?? null)
}

// #166095: previously the only way to change an opportunity's content was the
// file-based `push` (pull → edit JSON → push). This gives a direct, flag-driven,
// headless-safe update path — only the flags you pass are sent (PATCH-like PUT).
const UpdateCommand = cmd({
  command: "update <id>",
  aliases: ["edit"],
  describe: "update an opportunity's fields directly (only the flags you pass are changed)",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "opportunity ID", type: "number", demandOption: true })
      .option("title", { describe: "title", type: "string" })
      .option("description", { describe: "description", type: "string" })
      .option("skills", { describe: "required skills (comma-separated; empty string clears)", type: "string" })
      .option("min-budget", { describe: "minimum budget", type: "number" })
      .option("max-budget", { describe: "maximum budget", type: "number" })
      .option("deadline", { describe: "application deadline (YYYY-MM-DD)", type: "string" })
      .option("funding-goal", { describe: "crowdfunding goal in dollars", type: "number" })
      .option("equity-pool-pct", { describe: "equity pool percentage (e.g. 5 for 5%)", type: "number" })
      .option("program-id", { describe: "gate applications to a program's members (0 to un-gate)", type: "number" })
      .option("public", { describe: "make the opportunity public", type: "boolean" })
      .option("private", { describe: "make the opportunity private (hidden)", type: "boolean" })
      .option("preview", { describe: "toggle preview mode on/off", type: "boolean" })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    const token = await requireAuth()
    if (!token) { if (!args.json) prompts.outro("Done"); return }

    // Build the payload from only the flags actually provided (yargs sets the key
    // when a flag is passed, even for empty strings, via hasOwnProperty).
    const payload: Record<string, unknown> = {}
    const has = (k: string) => Object.prototype.hasOwnProperty.call(args, k)

    if (args.title !== undefined) payload.title = args.title
    if (args.description !== undefined) payload.description = args.description
    if (has("skills")) {
      const s = String(args.skills ?? "").trim()
      payload.skills_required = s ? s.split(",").map((x) => x.trim()).filter(Boolean) : []
    }
    if (args["min-budget"] !== undefined) payload.price_min = args["min-budget"]
    if (args["max-budget"] !== undefined) payload.price_max = args["max-budget"]
    if (args.deadline !== undefined) payload.application_deadline = args.deadline
    if (args["funding-goal"] !== undefined) payload.funding_goal_cents = Math.round(Number(args["funding-goal"]) * 100)
    if (args["equity-pool-pct"] !== undefined) payload.equity_pool_bps = Math.round(Number(args["equity-pool-pct"]) * 100)
    if (args["program-id"] !== undefined) payload.program_id = Number(args["program-id"]) === 0 ? null : Number(args["program-id"])
    if (args.preview !== undefined) payload.preview_mode = args.preview
    if (args.public) payload.is_public = true
    if (args.private) payload.is_public = false

    if (Object.keys(payload).length === 0) {
      const msg = "Nothing to update — pass at least one field flag (e.g. --title, --description, --program-id)."
      if (args.json) console.log(JSON.stringify({ success: false, error: msg }))
      else prompts.log.error(msg)
      process.exitCode = 2
      return
    }

    if (!args.json) { UI.empty(); prompts.intro(`◈  Update Opportunity #${args.id}`) }
    const spinner = args.json ? null : prompts.spinner()
    if (spinner) spinner.start("Updating…")

    try {
      const res = await irisFetch(`/api/v1/marketplace/opportunities/${args.id}`, { method: "PUT", body: JSON.stringify(payload) })
      const ok = await handleApiError(res, "Update opportunity")
      if (!ok) { if (spinner) spinner.stop("Failed", 1); if (!args.json) prompts.outro("Done"); process.exitCode = 1; return }

      const data = (await res.json()) as any
      const o = data?.data?.opportunity ?? data?.opportunity ?? data?.data ?? data

      if (args.json) { console.log(JSON.stringify(data, null, 2)); return }

      spinner!.stop(`${success("✓")} Updated`)
      printDivider()
      printKV("ID", o.id ?? args.id)
      printKV("Title", o.title)
      printKV("Changed", Object.keys(payload).join(", "))
      printDivider()
      prompts.outro(dim(`iris opportunities get ${args.id}`))
    } catch (err) {
      if (spinner) spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      if (!args.json) prompts.outro("Done")
      process.exitCode = 1
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

      // Validate skills_required is an array if present
      const skills = entity.skills_required ?? entity.skills
      if (skills != null && !Array.isArray(skills)) {
        spinner.stop("Failed", 1)
        prompts.log.error(`skills_required must be an array (e.g. ["design", "marketing"]), got ${typeof skills}`)
        prompts.outro("Done")
        return
      }

      // #176521 — build from SYNC_FIELDS so money/linkage fields can never be
      // silently omitted again (the old inline list dropped reward_tiers et al).
      const payload: Record<string, unknown> = {}
      for (const f of SYNC_FIELDS) {
        if (entity[f] !== undefined) payload[f] = entity[f]
      }
      // Legacy aliases from older pulled files.
      payload.skills_required = skills
      if (payload.price_min === undefined && entity.min_budget !== undefined) payload.price_min = entity.min_budget
      if (payload.price_max === undefined && entity.max_budget !== undefined) payload.price_max = entity.max_budget
      if (payload.application_deadline === undefined && entity.deadline !== undefined) payload.application_deadline = entity.deadline
      for (const k of Object.keys(payload)) { if (payload[k] === undefined) delete payload[k] }

      const res = await irisFetch(`/api/v1/marketplace/opportunities/${args.id}`, { method: "PUT", body: JSON.stringify(payload) })
      const ok = await handleApiError(res, "Push opportunity")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const data = (await res.json()) as { data?: any }
      const result = data?.data ?? data

      // WRITE-CONFIRMATION (#176521): a 200 is not proof of persistence. The API has
      // silently dropped fields that weren't mass-assignable (reward_tiers, #176520)
      // while still returning success. Re-read and assert, so "Pushed" means
      // "verified persisted" — and fail loudly (exit 1) when it doesn't.
      spinner.message?.("Verifying…")
      const unpersisted: { field: string; sent: unknown; live: unknown }[] = []
      try {
        const verifyRes = await irisFetch(`/api/v1/marketplace/opportunities/${args.id}`)
        if (verifyRes.ok) {
          const vJson = (await verifyRes.json()) as { data?: any }
          const liveNow = vJson?.data?.opportunity ?? vJson?.data ?? vJson
          for (const f of Object.keys(payload)) {
            if (f === "skills_required") continue // server may normalize/rename
            if (normalizeForCompare(f, liveNow?.[f]) !== normalizeForCompare(f, payload[f])) {
              unpersisted.push({ field: f, sent: payload[f], live: liveNow?.[f] })
            }
          }
        }
      } catch {
        // verification is best-effort; never mask a successful write with a network blip
      }

      if (unpersisted.length > 0) {
        spinner.stop("Pushed, but some fields did NOT persist", 1)
        printDivider()
        printKV("ID", args.id)
        for (const u of unpersisted) {
          console.log(`  ${UI.Style.TEXT_DANGER}✗ ${u.field}${UI.Style.TEXT_NORMAL}`)
          console.log(`    sent: ${String(JSON.stringify(u.sent)).slice(0, 120)}`)
          console.log(`    live: ${String(JSON.stringify(u.live ?? null)).slice(0, 120)}`)
        }
        console.log()
        console.log(`  ${UI.Style.TEXT_WARNING}The API accepted the request but did not store these fields.${UI.Style.TEXT_NORMAL}`)
        console.log(`  ${dim("Likely a server-side mass-assignment ($fillable) gap — see #176520.")}`)
        printDivider()
        prompts.outro("Done")
        process.exitCode = 1
        return
      }

      spinner.stop(success("Pushed"))

      printDivider()
      printKV("Title", result.title)
      printKV("ID", args.id)
      printKV("From", filepath)
      printKV("Verified", `${Object.keys(payload).length} field(s) persisted`)
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

      const changes: { field: string; live: unknown; local: unknown }[] = []

      for (const f of SYNC_FIELDS) {
        if (normalizeForCompare(f, live[f]) !== normalizeForCompare(f, local[f])) {
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

const LinkLeadCommand = cmd({
  command: "link-lead <id> <leadId>",
  describe: "link an opportunity to a CRM lead (sets opportunity.lead_id)",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "opportunity ID", type: "number", demandOption: true })
      .positional("leadId", { describe: "lead ID to link (use 0 to unlink)", type: "number", demandOption: true }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Link Opportunity #${args.id} → Lead #${args.leadId}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start(args.leadId === 0 ? "Unlinking…" : `Linking to lead ${args.leadId}…`)

    try {
      const body: Record<string, unknown> = { lead_id: args.leadId === 0 ? null : args.leadId }
      const res = await irisFetch(`/api/v1/marketplace/opportunities/${args.id}`, {
        method: "PUT",
        body: JSON.stringify(body),
      })
      const ok = await handleApiError(res, "Update opportunity")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      spinner.stop(`${success("✓")} ${args.leadId === 0 ? "Unlinked" : `Linked to lead #${args.leadId}`}`)
      prompts.outro(dim(`iris leads get ${args.leadId}  |  iris opportunities get ${args.id}`))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const LinkEventCommand = cmd({
  command: "link-event <id> <eventId>",
  describe: "link an opportunity/bounty to an event (sets opportunity.event_id) — the job listing a role was hired under",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "opportunity ID", type: "number", demandOption: true })
      .positional("eventId", { describe: "event ID to link (use 0 to unlink)", type: "number", demandOption: true }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Link Opportunity #${args.id} → Event #${args.eventId}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start(args.eventId === 0 ? "Unlinking…" : `Linking to event ${args.eventId}…`)

    try {
      const body: Record<string, unknown> = { event_id: args.eventId === 0 ? null : args.eventId }
      const res = await irisFetch(`/api/v1/marketplace/opportunities/${args.id}`, {
        method: "PUT",
        body: JSON.stringify(body),
      })
      const ok = await handleApiError(res, "Update opportunity")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      spinner.stop(`${success("✓")} ${args.eventId === 0 ? "Unlinked" : `Linked to event #${args.eventId}`}`)
      prompts.outro(dim(`iris events show ${args.eventId}  |  iris opportunities get ${args.id}`))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const LinkProfileCommand = cmd({
  command: "link-profile <id> <profileSlug>",
  describe: "attach an opportunity to a profile (sets opportunity.profile_id)",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "opportunity ID", type: "number", demandOption: true })
      .positional("profileSlug", { describe: "profile slug or PK (use 0 to unlink)", type: "string", demandOption: true }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Link Opportunity #${args.id} → Profile ${args.profileSlug}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()

    let profilePk: number | null = null
    if (args.profileSlug !== "0") {
      spinner.start("Resolving profile…")
      const profileRes = await irisFetch(`/api/v1/profile/${args.profileSlug}`)
      if (!profileRes.ok) { spinner.stop("Failed", 1); prompts.log.error(`Profile '${args.profileSlug}' not found`); prompts.outro("Done"); return }
      const pd = (await profileRes.json()) as any
      const p = pd?.data ?? pd
      profilePk = p?.pk
      if (!profilePk) { spinner.stop("Failed", 1); prompts.log.error("Could not resolve profile PK"); prompts.outro("Done"); return }
      spinner.stop(`${p.name} (pk ${profilePk})`)
    }

    const spinner2 = prompts.spinner()
    spinner2.start(profilePk ? `Linking to profile ${profilePk}…` : "Unlinking…")

    try {
      const res = await irisFetch(`/api/v1/marketplace/opportunities/${args.id}`, {
        method: "PUT",
        body: JSON.stringify({ profile_id: profilePk }),
      })
      const ok = await handleApiError(res, "Update opportunity")
      if (!ok) { spinner2.stop("Failed", 1); prompts.outro("Done"); return }

      spinner2.stop(`${success("✓")} ${profilePk ? `Linked to profile pk ${profilePk}` : "Unlinked"}`)
      prompts.outro(dim(`iris opportunities get ${args.id}  |  iris profile show ${args.profileSlug}`))
    } catch (err) {
      spinner2.stop("Error", 1)
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
    yargs
      .positional("id", { describe: "opportunity ID", type: "number", demandOption: true })
      .option("force", { alias: "y", describe: "skip confirmation prompt", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Delete Opportunity #${args.id}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    if (!args.force) {
      const confirmed = await prompts.confirm({ message: `Delete opportunity #${args.id}?` })
      if (!confirmed || prompts.isCancel(confirmed)) { prompts.outro("Cancelled"); return }
    }

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
      .command(UpdateCommand)
      .command(PullCommand)
      .command(PushCommand)
      .command(DiffCommand)
      .command(PreviewCommand)
      .command(LinkLeadCommand)
      .command(LinkEventCommand)
      .command(LinkProfileCommand)
      .command(DeleteCommand)
      .command(InterestCommand)
      .demandCommand(),
  async handler() {},
})
