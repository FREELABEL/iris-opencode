import { cmd } from "./cmd"
import * as prompts from "./clack"
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
    describe: `${action === "vary" ? "generate AI variation of" : "personalize"} a step message (not yet available)`,
    builder: (yargs) =>
      yargs
        .positional("lead-id", { describe: "lead ID", type: "number", demandOption: true })
        .option("step", { describe: "step number (1-based)", type: "number", demandOption: true })
        .option("use", { describe: "save result as new message", type: "boolean", default: false }),
    async handler() {
      // No backend endpoint exists for per-step AI variation/personalization
      // yet, so this used to leak a raw HTTP 404. Fail clearly instead. (#137539)
      prompts.log.warn(
        `${bold(`outreach-send ${action}`)} is not available yet — per-step AI ${action === "vary" ? "variation" : "personalization"} is not implemented on the server.`,
      )
      prompts.log.info(
        dim(`Tracked in bug #137539. For now: ${highlight(`iris outreach-send show <lead-id> --step N`)} to view a message, edit the step, or apply a different strategy.`),
      )
      process.exitCode = 2
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
  describe: "send email/SMS for a step (not yet available)",
  builder: (yargs) =>
    yargs
      .positional("lead-id", { describe: "lead ID", type: "number", demandOption: true })
      .option("step", { describe: "step number (1-based)", type: "number", demandOption: true })
      .option("subject", { describe: "email subject override", type: "string" }),
  async handler() {
    // No per-step send pipeline exists on the server (only lead-level reminders),
    // so this used to leak a raw HTTP 404. Fail clearly instead. (#137539)
    prompts.log.warn(
      `${bold("outreach-send send")} is not available yet — per-step email/SMS sending is not implemented on the server.`,
    )
    prompts.log.info(
      dim(`Tracked in bug #137539 (also gated on the outreach compliance layer #137534). After sending manually, mark the step done with ${highlight("iris outreach-send complete <lead-id> --step N")}.`),
    )
    process.exitCode = 2
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
      .option("strategy", { describe: "strategy template ID (from `iris outreach-strategy list <bloq>`)", type: "string", demandOption: true })
      .option("bloq", { describe: "bloq ID that owns the strategy template", type: "number", demandOption: true })
      .option("clear-existing", { describe: "clear existing steps before applying", type: "boolean", default: true }),
  async handler(args) {
    if (!(await requireAuth())) return
    // Apply lives on the bloq-scoped strategy-template endpoint, not on
    // /outreach-steps (which only exposes index/store/update/destroy). The old
    // POST /outreach-steps/apply hit the {stepId} resource route -> 405. (#137539)
    const res = await irisFetch(
      `/api/v1/bloqs/${args.bloq}/outreach-strategy-templates/${args.strategy}/apply`,
      {
        method: "POST",
        body: JSON.stringify({ lead_id: args.leadId, clear_existing: args.clearExisting }),
      },
    )
    if (!(await handleApiError(res, "Apply strategy"))) return
    const body = await getJson(res)
    const count = body.data?.step_count ?? body.step_count ?? body.data?.created_steps?.length ?? 0
    prompts.log.success(`${success("✓")} Strategy applied — ${count} steps created on lead #${args.leadId}`)
  },
})

// ── Root ──

export const PlatformOutreachSendCommand = cmd({
  command: "outreach-send",
  aliases: ["reachr-send"],
  describe: "per-lead outreach — list/show steps, apply a strategy, complete or mark a step invalid",
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
