import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { irisFetch, requireAuth, handleApiError, printDivider, printKV, dim, bold, success, highlight } from "./iris-api"

// ============================================================================
// Deliver — port of DeliverCommand.php
// Executes a callable workflow and delivers result to a lead.
// Endpoint: /api/v1/leads/{leadId}/deliverables/workflow
// ============================================================================

async function getJson(res: Response): Promise<any> { try { return await res.json() } catch { return {} } }

export const PlatformDeliverCommand = cmd({
  command: "deliver <lead-id> <workflow>",
  describe: "execute a workflow and deliver the result to a lead",
  builder: (yargs) =>
    yargs
      .positional("lead-id", { describe: "lead ID", type: "number", demandOption: true })
      .positional("workflow", { describe: "callable workflow name", type: "string", demandOption: true })
      .option("input", { alias: "i", describe: "workflow input as JSON", type: "string", default: "{}" })
      .option("no-email", { describe: "skip email notification", type: "boolean", default: false })
      .option("subject", { alias: "s", describe: "custom email subject", type: "string" })
      .option("recipients", { alias: "r", describe: "override recipient emails (comma-separated)", type: "string" })
      .option("title", { alias: "t", describe: "custom deliverable title", type: "string" })
      .option("context", { alias: "c", describe: "custom context for AI email generation", type: "string" })
      .option("json", { describe: "JSON output", type: "boolean" }),
  async handler(args) {
    if (!(await requireAuth())) return

    let workflowInput: unknown
    try {
      workflowInput = JSON.parse(String(args.input))
    } catch (e) {
      prompts.log.error(`Invalid JSON for --input: ${(e as Error).message}`)
      return
    }

    const options: Record<string, unknown> = {
      send_email: !args["no-email"],
      message_mode: "ai",
      include_project_context: true,
    }
    if (args.subject) options.email_subject = args.subject
    if (args.recipients) options.recipient_emails = String(args.recipients).split(",").map((s) => s.trim())
    if (args.title) options.deliverable_title = args.title
    if (args.context) options.custom_context = args.context

    const payload = {
      workflow_name: args.workflow,
      input: workflowInput,
      options,
    }

    if (!args.json) {
      console.log("")
      console.log(bold("IRIS Workflow Delivery"))
      printKV("Lead", `#${args.leadId}`)
      printKV("Workflow", args.workflow)
      printKV("Send Email", options.send_email ? "Yes" : "No")
      console.log("")
    }

    const spinner = prompts.spinner()
    spinner.start("Executing workflow…")

    const res = await irisFetch(`/api/v1/leads/${args.leadId}/deliverables/workflow`, {
      method: "POST",
      body: JSON.stringify(payload),
    })
    const ok = await handleApiError(res, "Deliver")
    if (!ok) { spinner.stop("Failed", 1); return }

    const body = await getJson(res)
    spinner.stop(success("Delivered"))
    const data = body.data ?? body

    if (args.json) { console.log(JSON.stringify(data, null, 2)); return }

    console.log("")
    console.log(bold("Delivery Summary"))
    printDivider()
    printKV("Workflow", data.workflow_name ?? args.workflow)
    printKV("Lead ID", `#${args.leadId}`)
    printKV("Execution ID", data.execution_id)
    printKV("Deliverable ID", data.deliverable_id ? `#${data.deliverable_id}` : undefined)
    printKV("Deliverable URL", data.deliverable_url ? highlight(data.deliverable_url) : undefined)
    if (data.email_sent) {
      printKV("Email Sent", "Yes")
      if (Array.isArray(data.email_sent_to)) printKV("Recipients", data.email_sent_to.join(", "))
    } else {
      printKV("Email Sent", "No")
    }
    if (data.time_to_value_seconds != null) printKV("Time to Value", `${data.time_to_value_seconds}s`)

    // Workflow output preview
    if (data.workflow_output) {
      console.log("")
      console.log(bold("Workflow Output Preview"))
      const preview = typeof data.workflow_output === "string" ? data.workflow_output : JSON.stringify(data.workflow_output, null, 2)
      console.log(preview.length > 500 ? preview.slice(0, 500) + "..." : preview)
    }
    printDivider()
  },
})
