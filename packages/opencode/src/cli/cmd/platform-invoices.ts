import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { irisFetch, requireAuth, handleApiError, printDivider, printKV, dim, bold, success, highlight } from "./iris-api"

// ============================================================================
// Invoices — port of InvoicesCommand.php
// Endpoints: /api/v1/leads/{leadId}/invoices|invoice|subscription/create
//            /api/v1/custom-requests/{invoiceId}/generate-checkout|send-reminder
// ============================================================================

async function getJson(res: Response): Promise<any> { try { return await res.json() } catch { return {} } }

function fmtMoney(n: unknown): string {
  const v = Number(n ?? 0)
  return `$${v.toFixed(2)}`
}

// ── list ──

const ListCmd = cmd({
  command: "list <lead-id>",
  aliases: ["ls"],
  describe: "list invoices for a lead",
  builder: (yargs) =>
    yargs
      .positional("lead-id", { describe: "lead ID", type: "number", demandOption: true })
      .option("json", { describe: "JSON output", type: "boolean" }),
  async handler(args) {
    if (!(await requireAuth())) return
    const res = await irisFetch(`/api/v1/leads/${args.leadId}/invoices`)
    if (!(await handleApiError(res, "List invoices"))) return
    const body = await getJson(res)
    const raw = body.data ?? body.invoices ?? body
    const invoices: any[] = Array.isArray(raw) ? raw : []

    if (args.json) { console.log(JSON.stringify(invoices, null, 2)); return }
    if (invoices.length === 0) { prompts.log.info(`No invoices for lead #${args.leadId}`); return }

    console.log("")
    console.log(bold(`Invoices — Lead #${args.leadId} (${invoices.length})`))
    printDivider()
    for (const inv of invoices) {
      const paid = !!inv.paid_at
      const status = paid ? success("PAID") : `${dim("UNPAID")}`
      console.log(`  ${dim(`#${inv.id}`)}  ${bold(String(inv.title ?? "Untitled"))}  ${fmtMoney(inv.price)}  ${status}  ${dim(inv.created_at ?? "")}`)
    }
    printDivider()
  },
})

// ── create ──

const CreateCmd = cmd({
  command: "create <lead-id>",
  describe: "create an invoice for a lead",
  builder: (yargs) =>
    yargs
      .positional("lead-id", { describe: "lead ID", type: "number", demandOption: true })
      .option("price", { describe: "amount in dollars", type: "number", demandOption: true })
      .option("title", { describe: "invoice title", type: "string", default: "Invoice" })
      .option("description", { describe: "description / notes", type: "string" })
      .option("json", { describe: "JSON output", type: "boolean" }),
  async handler(args) {
    if (!(await requireAuth())) return
    const payload: Record<string, unknown> = { price: args.price, title: args.title }
    if (args.description) payload.description = args.description
    const res = await irisFetch(`/api/v1/leads/${args.leadId}/invoices`, {
      method: "POST",
      body: JSON.stringify(payload),
    })
    if (!(await handleApiError(res, "Create invoice"))) return
    const body = await getJson(res)
    const inv = body.data ?? body

    if (args.json) { console.log(JSON.stringify(inv, null, 2)); return }

    prompts.log.success(`${success("✓")} Invoice #${inv.id} created`)
    printKV("Title", inv.title)
    printKV("Amount", fmtMoney(inv.price))
    prompts.log.info(dim(`Next: iris invoices checkout ${inv.id}  |  iris invoices send ${inv.id}`))
  },
})

// ── subscribe ──

const SubscribeCmd = cmd({
  command: "subscribe <lead-id>",
  describe: "create a recurring subscription for a lead",
  builder: (yargs) =>
    yargs
      .positional("lead-id", { describe: "lead ID", type: "number", demandOption: true })
      .option("price", { describe: "base recurring amount in dollars", type: "number", demandOption: true })
      .option("interval", { describe: "week|month|year", type: "string", default: "month" })
      .option("fee", { describe: "platform fee percentage", type: "number" })
      .option("title", { describe: "subscription title", type: "string" })
      .option("description", { describe: "description", type: "string" })
      .option("json", { describe: "JSON output", type: "boolean" }),
  async handler(args) {
    if (!(await requireAuth())) return
    if (!["week", "month", "year"].includes(String(args.interval))) {
      prompts.log.error("--interval must be week, month, or year")
      return
    }

    const base = Number(args.price)
    let total = base
    const data: Record<string, unknown> = { interval: args.interval }

    if (args.fee) {
      const feeAmount = Math.round(base * (Number(args.fee) / 100) * 100) / 100
      total = base + feeAmount
      data.amount = total
      data.line_items = [
        { title: args.title ?? "Subscription", amount: base },
        { title: `Platform Fee (${args.fee}%)`, amount: feeAmount },
      ]
    } else {
      data.amount = base
    }
    if (args.title) data.title = args.title
    if (args.description) data.description = args.description

    const res = await irisFetch(`/api/v1/leads/${args.leadId}/subscription/create`, {
      method: "POST",
      body: JSON.stringify(data),
    })
    if (!(await handleApiError(res, "Create subscription"))) return
    const body = await getJson(res)

    if (args.json) { console.log(JSON.stringify(body, null, 2)); return }

    const checkoutUrl = body.checkout_url ?? body.data?.checkout_url
    const custom = body.custom_request ?? body.data?.custom_request ?? {}
    prompts.log.success(`${success("✓")} Subscription created`)
    printKV("Invoice ID", custom.id)
    printKV("Amount", `${fmtMoney(total)}/${args.interval}`)
    if (checkoutUrl) {
      console.log("")
      console.log(bold("Checkout Link:"))
      console.log(highlight(checkoutUrl))
    }
  },
})

// ── show ──

const ShowCmd = cmd({
  command: "show <lead-id>",
  describe: "show latest invoice for a lead",
  builder: (yargs) =>
    yargs
      .positional("lead-id", { describe: "lead ID", type: "number", demandOption: true })
      .option("json", { describe: "JSON output", type: "boolean" }),
  async handler(args) {
    if (!(await requireAuth())) return
    const res = await irisFetch(`/api/v1/leads/${args.leadId}/invoice`)
    if (!(await handleApiError(res, "Show invoice"))) return
    const body = await getJson(res)
    const inv = body.request ?? body.invoice ?? body.data ?? body

    if (args.json) { console.log(JSON.stringify(inv, null, 2)); return }
    if (!inv || !inv.id) { prompts.log.info(`No invoice for lead #${args.leadId}`); return }

    const paid = !!inv.paid_at
    console.log("")
    console.log(bold(`Invoice #${inv.id} — Lead #${args.leadId}`))
    printDivider()
    printKV("Title", inv.title)
    printKV("Description", inv.description)
    printKV("Amount", fmtMoney(inv.price))
    printKV("Status", paid ? success(`PAID on ${inv.paid_at}`) : dim("UNPAID"))
    printKV("Payment Link", inv.vendor_url)
    printKV("Created", inv.created_at)
    printDivider()
  },
})

// ── checkout ──

const CheckoutCmd = cmd({
  command: "checkout <invoice-id>",
  describe: "generate Stripe checkout payment link",
  builder: (yargs) =>
    yargs
      .positional("invoice-id", { describe: "invoice ID", type: "number", demandOption: true })
      .option("json", { describe: "JSON output", type: "boolean" }),
  async handler(args) {
    if (!(await requireAuth())) return
    const res = await irisFetch(`/api/v1/custom-requests/${args.invoiceId}/generate-checkout`, { method: "POST" })
    if (!(await handleApiError(res, "Generate checkout"))) return
    const body = await getJson(res)

    if (args.json) { console.log(JSON.stringify(body, null, 2)); return }

    const url = body.url ?? body.checkout_url ?? body.vendor_url ?? body.data?.url
    if (url) {
      prompts.log.success(`${success("✓")} Checkout URL generated`)
      console.log("")
      console.log(bold("Payment Link:"))
      console.log(highlight(url))
      console.log("")
      prompts.log.info(dim(`iris invoices send ${args.invoiceId}`))
    } else {
      prompts.log.warn("No URL returned")
    }
  },
})

// ── send ──

const SendCmd = cmd({
  command: "send <invoice-id>",
  describe: "send payment email to the lead",
  builder: (yargs) =>
    yargs
      .positional("invoice-id", { describe: "invoice ID", type: "number", demandOption: true })
      .option("json", { describe: "JSON output", type: "boolean" }),
  async handler(args) {
    if (!(await requireAuth())) return
    const res = await irisFetch(`/api/v1/custom-requests/${args.invoiceId}/send-reminder`, { method: "POST" })
    if (!(await handleApiError(res, "Send invoice"))) return
    const body = await getJson(res)

    if (args.json) { console.log(JSON.stringify(body, null, 2)); return }

    if (body.success === false) {
      prompts.log.error(`Failed: ${body.message ?? "Unknown error"}`)
      return
    }
    prompts.log.success(`${success("✓")} Invoice sent`)
    const emails = body.emails ?? []
    if (Array.isArray(emails) && emails.length > 0) {
      prompts.log.info(`Sent to: ${emails.join(", ")}`)
    }
  },
})

export const PlatformInvoicesCommand = cmd({
  command: "invoices",
  describe: "create, view, and send invoices for leads",
  builder: (yargs) =>
    yargs
      .command(ListCmd)
      .command(CreateCmd)
      .command(SubscribeCmd)
      .command(ShowCmd)
      .command(CheckoutCmd)
      .command(SendCmd)
      .demandCommand(),
  async handler() {},
})
