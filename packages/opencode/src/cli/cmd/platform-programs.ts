import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, printDivider, printKV, dim, bold, success, highlight } from "./iris-api"
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "fs"
import { join, basename } from "path"

// ============================================================================
// Sync helpers
// ============================================================================

const SYNC_DIR = ".iris/programs"

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
  return `${e.id}-${slugify(String(e.name ?? e.slug ?? "program"))}.json`
}

function findLocalFile(dir: string, id: number | string): string | undefined {
  if (!existsSync(dir)) return undefined
  const prefix = `${id}-`
  const files = require("fs").readdirSync(dir).filter((f: string) => f.startsWith(prefix) && f.endsWith(".json"))
  return files.length > 0 ? join(dir, files[0]) : undefined
}

// ============================================================================
// Display helpers
// ============================================================================

function printProgram(p: Record<string, unknown>): void {
  const name = bold(String(p.name ?? `Program #${p.id}`))
  const id = dim(`#${p.id}`)
  const active = p.active ? `  ${UI.Style.TEXT_SUCCESS}active${UI.Style.TEXT_NORMAL}` : `  ${dim("inactive")}`
  const tier = p.tier ? `  ${dim(String(p.tier))}` : ""
  console.log(`  ${name}  ${id}${active}${tier}`)
  if (p.description) console.log(`    ${dim(String(p.description).slice(0, 100))}`)
}

function printPackage(pkg: Record<string, unknown>): void {
  const name = bold(String(pkg.name ?? `Package #${pkg.id}`))
  const id = dim(`#${pkg.id}`)
  const price = pkg.price ? `  ${UI.Style.TEXT_SUCCESS}$${pkg.price}/${pkg.billing_interval ?? "month"}${UI.Style.TEXT_NORMAL}` : ""
  const active = pkg.is_active ? "" : `  ${dim("[inactive]")}`
  console.log(`  ${name}  ${id}${price}${active}`)
  if (pkg.description) console.log(`    ${dim(String(pkg.description).slice(0, 100))}`)
}

// ============================================================================
// Program Subcommands
// ============================================================================

const ListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list programs",
  builder: (yargs) =>
    yargs.option("limit", { describe: "max results", type: "number", default: 20 }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Programs")

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Loading…")

    try {
      const params = new URLSearchParams({ per_page: String(args.limit) })
      const res = await irisFetch(`/api/v1/programs?${params}`)
      const ok = await handleApiError(res, "List programs")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const data = (await res.json()) as any
      const items: any[] = data?.data ?? (Array.isArray(data) ? data : [])
      spinner.stop(`${items.length} program(s)`)

      if (items.length === 0) { prompts.log.warn("No programs found"); prompts.outro("Done"); return }

      printDivider()
      for (const p of items) { printProgram(p); console.log() }
      printDivider()

      prompts.outro(dim("iris programs get <id>  |  iris programs packages <id>"))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const GetCommand = cmd({
  command: "get <id>",
  describe: "show program details",
  builder: (yargs) =>
    yargs.positional("id", { describe: "program ID or slug", type: "string", demandOption: true }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Program: ${args.id}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Loading…")

    try {
      const res = await irisFetch(`/api/v1/programs/${args.id}`)
      const ok = await handleApiError(res, "Get program")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const data = (await res.json()) as any
      const p = data?.data ?? data
      spinner.stop(String(p.name ?? `#${p.id}`))

      printDivider()
      printKV("ID", p.id)
      printKV("Name", p.name)
      printKV("Slug", p.slug)
      printKV("Active", p.active)
      printKV("Tier", p.tier)
      printKV("Bloq ID", p.bloq_id)
      printKV("Base Price", p.base_price ? `$${p.base_price}` : undefined)
      printKV("Has Paid", p.has_paid_membership)
      printKV("Allow Free", p.allow_free_enrollment)
      printKV("Enrollments", p.enrollments_count)
      printKV("Created", p.created_at)
      if (p.description) { console.log(); console.log(`  ${dim("Description:")} ${String(p.description).slice(0, 200)}`) }
      console.log()
      printDivider()

      prompts.outro(dim(`iris programs pull ${p.id}  |  iris programs packages ${p.id}`))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const CreateCommand = cmd({
  command: "create",
  describe: "create a new program",
  builder: (yargs) =>
    yargs
      .option("name", { describe: "program name", type: "string" })
      .option("slug", { describe: "URL slug", type: "string" })
      .option("description", { describe: "description", type: "string" })
      .option("bloq-id", { describe: "bloq ID", type: "number" })
      .option("tier", { describe: "tier (free/basic/premium)", type: "string" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Create Program")

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    let name = args.name
    if (!name) {
      name = (await prompts.text({ message: "Program name", validate: (x) => (x && x.length > 0 ? undefined : "Required") })) as string
      if (prompts.isCancel(name)) { prompts.outro("Cancelled"); return }
    }

    const spinner = prompts.spinner()
    spinner.start("Creating…")

    try {
      const payload: Record<string, unknown> = { name, active: true }
      if (args.slug) payload.slug = args.slug
      if (args.description) payload.description = args.description
      if (args["bloq-id"]) payload.bloq_id = args["bloq-id"]
      if (args.tier) payload.tier = args.tier

      const res = await irisFetch("/api/v1/programs", { method: "POST", body: JSON.stringify(payload) })
      const ok = await handleApiError(res, "Create program")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const data = (await res.json()) as any
      const p = data?.data ?? data?.program ?? data
      spinner.stop(`${success("✓")} Created: ${bold(String(p.name ?? p.id))}`)

      printDivider()
      printKV("ID", p.id)
      printKV("Name", p.name)
      printKV("Slug", p.slug)
      printDivider()

      prompts.outro(dim(`iris programs get ${p.id}`))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const UpdateCommand = cmd({
  command: "update <id>",
  describe: "update a program",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "program ID", type: "number", demandOption: true })
      .option("name", { describe: "new name", type: "string" })
      .option("description", { describe: "new description", type: "string" })
      .option("tier", { describe: "new tier", type: "string" })
      .option("active", { describe: "active (true/false)", type: "boolean" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Update Program #${args.id}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const payload: Record<string, unknown> = {}
    if (args.name) payload.name = args.name
    if (args.description) payload.description = args.description
    if (args.tier) payload.tier = args.tier
    if (args.active !== undefined) payload.active = args.active

    if (Object.keys(payload).length === 0) {
      prompts.log.warn("Nothing to update. Use --name, --description, --tier, or --active")
      prompts.outro("Done")
      return
    }

    const spinner = prompts.spinner()
    spinner.start("Updating…")

    try {
      const res = await irisFetch(`/api/v1/programs/${args.id}`, { method: "PUT", body: JSON.stringify(payload) })
      const ok = await handleApiError(res, "Update program")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const data = (await res.json()) as any
      const p = data?.data ?? data?.program ?? data
      spinner.stop(`${success("✓")} Updated: ${bold(String(p.name ?? p.id))}`)

      printDivider()
      printKV("ID", p.id)
      printKV("Name", p.name)
      printDivider()

      prompts.outro(dim(`iris programs get ${args.id}`))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const PullCommand = cmd({
  command: "pull <id>",
  describe: "download program JSON to local file (includes packages)",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "program ID", type: "string", demandOption: true })
      .option("output", { alias: "o", describe: "output file path", type: "string" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Pull Program #${args.id}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Fetching program + packages…")

    try {
      // Fetch program
      const res = await irisFetch(`/api/v1/programs/${args.id}`)
      const ok = await handleApiError(res, "Pull program")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const data = (await res.json()) as any
      const entity = data?.data ?? data

      // Also fetch packages
      const pkgRes = await irisFetch(`/api/v1/programs/${entity.id}/packages`)
      if (pkgRes.ok) {
        const pkgData = (await pkgRes.json()) as any
        entity._packages = pkgData?.data ?? (Array.isArray(pkgData) ? pkgData : [])
      }

      const dir = resolveSyncDir()
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

      const filename = args.output ?? entityFilename(entity)
      const filepath = filename.startsWith("/") ? filename : join(dir, filename)

      writeFileSync(filepath, JSON.stringify(entity, null, 2))
      spinner.stop(success("Pulled"))

      const pkgCount = Array.isArray(entity._packages) ? entity._packages.length : 0

      printDivider()
      printKV("Name", entity.name)
      printKV("ID", entity.id)
      printKV("Slug", entity.slug)
      printKV("Packages", pkgCount)
      printKV("Saved to", filepath)
      printDivider()

      prompts.outro(dim(`iris programs push ${args.id}  |  iris programs diff ${args.id}`))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const PushCommand = cmd({
  command: "push <id>",
  describe: "upload local program JSON to API",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "program ID", type: "number", demandOption: true })
      .option("file", { alias: "f", describe: "local JSON file path", type: "string" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Push Program #${args.id}`)

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
        prompts.log.error(`Local file not found. Run: ${highlight(`iris programs pull ${args.id}`)}`)
        prompts.outro("Done")
        return
      }

      spinner.start(`Pushing ${basename(filepath)}…`)

      const entity = JSON.parse(readFileSync(filepath, "utf-8"))
      const payload: Record<string, unknown> = {
        name: entity.name, slug: entity.slug, description: entity.description,
        active: entity.active, tier: entity.tier, bloq_id: entity.bloq_id,
        base_price: entity.base_price, has_paid_membership: entity.has_paid_membership,
        allow_free_enrollment: entity.allow_free_enrollment,
        membership_features: entity.membership_features,
        custom_fields: entity.custom_fields,
        enrollment_form_config: entity.enrollment_form_config,
      }
      for (const k of Object.keys(payload)) { if (payload[k] === undefined) delete payload[k] }

      const res = await irisFetch(`/api/v1/programs/${args.id}`, { method: "PUT", body: JSON.stringify(payload) })
      const ok = await handleApiError(res, "Push program")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      spinner.stop(success("Pushed"))

      printDivider()
      printKV("ID", args.id)
      printKV("From", filepath)
      printDivider()

      prompts.outro(dim(`iris programs diff ${args.id}`))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const DiffCommand = cmd({
  command: "diff <id>",
  describe: "compare local program JSON vs live API",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "program ID", type: "string", demandOption: true })
      .option("file", { alias: "f", describe: "local JSON file path", type: "string" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Diff Program #${args.id}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Comparing…")

    try {
      const res = await irisFetch(`/api/v1/programs/${args.id}`)
      const ok = await handleApiError(res, "Fetch program")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const data = (await res.json()) as any
      const live = data?.data ?? data

      const dir = resolveSyncDir()
      let filepath = args.file
      if (!filepath) filepath = findLocalFile(dir, typeof args.id === "string" ? parseInt(args.id) || args.id : args.id)

      if (!filepath || !existsSync(filepath)) {
        spinner.stop("Failed", 1)
        prompts.log.error(`Local file not found. Run: ${highlight(`iris programs pull ${args.id}`)}`)
        prompts.outro("Done")
        return
      }

      const local = JSON.parse(readFileSync(filepath, "utf-8"))

      const fields = ["name", "slug", "description", "active", "tier", "bloq_id", "base_price", "has_paid_membership", "allow_free_enrollment"]
      const changes: { field: string; live: unknown; local: unknown }[] = []

      for (const f of fields) {
        if (JSON.stringify(live[f] ?? null) !== JSON.stringify(local[f] ?? null)) {
          changes.push({ field: f, live: live[f], local: local[f] })
        }
      }
      for (const f of ["membership_features", "custom_fields", "enrollment_form_config"]) {
        if (JSON.stringify(live[f] ?? null) !== JSON.stringify(local[f] ?? null)) {
          changes.push({ field: f, live: "(changed)", local: "(changed)" })
        }
      }

      spinner.stop(changes.length === 0 ? success("In sync") : `${changes.length} difference(s)`)

      printDivider()
      printKV("Program", live.name ?? `#${args.id}`)
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

      prompts.outro(changes.length > 0 ? dim(`iris programs push ${args.id}`) : "Done")
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const DeleteCommand = cmd({
  command: "delete <id>",
  describe: "delete a program",
  builder: (yargs) =>
    yargs.positional("id", { describe: "program ID", type: "number", demandOption: true }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Delete Program #${args.id}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const confirmed = await prompts.confirm({ message: `Delete program #${args.id}? This cannot be undone.` })
    if (!confirmed || prompts.isCancel(confirmed)) { prompts.outro("Cancelled"); return }

    const spinner = prompts.spinner()
    spinner.start("Deleting…")

    try {
      const res = await irisFetch(`/api/v1/programs/${args.id}`, { method: "DELETE" })
      const ok = await handleApiError(res, "Delete program")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      spinner.stop(`${success("✓")} Deleted`)
      prompts.outro(dim("iris programs list"))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

// ============================================================================
// Package Subcommands (nested under programs)
// ============================================================================

const PackagesListCommand = cmd({
  command: "packages <program-id>",
  describe: "list membership packages for a program",
  builder: (yargs) =>
    yargs.positional("program-id", { describe: "program ID", type: "number", demandOption: true }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Packages — Program #${args["program-id"]}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Loading…")

    try {
      const res = await irisFetch(`/api/v1/programs/${args["program-id"]}/packages`)
      const ok = await handleApiError(res, "List packages")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const data = (await res.json()) as any
      const items: any[] = data?.data ?? (Array.isArray(data) ? data : [])
      spinner.stop(`${items.length} package(s)`)

      if (items.length === 0) { prompts.log.warn("No packages found"); prompts.outro("Done"); return }

      printDivider()
      for (const pkg of items) { printPackage(pkg); console.log() }
      printDivider()

      prompts.outro(dim(`iris programs package-create ${args["program-id"]}`))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const PackageCreateCommand = cmd({
  command: "package-create <program-id>",
  describe: "create a membership package for a program",
  builder: (yargs) =>
    yargs
      .positional("program-id", { describe: "program ID", type: "number", demandOption: true })
      .option("name", { describe: "package name", type: "string" })
      .option("price", { describe: "price", type: "number" })
      .option("interval", { describe: "billing interval (month/year)", type: "string", default: "month" })
      .option("description", { describe: "description", type: "string" })
      .option("max-members", { describe: "max members (0=unlimited)", type: "number" })
      .option("trial-days", { describe: "trial days", type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Create Package — Program #${args["program-id"]}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    let name = args.name
    if (!name) {
      name = (await prompts.text({ message: "Package name", validate: (x) => (x && x.length > 0 ? undefined : "Required") })) as string
      if (prompts.isCancel(name)) { prompts.outro("Cancelled"); return }
    }

    const spinner = prompts.spinner()
    spinner.start("Creating…")

    try {
      const payload: Record<string, unknown> = { name, billing_interval: args.interval, is_active: true }
      if (args.price) payload.price = args.price
      if (args.description) payload.description = args.description
      if (args["max-members"]) payload.max_members = args["max-members"]
      if (args["trial-days"]) payload.trial_days = args["trial-days"]

      const res = await irisFetch(`/api/v1/programs/${args["program-id"]}/packages`, { method: "POST", body: JSON.stringify(payload) })
      const ok = await handleApiError(res, "Create package")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const data = (await res.json()) as any
      const pkg = data?.data ?? data
      spinner.stop(`${success("✓")} Created: ${bold(String(pkg.name ?? pkg.id))}`)

      printDivider()
      printKV("ID", pkg.id)
      printKV("Name", pkg.name)
      printKV("Price", pkg.price ? `$${pkg.price}/${pkg.billing_interval}` : undefined)
      printDivider()

      prompts.outro(dim(`iris programs packages ${args["program-id"]}`))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const PackageUpdateCommand = cmd({
  command: "package-update <program-id> <package-id>",
  describe: "update a membership package",
  builder: (yargs) =>
    yargs
      .positional("program-id", { describe: "program ID", type: "number", demandOption: true })
      .positional("package-id", { describe: "package ID", type: "number", demandOption: true })
      .option("name", { describe: "new name", type: "string" })
      .option("price", { describe: "new price", type: "number" })
      .option("description", { describe: "new description", type: "string" })
      .option("active", { describe: "active (true/false)", type: "boolean" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Update Package #${args["package-id"]}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const payload: Record<string, unknown> = {}
    if (args.name) payload.name = args.name
    if (args.price) payload.price = args.price
    if (args.description) payload.description = args.description
    if (args.active !== undefined) payload.is_active = args.active

    if (Object.keys(payload).length === 0) {
      prompts.log.warn("Nothing to update. Use --name, --price, --description, or --active")
      prompts.outro("Done")
      return
    }

    const spinner = prompts.spinner()
    spinner.start("Updating…")

    try {
      const res = await irisFetch(`/api/v1/programs/${args["program-id"]}/packages/${args["package-id"]}`, { method: "PUT", body: JSON.stringify(payload) })
      const ok = await handleApiError(res, "Update package")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const data = (await res.json()) as any
      const pkg = data?.data ?? data
      spinner.stop(`${success("✓")} Updated: ${bold(String(pkg.name ?? pkg.id))}`)

      printDivider()
      printKV("ID", pkg.id)
      printKV("Name", pkg.name)
      printKV("Price", pkg.price ? `$${pkg.price}` : undefined)
      printDivider()

      prompts.outro(dim(`iris programs packages ${args["program-id"]}`))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const PackageDeleteCommand = cmd({
  command: "package-delete <program-id> <package-id>",
  describe: "delete a membership package",
  builder: (yargs) =>
    yargs
      .positional("program-id", { describe: "program ID", type: "number", demandOption: true })
      .positional("package-id", { describe: "package ID", type: "number", demandOption: true }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Delete Package #${args["package-id"]}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const confirmed = await prompts.confirm({ message: `Delete package #${args["package-id"]}?` })
    if (!confirmed || prompts.isCancel(confirmed)) { prompts.outro("Cancelled"); return }

    const spinner = prompts.spinner()
    spinner.start("Deleting…")

    try {
      const res = await irisFetch(`/api/v1/programs/${args["program-id"]}/packages/${args["package-id"]}`, { method: "DELETE" })
      const ok = await handleApiError(res, "Delete package")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      spinner.stop(`${success("✓")} Deleted`)
      prompts.outro(dim(`iris programs packages ${args["program-id"]}`))
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

export const PlatformProgramsCommand = cmd({
  command: "programs",
  describe: "manage programs & membership packages — pull, push, diff, CRUD",
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
      .command(PackagesListCommand)
      .command(PackageCreateCommand)
      .command(PackageUpdateCommand)
      .command(PackageDeleteCommand)
      .demandCommand(),
  async handler() {},
})
