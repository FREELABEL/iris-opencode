import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, printDivider, printKV, dim, bold, success, highlight, promptOrFail, MissingFlagError, isNonInteractive } from "./iris-api"
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "fs"
import { join, basename } from "path"

// ============================================================================
// Sync helpers
// ============================================================================

const SYNC_DIR = ".iris/products"

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
  return `${e.id}-${slugify(String(e.title ?? "product"))}.json`
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

function printProduct(p: Record<string, unknown>): void {
  const title = bold(String(p.title ?? `Product #${p.id}`))
  const id = dim(`#${p.id}`)
  const price = p.price ? `  ${UI.Style.TEXT_SUCCESS}$${p.price}${UI.Style.TEXT_NORMAL}` : ""
  const active = p.is_active ? "" : `  ${dim("[inactive]")}`
  console.log(`  ${title}  ${id}${price}${active}`)
  if (p.short_description || p.description) {
    console.log(`    ${dim(String(p.short_description ?? p.description).slice(0, 100))}`)
  }
}

// ============================================================================
// Subcommands
// ============================================================================

const ListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list products",
  builder: (yargs) =>
    yargs
      .option("limit", { describe: "max results", type: "number", default: 20 })
      .option("profile-id", { describe: "filter by profile", type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Products")

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Loading…")

    try {
      const params = new URLSearchParams({ per_page: String(args.limit) })
      if (args["profile-id"]) params.set("profile_id", String(args["profile-id"]))

      const res = await irisFetch(`/api/v1/products?${params}`)
      const ok = await handleApiError(res, "List products")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const raw = (await res.json()) as any
      const items: any[] = raw?.data?.data ?? raw?.data ?? (Array.isArray(raw) ? raw : [])
      spinner.stop(`${items.length} product(s)`)

      if (items.length === 0) { prompts.log.warn("No products found"); prompts.outro("Done"); return }

      printDivider()
      for (const p of items) { printProduct(p); console.log() }
      printDivider()

      prompts.outro(dim("iris products get <id>  |  iris products pull <id>"))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const GetCommand = cmd({
  command: "get <id>",
  describe: "show product details",
  builder: (yargs) =>
    yargs.positional("id", { describe: "product ID", type: "number", demandOption: true }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Product #${args.id}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Loading…")

    try {
      const res = await irisFetch(`/api/v1/products/${args.id}`)
      const ok = await handleApiError(res, "Get product")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const data = (await res.json()) as { data?: any }
      const p = data?.data?.product ?? data?.data ?? data
      spinner.stop(String(p.title ?? `#${p.id}`))

      printDivider()
      printKV("ID", p.id)
      printKV("Title", p.title)
      printKV("Price", p.price ? `$${p.price}` : undefined)
      printKV("Retail", p.retail_price ? `$${p.retail_price}` : undefined)
      printKV("Quantity", p.quantity)
      printKV("Active", p.is_active)
      printKV("Tags", p.tags)
      printKV("Currency", p.currency_code)
      printKV("Created", p.created_at)
      if (p.description) { console.log(); console.log(`  ${dim("Description:")} ${String(p.description).slice(0, 200)}`) }
      console.log()
      printDivider()

      prompts.outro(dim(`iris products pull ${args.id}`))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const CreateCommand = cmd({
  command: "create",
  describe: "create a new product",
  builder: (yargs) =>
    yargs
      .option("title", { describe: "product title", type: "string" })
      .option("description", { describe: "description", type: "string" })
      .option("price", { describe: "price", type: "number" })
      .option("profile-id", { describe: "profile ID", type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Create Product")

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    let title = args.title
    if (!title) {
      try {
        title = (await promptOrFail("title", () =>
          prompts.text({ message: "Product title", validate: (x) => (x && x.length > 0 ? undefined : "Required") }),
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
      if (prompts.isCancel(title)) { prompts.outro("Cancelled"); return }
    }

    const spinner = prompts.spinner()
    spinner.start("Creating…")

    try {
      const payload: Record<string, unknown> = { title, is_active: 1, quantity: 999, currency_code: "USD" }
      if (args.description) payload.description = args.description
      if (args.price) payload.price = args.price
      if (args["profile-id"]) payload.profile_id = args["profile-id"]

      const res = await irisFetch("/api/v1/products", { method: "POST", body: JSON.stringify(payload) })
      const ok = await handleApiError(res, "Create product")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const data = (await res.json()) as { data?: any }
      const p = data?.data?.product ?? data?.data ?? data
      spinner.stop(`${success("✓")} Created: ${bold(String(p.title ?? p.id))}`)

      printDivider()
      printKV("ID", p.id)
      printKV("Title", p.title)
      printDivider()

      prompts.outro(dim(`iris products get ${p.id}`))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const UpdateCommand = cmd({
  command: "update <id>",
  describe: "update a product",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "product ID", type: "number", demandOption: true })
      .option("title", { describe: "new title", type: "string" })
      .option("description", { describe: "new description", type: "string" })
      .option("price", { describe: "new price", type: "number" })
      .option("photo", { describe: "photo URL", type: "string" })
      .option("quantity", { describe: "stock quantity", type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Update Product #${args.id}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const payload: Record<string, unknown> = {}
    if (args.title) payload.title = args.title
    if (args.description) payload.description = args.description
    if (args.price) payload.price = args.price
    if (args.photo) payload.photo = args.photo
    if (args.quantity !== undefined) payload.quantity = args.quantity

    if (Object.keys(payload).length === 0) {
      prompts.log.warn("Nothing to update. Use --title, --description, --price, --photo, or --quantity")
      prompts.outro("Done")
      return
    }

    const spinner = prompts.spinner()
    spinner.start("Updating…")

    try {
      const res = await irisFetch(`/api/v1/products/${args.id}`, { method: "PUT", body: JSON.stringify(payload) })
      const ok = await handleApiError(res, "Update product")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const data = (await res.json()) as { data?: any }
      const p = data?.data?.product ?? data?.data ?? data
      spinner.stop(`${success("✓")} Updated: ${bold(String(p.title ?? p.id))}`)

      printDivider()
      printKV("ID", p.id)
      printKV("Title", p.title)
      printKV("Price", p.price ? `$${p.price}` : undefined)
      printDivider()

      prompts.outro(dim(`iris products get ${args.id}`))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const PullCommand = cmd({
  command: "pull <id>",
  describe: "download product JSON to local file",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "product ID", type: "number", demandOption: true })
      .option("output", { alias: "o", describe: "output file path", type: "string" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Pull Product #${args.id}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Fetching…")

    try {
      const res = await irisFetch(`/api/v1/products/${args.id}`)
      const ok = await handleApiError(res, "Pull product")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const data = (await res.json()) as { data?: any }
      const entity = data?.data?.product ?? data?.data ?? data

      const dir = resolveSyncDir()
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

      const filename = args.output ?? entityFilename(entity)
      const filepath = filename.startsWith("/") ? filename : join(dir, filename)

      writeFileSync(filepath, JSON.stringify(entity, null, 2))
      spinner.stop(success("Pulled"))

      printDivider()
      printKV("Title", entity.title)
      printKV("ID", entity.id)
      printKV("Price", entity.price ? `$${entity.price}` : undefined)
      printKV("Saved to", filepath)
      printDivider()

      prompts.outro(dim(`iris products push ${args.id}  |  iris products diff ${args.id}`))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const PushCommand = cmd({
  command: "push <id>",
  describe: "upload local product JSON to API",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "product ID", type: "number", demandOption: true })
      .option("file", { alias: "f", describe: "local JSON file path", type: "string" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Push Product #${args.id}`)

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
        prompts.log.error(`Local file not found. Run: ${highlight(`iris products pull ${args.id}`)}`)
        prompts.outro("Done")
        return
      }

      spinner.start(`Pushing ${basename(filepath)}…`)

      const entity = JSON.parse(readFileSync(filepath, "utf-8"))
      const payload: Record<string, unknown> = {
        title: entity.title, description: entity.description, short_description: entity.short_description,
        price: entity.price, retail_price: entity.retail_price, quantity: entity.quantity,
        tags: entity.tags, is_active: entity.is_active, currency_code: entity.currency_code,
      }
      for (const k of Object.keys(payload)) { if (payload[k] === undefined) delete payload[k] }

      const res = await irisFetch(`/api/v1/products/${args.id}`, { method: "PUT", body: JSON.stringify(payload) })
      const ok = await handleApiError(res, "Push product")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      spinner.stop(success("Pushed"))

      printDivider()
      printKV("ID", args.id)
      printKV("From", filepath)
      printDivider()

      prompts.outro(dim(`iris products diff ${args.id}`))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const DiffCommand = cmd({
  command: "diff <id>",
  describe: "compare local product JSON vs live API",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "product ID", type: "number", demandOption: true })
      .option("file", { alias: "f", describe: "local JSON file path", type: "string" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Diff Product #${args.id}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Comparing…")

    try {
      const res = await irisFetch(`/api/v1/products/${args.id}`)
      const ok = await handleApiError(res, "Fetch product")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const data = (await res.json()) as { data?: any }
      const live = data?.data?.product ?? data?.data ?? data

      const dir = resolveSyncDir()
      let filepath = args.file
      if (!filepath) filepath = findLocalFile(dir, args.id)

      if (!filepath || !existsSync(filepath)) {
        spinner.stop("Failed", 1)
        prompts.log.error(`Local file not found. Run: ${highlight(`iris products pull ${args.id}`)}`)
        prompts.outro("Done")
        return
      }

      const local = JSON.parse(readFileSync(filepath, "utf-8"))

      const fields = ["title", "description", "short_description", "price", "retail_price", "quantity", "tags", "is_active", "currency_code"]
      const changes: { field: string; live: unknown; local: unknown }[] = []

      for (const f of fields) {
        if (JSON.stringify(live[f] ?? null) !== JSON.stringify(local[f] ?? null)) {
          changes.push({ field: f, live: live[f], local: local[f] })
        }
      }

      spinner.stop(changes.length === 0 ? success("In sync") : `${changes.length} difference(s)`)

      printDivider()
      printKV("Product", live.title ?? `#${args.id}`)
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

      prompts.outro(changes.length > 0 ? dim(`iris products push ${args.id}`) : "Done")
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const DeleteCommand = cmd({
  command: "delete <id>",
  describe: "delete a product",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "product ID", type: "number", demandOption: true })
      .option("yes", { describe: "skip confirmation prompt", type: "boolean", alias: "y", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Delete Product #${args.id}`)

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
      confirmed = await prompts.confirm({ message: `Delete product #${args.id}?` })
    }
    if (!confirmed || prompts.isCancel(confirmed)) { prompts.outro("Cancelled"); return }

    const spinner = prompts.spinner()
    spinner.start("Deleting…")

    try {
      const res = await irisFetch(`/api/v1/products/${args.id}`, { method: "DELETE" })
      const ok = await handleApiError(res, "Delete product")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      spinner.stop(`${success("✓")} Deleted`)
      prompts.outro(dim("iris products list"))
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

export const PlatformProductsCommand = cmd({
  command: "products",
  describe: "manage products — pull, push, diff, CRUD",
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
      .demandCommand(),
  async handler() {},
})
