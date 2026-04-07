import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, printDivider, printKV, dim, bold, success, highlight } from "./iris-api"

// ============================================================================
// Per-lead outreach — port of OutreachSendCommand.php
// Endpoints: /api/v1/leads/{leadId}/outreach-steps
// ============================================================================

function stepsEndpoint(leadId: number, suffix = ""): string {
  return `/api/v1/leads/${leadId}/outreach-steps${suffix}`
}

async function getJson(res: Response): Promise<any> { try { return await res.json() } catch { return {} } }

async function fetchSteps(leadId: number): Promise<any[]> {
  const res = await irisFetch(stepsEndpoint(leadId))
  if (!res.ok) return []
  const body = await getJson(res)
  const raw = body.steps ?? body.data ?? body
  return Array.isArray(raw) ? raw : (raw?.steps ?? raw?.data ?? [])
}

function printStepLine(step: any, idx: number): void {
  const num = idx + 1
  const title = bold(String(step.title ?? step.subject ?? `Step ${num}`))
  const type = dim(`[${step.type ?? "?"}]`)
  const status = step.completed_at
    ? `${UI.Style.TEXT_SUCCESS}✓ done${UI.Style.TEXT_NORMAL}`
    : step.invalid_at
    ? `${UI.Style.TEXT_DANGER}✗ invalid${UI.Style.TEXT_NORMAL}`
    : `${UI.Style.TEXT_DIM}pending${UI.Style.TEXT_NORMAL}`
  console.log(`  ${dim(`#${num}`)}  ${title}  ${type}  ${status}`)
  const msg = step.message ?? step.instructions
  if (msg) console.log(`    ${dim(String(msg).slice(0, 100))}`)
}

// ── list ──

const ListCmd = cmd({
  command: "list <lead-id>",
  aliases: ["ls"],
  describe: "show outreach steps for a lead",
  builder: (yargs) =>
    yargs
      .positional("lead-id", { describe: "lead ID", type: "number", demandOption: true })
      .option("json", { describe: "JSON output", type: "boolean" }),
  async handler(args) {
    if (!(await requireAuth())) return
    const steps = await fetchSteps(args.leadId)
    if (args.json) { console.log(JSON.stringify(steps, null, 2)); return }
    if (steps.length === 0) { prompts.log.info("No outreach steps for this lead"); return }
    console.log("")
    console.log(bold(`Outreach Steps — Lead #${args.leadId}`))
    printDivider()
    steps.forEach((s, i) => printStepLine(s, i))
    printDivider()
  },
})

// ── show ──

const ShowCmd = cmd({
  command: "show <lead-id>",
  describe: "show full message for a step",
  builder: (yargs) =>
    yargs
      .positional("lead-id", { describe: "lead ID", type: "number", demandOption: true })
      .option("step", { describe: "step number (1-based)", type: "number", demandOption: true }),
  async handler(args) {
    if (!(await requireAuth())) return
    const steps = await fetchSteps(args.leadId)
    const step = steps[args.step - 1]
    if (!step) { prompts.log.error(`Step ${args.step} not found`); return }

    console.log("")
    console.log(bold(`Step ${args.step}: ${step.title ?? "(no title)"}`))
    printDivider()
    printKV("Type", step.type)
    printKV("Subject", step.subject)
    printKV("Delay (hours)", step.delay_hours)
    console.log("")
    console.log(bold("Message:"))
    console.log(step.message ?? step.instructions ?? dim("(empty)"))
    if (step.ai_prompt) {
      console.log("")
      console.log(bold("AI Prompt:"))
      console.log(step.ai_prompt)
    }
    printDivider()
  },
})

// ── vary / personalize ──

function transformCmd(action: "vary" | "personalize") {
  return cmd({
    command: `${action} <lead-id>`,
    describe: `${action === "vary" ? "generate AI variation of" : "personalize"} a step message`,
    builder: (yargs) =>
      yargs
        .positional("lead-id", { describe: "lead ID", type: "number", demandOption: true })
        .option("step", { describe: "step number (1-based)", type: "number", demandOption: true })
        .option("use", { describe: "save result as new message", type: "boolean", default: false }),
    async handler(args) {
      if (!(await requireAuth())) return
      const steps = await fetchSteps(args.leadId)
      const step = steps[args.step - 1]
      if (!step) { prompts.log.error(`Step ${args.step} not found`); return }

      const stepId = step.id
      const path = stepsEndpoint(args.leadId, `/${stepId}/${action}`)
      const spinner = prompts.spinner()
      spinner.start(`${action === "vary" ? "Varying" : "Personalizing"}…`)
      const res = await irisFetch(path, { method: "POST", body: JSON.stringify({ save: args.use }) })
      if (!(await handleApiError(res, action))) { spinner.stop("Failed", 1); return }
      const body = await getJson(res)
      spinner.stop(success("Done"))

      const newMsg = body.message ?? body.data?.message ?? body.variation ?? body.data?.variation ?? ""
      console.log("")
      console.log(bold(`${action === "vary" ? "Variation" : "Personalized"}:`))
      console.log(newMsg)
      console.log("")
      if (args.use) prompts.log.success(`${success("✓")} Saved as new message`)
      else prompts.log.info(dim(`Use --use to save`))
    },
  })
}

// ── complete ──

const CompleteCmd = cmd({
  command: "complete <lead-id>",
  describe: "mark a step as done",
  builder: (yargs) =>
    yargs
      .positional("lead-id", { describe: "lead ID", type: "number", demandOption: true })
      .option("step", { describe: "step number (1-based)", type: "number", demandOption: true })
      .option("notes", { describe: "completion notes", type: "string" }),
  async handler(args) {
    if (!(await requireAuth())) return
    const steps = await fetchSteps(args.leadId)
    const step = steps[args.step - 1]
    if (!step) { prompts.log.error(`Step ${args.step} not found`); return }
    const res = await irisFetch(stepsEndpoint(args.leadId, `/${step.id}/complete`), {
      method: "POST",
      body: JSON.stringify({ notes: args.notes ?? null }),
    })
    if (!(await handleApiError(res, "Complete step"))) return
    prompts.log.success(`${success("✓")} Step ${args.step} marked done`)
  },
})

// ── send ──

const SendCmd = cmd({
  command: "send <lead-id>",
  describe: "send email/SMS for a step",
  builder: (yargs) =>
    yargs
      .positional("lead-id", { describe: "lead ID", type: "number", demandOption: true })
      .option("step", { describe: "step number (1-based)", type: "number", demandOption: true })
      .option("subject", { describe: "email subject override", type: "string" }),
  async handler(args) {
    if (!(await requireAuth())) return
    const steps = await fetchSteps(args.leadId)
    const step = steps[args.step - 1]
    if (!step) { prompts.log.error(`Step ${args.step} not found`); return }
    const payload: Record<string, unknown> = {}
    if (args.subject) payload.subject = args.subject
    const res = await irisFetch(stepsEndpoint(args.leadId, `/${step.id}/send`), {
      method: "POST",
      body: JSON.stringify(payload),
    })
    if (!(await handleApiError(res, "Send step"))) return
    prompts.log.success(`${success("✓")} Step sent`)
  },
})

// ── invalid ──

const InvalidCmd = cmd({
  command: "invalid <lead-id>",
  describe: "mark a step as cannot contact",
  builder: (yargs) =>
    yargs
      .positional("lead-id", { describe: "lead ID", type: "number", demandOption: true })
      .option("step", { describe: "step number (1-based)", type: "number", demandOption: true })
      .option("reason", { describe: "reason (e.g. 'Private Account')", type: "string" }),
  async handler(args) {
    if (!(await requireAuth())) return
    const steps = await fetchSteps(args.leadId)
    const step = steps[args.step - 1]
    if (!step) { prompts.log.error(`Step ${args.step} not found`); return }
    const res = await irisFetch(stepsEndpoint(args.leadId, `/${step.id}/invalid`), {
      method: "POST",
      body: JSON.stringify({ reason: args.reason ?? "Other" }),
    })
    if (!(await handleApiError(res, "Mark invalid"))) return
    prompts.log.success(`${success("✓")} Step marked invalid`)
  },
})

// ── apply strategy template ──

const ApplyCmd = cmd({
  command: "apply <lead-id>",
  describe: "apply a strategy template to a lead",
  builder: (yargs) =>
    yargs
      .positional("lead-id", { describe: "lead ID", type: "number", demandOption: true })
      .option("strategy", { describe: "strategy key or template ID", type: "string", demandOption: true })
      .option("bloq", { describe: "bloq ID (for template lookup)", type: "number" }),
  async handler(args) {
    if (!(await requireAuth())) return
    const payload: Record<string, unknown> = { strategy: args.strategy }
    if (args.bloq) payload.bloq_id = args.bloq
    const res = await irisFetch(stepsEndpoint(args.leadId, "/apply"), {
      method: "POST",
      body: JSON.stringify(payload),
    })
    if (!(await handleApiError(res, "Apply strategy"))) return
    const body = await getJson(res)
    const count = body.data?.step_count ?? body.step_count ?? body.data?.created_steps?.length ?? 0
    prompts.log.success(`${success("✓")} Strategy applied — ${count} steps created`)
  },
})

// ── Root ──

export const PlatformOutreachSendCommand = cmd({
  command: "outreach-send",
  aliases: ["reachr-send"],
  describe: "per-lead outreach — view steps, vary, personalize, complete, send",
  builder: (yargs) =>
    yargs
      .command(ListCmd)
      .command(ShowCmd)
      .command(transformCmd("vary"))
      .command(transformCmd("personalize"))
      .command(CompleteCmd)
      .command(SendCmd)
      .command(InvalidCmd)
      .command(ApplyCmd)
      .demandCommand(),
  async handler() {},
})
