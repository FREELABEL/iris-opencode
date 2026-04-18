import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, requireUserId, printDivider, printKV, dim, bold, success, highlight } from "./iris-api"
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "fs"
import { join, basename } from "path"

// ============================================================================
// Sync helpers
// ============================================================================

const SYNC_DIR = ".iris/workflows"

function resolveSyncDir(): string {
  let dir = process.cwd()
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, "fl-docker-dev"))) return join(dir, SYNC_DIR)
    const parent = join(dir, "..")
    if (parent === dir) break
    dir = parent
  }
  return join(process.cwd(), SYNC_DIR)
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")
}

function workflowFilename(w: Record<string, unknown>): string {
  return `${w.id}-${slugify(String(w.name ?? "workflow"))}.json`
}

function findLocalFile(dir: string, id: number): string | undefined {
  if (!existsSync(dir)) return undefined
  const prefix = `${id}-`
  const files = require("fs").readdirSync(dir).filter((f: string) => f.startsWith(prefix) && f.endsWith(".json"))
  return files.length > 0 ? join(dir, files[0]) : undefined
}

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
  // Bug #57347: Display run_id (UUID) which is what the status endpoint expects,
  // falling back to id for backward compatibility
  const displayId = r.run_id ?? r.id
  const id = bold(String(displayId))
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

async function pollRun(userId: number, runId: string, timeoutSecs = 300): Promise<any> {
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
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
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
      if (!ok) { spinner.stop("Failed", 1); process.exitCode = 1; prompts.outro("Done"); return }

      const raw = await res.json()
      const workflows: any[] = Array.isArray(raw) ? raw : (raw as any)?.data ?? []
      spinner.stop(`${workflows.length} workflow(s)`)

      if (args.json) {
        console.log(JSON.stringify(workflows, null, 2))
        return
      }

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
      process.exitCode = 1
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
      .option("timeout", { describe: "max seconds to wait", type: "number", default: 300 })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Run Workflow #${args.id}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { prompts.outro("Done"); return }

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
      if (!res.ok) {
        // Bug #57344: Provide actionable guidance when execution_mode doesn't match
        const errBody = await res.json().catch(() => ({})) as Record<string, unknown>
        const msg = String(errBody?.message ?? "")
        if (res.status === 400 && msg.includes("execution_mode")) {
          spinner.stop("Incompatible workflow", 1)
          process.exitCode = 1
          prompts.log.error(`Workflow #${args.id} cannot be executed via this endpoint.`)
          prompts.log.info(dim("This workflow's execution_mode is not 'agentic_v6'."))
          prompts.log.info(dim("Agent-type workflows run through the agent chat system instead."))
          prompts.log.info(dim(`Try: iris agents chat ${args.id} --query "${query ?? "..."}"`))
          prompts.outro("Done")
          return
        }
        spinner.stop("Failed", 1)
        process.exitCode = 1
        prompts.log.error(msg || `HTTP ${res.status}`)
        prompts.outro("Done")
        return
      }

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

      const finalRun = await pollRun(userId, runId, args.timeout)
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
      process.exitCode = 1
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const WorkflowsStatusCommand = cmd({
  command: "status <run-id>",
  describe: "check workflow run status",
  builder: (yargs) =>
    yargs
      .positional("run-id", { describe: "run ID", type: "string", demandOption: true })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Run Status: ${args["run-id"]}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Checking…")

    try {
      const res = await irisFetch(`/api/v1/users/${userId}/bloqs/workflow-runs/${args["run-id"]}`)
      const ok = await handleApiError(res, "Get run status")
      if (!ok) { spinner.stop("Failed", 1); process.exitCode = 1; prompts.outro("Done"); return }

      const data = (await res.json()) as { data?: any }
      const run = data?.data ?? data

      if (!run || !run.id) { spinner.stop("Run not found", 1); process.exitCode = 1; prompts.outro("Done"); return }

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
      process.exitCode = 1
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const WorkflowsRunsCommand = cmd({
  command: "runs",
  describe: "list recent workflow runs",
  builder: (yargs) =>
    yargs
      .option("limit", { describe: "max results", type: "number", default: 10 })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Recent Workflow Runs")

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Loading runs…")

    try {
      const params = new URLSearchParams({ per_page: String(args.limit) })
      const res = await irisFetch(`/api/v1/users/${userId}/bloqs/workflow-runs?${params}`)
      const ok = await handleApiError(res, "List runs")
      if (!ok) { spinner.stop("Failed", 1); process.exitCode = 1; prompts.outro("Done"); return }

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
      process.exitCode = 1
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const WorkflowsGetCommand = cmd({
  command: "get <id>",
  describe: "show workflow details",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "workflow ID", type: "number", demandOption: true })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Workflow #${args.id}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Loading…")

    try {
      const res = await irisFetch(`/api/v1/users/${userId}/bloqs/workflows/${args.id}`)
      const ok = await handleApiError(res, "Get workflow")
      if (!ok) { spinner.stop("Failed", 1); process.exitCode = 1; prompts.outro("Done"); return }

      const data = (await res.json()) as { data?: any }
      const w = data?.data ?? data

      if (!w || !w.id) { spinner.stop("Workflow not found", 1); process.exitCode = 1; prompts.outro("Done"); return }

      spinner.stop(String(w.name ?? `Workflow #${w.id}`))

      printDivider()
      printKV("ID", w.id)
      printKV("Name", w.name)
      printKV("Type", w.type)
      printKV("Description", w.description)
      printKV("Bloq ID", w.bloq_id)
      printKV("Agent ID", w.agent_id)
      printKV("Status", w.status)
      const steps = Array.isArray(w.content) ? w.content : (w.steps ?? [])
      printKV("Steps", Array.isArray(steps) ? steps.length : 0)
      printKV("Created", w.created_at)
      console.log()
      printDivider()

      prompts.outro(dim(`iris workflows pull ${args.id}  |  iris workflows run ${args.id}`))
    } catch (err) {
      spinner.stop("Error", 1)
      process.exitCode = 1
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const WorkflowsCreateCommand = cmd({
  command: "create",
  describe: "create a new workflow (visual, agentic, or code)",
  builder: (yargs) =>
    yargs
      .option("name", { describe: "workflow name", type: "string" })
      .option("description", { describe: "workflow description", type: "string" })
      .option("bloq-id", { describe: "bloq ID", type: "number" })
      .option("type", { describe: "workflow type (standard, code)", type: "string" })
      .option("script", { describe: "path to script file (for code workflows)", type: "string" })
      .option("runtime", { describe: "script runtime: javascript, bash, python (default: javascript)", type: "string", default: "javascript" })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Create Workflow")

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { prompts.outro("Done"); return }

    // If --script is provided, auto-set type to 'code'
    const isCode = args.script || args.type === "code"
    let scriptContent = ""

    if (args.script) {
      const { existsSync, readFileSync } = await import("fs")
      if (!existsSync(args.script)) {
        prompts.log.error(`Script file not found: ${args.script}`)
        prompts.outro("Done")
        return
      }
      scriptContent = readFileSync(args.script, "utf-8")
    }

    let name = args.name
    if (!name) {
      const defaultName = args.script ? args.script.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "code-workflow" : ""
      name = (await prompts.text({
        message: "Workflow name",
        initialValue: defaultName,
        validate: (x) => (x && x.length > 0 ? undefined : "Required"),
      })) as string
      if (prompts.isCancel(name)) { prompts.outro("Cancelled"); return }
    }

    const spinner = prompts.spinner()
    spinner.start("Creating workflow…")

    try {
      const payload: Record<string, unknown> = { name }
      if (args.description) payload.description = args.description
      if (args["bloq-id"]) payload.bloq_id = args["bloq-id"]

      if (isCode) {
        payload.type = "code"
        payload.execution_mode = "code"
        payload.settings = {
          script_content: scriptContent,
          runtime: args.runtime,
        }
      } else if (args.type) {
        payload.type = args.type
      }

      const res = await irisFetch(`/api/v1/users/${userId}/bloqs/workflows`, {
        method: "POST",
        body: JSON.stringify(payload),
      })
      const ok = await handleApiError(res, "Create workflow")
      if (!ok) { spinner.stop("Failed", 1); process.exitCode = 1; prompts.outro("Done"); return }

      const data = (await res.json()) as { data?: any }
      const w = data?.data ?? data
      spinner.stop(`${success("✓")} Workflow created: ${bold(String(w.name ?? w.id))}`)

      printDivider()
      printKV("ID", w.id)
      printKV("Name", w.name)
      printKV("Type", isCode ? "code" : (w.type ?? "standard"))
      if (isCode) {
        printKV("Runtime", args.runtime)
        printKV("Script", `${scriptContent.length} chars`)
      }
      printDivider()

      if (isCode) {
        prompts.log.info(dim(`iris workflows run ${w.id}  — execute on Hive node`))
      }
      prompts.outro(dim(`iris workflows get ${w.id}`))
    } catch (err) {
      spinner.stop("Error", 1)
      process.exitCode = 1
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const WorkflowsUpdateCommand = cmd({
  command: "update <id>",
  describe: "update a workflow",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "workflow ID", type: "number", demandOption: true })
      .option("name", { describe: "new name", type: "string" })
      .option("description", { describe: "new description", type: "string" })
      .option("type", { describe: "new type", type: "string" })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Update Workflow #${args.id}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { prompts.outro("Done"); return }

    const payload: Record<string, unknown> = {}
    if (args.name) payload.name = args.name
    if (args.description) payload.description = args.description
    if (args.type) payload.type = args.type

    if (Object.keys(payload).length === 0) {
      prompts.log.warn("Nothing to update. Use --name, --description, or --type")
      prompts.outro("Done")
      return
    }

    const spinner = prompts.spinner()
    spinner.start("Updating…")

    try {
      const res = await irisFetch(`/api/v1/users/${userId}/bloqs/workflows/${args.id}`, {
        method: "PUT",
        body: JSON.stringify(payload),
      })
      const ok = await handleApiError(res, "Update workflow")
      if (!ok) { spinner.stop("Failed", 1); process.exitCode = 1; prompts.outro("Done"); return }

      const data = (await res.json()) as { data?: any }
      const w = data?.data ?? data
      spinner.stop(`${success("✓")} Updated: ${bold(String(w.name ?? w.id))}`)

      printDivider()
      printKV("ID", w.id)
      printKV("Name", w.name)
      printKV("Type", w.type)
      printDivider()

      prompts.outro(dim(`iris workflows get ${args.id}`))
    } catch (err) {
      spinner.stop("Error", 1)
      process.exitCode = 1
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const WorkflowsPullCommand = cmd({
  command: "pull <id>",
  describe: "download workflow JSON to local file",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "workflow ID", type: "number", demandOption: true })
      .option("output", { alias: "o", describe: "output file path", type: "string" })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Pull Workflow #${args.id}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Fetching workflow…")

    try {
      const res = await irisFetch(`/api/v1/users/${userId}/bloqs/workflows/${args.id}`)
      const ok = await handleApiError(res, "Pull workflow")
      if (!ok) { spinner.stop("Failed", 1); process.exitCode = 1; prompts.outro("Done"); return }

      const data = (await res.json()) as { data?: any }
      const workflow = data?.data ?? data

      const dir = resolveSyncDir()
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

      const filename = args.output ?? workflowFilename(workflow)
      const filepath = filename.startsWith("/") ? filename : join(dir, filename)

      writeFileSync(filepath, JSON.stringify(workflow, null, 2))
      spinner.stop(success("Pulled"))

      const steps = Array.isArray(workflow.content) ? workflow.content : (workflow.steps ?? [])

      printDivider()
      printKV("Name", workflow.name)
      printKV("ID", workflow.id)
      printKV("Type", workflow.type)
      printKV("Steps", Array.isArray(steps) ? steps.length : 0)
      printKV("Saved to", filepath)
      printDivider()

      prompts.outro(dim(`iris workflows push ${args.id}  |  iris workflows diff ${args.id}`))
    } catch (err) {
      spinner.stop("Error", 1)
      process.exitCode = 1
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const WorkflowsPushCommand = cmd({
  command: "push <id>",
  describe: "upload local workflow JSON to API",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "workflow ID", type: "number", demandOption: true })
      .option("file", { alias: "f", describe: "local JSON file path", type: "string" })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Push Workflow #${args.id}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()

    try {
      const dir = resolveSyncDir()
      let filepath = args.file
      if (!filepath) filepath = findLocalFile(dir, args.id)

      if (!filepath || !existsSync(filepath)) {
        spinner.start("")
        spinner.stop("Failed", 1)
        process.exitCode = 1
        prompts.log.error(`Local file not found. Run: ${highlight(`iris workflows pull ${args.id}`)}`)
        prompts.outro("Done")
        return
      }

      spinner.start(`Pushing ${basename(filepath)}…`)

      const workflow = JSON.parse(readFileSync(filepath, "utf-8"))
      const payload: Record<string, unknown> = {
        name: workflow.name,
        description: workflow.description,
        type: workflow.type,
        steps: workflow.content ?? workflow.steps,
        settings: workflow.settings,
      }
      for (const k of Object.keys(payload)) {
        if (payload[k] === undefined) delete payload[k]
      }
      if (workflow.bloq_id) payload.bloq_id = workflow.bloq_id
      if (workflow.agent_id) payload.agent_id = workflow.agent_id

      const res = await irisFetch(`/api/v1/users/${userId}/bloqs/workflows/${args.id}`, {
        method: "PUT",
        body: JSON.stringify(payload),
      })
      const ok = await handleApiError(res, "Push workflow")
      if (!ok) { spinner.stop("Failed", 1); process.exitCode = 1; prompts.outro("Done"); return }

      const data = (await res.json()) as { data?: any }
      const result = data?.data ?? data
      spinner.stop(success("Pushed"))

      printDivider()
      printKV("Name", result.name)
      printKV("ID", args.id)
      printKV("Type", result.type)
      printKV("From", filepath)
      printDivider()

      prompts.outro(dim(`iris workflows diff ${args.id}`))
    } catch (err) {
      spinner.stop("Error", 1)
      process.exitCode = 1
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const WorkflowsDiffCommand = cmd({
  command: "diff <id>",
  describe: "compare local workflow JSON vs live API",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "workflow ID", type: "number", demandOption: true })
      .option("file", { alias: "f", describe: "local JSON file path", type: "string" })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Diff Workflow #${args.id}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Comparing…")

    try {
      const res = await irisFetch(`/api/v1/users/${userId}/bloqs/workflows/${args.id}`)
      const ok = await handleApiError(res, "Fetch workflow")
      if (!ok) { spinner.stop("Failed", 1); process.exitCode = 1; prompts.outro("Done"); return }

      const data = (await res.json()) as { data?: any }
      const live = data?.data ?? data

      const dir = resolveSyncDir()
      let filepath = args.file
      if (!filepath) filepath = findLocalFile(dir, args.id)

      if (!filepath || !existsSync(filepath)) {
        spinner.stop("Failed", 1)
        process.exitCode = 1
        prompts.log.error(`Local file not found. Run: ${highlight(`iris workflows pull ${args.id}`)}`)
        prompts.outro("Done")
        return
      }

      const local = JSON.parse(readFileSync(filepath, "utf-8"))

      // Compare key fields
      const fields = ["name", "description", "type", "bloq_id", "agent_id", "status"]
      const changes: { field: string; live: unknown; local: unknown }[] = []

      for (const f of fields) {
        const liveVal = JSON.stringify(live[f] ?? null)
        const localVal = JSON.stringify(local[f] ?? null)
        if (liveVal !== localVal) {
          changes.push({ field: f, live: live[f], local: local[f] })
        }
      }

      // Compare steps/content
      const liveSteps = Array.isArray(live.content) ? live.content : (live.steps ?? [])
      const localSteps = Array.isArray(local.content) ? local.content : (local.steps ?? [])
      const liveStepsJson = JSON.stringify(liveSteps)
      const localStepsJson = JSON.stringify(localSteps)
      if (liveStepsJson !== localStepsJson) {
        changes.push({
          field: "steps",
          live: `${Array.isArray(liveSteps) ? liveSteps.length : 0} step(s)`,
          local: `${Array.isArray(localSteps) ? localSteps.length : 0} step(s)`,
        })
      }

      // Compare settings
      if (JSON.stringify(live.settings ?? null) !== JSON.stringify(local.settings ?? null)) {
        changes.push({ field: "settings", live: "(object changed)", local: "(object changed)" })
      }

      spinner.stop(changes.length === 0 ? success("In sync") : `${changes.length} difference(s)`)

      printDivider()
      printKV("Workflow", live.name ?? `#${args.id}`)
      printKV("Type", live.type)
      console.log()

      if (changes.length === 0) {
        console.log(`  ${success("No differences")}`)
      } else {
        for (const c of changes) {
          console.log(`  ${UI.Style.TEXT_WARNING}~ ${c.field}${UI.Style.TEXT_NORMAL}`)
          console.log(`    ${UI.Style.TEXT_DANGER}- live:  ${String(c.live ?? "(empty)").slice(0, 120)}${UI.Style.TEXT_NORMAL}`)
          console.log(`    ${UI.Style.TEXT_SUCCESS}+ local: ${String(c.local ?? "(empty)").slice(0, 120)}${UI.Style.TEXT_NORMAL}`)
        }
      }
      console.log()
      printDivider()

      if (changes.length > 0) {
        prompts.outro(dim(`iris workflows push ${args.id}  — to push local changes live`))
      } else {
        prompts.outro("Done")
      }
    } catch (err) {
      spinner.stop("Error", 1)
      process.exitCode = 1
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const WorkflowsDeleteCommand = cmd({
  command: "delete <id>",
  describe: "delete a workflow",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "workflow ID", type: "number", demandOption: true })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Delete Workflow #${args.id}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { prompts.outro("Done"); return }

    const confirmed = await prompts.confirm({ message: `Delete workflow #${args.id}? This cannot be undone.` })
    if (!confirmed || prompts.isCancel(confirmed)) { prompts.outro("Cancelled"); return }

    const spinner = prompts.spinner()
    spinner.start("Deleting…")

    try {
      const res = await irisFetch(`/api/v1/users/${userId}/bloqs/workflows/${args.id}`, {
        method: "DELETE",
      })
      const ok = await handleApiError(res, "Delete workflow")
      if (!ok) { spinner.stop("Failed", 1); process.exitCode = 1; prompts.outro("Done"); return }

      spinner.stop(`${success("✓")} Workflow #${args.id} deleted`)
      prompts.outro(dim("iris workflows list"))
    } catch (err) {
      spinner.stop("Error", 1)
      process.exitCode = 1
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
  describe: "manage and execute IRIS workflows — pull, push, diff, CRUD",
  builder: (yargs) =>
    yargs
      .command(WorkflowsListCommand)
      .command(WorkflowsGetCommand)
      .command(WorkflowsCreateCommand)
      .command(WorkflowsUpdateCommand)
      .command(WorkflowsPullCommand)
      .command(WorkflowsPushCommand)
      .command(WorkflowsDiffCommand)
      .command(WorkflowsDeleteCommand)
      .command(WorkflowsRunCommand)
      .command(WorkflowsStatusCommand)
      .command(WorkflowsRunsCommand)
      .demandCommand(),
  async handler() {},
})
