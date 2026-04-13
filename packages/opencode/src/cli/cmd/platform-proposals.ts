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
      .option("interval", { alias: "i", describe: "billing interval: month|quarter|year|one-time", type: "string" })
      .option("duration", { alias: "d", describe: "duration in months (default: 12)", type: "number" })
      .option("deposit", { describe: "deposit percentage 0-100", type: "number" })
      .option("rev-share", { describe: "revenue share percentage (e.g. 5)", type: "number" })
      .option("pass-fees", { describe: "pass processing fees to client (Stripe 2.9% + $0.30)", type: "boolean" })
      .option("brand-logo", { describe: "brand logo URL for proposal header", type: "string" })
      .option("package", { alias: "p", describe: "service package ID (auto-fills amount + scope)", type: "number" })
      .option("template", { alias: "t", describe: "proposal template name", type: "string" })
      .option("list-price", { describe: "list price before discount (shows strikethrough on proposal)", type: "number" })
      .option("discount", { describe: "discount percentage (auto-calculated from list-price vs amount if omitted)", type: "number" })
      .option("skip-contract", { describe: "skip contract attachment", type: "boolean" })
      .option("skip-send", { describe: "generate but don't send to client", type: "boolean" })
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
    if (args["skip-contract"]) body.skip_contract = true
    if (args.template) body.template = args.template
    if (args.interval) body.interval = args.interval
    if (args.duration) body.duration_months = args.duration
    if (args.deposit !== undefined) body.deposit_percent = args.deposit
    if (args["brand-logo"]) body.brand_logo_url = args["brand-logo"]
    if (args["rev-share"] !== undefined) body.rev_share_percent = args["rev-share"]
    if (args["pass-fees"]) body.processing_fee_mode = "pass_to_client"
    if (args["list-price"] !== undefined) body.list_price = args["list-price"]
    if (args["discount"] !== undefined) body.discount_percent = args["discount"]

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
    if (args["list-price"]) {
      const discPct = args["discount"] ?? Math.round((1 - (Number(amount) / Number(args["list-price"]))) * 100)
      printKV("List Price", `$${Number(args["list-price"]).toFixed(2)}${args.interval && args.interval !== "one-time" ? "/" + args.interval : ""}`)
      printKV("Discount", `${discPct}% off`)
    }
    printKV("Amount", `$${Number(amount).toFixed(2)}${args.interval && args.interval !== "one-time" ? "/" + args.interval : ""}`)
    if (args.interval && args.interval !== "one-time") {
      const dur = args.duration ?? 12
      const total = Number(amount) * dur
      printKV("Duration", `${dur} months`)
      printKV("Total", `$${total.toFixed(2)}`)
      if (args.deposit) {
        const dep = total * (args.deposit / 100)
        printKV("Deposit", `${args.deposit}% = $${dep.toFixed(2)} upfront`)
      }
      if (args["rev-share"]) {
        printKV("Rev Share", `${args["rev-share"]}% of net platform revenue`)
      }
    }
    printKV("Scope", String(scope))
    printDivider()
    printKV("Proposal URL", data.proposal_url ?? dim("(not generated)"))
    printKV("Contract URL", data.contract_signing_url ?? dim("(not attached)"))
    printKV("Payment URL", data.stripe_checkout_url ?? dim("(not configured)"))
    printDivider()

    if (!args["skip-send"] && data.proposal_url) {
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
// Proposals Cancel — cancel/clear an active proposal
// ============================================================================

const ProposalsCancelCommand = cmd({
  command: "cancel <lead-id>",
  aliases: ["clear", "delete"],
  describe: "cancel the active proposal/payment gate for a lead",
  builder: (yargs) =>
    yargs
      .positional("lead-id", { describe: "lead ID", type: "number", demandOption: true })
      .option("json", { describe: "JSON output", type: "boolean" }),
  async handler(args) {
    if (!(await requireAuth())) return

    const leadId = args["lead-id"]

    // Find the active payment gate step
    const stepsRes = await irisFetch(`/api/v1/leads/${leadId}/outreach-steps`)
    if (!(await handleApiError(stepsRes, "Fetch outreach steps"))) return

    const stepsData = await stepsRes.json().catch(() => ({}))
    const steps = stepsData?.data ?? stepsData?.steps ?? stepsData ?? []

    if (!Array.isArray(steps)) {
      prompts.log.error("Could not read outreach steps")
      return
    }

    const activeGates = steps.filter((s: any) => s.type === "payment_gate" && !s.is_completed)

    if (activeGates.length === 0) {
      prompts.log.info(`No active proposal for lead #${leadId}`)
      return
    }

    // Complete each active payment gate + its reminder steps
    let cancelled = 0
    for (const gate of activeGates) {
      const res = await irisFetch(`/api/v1/leads/${leadId}/outreach-steps/${gate.id}/complete`, {
        method: "POST",
      })
      if (res.ok) cancelled++
    }

    if (args.json) {
      console.log(JSON.stringify({ cancelled, lead_id: leadId }))
      return
    }

    console.log("")
    console.log(success(`Cancelled ${cancelled} active proposal(s) for lead #${leadId}`))
    console.log(dim(`Create a new one: iris proposals create ${leadId}`))
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
      .command(ProposalsCancelCommand)
      .demandCommand(),
  async handler() {},
})
