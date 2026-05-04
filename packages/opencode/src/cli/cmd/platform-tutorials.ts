import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, printDivider, printKV, dim, bold, success, highlight } from "./iris-api"

// ============================================================================
// Helpers
// ============================================================================

function formatPrice(n: unknown): string {
  const num = Number(n)
  if (!isFinite(num) || num <= 0) return dim("(free)")
  return Number.isInteger(num) ? `$${num}` : `$${num.toFixed(2)}`
}

function printTutorial(t: Record<string, unknown>): void {
  const price = highlight(formatPrice(t.price_usd))
  const type = dim(`[${String(t.type ?? "?")}]`)
  const id = dim(`#${t.id}`)
  const title = bold(String(t.title ?? "Untitled"))
  console.log(`  ${price}  ${type}  ${title}  ${id}`)
  if (t.description) console.log(`    ${dim(String(t.description).slice(0, 120))}`)
}

// ============================================================================
// Subcommands
// ============================================================================

const ListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list paid tutorials (videos + articles with a price)",
  builder: (yargs) =>
    yargs.option("limit", { describe: "max results", type: "number", default: 50 }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Paid Tutorials")

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Loading…")

    try {
      const params = new URLSearchParams({ limit: String(args.limit) })
      const res = await irisFetch(`/api/v1/discover/tutorials?${params}`)
      const ok = await handleApiError(res, "List tutorials")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const raw = (await res.json()) as any
      const items: any[] = raw?.data?.data ?? raw?.data ?? []
      const total: number = raw?.data?.total ?? items.length

      spinner.stop(`${total} priced tutorial(s)`)

      if (items.length === 0) {
        prompts.log.warn("No paid tutorials yet")
        prompts.log.info(`Set a price: ${highlight("iris tutorials price <video|article> <id> --price=29")}`)
        prompts.outro("Done")
        return
      }

      printDivider()
      for (const t of items) { printTutorial(t); console.log() }
      printDivider()

      prompts.outro(dim("iris tutorials price <video|article> <id> --price=N"))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const PriceCommand = cmd({
  command: "price <type> <id>",
  describe: "set or clear the price on a tutorial (use --price=0 to unprice)",
  builder: (yargs) =>
    yargs
      .positional("type", { describe: "video or article", type: "string", choices: ["video", "article"], demandOption: true })
      .positional("id", { describe: "content ID", type: "number", demandOption: true })
      .option("price", { describe: "price in USD (0 or omit to unprice)", type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Price ${args.type} #${args.id}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    let price = args.price
    if (price === undefined) {
      const input = (await prompts.text({
        message: "Price in USD (0 to unprice)",
        validate: (x) => {
          if (x === undefined || x === "") return "Required (use 0 to unprice)"
          const n = Number(x)
          if (!isFinite(n) || n < 0) return "Must be a non-negative number"
          return undefined
        },
      })) as string
      if (prompts.isCancel(input)) { prompts.outro("Cancelled"); return }
      price = Number(input)
    }

    const spinner = prompts.spinner()
    spinner.start("Updating…")

    try {
      const res = await irisFetch(`/api/v1/discover/learning-content/${args.type}/${args.id}/price`, {
        method: "PUT",
        body: JSON.stringify({ price_usd: price && price > 0 ? price : null }),
      })
      const ok = await handleApiError(res, "Set price")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const raw = (await res.json()) as any
      const data = raw?.data ?? raw

      spinner.stop(`${success("✓")} ${data?.price_usd ? `Priced at ${formatPrice(data.price_usd)}` : "Unpriced"}`)

      printDivider()
      printKV("Title", data?.title)
      printKV("Type", data?.type)
      printKV("ID", data?.id)
      printKV("Price", data?.price_usd ? formatPrice(data.price_usd) : "(free)")
      printDivider()

      prompts.outro(dim("iris tutorials list"))
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

export const PlatformTutorialsCommand = cmd({
  command: "tutorials",
  aliases: ["tutorial"],
  describe: "manage monetized tutorials on the Learning tab",
  builder: (yargs) =>
    yargs
      .command(ListCommand)
      .command(PriceCommand)
      .demandCommand(),
  async handler() {},
})
