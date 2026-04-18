import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { irisFetch, requireAuth, handleApiError, printDivider, printKV, dim, bold, success, highlight } from "./iris-api"

// ============================================================================
// Contracts Send — send a contract to a lead for signing
// ============================================================================

const ContractsSendCommand = cmd({
  command: "send <lead-id>",
  describe: "send a contract to a lead for signing",
  builder: (yargs) =>
    yargs
      .positional("lead-id", { describe: "lead ID", type: "number", demandOption: true })
      .option("template", { alias: "t", describe: "contract template name", type: "string" })
      .option("scope", { alias: "s", describe: "scope of work", type: "string" })
      .option("amount", { alias: "a", describe: "contract amount ($)", type: "number" })
      .option("json", { describe: "JSON output", type: "boolean" }),
  async handler(args) {
    if (!(await requireAuth())) return

    const leadId = args["lead-id"]

    // Fetch lead info
    const leadRes = await irisFetch(`/api/v1/leads/${leadId}`)
    if (!(await handleApiError(leadRes, "Fetch lead"))) return
    const lead = await leadRes.json().catch(() => ({}))
    const leadData = lead?.data ?? lead

    if (!leadData?.id) {
      prompts.log.error(`Lead #${leadId} not found`)
      return
    }

    const name = leadData.name ?? leadData.first_name ?? `Lead #${leadId}`
    console.log("")
    console.log(bold(`Sending contract to: ${name}`))

    // Prompt for missing fields
    let scope = args.scope
    if (!scope) {
      const input = await prompts.text({ message: "Scope of work:" })
      if (prompts.isCancel(input)) return
      scope = String(input)
    }

    let amount = args.amount
    if (!amount) {
      const input = await prompts.text({ message: "Contract amount ($):", validate: (v) => isNaN(Number(v)) ? "Must be a number" : undefined })
      if (prompts.isCancel(input)) return
      amount = Number(input)
    }

    const body: Record<string, unknown> = {
      scope,
      amount,
      send_contract: true,
    }
    if (args.template) body.template = args.template

    const spinner = prompts.spinner()
    spinner.start("Creating contract...")

    // Use payment-gate endpoint which handles contract creation
    const res = await irisFetch(`/api/v1/leads/${leadId}/payment-gate`, {
      method: "POST",
      body: JSON.stringify(body),
    })

    spinner.stop("Contract created")

    if (!(await handleApiError(res, "Send contract"))) return
    const data = await res.json().catch(() => ({}))

    if (args.json) { console.log(JSON.stringify(data, null, 2)); return }

    if (!data.success) {
      if (data.error === "duplicate") {
        prompts.log.warn("A contract already exists for this lead")
        const step = data.step?.data ?? {}
        if (step.contract_signing_url) printKV("Existing Contract", step.contract_signing_url)
        return
      }
      prompts.log.error(data.message || "Failed to create contract")
      return
    }

    console.log("")
    console.log(success("Contract sent!"))
    printDivider()
    printKV("Lead", `${name} (#${leadId})`)
    printKV("Amount", `$${Number(amount).toFixed(2)}`)
    printKV("Scope", String(scope))
    printKV("Signing URL", data.contract_signing_url ?? dim("(not generated)"))
    printKV("Proposal URL", data.proposal_url ?? dim("(not attached)"))
    printDivider()
  },
})

// ============================================================================
// Contracts Status — check contract signing status
// ============================================================================

const ContractsStatusCommand = cmd({
  command: "status <lead-id>",
  aliases: ["check"],
  describe: "check contract signing status for a lead",
  builder: (yargs) =>
    yargs
      .positional("lead-id", { describe: "lead ID", type: "number", demandOption: true })
      .option("json", { describe: "JSON output", type: "boolean" }),
  async handler(args) {
    if (!(await requireAuth())) return

    const leadId = args["lead-id"]
    const res = await irisFetch(`/api/v1/leads/${leadId}/deal-status`)
    if (!(await handleApiError(res, "Get contract status"))) return

    const result = await res.json().catch(() => ({}))
    const status = result?.data ?? result

    if (args.json) { console.log(JSON.stringify(status, null, 2)); return }

    if (!status?.has_payment_gate) {
      prompts.log.info(`No contract for lead #${leadId}`)
      console.log(dim(`Send one: iris contracts send ${leadId}`))
      return
    }

    console.log("")
    console.log(bold(`Contract Status — Lead #${leadId}`))
    printDivider()
    printKV("Contract", status.contract_signed ? success("SIGNED") : highlight("PENDING"))
    printKV("Payment", status.payment_received ? success("RECEIVED") : highlight("PENDING"))
    printKV("Amount", `$${Number(status.amount ?? 0).toFixed(2)}`)
    printKV("Scope", status.scope ?? dim("—"))

    if (status.contract_signing_url) {
      console.log("")
      printKV("Signing URL", status.contract_signing_url)
    }
    printDivider()
  },
})

// ============================================================================
// Contracts Templates — list available contract templates
// ============================================================================

const ContractsTemplatesCommand = cmd({
  command: "templates",
  aliases: ["tpl"],
  describe: "list available contract templates",
  builder: (yargs) =>
    yargs
      .option("json", { describe: "JSON output", type: "boolean" }),
  async handler(args) {
    if (!(await requireAuth())) return

    const res = await irisFetch(`/api/v1/atlas/contract-templates`)
    if (!(await handleApiError(res, "List templates"))) return

    const result = (await res.json().catch(() => ({}))) as any
    const templates = result?.data ?? result ?? []

    if (args.json) { console.log(JSON.stringify(templates, null, 2)); return }

    if (!Array.isArray(templates) || templates.length === 0) {
      prompts.log.info("No contract templates found")
      return
    }

    console.log("")
    console.log(bold(`Contract Templates (${templates.length})`))
    printDivider()

    for (const tpl of templates) {
      const name = tpl.name ?? "Untitled"
      const cat = dim(`[${tpl.category ?? "standard"}]`)
      console.log(`  ${highlight(tpl.slug ?? `#${tpl.id}`)}  ${name}  ${cat}`)
      if (tpl.description) console.log(`     ${dim(tpl.description.slice(0, 80))}`)
      if (tpl.merge_fields?.length) console.log(`     ${dim(`fields: ${tpl.merge_fields.join(", ")}`)}`)
    }

    printDivider()
  },
})

// ============================================================================
// Root command
// ============================================================================

export const PlatformContractsCommand = cmd({
  command: "contracts",
  aliases: ["contract"],
  describe: "send contracts for signing, track status, manage templates",
  builder: (yargs) =>
    yargs
      .command(ContractsSendCommand)
      .command(ContractsStatusCommand)
      .command(ContractsTemplatesCommand)
      .demandCommand(),
  async handler() {},
})
