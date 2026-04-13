import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { irisFetch, requireAuth, handleApiError, printDivider, printKV, dim, bold, success, highlight } from "./iris-api"

// ============================================================================
// Proposals Create — generate proposal from lead data + send
// ============================================================================

const ProposalsCreateCommand = cmd({
  command: "create <lead-id>",
  aliases: ["generate", "send"],
  describe: "generate a proposal from lead notes/tasks and send for signing",
  builder: (yargs) =>
    yargs
      .positional("lead-id", { describe: "lead ID", type: "number", demandOption: true })
      .option("amount", { alias: "a", describe: "total amount ($)", type: "number" })
      .option("scope", { alias: "s", describe: "scope of work", type: "string" })
      .option("package", { alias: "p", describe: "service package ID (auto-fills amount + scope)", type: "number" })
      .option("template", { alias: "t", describe: "proposal template name", type: "string" })
      .option("no-contract", { describe: "skip contract attachment", type: "boolean" })
      .option("no-send", { describe: "generate but don't send to client", type: "boolean" })
      .option("json", { describe: "JSON output", type: "boolean" }),
  async handler(args) {
    if (!(await requireAuth())) return

    const leadId = args["lead-id"]

    // Step 1: Fetch lead data (notes, tasks, deliverables)
    const leadRes = await irisFetch(`/api/v1/leads/${leadId}?include=notes,tasks,deliverables`)
    if (!(await handleApiError(leadRes, "Fetch lead"))) return
    const lead = await leadRes.json().catch(() => ({}))
    const leadData = lead?.data ?? lead

    if (!leadData?.id) {
      prompts.log.error(`Lead #${leadId} not found`)
      return
    }

    console.log("")
    console.log(bold(`Generating proposal for: ${leadData.name ?? leadData.first_name ?? `Lead #${leadId}`}`))

    // Step 2: If no amount/scope, prompt or pull from package
    let amount = args.amount
    let scope = args.scope

    if (args.package) {
      const pkgRes = await irisFetch(`/api/v1/bloq-packages/${args.package}`)
      if (pkgRes.ok) {
        const pkg = await pkgRes.json().catch(() => ({}))
        const pkgData = pkg?.data ?? pkg
        amount = amount ?? pkgData.price
        scope = scope ?? pkgData.scope_template ?? pkgData.description
        printKV("Package", pkgData.name ?? `#${args.package}`)
      }
    }

    if (!amount) {
      const input = await prompts.text({ message: "Total amount ($):", validate: (v) => isNaN(Number(v)) ? "Must be a number" : undefined })
      if (prompts.isCancel(input)) return
      amount = Number(input)
    }

    if (!scope) {
      const input = await prompts.text({ message: "Scope of work:" })
      if (prompts.isCancel(input)) return
      scope = String(input)
    }

    // Step 3: Create payment gate (which generates proposal + contract + Stripe)
    const body: Record<string, unknown> = {
      amount,
      scope,
      auto_send_reminders: true,
      generate_proposal: true,
    }
    if (args.package) body.package_id = args.package
    if (args["no-contract"]) body.skip_contract = true
    if (args.template) body.template = args.template

    const spinner = prompts.spinner()
    spinner.start("Generating proposal...")

    const res = await irisFetch(`/api/v1/leads/${leadId}/payment-gate`, {
      method: "POST",
      body: JSON.stringify(body),
    })

    spinner.stop("Proposal generated")

    if (!(await handleApiError(res, "Create proposal"))) return
    const data = await res.json().catch(() => ({}))

    if (args.json) { console.log(JSON.stringify(data, null, 2)); return }

    if (!data.success) {
      if (data.error === "duplicate") {
        prompts.log.warn(data.message || "A proposal already exists for this lead")
        const step = data.step?.data ?? {}
        if (step.proposal_url) {
          console.log("")
          printKV("Existing Proposal", step.proposal_url)
        }
        return
      }
      prompts.log.error(data.message || "Failed to create proposal")
      return
    }

    console.log("")
    console.log(success("Proposal created!"))
    printDivider()
    printKV("Lead", `${leadData.name ?? leadData.first_name ?? ""} (#${leadId})`)
    printKV("Amount", `$${Number(amount).toFixed(2)}`)
    printKV("Scope", String(scope))
    printDivider()
    printKV("Proposal URL", data.proposal_url ?? dim("(not generated)"))
    printKV("Contract URL", data.contract_signing_url ?? dim("(not attached)"))
    printKV("Payment URL", data.stripe_checkout_url ?? dim("(not configured)"))
    printDivider()

    if (!args["no-send"] && data.proposal_url) {
      console.log("")
      console.log(dim("Proposal ready to send. Use outreach or share the URL above."))
    }
  },
})

// ============================================================================
// Proposals Status — check proposal + deal status
// ============================================================================

const ProposalsStatusCommand = cmd({
  command: "status <lead-id>",
  aliases: ["check"],
  describe: "check proposal and deal status for a lead",
  builder: (yargs) =>
    yargs
      .positional("lead-id", { describe: "lead ID", type: "number", demandOption: true })
      .option("json", { describe: "JSON output", type: "boolean" }),
  async handler(args) {
    if (!(await requireAuth())) return

    const leadId = args["lead-id"]
    const res = await irisFetch(`/api/v1/leads/${leadId}/deal-status`)
    if (!(await handleApiError(res, "Get proposal status"))) return

    const result = await res.json().catch(() => ({}))
    const status = result?.data ?? result

    if (args.json) { console.log(JSON.stringify(status, null, 2)); return }

    if (!status?.has_payment_gate) {
      prompts.log.info(`No proposal for lead #${leadId}`)
      console.log(dim(`Create one: iris proposals create ${leadId}`))
      return
    }

    const statusLabels: Record<string, string> = {
      deal_closed: success("CLOSED"),
      awaiting_payment: highlight("AWAITING PAYMENT"),
      awaiting_contract: highlight("AWAITING CONTRACT"),
      awaiting_both: dim("PENDING"),
    }

    console.log("")
    console.log(bold(`Proposal Status — Lead #${leadId}`))
    printDivider()
    printKV("Status", statusLabels[status.status] ?? status.status)
    printKV("Amount", `$${Number(status.amount ?? 0).toFixed(2)}`)
    printKV("Scope", status.scope ?? dim("—"))
    printKV("Contract", status.contract_signed ? success("Signed") : highlight("Pending"))
    printKV("Payment", status.payment_received ? success("Received") : highlight("Pending"))
    printKV("Reminders", `${status.reminders_sent ?? 0}/${status.reminders_total ?? 0} sent`)
    printDivider()

    if (status.proposal_url) printKV("Proposal", status.proposal_url)
    if (status.contract_signing_url) printKV("Contract", status.contract_signing_url)
    if (status.stripe_checkout_url) printKV("Payment", status.stripe_checkout_url)

    if (status.proposal_url || status.contract_signing_url) {
      printDivider()
    }
  },
})

// ============================================================================
// Proposals List — list all leads with active proposals
// ============================================================================

const ProposalsListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list leads with active proposals/payment gates",
  builder: (yargs) =>
    yargs
      .option("status", { alias: "s", describe: "filter by status", type: "string", choices: ["pending", "awaiting_payment", "awaiting_contract", "deal_closed"] })
      .option("json", { describe: "JSON output", type: "boolean" }),
  async handler(args) {
    if (!(await requireAuth())) return

    const params = new URLSearchParams({ has_payment_gate: "1" })
    if (args.status) params.set("deal_status", args.status)

    const res = await irisFetch(`/api/v1/leads?${params}`)
    if (!(await handleApiError(res, "List proposals"))) return

    const result = await res.json().catch(() => ({}))
    const leads = result?.data ?? result ?? []

    if (args.json) { console.log(JSON.stringify(leads, null, 2)); return }

    if (!Array.isArray(leads) || leads.length === 0) {
      prompts.log.info("No active proposals found")
      return
    }

    console.log("")
    console.log(bold(`Active Proposals (${leads.length})`))
    printDivider()

    for (const lead of leads) {
      const name = lead.name ?? lead.first_name ?? `Lead #${lead.id}`
      const amount = lead.deal_amount ? `$${Number(lead.deal_amount).toFixed(2)}` : dim("—")
      const st = lead.deal_status ?? dim("unknown")
      console.log(`  ${highlight(`#${lead.id}`)} ${name.padEnd(25)} ${amount.padEnd(12)} ${st}`)
    }

    printDivider()
  },
})

// ============================================================================
// Root command
// ============================================================================

export const PlatformProposalsCommand = cmd({
  command: "proposals",
  aliases: ["proposal"],
  describe: "create, send, and track client proposals with contracts + payment",
  builder: (yargs) =>
    yargs
      .command(ProposalsCreateCommand)
      .command(ProposalsStatusCommand)
      .command(ProposalsListCommand)
      .demandCommand(),
  async handler() {},
})
