import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { irisFetch, requireAuth, handleApiError, printDivider, printKV, dim, bold, success } from "./iris-api"

// ============================================================================
// Payments — port of PaymentsCommand.php
// Endpoint: /api/v1/leads/{leadId}/stripe-payments
// ============================================================================

async function getJson(res: Response): Promise<any> { try { return await res.json() } catch { return {} } }

function fmtMoney(n: unknown): string {
  return `$${Number(n ?? 0).toFixed(2)}`
}

async function fetchPayments(leadId: number, params: URLSearchParams): Promise<any> {
  const res = await irisFetch(`/api/v1/leads/${leadId}/stripe-payments?${params}`)
  if (!(await handleApiError(res, "Payments"))) return null
  return getJson(res)
}

const PaymentsCmd = cmd({
  command: "payments <lead-id>",
  describe: "view Stripe payment history for a lead",
  builder: (yargs) =>
    yargs
      .positional("lead-id", { describe: "lead ID", type: "number", demandOption: true })
      .option("json", { describe: "JSON output", type: "boolean" })
      .option("summary", { alias: "s", describe: "summary only", type: "boolean" })
      .option("email", { describe: "override email for Stripe lookup", type: "string" })
      .option("no-connect", { describe: "search platform Stripe account", type: "boolean" }),
  async handler(args) {
    if (!(await requireAuth())) return

    const params = new URLSearchParams()
    if (args.email) params.set("email", String(args.email))
    if (args["no-connect"]) params.set("no_connect", "1")

    let payments = await fetchPayments(args.leadId, params)
    if (!payments) return

    // Auto-fallback: try platform account if no customer found
    if (!payments.has_stripe_customer && !args["no-connect"]) {
      const fallback = new URLSearchParams(params)
      fallback.set("no_connect", "1")
      const platform = await fetchPayments(args.leadId, fallback)
      if (platform?.has_stripe_customer) {
        payments = platform
        if (!args.json) prompts.log.info("Found payments on platform account (not connected account)")
      }
    }

    if (args.json) { console.log(JSON.stringify(payments, null, 2)); return }

    console.log("")
    console.log(bold(`Stripe Payment History — ${payments.lead_name ?? `Lead #${args.leadId}`}`))
    printDivider()

    if (!payments.has_stripe_customer) {
      prompts.log.warn("No Stripe customer found for this lead")
      printDivider()
      return
    }

    const customer = payments.customer ?? {}
    const summary = payments.summary ?? {}

    printKV("Customer", customer.name)
    printKV("Email", customer.email)
    printKV("Stripe ID", customer.id)

    if (args.summary) {
      console.log("")
      printKV("Total Invoices", summary.total_invoices ?? 0)
      printKV("Paid", summary.paid_invoices ?? 0)
      printKV("Pending", summary.pending_invoices ?? 0)
      printKV("Successful Payments", summary.successful_payments ?? 0)
      printKV("Total Paid", success(fmtMoney(payments.total_paid)))
      printDivider()
      return
    }

    // Invoices
    const invoices: any[] = payments.invoices ?? []
    if (invoices.length > 0) {
      console.log("")
      console.log(bold(`Invoices (${invoices.length})`))
      for (const inv of invoices) {
        console.log(`  ${dim(inv.number ?? inv.id)}  ${String(inv.status ?? "").toUpperCase()}  due:${fmtMoney(inv.amount_due)}  paid:${fmtMoney(inv.amount_paid)}  ${dim(inv.created ?? "")}`)
      }
    }

    // Payments
    const txns: any[] = payments.payments ?? []
    if (txns.length > 0) {
      console.log("")
      console.log(bold(`Transactions (${txns.length})`))
      for (const p of txns) {
        const m = p.payment_method ?? {}
        const card = m.brand && m.last4 ? `${String(m.brand).toUpperCase()} ****${m.last4}` : "-"
        console.log(`  ${dim(String(p.id).slice(0, 20))}  ${fmtMoney(p.amount)}  ${String(p.status ?? "").toUpperCase()}  ${card}  ${dim(p.created ?? "")}`)
      }
    }

    // Subscriptions
    const subs: any[] = payments.subscriptions ?? []
    if (subs.length > 0) {
      console.log("")
      console.log(bold(`Subscriptions (${subs.length})`))
      for (const s of subs) {
        console.log(`  ${bold(String(s.plan_name ?? "Unknown"))}  ${String(s.status ?? "").toUpperCase()}  ${fmtMoney(s.amount)}/${s.interval ?? "-"}  ${dim(`next: ${s.current_period_end ?? "-"}`)}`)
      }
    }

    // Summary
    console.log("")
    console.log(bold("Summary"))
    printKV("Total Invoices", summary.total_invoices ?? 0)
    printKV("Paid Invoices", summary.paid_invoices ?? 0)
    printKV("Pending Invoices", summary.pending_invoices ?? 0)
    printKV("Successful Payments", summary.successful_payments ?? 0)
    printKV("Total Revenue", success(fmtMoney(payments.total_paid)))
    printDivider()
  },
})

// Exported as a flat command (not subcommand group) to match PHP `iris payments <lead_id>`
export const PlatformPaymentsCommand = PaymentsCmd
