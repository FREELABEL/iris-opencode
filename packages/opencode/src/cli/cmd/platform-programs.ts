import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, printDivider, printKV, dim, bold, success, highlight, isNonInteractive, resolveUserId, failNoOp} from "./iris-api"
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

// ── Response normalisers — ONE seam ────────────────────────────────────────
// The API is not uniform. GET /programs/{id} answers { program: {...} } while
// GET /programs/{id}/packages answers { success, data: { packages: [...] } }.
// Pull/Push/Diff/PackagesList each unwrapped this by hand and each got it wrong:
// diff compared undefined to undefined and printed "No differences" for a
// completely divergent file, push PUT an empty body, and pull wrote every
// program to "undefined-program.json". Normalise in one place instead.

function unwrapProgram(json: any): any {
  const raw = json?.data ?? json
  return raw?.program ?? raw
}

function unwrapPackages(json: any): any[] {
  if (Array.isArray(json)) return json
  const raw = json?.data ?? json
  if (Array.isArray(raw)) return raw
  if (Array.isArray(raw?.packages)) return raw.packages
  return []
}

// Local files written before the pull fix still carry the { program: {...} }
// envelope. Accept both so an old checkout does not silently compare wrong.
function readLocalProgram(filepath: string): any {
  const parsed = JSON.parse(readFileSync(filepath, "utf-8"))
  return parsed?.program ?? parsed
}

// A program's bloq_id was never validated on write, so #83 shipped pointing at
// bloq 609 which does not exist — and `programs get` printed it as though it
// resolved. Check it, so a dangling reference cannot be created silently and
// cannot read as healthy afterwards.
async function bloqExists(bloqId: number | string): Promise<boolean> {
  try {
    // Bloqs are USER-SCOPED. An earlier version of this guard called
    // /api/v1/bloqs/{id}, which does not exist — it 404s for every bloq, so the
    // guard refused writes for bloqs that were perfectly real. Caught on #314.
    const userId = await resolveUserId()
    if (!userId) return true // cannot verify → do not block the write
    const res = await irisFetch(`/api/v1/user/${userId}/bloqs/${bloqId}`)
    if (!res.ok) return false
    const json = (await res.json()) as any
    const b = json?.data ?? json
    return Boolean(b?.id ?? b?.name)
  } catch {
    return true // network/parse failure is not evidence of absence
  }
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
      // The endpoint returns { programs: [...] } (flat array). The old parser only
      // looked at data.data → always 0, hiding every program (false-zero). Accept the
      // `programs` key, a paginator, a `data` wrapper, or a top-level array.
      const raw = data?.programs ?? data?.data ?? data
      const items: any[] = Array.isArray(raw) ? raw : (Array.isArray(raw?.data) ? raw.data : [])
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
      const p = unwrapProgram(data)
      if (!p || !p.id) { spinner.stop("Program not found", 1); process.exitCode = 1; prompts.outro("Done"); return }
      spinner.stop(String(p.name ?? `#${p.id}`))

      printDivider()
      printKV("ID", p.id)
      printKV("Name", p.name)
      printKV("Slug", p.slug)
      printKV("Active", p.active)
      printKV("Tier", p.tier)
      if (p.bloq_id) {
        const linked = await bloqExists(p.bloq_id)
        printKV("Bloq ID", linked ? p.bloq_id : `${p.bloq_id}  ⚠ bloq not found — dangling reference`)
      }
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
      if (args["bloq-id"]) {
        if (!(await bloqExists(args["bloq-id"]))) {
          spinner.stop("Failed", 1)
          prompts.log.error(`Bloq #${args["bloq-id"]} does not exist — refusing to create a dangling reference.`)
          process.exitCode = 1
          prompts.outro("Done")
          return
        }
        payload.bloq_id = args["bloq-id"]
      }
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
      .option("type", { describe: "program type (membership/learning/...)", type: "string" })
      .option("slug", { describe: "new slug", type: "string" })
      .option("base-price", { describe: "base price", type: "number" })
      .option("has-paid-membership", { describe: "can this program take money", type: "boolean" })
      .option("bloq-id", { describe: "link to a bloq (validated; use --clear-bloq to unlink)", type: "number" })
      .option("clear-bloq", { describe: "remove the bloq link", type: "boolean" })
      .option("active", { describe: "active (true/false)", type: "boolean" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Update Program #${args.id}`)


    const payload: Record<string, unknown> = {}
    if (args.name) payload.name = args.name
    if (args.description) payload.description = args.description
    if (args.tier) payload.tier = args.tier
    if (args.type) payload.type = args.type
    if (args.slug) payload.slug = args.slug
    if (args["base-price"] !== undefined) payload.base_price = args["base-price"]
    if (args["has-paid-membership"] !== undefined) payload.has_paid_membership = args["has-paid-membership"]
    if (args["clear-bloq"]) payload.bloq_id = null
    if (args["bloq-id"] !== undefined) {
      if (!(await bloqExists(args["bloq-id"]))) {
        prompts.log.error(`Bloq #${args["bloq-id"]} does not exist — refusing to write a dangling reference.`)
        process.exitCode = 1
        prompts.outro("Done")
        return
      }
      payload.bloq_id = args["bloq-id"]
    }
    if (args.active !== undefined) payload.active = args.active

    if (Object.keys(payload).length === 0) {
      failNoOp("update", "Use --name, --description, --tier, or --active")
    }
    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

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
      const entity = unwrapProgram(data)
      if (!entity || !entity.id) {
        spinner.stop("Failed", 1)
        prompts.log.error("Program response had no id — refusing to write a file that push and diff cannot read.")
        process.exitCode = 1
        prompts.outro("Done")
        return
      }

      // Also fetch packages
      const pkgRes = await irisFetch(`/api/v1/programs/${entity.id}/packages`)
      if (pkgRes.ok) {
        entity._packages = unwrapPackages((await pkgRes.json()) as any)
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

      const entity = readLocalProgram(filepath)
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

      if (payload.bloq_id && !(await bloqExists(payload.bloq_id as number))) {
        spinner.stop("Failed", 1)
        prompts.log.error(`Local file links bloq #${payload.bloq_id}, which does not exist. Fix it or run: ${highlight(`iris programs update ${args.id} --clear-bloq`)}`)
        process.exitCode = 1
        prompts.outro("Done")
        return
      }

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
      const live = unwrapProgram(data)

      const dir = resolveSyncDir()
      let filepath = args.file
      if (!filepath) filepath = findLocalFile(dir, typeof args.id === "string" ? parseInt(args.id) || args.id : args.id)

      if (!filepath || !existsSync(filepath)) {
        spinner.stop("Failed", 1)
        prompts.log.error(`Local file not found. Run: ${highlight(`iris programs pull ${args.id}`)}`)
        prompts.outro("Done")
        return
      }

      const local = readLocalProgram(filepath)

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
    yargs
      .positional("id", { describe: "program ID", type: "number", demandOption: true })
      .option("force", { alias: "y", describe: "skip confirmation prompt", type: "boolean", default: false }),
  async handler(args) {
    // Bug #162733: a destructive delete must NOT hang on prompts.confirm() when
    // there is no TTY to answer at (headless server, CI, desktop MCP bridge).
    // Refuse unless --force/-y is explicitly passed.
    if (!args.force && isNonInteractive()) {
      prompts.log.error("Refusing to delete program without --force/-y in a non-interactive shell. Re-run with --force.")
      process.exitCode = 2
      return
    }

    UI.empty()
    prompts.intro(`◈  Delete Program #${args.id}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    if (!args.force) {
      const confirmed = await prompts.confirm({ message: `Delete program #${args.id}? This cannot be undone.` })
      if (!confirmed || prompts.isCancel(confirmed)) { prompts.outro("Cancelled"); return }
    }

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
      const items: any[] = unwrapPackages(data)
      spinner.stop(`${items.length} package(s)`)

      if (items.length === 0) {
        prompts.log.warn("No packages yet")
        prompts.outro(dim(`Add one:  iris programs package-create ${args["program-id"]}`))
        return
      }

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
      // `if (args.price)` dropped a deliberate 0, so the API's `required` rule
      // rejected the call and a FREE tier was impossible to create. Same for
      // trial-days. max_members stays falsy-dropped on purpose: the API rule is
      // `nullable|integer|min:1`, so 0 ("unlimited") must be omitted, not sent.
      if (args.price !== undefined) payload.price = args.price
      if (args.description) payload.description = args.description
      if (args["max-members"]) payload.max_members = args["max-members"]
      if (args["trial-days"] !== undefined) payload.trial_days = args["trial-days"]

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


    const payload: Record<string, unknown> = {}
    if (args.name) payload.name = args.name
    if (args.price) payload.price = args.price
    if (args.description) payload.description = args.description
    if (args.active !== undefined) payload.is_active = args.active

    if (Object.keys(payload).length === 0) {
      failNoOp("update", "Use --name, --price, --description, or --active")
    }
    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

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
      .positional("package-id", { describe: "package ID", type: "number", demandOption: true })
      .option("force", { alias: "y", describe: "skip confirmation prompt", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Delete Package #${args["package-id"]}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    if (!args.force) {
      const confirmed = await prompts.confirm({ message: `Delete package #${args["package-id"]}?` })
      if (!confirmed || prompts.isCancel(confirmed)) { prompts.outro("Cancelled"); return }
    }

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
// Course & Certification subcommands
// ============================================================================

const CoursesListCommand = cmd({
  command: "courses <program-id>",
  describe: "list courses for a program",
  builder: (yargs) => yargs.positional("program-id", { type: "number", demandOption: true }),
  async handler(argv) {
    await requireAuth()
    const res = await irisFetch("/api/v1/courses?per_page=50")
    if (!res.ok) { await handleApiError(res, "list courses"); return }
    const body = await res.json() as Record<string, unknown>
    const data = (body as any).data ?? []
    if (!data.length) { prompts.outro("No courses found"); return }
    for (const c of data) {
      console.log(`  ${bold(String(c.title))}  ${dim(`#${c.id}`)}  ${dim(c.difficulty_level ?? "")}  chapters: ${c.chapter_count ?? 0}`)
    }
    prompts.outro(`${data.length} course(s)`)
  },
})

const QuizCommand = cmd({
  command: "quiz <course-id> <chapter-id>",
  describe: "view quiz for a course chapter",
  builder: (yargs) =>
    yargs
      .positional("course-id", { type: "number", demandOption: true })
      .positional("chapter-id", { type: "number", demandOption: true }),
  async handler(argv) {
    await requireAuth()
    const cid = argv["course-id"]
    const chid = argv["chapter-id"]
    const res = await irisFetch(`/api/v1/courses/${cid}/chapters/${chid}/quiz`)
    if (!res.ok) { await handleApiError(res, "get quiz"); return }
    const body = await res.json() as Record<string, unknown>
    const data = (body as any).data
    console.log(`\n  ${bold(data.chapter_title)} — Quiz`)
    console.log(`  Passing score: ${data.passing_score}%  |  Questions: ${data.question_count}\n`)
    for (let i = 0; i < data.questions.length; i++) {
      const q = data.questions[i]
      console.log(`  ${i + 1}. ${q.text}`)
      for (let j = 0; j < q.options.length; j++) {
        console.log(`     ${String.fromCharCode(65 + j)}) ${q.options[j]}`)
      }
      console.log()
    }
    prompts.outro("Done")
  },
})

const CertificateCommand = cmd({
  command: "certificate <course-id>",
  describe: "view or issue your certificate for a course",
  builder: (yargs) => yargs.positional("course-id", { type: "number", demandOption: true }),
  async handler(argv) {
    await requireAuth()
    const cid = argv["course-id"]
    // Try get existing
    let res = await irisFetch(`/api/v1/courses/${cid}/certificate`)
    if (res.ok) {
      const body = await res.json() as Record<string, unknown>
      const cert = (body as any).data
      console.log(`\n  Certificate: ${bold(cert.certificate_badge?.toUpperCase())}`)
      console.log(`  Score: ${cert.average_score}%`)
      console.log(`  UUID: ${cert.uuid}`)
      console.log(`  Issued: ${cert.issued_at}`)
      prompts.outro("Done"); return
    }
    // Try issue
    const confirm = await prompts.confirm({ message: "No certificate found. Issue one now?" })
    if (!confirm) { prompts.outro("Cancelled"); return }
    res = await irisFetch(`/api/v1/courses/${cid}/certificate`, { method: "POST" })
    if (!res.ok) { await handleApiError(res, "issue certificate"); return }
    const body = await res.json() as Record<string, unknown>
    const cert = (body as any).data
    console.log(`\n  ${success("Certificate issued!")}`)
    console.log(`  Badge: ${bold(cert.certificate_badge?.toUpperCase())}`)
    console.log(`  Score: ${cert.average_score}%`)
    console.log(`  UUID: ${cert.uuid}`)
    prompts.outro("Done")
  },
})

const VerifyCertCommand = cmd({
  command: "verify <uuid>",
  describe: "verify a certificate by UUID (public)",
  builder: (yargs) => yargs.positional("uuid", { type: "string", demandOption: true }),
  async handler(argv) {
    const res = await irisFetch(`/api/v1/certificates/verify/${argv.uuid}`)
    if (!res.ok) { await handleApiError(res, "verify certificate"); return }
    const body = await res.json() as Record<string, unknown>
    const d = (body as any).data
    console.log(`\n  ${bold("Certificate Verified")}`)
    printKV("Recipient", d.recipient)
    printKV("Course", d.course_title)
    printKV("Badge", d.badge?.toUpperCase())
    printKV("Score", `${d.average_score}%`)
    printKV("Issued", d.issued_at)
    prompts.outro("Done")
  },
})

// ============================================================================
// Root command
// ============================================================================

export const PlatformProgramsCommand = cmd({
  command: "programs",
  aliases: ["locale"],
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
      .command(CoursesListCommand)
      .command(QuizCommand)
      .command(CertificateCommand)
      .command(VerifyCertCommand)
      .demandCommand(),
  async handler() {},
})
