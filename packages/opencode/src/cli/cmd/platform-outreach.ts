import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, printDivider, printKV, dim, bold, success, highlight } from "./iris-api"
import { OutreachApproveGroup } from "./platform-outreach-approve"

// ============================================================================
// Outreach Strategy Commands — list, show, create, update, delete
// ============================================================================

const RAICHU = process.env.IRIS_FL_API_URL ?? process.env.FL_API_URL ?? "https://raichu.heyiris.io"

async function fetchStrategies(bloqId: string, category?: string): Promise<Record<string, unknown>[]> {
  const q = category ? `?category=${category}` : ""
  const resp = await irisFetch(`/api/v1/bloqs/${bloqId}/outreach-strategy-templates${q}`, {}, RAICHU)
  if (!resp.ok) { await handleApiError(resp, "fetch strategies"); return [] }
  const body = await resp.json()
  return body.data?.templates ?? body.templates ?? []
}

async function fetchStrategy(bloqId: string, id: string): Promise<Record<string, unknown>> {
  const resp = await irisFetch(`/api/v1/bloqs/${bloqId}/outreach-strategy-templates/${id}`, {}, RAICHU)
  if (!resp.ok) { await handleApiError(resp, "fetch strategy"); return {} }
  const body = await resp.json()
  return body.data ?? body
}

function channelLabel(type: string): string {
  const map: Record<string, string> = {
    instagram: "IG DM", email: "Email", sms: "SMS",
    phone: "Phone", linkedin: "LinkedIn", visit: "Visit", other: "Other",
  }
  return map[type] ?? type
}

function printStrategy(s: Record<string, unknown>, showSteps = false): void {
  const steps = (s.steps ?? []) as Record<string, unknown>[]
  printKV("ID", String(s.id))
  printKV("Name", bold(String(s.name)))
  printKV("Code", String(s.short_code ?? "-"))
  printKV("Category", String(s.category ?? "-"))
  printKV("Icon", String(s.icon ?? "-"))
  printKV("Usage", String(s.usage_count ?? 0))
  printKV("Steps", String(steps.length))

  if (showSteps && steps.length > 0) {
    console.log("")
    console.log(bold("Steps:"))
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i] as Record<string, unknown>
      const delay = Number(step.delay_hours ?? 0) > 0 ? dim(` (+${step.delay_hours}h)`) : ""
      const ch = channelLabel(String(step.type ?? "other"))
      console.log(`  ${i + 1}. ${step.title} ${dim(`[${ch}]`)}${delay}`)
      if (step.instructions) {
        const instr = String(step.instructions)
        console.log(`     ${dim(instr.length > 100 ? instr.slice(0, 100) + "..." : instr)}`)
      }
      if (step.ai_prompt) {
        console.log(`     ${dim("AI: " + String(step.ai_prompt).slice(0, 80) + "...")}`)
      }
    }
  }
}

// ── List ──

const OutreachListCommand = cmd({
  command: "list <bloq-id>",
  describe: "list outreach strategies for a board",
  builder: (yargs) =>
    yargs
      .positional("bloq-id", { describe: "board/bloq ID", type: "string", demandOption: true })
      .option("category", { describe: "filter by category", type: "string" })
      .option("json", { describe: "JSON output", type: "boolean" }),
  async handler(args) {
    if (!args.bloqId) {
      prompts.log.error("Missing required argument: bloq-id")
      prompts.log.info(dim("Usage: iris outreach list <bloq-id>"))
      process.exitCode = 1
      return
    }
    await requireAuth()
    const templates = await fetchStrategies(args.bloqId, args.category as string | undefined)

    if (args.json) {
      console.log(JSON.stringify(templates, null, 2))
      return
    }

    if (templates.length === 0) {
      prompts.log.info(`No strategies found for bloq #${args.bloqId}`)
      return
    }

    console.log(bold(`\nOutreach Strategies [Board #${args.bloqId}]\n`))
    for (const t of templates) {
      const steps = (t.steps ?? []) as unknown[]
      const def = t.is_default ? success(" (default)") : ""
      console.log(`  ${dim(`#${t.id}`)} ${bold(String(t.name))}${def}  ${dim(`${steps.length} steps | ${t.usage_count ?? 0} uses`)}`)
    }
    console.log("")
  },
})

// ── Show ──

const OutreachShowCommand = cmd({
  command: "show <bloq-id> <id>",
  describe: "show strategy details + steps",
  builder: (yargs) =>
    yargs
      .positional("bloq-id", { describe: "board/bloq ID", type: "string", demandOption: true })
      .positional("id", { describe: "strategy ID", type: "string", demandOption: true })
      .option("json", { describe: "JSON output", type: "boolean" }),
  async handler(args) {
    await requireAuth()
    const strategy = await fetchStrategy(args.bloqId, args.id)

    if (args.json) {
      console.log(JSON.stringify(strategy, null, 2))
      return
    }

    console.log("")
    printStrategy(strategy, true)
    console.log("")
  },
})

// ── Create (from JSON) ──

const OutreachCreateCommand = cmd({
  command: "create <bloq-id>",
  describe: "create strategy from JSON file",
  builder: (yargs) =>
    yargs
      .positional("bloq-id", { describe: "board/bloq ID", type: "string", demandOption: true })
      .option("from-json", { describe: "JSON file path", type: "string", demandOption: true })
      .option("json", { describe: "JSON output", type: "boolean" }),
  async handler(args) {
    await requireAuth()
    const fs = await import("fs")
    const filePath = args.fromJson as string
    if (!fs.existsSync(filePath)) {
      prompts.log.error(`File not found: ${filePath}`)
      return
    }

    const payload = JSON.parse(fs.readFileSync(filePath, "utf-8"))
    const resp = await irisFetch(`/api/v1/bloqs/${args.bloqId}/outreach-strategy-templates`, {
      method: "POST",
      body: JSON.stringify(payload),
    }, RAICHU)

    if (!resp.ok) { await handleApiError(resp, "outreach"); return }
    const body = await resp.json()
    const created = body.data ?? body

    if (args.json) {
      console.log(JSON.stringify(created, null, 2))
      return
    }

    prompts.log.success(`Strategy "${created.name}" created (ID: ${created.id})`)
  },
})

// ── Update ──

const OutreachUpdateCommand = cmd({
  command: "update <bloq-id> <id>",
  describe: "update strategy from JSON file",
  builder: (yargs) =>
    yargs
      .positional("bloq-id", { describe: "board/bloq ID", type: "string", demandOption: true })
      .positional("id", { describe: "strategy ID", type: "string", demandOption: true })
      .option("from-json", { describe: "JSON file path", type: "string", demandOption: true })
      .option("json", { describe: "JSON output", type: "boolean" }),
  async handler(args) {
    await requireAuth()
    const fs = await import("fs")
    const filePath = args.fromJson as string
    if (!fs.existsSync(filePath)) {
      prompts.log.error(`File not found: ${filePath}`)
      return
    }

    const payload = JSON.parse(fs.readFileSync(filePath, "utf-8"))
    const resp = await irisFetch(`/api/v1/bloqs/${args.bloqId}/outreach-strategy-templates/${args.id}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    }, RAICHU)

    if (!resp.ok) { await handleApiError(resp, "outreach"); return }
    const body = await resp.json()
    const updated = body.data ?? body

    if (args.json) {
      console.log(JSON.stringify(updated, null, 2))
      return
    }

    prompts.log.success(`Strategy "${updated.name}" updated`)
  },
})

// ── Delete ──

const OutreachDeleteCommand = cmd({
  command: "delete <bloq-id> <id>",
  describe: "delete a strategy",
  builder: (yargs) =>
    yargs
      .positional("bloq-id", { describe: "board/bloq ID", type: "string", demandOption: true })
      .positional("id", { describe: "strategy ID", type: "string", demandOption: true }),
  async handler(args) {
    await requireAuth()

    const strategy = await fetchStrategy(args.bloqId, args.id)
    const name = String(strategy.name ?? `#${args.id}`)

    const confirmed = await prompts.confirm({ message: `Delete strategy "${name}"?` })
    if (!confirmed || prompts.isCancel(confirmed)) {
      prompts.log.info("Cancelled")
      return
    }

    const resp = await irisFetch(`/api/v1/bloqs/${args.bloqId}/outreach-strategy-templates/${args.id}`, {
      method: "DELETE",
    }, RAICHU)

    if (!resp.ok) { await handleApiError(resp, "outreach"); return }
    prompts.log.success(`Strategy "${name}" deleted`)
  },
})

// ── Apply ──

const OutreachApplyCommand = cmd({
  command: "apply <bloq-id> <id> <lead-id>",
  describe: "apply strategy to a lead",
  builder: (yargs) =>
    yargs
      .positional("bloq-id", { describe: "board/bloq ID", type: "string", demandOption: true })
      .positional("id", { describe: "strategy ID", type: "string", demandOption: true })
      .positional("lead-id", { describe: "lead ID", type: "string", demandOption: true })
      .option("clear-existing", { describe: "clear existing steps", type: "boolean", default: true }),
  async handler(args) {
    await requireAuth()

    const resp = await irisFetch(`/api/v1/bloqs/${args.bloqId}/outreach-strategy-templates/${args.id}/apply`, {
      method: "POST",
      body: JSON.stringify({ lead_id: Number(args.leadId), clear_existing: args.clearExisting }),
    }, RAICHU)

    if (!resp.ok) { await handleApiError(resp, "outreach"); return }
    const body = await resp.json()
    const steps = body.data?.step_count ?? body.data?.created_steps?.length ?? 0
    prompts.log.success(`Applied — ${steps} steps created on lead #${args.leadId}`)
  },
})

// ── Parent command ──

export const PlatformOutreachCommand = cmd({
  command: "outreach",
  aliases: ["reachr"],
  describe: "manage outreach strategies — list, show, create, update, apply, delete",
  builder: (yargs) =>
    yargs
      .command(OutreachListCommand)
      .command(OutreachShowCommand)
      .command(OutreachCreateCommand)
      .command(OutreachUpdateCommand)
      .command(OutreachDeleteCommand)
      .command(OutreachApplyCommand)
      .command(OutreachApproveGroup)
      .demandCommand(),
  async handler() {},
})
