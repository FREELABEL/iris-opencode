import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { irisFetch, requireAuth, requireUserId, handleApiError, printDivider, printKV, dim, bold, success } from "./iris-api"

// ============================================================================
// Display helpers
// ============================================================================

function statusColor(status: string): string {
  const colors: Record<string, string> = {
    active: UI.Style.TEXT_SUCCESS,
    enabled: UI.Style.TEXT_SUCCESS,
    disabled: UI.Style.TEXT_DIM,
    paused: UI.Style.TEXT_WARNING,
    running: UI.Style.TEXT_HIGHLIGHT,
    failed: UI.Style.TEXT_DANGER,
    completed: UI.Style.TEXT_SUCCESS,
  }
  const c = colors[status?.toLowerCase()] ?? UI.Style.TEXT_DIM
  return `${c}${status}${UI.Style.TEXT_NORMAL}`
}

function printSchedule(s: Record<string, unknown>): void {
  const name = bold(String(s.name ?? s.title ?? `Schedule #${s.id}`))
  const id = dim(`#${s.id}`)
  const status = s.status ? `  ${statusColor(String(s.status))}` : ""
  const freq = s.frequency ?? s.cron_expression ?? s.interval
  const freqStr = freq ? `  ${dim(String(freq))}` : ""
  console.log(`  ${name}  ${id}${status}${freqStr}`)
  if (s.description) {
    console.log(`    ${dim(String(s.description).slice(0, 100))}`)
  }
}

// ============================================================================
// Subcommands
// ============================================================================

const SchedulesListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list scheduled jobs",
  builder: (yargs) =>
    yargs
      .option("limit", { describe: "max results", type: "number", default: 20 })
      .option("agent-id", { describe: "filter by agent ID", type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  IRIS Schedules")

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const userId = await requireUserId((args as any)["user-id"])
    if (!userId) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Loading schedules…")

    try {
      const params = new URLSearchParams({ per_page: String(args.limit) })
      if (args["agent-id"]) params.set("agent_id", String(args["agent-id"]))

      const res = await irisFetch(`/api/v1/users/${userId}/bloqs/scheduled-jobs?${params}`)
      const ok = await handleApiError(res, "List schedules")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const data = (await res.json()) as { data?: any[]; total?: number }
      const schedules: any[] = data?.data ?? []
      spinner.stop(`${schedules.length} schedule(s)`)

      if (schedules.length === 0) {
        prompts.log.warn("No schedules found")
        prompts.outro("Done")
        return
      }

      printDivider()
      for (const s of schedules) {
        printSchedule(s)
        console.log()
      }
      printDivider()

      prompts.outro(
        `${dim("iris schedules get <id>")}  ·  ${dim("iris schedules run <id>")}`,
      )
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const SchedulesGetCommand = cmd({
  command: "get <id>",
  describe: "show schedule details",
  builder: (yargs) =>
    yargs.positional("id", { describe: "schedule ID", type: "number", demandOption: true }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Schedule #${args.id}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const userId = await requireUserId((args as any)["user-id"])
    if (!userId) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Loading…")

    try {
      const res = await irisFetch(`/api/v1/users/${userId}/bloqs/scheduled-jobs/${args.id}`)
      const ok = await handleApiError(res, "Get schedule")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const data = (await res.json()) as { data?: any }
      const s = data?.data ?? data
      spinner.stop(String(s.name ?? s.title ?? `Schedule #${s.id}`))

      printDivider()
      printKV("ID", s.id)
      printKV("Name", s.name ?? s.title)
      printKV("Status", s.status)
      printKV("Frequency", s.frequency ?? s.cron_expression ?? s.interval)
      printKV("Agent ID", s.agent_id)
      printKV("Last Run", s.last_run_at)
      printKV("Next Run", s.next_run_at)
      printKV("Created", s.created_at)
      console.log()
      printDivider()

      prompts.outro(dim(`iris schedules run ${args.id}`))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const SchedulesRunCommand = cmd({
  command: "run <id>",
  describe: "trigger a schedule to run now",
  builder: (yargs) =>
    yargs.positional("id", { describe: "schedule ID", type: "number", demandOption: true }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Run Schedule #${args.id}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const userId = await requireUserId((args as any)["user-id"])
    if (!userId) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Triggering…")

    try {
      const res = await irisFetch(`/api/v1/users/${userId}/bloqs/scheduled-jobs/${args.id}/run`, {
        method: "POST",
        body: JSON.stringify({}),
      })
      const ok = await handleApiError(res, "Run schedule")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const data = (await res.json()) as { data?: any; message?: string }
      spinner.stop(`${success("✓")} Schedule triggered`)

      if (data?.message) {
        prompts.log.info(data.message)
      }
      if (data?.data?.run_id ?? data?.data?.id) {
        const runId = data?.data?.run_id ?? data?.data?.id
        prompts.log.info(`Run ID: ${dim(String(runId))}`)
      }

      prompts.outro(dim(`iris schedules history ${args.id}`))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const SchedulesHistoryCommand = cmd({
  command: "history <id>",
  describe: "show run history for a schedule",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "schedule ID", type: "number", demandOption: true })
      .option("limit", { describe: "max results", type: "number", default: 10 }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Schedule History #${args.id}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const userId = await requireUserId((args as any)["user-id"])
    if (!userId) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Loading history…")

    try {
      const params = new URLSearchParams({ per_page: String(args.limit) })
      const res = await irisFetch(`/api/v1/users/${userId}/bloqs/scheduled-jobs/${args.id}/executions?${params}`)
      const ok = await handleApiError(res, "Get schedule history")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const data = (await res.json()) as { data?: any[] }
      const runs: any[] = data?.data ?? []
      spinner.stop(`${runs.length} run(s)`)

      if (runs.length === 0) {
        prompts.log.warn("No history found")
        prompts.outro("Done")
        return
      }

      printDivider()
      for (const r of runs) {
        const status = statusColor(String(r.status ?? "unknown"))
        const created = r.created_at ? dim(String(r.created_at)) : ""
        console.log(`  ${bold(String(r.id))}  ${status}  ${created}`)
        if (r.summary ?? r.response) {
          console.log(`    ${dim(String(r.summary ?? r.response).slice(0, 120))}`)
        }
        console.log()
      }
      printDivider()

      prompts.outro("Done")
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const SchedulesToggleCommand = cmd({
  command: "toggle <id>",
  describe: "enable or disable a schedule",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "schedule ID", type: "number", demandOption: true })
      .option("disable", { describe: "disable the schedule", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    const action = args.disable ? "Disable" : "Enable"
    prompts.intro(`◈  ${action} Schedule #${args.id}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const userId = await requireUserId((args as any)["user-id"])
    if (!userId) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start(`${action}ing…`)

    try {
      // toggle via PUT update with is_active flag
      const endpoint = `/api/v1/users/${userId}/bloqs/scheduled-jobs/${args.id}`

      const res = await irisFetch(endpoint, { method: "PUT", body: JSON.stringify({ is_active: !args.disable }) })
      const ok = await handleApiError(res, `${action} schedule`)
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      spinner.stop(`${success("✓")} Schedule ${action.toLowerCase()}d`)
      prompts.outro(dim(`iris schedules get ${args.id}`))
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

export const PlatformSchedulesCommand = cmd({
  command: "schedules",
  describe: "manage agent scheduled jobs",
  builder: (yargs) =>
    yargs
      .command(SchedulesListCommand)
      .command(SchedulesGetCommand)
      .command(SchedulesRunCommand)
      .command(SchedulesHistoryCommand)
      .command(SchedulesToggleCommand)
      .demandCommand(),
  async handler() {},
})
