import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, dim, bold } from "./iris-api"

// ============================================================================
// Atlas Inventory CLI (Track 7)
// Routes: /api/v1/atlas/inventory
// ============================================================================

function fmtCents(c?: number | null): string {
  if (c == null) return dim("—")
  return "$" + (c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

const ListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list inventory items",
  builder: (y) =>
    y
      .option("bloq", { type: "number" })
      .option("category", { type: "string" })
      .option("supplier", { type: "string" })
      .option("search", { type: "string" })
      .option("limit", { type: "number", default: 50 })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Atlas Inventory")
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }
    const p = new URLSearchParams({ per_page: String(args.limit) })
    if (args.bloq != null) p.set("bloq_id", String(args.bloq))
    if (args.category) p.set("category", args.category)
    if (args.supplier) p.set("supplier", args.supplier)
    if (args.search) p.set("search", args.search)

    const spinner = prompts.spinner()
    spinner.start("Loading…")
    try {
      const res = await irisFetch(`/api/v1/atlas/inventory?${p}`)
      const ok = await handleApiError(res, "List"); if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }
      const body = (await res.json()) as any
      const rows: any[] = body?.data?.data ?? body?.data ?? []
      spinner.stop(`${rows.length} item(s)`)

      if (args.json) { console.log(JSON.stringify(rows, null, 2)); prompts.outro("Done"); return }
      if (rows.length === 0) { prompts.log.warn("No inventory"); prompts.outro("Done"); return }

      for (const item of rows) {
        const qty = item.quantity ?? 0
        const low = item.reorder_point != null && qty <= item.reorder_point
        const warn = low ? " ⚠ LOW" : ""
        console.log(`  ${bold(item.name)}  ${dim(`#${item.id}`)}  qty=${qty}${warn}  ${fmtCents(item.unit_cost_cents)}/ea`)
        const meta: string[] = []
        if (item.sku) meta.push(`sku=${item.sku}`)
        if (item.category) meta.push(item.category)
        if (item.supplier) meta.push(`from ${item.supplier}`)
        if (meta.length) console.log("    " + dim(meta.join("  ·  ")))
      }
      prompts.outro("Done")
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const ShowCommand = cmd({
  command: "show <id>",
  describe: "show item details",
  builder: (y) => y.positional("id", { type: "number", demandOption: true }).option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    const token = await requireAuth(); if (!token) return
    const res = await irisFetch(`/api/v1/atlas/inventory/${args.id}`)
    const ok = await handleApiError(res, "Show"); if (!ok) return
    const data = ((await res.json()) as any)?.data
    if (args.json) { console.log(JSON.stringify(data, null, 2)) } else {
      for (const [k, v] of Object.entries(data ?? {})) {
        if (v != null && typeof v !== "object") console.log(`  ${dim(k + ":")} ${v}`)
      }
    }
  },
})

const AddCommand = cmd({
  command: "add",
  aliases: ["create"],
  describe: "add an inventory item",
  builder: (y) =>
    y
      .option("name", { type: "string", demandOption: true })
      .option("quantity", { type: "number", default: 0 })
      .option("cost", { type: "number", describe: "unit cost in dollars" })
      .option("sku", { type: "string" })
      .option("category", { type: "string" })
      .option("supplier", { type: "string" })
      .option("reorder", { type: "number", describe: "reorder point" })
      .option("bloq", { type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Add Inventory Item")
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }
    const body: Record<string, any> = { name: args.name, quantity: args.quantity }
    if (args.cost != null) body.unit_cost_cents = Math.round(Number(args.cost) * 100)
    if (args.sku) body.sku = args.sku
    if (args.category) body.category = args.category
    if (args.supplier) body.supplier = args.supplier
    if (args.reorder != null) body.reorder_point = args.reorder
    if (args.bloq != null) body.bloq_id = args.bloq

    const res = await irisFetch(`/api/v1/atlas/inventory`, { method: "POST", body: JSON.stringify(body) })
    const ok = await handleApiError(res, "Create"); if (!ok) { prompts.outro("Done"); return }
    const data = ((await res.json()) as any)?.data
    prompts.outro(`${bold(data?.name)} ${dim("#" + data?.id)} qty=${data?.quantity}`)
  },
})

const UpdateCommand = cmd({
  command: "update <id>",
  describe: "update an inventory item",
  builder: (y) =>
    y
      .positional("id", { type: "number", demandOption: true })
      .option("name", { type: "string" })
      .option("cost", { type: "number" })
      .option("sku", { type: "string" })
      .option("category", { type: "string" })
      .option("supplier", { type: "string" })
      .option("reorder", { type: "number" }),
  async handler(args) {
    const token = await requireAuth(); if (!token) return
    const body: Record<string, any> = {}
    if (args.name) body.name = args.name
    if (args.cost != null) body.unit_cost_cents = Math.round(Number(args.cost) * 100)
    if (args.sku) body.sku = args.sku
    if (args.category) body.category = args.category
    if (args.supplier) body.supplier = args.supplier
    if (args.reorder != null) body.reorder_point = args.reorder
    if (Object.keys(body).length === 0) { console.log("Nothing to update"); return }

    const res = await irisFetch(`/api/v1/atlas/inventory/${args.id}`, { method: "PATCH", body: JSON.stringify(body) })
    await handleApiError(res, "Update")
    console.log("Updated")
  },
})

const RemoveCommand = cmd({
  command: "remove <id>",
  aliases: ["rm"],
  describe: "delete an inventory item",
  builder: (y) => y.positional("id", { type: "number", demandOption: true }),
  async handler(args) {
    const token = await requireAuth(); if (!token) return
    const res = await irisFetch(`/api/v1/atlas/inventory/${args.id}`, { method: "DELETE" })
    await handleApiError(res, "Delete")
    console.log("Deleted")
  },
})

const AdjustCommand = cmd({
  command: "adjust <id>",
  describe: "adjust quantity (+/- delta with audit reason)",
  builder: (y) =>
    y
      .positional("id", { type: "number", demandOption: true })
      .option("delta", { type: "number", demandOption: true, describe: "+10 or -5" })
      .option("reason", { type: "string", describe: "restock | shrinkage | sold | etc." }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Adjust #${args.id} by ${args.delta > 0 ? "+" : ""}${args.delta}`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }
    const body: Record<string, any> = { delta: args.delta }
    if (args.reason) body.reason = args.reason

    const res = await irisFetch(`/api/v1/atlas/inventory/${args.id}/adjust`, { method: "POST", body: JSON.stringify(body) })
    const ok = await handleApiError(res, "Adjust"); if (!ok) { prompts.outro("Done"); return }
    const data = ((await res.json()) as any)?.data
    prompts.outro(`${bold(data?.name)} qty=${data?.quantity}`)
  },
})

const LowStockCommand = cmd({
  command: "low-stock",
  aliases: ["alerts"],
  describe: "items at or below reorder point",
  builder: (y) => y.option("bloq", { type: "number" }).option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Low Stock Alerts")
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }
    const p = new URLSearchParams()
    if (args.bloq != null) p.set("bloq_id", String(args.bloq))

    const res = await irisFetch(`/api/v1/atlas/inventory/low-stock?${p}`)
    const ok = await handleApiError(res, "Low stock"); if (!ok) { prompts.outro("Done"); return }
    const rows: any[] = ((await res.json()) as any)?.data ?? []
    if (args.json) { console.log(JSON.stringify(rows, null, 2)); prompts.outro("Done"); return }
    if (rows.length === 0) { prompts.log.info("No low-stock items"); prompts.outro("Done"); return }

    for (const item of rows) {
      console.log(`  ⚠ ${bold(item.name)}  qty=${item.quantity}  reorder_point=${item.reorder_point}  ${dim(`#${item.id}`)}`)
    }
    prompts.outro(`${rows.length} item(s) need restocking`)
  },
})

export const PlatformAtlasInventoryCommand = cmd({
  command: "atlas:inventory",
  aliases: ["atlas-inventory", "inventory"],
  describe: "Atlas inventory management",
  builder: (y) =>
    y
      .command(ListCommand)
      .command(ShowCommand)
      .command(AddCommand)
      .command(UpdateCommand)
      .command(RemoveCommand)
      .command(AdjustCommand)
      .command(LowStockCommand)
      .demandCommand(),
  async handler() {},
})
