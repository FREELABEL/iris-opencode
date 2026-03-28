import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, requireUserId, printDivider, printKV, dim, bold, success } from "./iris-api"

// ============================================================================
// Display helpers
// ============================================================================

function statusColor(status: string): string {
  const colors: Record<string, string> = {
    completed: UI.Style.TEXT_SUCCESS,
    failed: UI.Style.TEXT_DANGER,
    running: UI.Style.TEXT_HIGHLIGHT,
    pending: UI.Style.TEXT_WARNING,
    paused: UI.Style.TEXT_INFO,
  }
  const c = colors[status?.toLowerCase()] ?? UI.Style.TEXT_DIM
  return `${c}${status}${UI.Style.TEXT_NORMAL}`
}

function printWorkflow(w: Record<string, unknown>): void {
  const name = bold(String(w.name ?? `Workflow #${w.id}`))
  const id = dim(`#${w.id}`)
  const type = w.type ? `  ${dim(String(w.type))}` : ""
  console.log(`  ${name}  ${id}${type}`)
  if (w.description) {
    console.log(`    ${dim(String(w.description).slice(0, 100))}`)
  }
}

function printRun(r: Record<string, unknown>): void {
  const id = bold(String(r.id))
  const status = statusColor(String(r.status ?? "unknown"))
  const created = r.created_at ? `  ${dim(String(r.created_at))}` : ""
  console.log(`  ${id}  ${status}${created}`)
  if (r.summary) {
    console.log(`    ${dim(String(r.summary).slice(0, 120))}`)
  }
}

// ============================================================================
// Polling helper
// ============================================================================

async function pollRun(runId: string, timeoutSecs = 300): Promise<any> {
  const start = Date.now()
  while (true) {
    if ((Date.now() - start) / 1000 > timeoutSecs) break
    const res = await irisFetch(`/api/v1/users/${userId}/bloqs/workflow-runs/${runId}`)
    if (!res.ok) break
    const data = (await res.json()) as { data?: any }
    const run = data?.data ?? data
    if (run.status === "completed" || run.status === "failed") return run
    await Bun.sleep(800)
  }
  return null
}

// ============================================================================
// Subcommands
// ============================================================================

const WorkflowsListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list your workflows",
  builder: (yargs) =>
    yargs
      .option("limit", { describe: "max results", type: "number", default: 15 })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  IRIS Workflows")

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Loading workflows…")

    try {
      const params = new URLSearchParams({ per_page: String(args.limit) })
      const res = await irisFetch(`/api/v1/users/${userId}/bloqs/workflows?${params}`)
      const ok = await handleApiError(res, "List workflows")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const raw = await res.json()
      const workflows: any[] = Array.isArray(raw) ? raw : (raw as any)?.data ?? []
      spinner.stop(`${workflows.length} workflow(s)`)

      if (workflows.length === 0) {
        prompts.log.warn("No workflows found")
        prompts.outro("Done")
        return
      }

      printDivider()
      for (const w of workflows) {
        printWorkflow(w)
        console.log()
      }
      printDivider()

      prompts.outro(
        `${dim("iris workflows run <id> --query \"...\"")}  Execute a workflow`,
      )
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const WorkflowsRunCommand = cmd({
  command: "run <id>",
  describe: "execute a workflow",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "workflow ID", type: "number", demandOption: true })
      .option("query", { alias: "q", describe: "input query for the workflow", type: "string" })
      .option("wait", { describe: "wait for completion", type: "boolean", default: true })
      .option("timeout", { describe: "max seconds to wait", type: "number", default: 300 }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Run Workflow #${args.id}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    let query = args.query
    if (!query) {
      query = (await prompts.text({
        message: "Workflow input (query)",
        placeholder: "e.g. Research top 5 competitors",
      })) as string
      if (prompts.isCancel(query)) query = ""
    }

    const spinner = prompts.spinner()
    spinner.start("Executing workflow…")

    try {
      const payload: Record<string, unknown> = {}
      if (query) payload.query = query

      const res = await irisFetch(`/api/v1/workflows/${args.id}/execute/v6`, {
        method: "POST",
        body: JSON.stringify(payload),
      })
      const ok = await handleApiError(res, "Execute workflow")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const data = (await res.json()) as { data?: any; run_id?: string; id?: string }
      const run = data?.data ?? data
      const runId = String(run?.id ?? run?.run_id ?? "")

      if (!args.wait || !runId) {
        spinner.stop(`Started${runId ? `: run ${dim(runId)}` : ""}`)
        prompts.outro(runId ? dim(`iris workflows status ${runId}`) : "Done")
        return
      }

      spinner.stop(`Run ${dim(runId)}`)
      prompts.log.info("Waiting for completion…")

      const finalRun = await pollRun(runId, args.timeout)
      if (!finalRun) {
        prompts.log.warn(`Timed out. Check: ${dim("iris workflows status " + runId)}`)
        prompts.outro("Done")
        return
      }

      const statusStr = statusColor(String(finalRun.status ?? "unknown"))
      printDivider()
      console.log(`  Status: ${statusStr}`)
      if (finalRun.summary) {
        console.log()
        console.log(`  ${dim("Summary:")} ${String(finalRun.summary).split("\n").join("\n  ")}`)
      }
      console.log()
      printDivider()

      prompts.outro(dim(`iris workflows status ${runId}`))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const WorkflowsStatusCommand = cmd({
  command: "status <run-id>",
  describe: "check workflow run status",
  builder: (yargs) =>
    yargs.positional("run-id", { describe: "run ID", type: "string", demandOption: true }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Run Status: ${args["run-id"]}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Checking…")

    try {
      const res = await irisFetch(`/api/v1/workflows/runs/${args["run-id"]}`)
      const ok = await handleApiError(res, "Get run status")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const data = (await res.json()) as { data?: any }
      const run = data?.data ?? data
      spinner.stop(statusColor(String(run.status ?? "unknown")))

      printDivider()
      printKV("Run ID", run.id)
      printKV("Status", run.status)
      printKV("Iterations", run.iteration_count)
      printKV("Started", run.started_at)
      printKV("Finished", run.finished_at)
      if (run.summary) {
        console.log()
        console.log(`  ${dim("Summary:")}`)
        console.log(`  ${String(run.summary).split("\n").join("\n  ")}`)
      }
      console.log()
      printDivider()

      prompts.outro("Done")
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const WorkflowsRunsCommand = cmd({
  command: "runs",
  describe: "list recent workflow runs",
  builder: (yargs) =>
    yargs.option("limit", { describe: "max results", type: "number", default: 10 }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Recent Workflow Runs")

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Loading runs…")

    try {
      const params = new URLSearchParams({ per_page: String(args.limit) })
      const res = await irisFetch(`/api/v1/users/${userId}/bloqs/workflow-runs?${params}`)
      const ok = await handleApiError(res, "List runs")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const data = (await res.json()) as { data?: any[] }
      const runs: any[] = data?.data ?? []
      spinner.stop(`${runs.length} run(s)`)

      if (runs.length === 0) {
        prompts.log.warn("No workflow runs found")
        prompts.outro("Done")
        return
      }

      printDivider()
      for (const r of runs) {
        printRun(r)
        console.log()
      }
      printDivider()

      prompts.outro(dim("iris workflows status <run-id>"))
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

export const PlatformWorkflowsCommand = cmd({
  command: "workflows",
  describe: "manage and execute IRIS workflows",
  builder: (yargs) =>
    yargs
      .command(WorkflowsListCommand)
      .command(WorkflowsRunCommand)
      .command(WorkflowsStatusCommand)
      .command(WorkflowsRunsCommand)
      .demandCommand(),
  async handler() {},
})
