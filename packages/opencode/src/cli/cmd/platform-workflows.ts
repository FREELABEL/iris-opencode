import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, requireUserId, printDivider, printKV, dim, bold, success, highlight, IRIS_API, FL_API } from "./iris-api"
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
      .option("json", { describe: "JSON output", type: "boolean", default: false })
      .option("include-templates", { describe: "also show campaign templates from hub", type: "boolean", default: false }),
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

      // Optionally merge campaign templates from IRIS_API
      let templates: any[] = []
      if (args["include-templates"]) {
        try {
          const tplRes = await irisFetch(`/api/v1/campaign-templates`, {}, IRIS_API)
          if (tplRes.ok) {
            const tplRaw = (await tplRes.json()) as { templates?: any[] }
            templates = (tplRaw?.templates ?? []).map((t: any) => ({
              id: t.id,
              name: t.label,
              type: t.type,
              description: t.subtitle,
              is_template: true,
            }))
          }
        } catch (_) { /* silently skip template fetch errors */ }
      }

      const all = [...workflows, ...templates]
      spinner.stop(`${workflows.length} workflow(s)${templates.length > 0 ? ` + ${templates.length} template(s)` : ""}`)

      if (args.json) {
        console.log(JSON.stringify(all, null, 2))
        return
      }

      if (all.length === 0) {
        prompts.log.warn("No workflows found")
        prompts.outro("Done")
        return
      }

      printDivider()
      for (const w of all) {
        if (w.is_template) {
          const name = bold(`[T] ${String(w.name ?? w.id)}`)
          const id = dim(String(w.id))
          const type = w.type ? `  ${dim(String(w.type))}` : ""
          console.log(`  ${name}  ${id}${type}`)
          if (w.description) {
            console.log(`    ${dim(String(w.description).slice(0, 100))}`)
          }
        } else {
          printWorkflow(w)
        }
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
      // Bail in non-TTY mode instead of hanging
      if (!process.stdin.isTTY) {
        prompts.log.error("--query is required in non-interactive mode")
        prompts.log.info(dim(`Usage: iris workflows run ${args.id} --query "your input here"`))
        process.exitCode = 1
        prompts.outro("Done")
        return
      }
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
// Hub subcommands (campaign templates from IRIS_API)
// ============================================================================

const WorkflowsHubListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list campaign templates",
  builder: (yargs) =>
    yargs
      .option("category", { describe: "filter by category", type: "string" })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Workflows Hub")

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Loading campaign templates…")

    try {
      const params = new URLSearchParams()
      if (args.category) params.set("category", args.category)
      const qs = params.toString()
      const res = await irisFetch(`/api/v1/campaign-templates${qs ? `?${qs}` : ""}`, {}, IRIS_API)
      const ok = await handleApiError(res, "List templates")
      if (!ok) { spinner.stop("Failed", 1); process.exitCode = 1; prompts.outro("Done"); return }

      const raw = (await res.json()) as { templates?: any[]; grouped?: Record<string, any[]> }
      const templates: any[] = raw?.templates ?? []
      const grouped: Record<string, any[]> = raw?.grouped ?? {}

      spinner.stop(`${templates.length} template(s)`)

      if (args.json) {
        console.log(JSON.stringify(raw, null, 2))
        return
      }

      if (templates.length === 0) {
        prompts.log.warn("No campaign templates found")
        prompts.outro("Done")
        return
      }

      printDivider()

      // Display grouped by category if available, else flat list
      const categories = Object.keys(grouped)
      if (categories.length > 0) {
        for (const cat of categories) {
          console.log(`  ${bold(cat)}`)
          for (const t of grouped[cat]) {
            const label = String(t.label ?? t.id)
            const type = dim(String(t.type ?? ""))
            const script = t.has_script ? `  ${highlight("[script]")}` : ""
            console.log(`    ${label}  ${type}${script}  ${dim(String(t.id))}`)
          }
          console.log()
        }
      } else {
        for (const t of templates) {
          const label = bold(String(t.label ?? t.id))
          const type = dim(String(t.type ?? ""))
          const script = t.has_script ? `  ${highlight("[script]")}` : ""
          console.log(`  ${label}  ${type}${script}  ${dim(String(t.id))}`)
        }
        console.log()
      }

      printDivider()

      prompts.outro(dim("iris workflows hub inspect <template-id>  |  iris workflows hub import <template-id>"))
    } catch (err) {
      spinner.stop("Error", 1)
      process.exitCode = 1
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const WorkflowsHubImportCommand = cmd({
  command: "import <template-id>",
  describe: "import a campaign template as a workflow",
  builder: (yargs) =>
    yargs
      .positional("template-id", { describe: "template ID (UUID)", type: "string", demandOption: true })
      .option("name", { describe: "custom workflow name", type: "string" })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Import Template ${args["template-id"]}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Fetching template…")

    try {
      const res = await irisFetch(`/api/v1/campaign-templates/${args["template-id"]}`, {}, IRIS_API)
      const ok = await handleApiError(res, "Fetch template")
      if (!ok) { spinner.stop("Failed", 1); process.exitCode = 1; prompts.outro("Done"); return }

      const raw = (await res.json()) as { template?: any }
      const template = raw?.template ?? raw

      if (!template || !template.id) {
        spinner.stop("Template not found", 1)
        process.exitCode = 1
        prompts.outro("Done")
        return
      }

      spinner.stop(`Found: ${bold(String(template.label ?? template.id))}`)

      const workflowName = args.name ?? template.label ?? `Imported: ${template.id}`

      const createSpinner = prompts.spinner()
      createSpinner.start("Creating workflow…")

      const payload: Record<string, unknown> = {
        name: workflowName,
        type: "code",
        execution_mode: "fixed",
        script_content: template.script_content ?? "",
        script_language: "node",
        source_template_id: template.id,
        hive_task_type: template.type,
      }

      const createRes = await irisFetch(`/api/v1/users/${userId}/bloqs/workflows`, {
        method: "POST",
        body: JSON.stringify(payload),
      }, FL_API)
      const createOk = await handleApiError(createRes, "Create workflow")
      if (!createOk) { createSpinner.stop("Failed", 1); process.exitCode = 1; prompts.outro("Done"); return }

      const data = (await createRes.json()) as { data?: any }
      const w = data?.data ?? data
      createSpinner.stop(`${success("✓")} Workflow created`)

      printDivider()
      printKV("Workflow ID", w.id)
      printKV("Name", w.name ?? workflowName)
      printKV("Type", "code")
      printKV("Source Template", template.id)
      printKV("Hive Task Type", template.type)
      printDivider()

      prompts.outro(dim(`iris workflows get ${w.id}  |  iris workflows run ${w.id}`))
    } catch (err) {
      spinner.stop("Error", 1)
      process.exitCode = 1
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const WorkflowsHubInspectCommand = cmd({
  command: "inspect <template-id>",
  describe: "view campaign template details",
  builder: (yargs) =>
    yargs
      .positional("template-id", { describe: "template ID (UUID)", type: "string", demandOption: true }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Inspect Template ${args["template-id"]}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Fetching template…")

    try {
      const res = await irisFetch(`/api/v1/campaign-templates/${args["template-id"]}`, {}, IRIS_API)
      const ok = await handleApiError(res, "Fetch template")
      if (!ok) { spinner.stop("Failed", 1); process.exitCode = 1; prompts.outro("Done"); return }

      const raw = (await res.json()) as { template?: any }
      const template = raw?.template ?? raw

      if (!template || !template.id) {
        spinner.stop("Template not found", 1)
        process.exitCode = 1
        prompts.outro("Done")
        return
      }

      spinner.stop(String(template.label ?? template.id))

      printDivider()
      printKV("ID", template.id)
      printKV("Label", template.label)
      printKV("Subtitle", template.subtitle)
      printKV("Category", template.category)
      printKV("Type", template.type)
      printKV("Has Script", template.has_script ? "yes" : "no")

      // Inputs
      const inputs = Array.isArray(template.inputs) ? template.inputs : []
      if (inputs.length > 0) {
        console.log()
        console.log(`  ${bold("Inputs:")}`)
        for (const input of inputs) {
          const name = String(input.name ?? input.key ?? input)
          const type = input.type ? dim(` (${input.type})`) : ""
          const required = input.required ? highlight(" *") : ""
          console.log(`    - ${name}${type}${required}`)
        }
      }

      // Config summary
      if (template.config && typeof template.config === "object") {
        console.log()
        console.log(`  ${bold("Config:")}`)
        const keys = Object.keys(template.config)
        for (const k of keys.slice(0, 10)) {
          const val = typeof template.config[k] === "object" ? JSON.stringify(template.config[k]).slice(0, 80) : String(template.config[k]).slice(0, 80)
          console.log(`    ${dim(k)}: ${val}`)
        }
        if (keys.length > 10) {
          console.log(`    ${dim(`… and ${keys.length - 10} more`)}`)
        }
      }

      // Script preview
      if (template.script_content) {
        console.log()
        console.log(`  ${bold("Script Preview:")}`)
        const lines = String(template.script_content).split("\n").slice(0, 20)
        for (const line of lines) {
          console.log(`    ${dim(line)}`)
        }
        const totalLines = String(template.script_content).split("\n").length
        if (totalLines > 20) {
          console.log(`    ${dim(`… ${totalLines - 20} more lines`)}`)
        }
      }

      console.log()
      printDivider()

      prompts.outro(dim(`iris workflows hub import ${template.id}  — import as workflow`))
    } catch (err) {
      spinner.stop("Error", 1)
      process.exitCode = 1
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

// ============================================================================
// Eval subcommands (workflow test cases & evaluation)
// ============================================================================

function badgeFor(score: number): string {
  if (score >= 90) return "\u{1F947}"
  if (score >= 75) return "\u{1F948}"
  if (score >= 60) return "\u{1F949}"
  return "\u2014"
}

function trendArrow(scores: number[]): string {
  if (scores.length < 2) return dim("(not enough data)")
  const recent = scores.slice(-3)
  const first = recent[0]
  const last = recent[recent.length - 1]
  const diff = last - first
  if (diff > 2) return `${UI.Style.TEXT_SUCCESS}\u2191 improving${UI.Style.TEXT_NORMAL}`
  if (diff < -2) return `${UI.Style.TEXT_DANGER}\u2193 regressing${UI.Style.TEXT_NORMAL}`
  return `${UI.Style.TEXT_INFO}\u2192 stable${UI.Style.TEXT_NORMAL}`
}

function parseAssertion(raw: string): { type: string; value: string | number } {
  const idx = raw.indexOf(":")
  if (idx === -1) return { type: raw, value: "" }
  const type = raw.slice(0, idx)
  const valStr = raw.slice(idx + 1)
  const num = Number(valStr)
  return { type, value: isNaN(num) ? valStr : num }
}

// ============================================================================
// Generate command — AI workflow generation from natural language
// ============================================================================

const WorkflowsGenerateCommand = cmd({
  command: "generate <goal>",
  aliases: ["gen"],
  describe: "generate a workflow from a natural language goal",
  builder: (yargs) =>
    yargs
      .positional("goal", { describe: "natural language description of the workflow", type: "string", demandOption: true })
      .option("name", { describe: "custom workflow name", type: "string" })
      .option("json", { describe: "JSON output", type: "boolean", default: false })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Generate Workflow")

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { prompts.outro("Done"); return }

    const goal = String(args.goal)
    const truncatedGoal = goal.length > 50 ? goal.slice(0, 50) + "…" : goal
    const workflowName = args.name ?? `Generated: ${truncatedGoal}`

    const spinner = prompts.spinner()
    spinner.start(`Generating "${truncatedGoal}"…`)

    try {
      const payload = {
        integration: "workflow-composer",
        function: "generate_workflow",
        args: {
          name: workflowName,
          goal,
        },
        user_id: userId,
      }

      const res = await irisFetch(`/api/v1/users/${userId}/integrations/execute-direct`, {
        method: "POST",
        body: JSON.stringify(payload),
      }, IRIS_API)

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({})) as Record<string, unknown>
        const msg = String(errBody?.message ?? errBody?.error ?? `HTTP ${res.status}`)
        spinner.stop("Failed", 1)
        process.exitCode = 1
        prompts.log.error(msg)
        prompts.outro("Done")
        return
      }

      const data = (await res.json()) as { data?: any; workflow?: any; id?: number; name?: string; steps?: any[] }
      const workflow = data?.data ?? data?.workflow ?? data

      if (args.json) {
        spinner.stop("Done")
        console.log(JSON.stringify(workflow, null, 2))
        prompts.outro("Done")
        return
      }

      const wId = workflow?.id ?? workflow?.workflow_id ?? "—"
      const wName = workflow?.name ?? workflowName
      const steps: any[] = Array.isArray(workflow?.steps) ? workflow.steps
        : Array.isArray(workflow?.content) ? workflow.content
        : []
      const callable = workflow?.callable ?? workflow?.slug ?? null

      spinner.stop(`${success("✓")} Workflow generated`)

      printDivider()
      printKV("ID", wId)
      printKV("Name", wName)
      printKV("Steps", steps.length)

      if (steps.length > 0) {
        for (let i = 0; i < steps.length; i++) {
          const s = steps[i]
          const label = s.integration ?? s.type ?? s.action ?? "step"
          const fn = s.function ?? s.name ?? ""
          console.log(`  ${dim(`${i + 1}.`)} ${label}${fn ? ` — ${fn}` : ""}`)
        }
      }

      if (callable) printKV("Callable", callable)
      printDivider()

      const hints: string[] = []
      if (wId && wId !== "—") {
        hints.push(`${dim(`iris workflows get ${wId}`)}`)
        hints.push(`${dim(`iris workflows run ${wId}`)}`)
      }
      prompts.outro(hints.length > 0 ? hints.join("  |  ") : "Done")
    } catch (err) {
      spinner.stop("Error", 1)
      process.exitCode = 1
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const WorkflowsEvalListCommand = cmd({
  command: "list <workflowId>",
  describe: "list test cases for a workflow",
  builder: (yargs) =>
    yargs
      .positional("workflowId", { describe: "workflow ID", type: "number", demandOption: true })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`\u25C8  Eval Suite \u2014 Workflow #${args.workflowId}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Loading workflow\u2026")

    try {
      const res = await irisFetch(`/api/v1/users/${userId}/bloqs/workflows/${args.workflowId}`)
      const ok = await handleApiError(res, "Get workflow")
      if (!ok) { spinner.stop("Failed", 1); process.exitCode = 1; prompts.outro("Done"); return }

      const data = (await res.json()) as { data?: any }
      const w = data?.data ?? data
      const tests: any[] = w?.settings?.eval_suite?.tests ?? []

      spinner.stop(`${tests.length} test case(s)`)

      if (args.json) {
        console.log(JSON.stringify(tests, null, 2))
        return
      }

      if (tests.length === 0) {
        prompts.log.warn("No test cases defined.")
        prompts.log.info(dim(`Add one: iris workflows eval add ${args.workflowId} --name="My test" --input='{"goal":"..."}' --assert='contains:keyword'`))
        prompts.outro("Done")
        return
      }

      printDivider()
      console.log(`  ${bold("#")}   ${bold("Name")}                              ${bold("Assertions")}   ${bold("Tags")}`)
      console.log()
      for (let i = 0; i < tests.length; i++) {
        const t = tests[i]
        const name = String(t.name ?? `Test ${i + 1}`).slice(0, 34).padEnd(34)
        const assertions = Array.isArray(t.assertions) ? String(t.assertions.length) : "0"
        const tags = Array.isArray(t.tags) ? t.tags.join(", ") : ""
        console.log(`  ${dim(String(i + 1).padStart(2))}  ${name} ${assertions.padStart(5)}        ${dim(tags)}`)
      }
      console.log()
      printDivider()

      prompts.outro(dim(`iris workflows eval add ${args.workflowId} --name="..." --assert='contains:...'`))
    } catch (err) {
      spinner.stop("Error", 1)
      process.exitCode = 1
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const WorkflowsEvalAddCommand = cmd({
  command: "add <workflowId>",
  describe: "add a test case to a workflow eval suite",
  builder: (yargs) =>
    yargs
      .positional("workflowId", { describe: "workflow ID", type: "number", demandOption: true })
      .option("name", { describe: "test case name", type: "string", demandOption: true })
      .option("input", { describe: "JSON input for the test case", type: "string" })
      .option("assert", { describe: "assertion (type:value)", type: "string", array: true })
      .option("tag", { describe: "tag for filtering", type: "string", array: true })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`\u25C8  Add Test Case \u2014 Workflow #${args.workflowId}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Loading workflow\u2026")

    try {
      const res = await irisFetch(`/api/v1/users/${userId}/bloqs/workflows/${args.workflowId}`)
      const ok = await handleApiError(res, "Get workflow")
      if (!ok) { spinner.stop("Failed", 1); process.exitCode = 1; prompts.outro("Done"); return }

      const data = (await res.json()) as { data?: any }
      const w = data?.data ?? data
      const settings = w?.settings ?? {}
      const evalSuite = settings.eval_suite ?? { name: `Eval Suite for Workflow #${args.workflowId}`, tests: [] }
      const tests: any[] = evalSuite.tests ?? []

      // Parse input JSON
      let inputData: Record<string, unknown> = {}
      if (args.input) {
        try {
          inputData = JSON.parse(args.input)
        } catch {
          spinner.stop("Failed", 1)
          process.exitCode = 1
          prompts.log.error("Invalid --input JSON")
          prompts.outro("Done")
          return
        }
      }

      // Parse assertions
      const assertions = (args.assert ?? []).map((a: string) => parseAssertion(a))

      // Build test case
      const testCase: Record<string, unknown> = {
        name: args.name,
        input: inputData,
        assertions,
      }
      if (args.tag && args.tag.length > 0) {
        testCase.tags = args.tag
      }

      tests.push(testCase)
      evalSuite.tests = tests
      settings.eval_suite = evalSuite

      spinner.stop("Saving\u2026")

      const saveSpinner = prompts.spinner()
      saveSpinner.start("Updating workflow\u2026")

      const updateRes = await irisFetch(`/api/v1/users/${userId}/bloqs/workflows/${args.workflowId}`, {
        method: "PUT",
        body: JSON.stringify({ settings }),
      })
      const updateOk = await handleApiError(updateRes, "Update workflow")
      if (!updateOk) { saveSpinner.stop("Failed", 1); process.exitCode = 1; prompts.outro("Done"); return }

      saveSpinner.stop(`${success("\u2713")} Test case added`)

      printDivider()
      printKV("Name", args.name)
      printKV("Input", JSON.stringify(inputData))
      printKV("Assertions", assertions.map((a: any) => `${a.type}:${a.value}`).join(", "))
      if (args.tag) printKV("Tags", args.tag.join(", "))
      printKV("Total tests", tests.length)
      printDivider()

      prompts.outro(dim(`iris workflows eval list ${args.workflowId}`))
    } catch (err) {
      spinner.stop("Error", 1)
      process.exitCode = 1
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const WorkflowsEvalRunCommand = cmd({
  command: "run <workflowId>",
  describe: "view latest eval results for a workflow",
  builder: (yargs) =>
    yargs
      .positional("workflowId", { describe: "workflow ID", type: "number", demandOption: true })
      .option("tag", { describe: "filter by tag", type: "string" })
      .option("json", { describe: "JSON output", type: "boolean", default: false })
      .option("exit-code", { describe: "exit 1 if any test failed", type: "boolean", default: false })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`\u25C8  Eval Run \u2014 Workflow #${args.workflowId}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { prompts.outro("Done"); return }

    // First check that tests exist
    const spinner = prompts.spinner()
    spinner.start("Loading eval suite\u2026")

    try {
      const wRes = await irisFetch(`/api/v1/users/${userId}/bloqs/workflows/${args.workflowId}`)
      const wOk = await handleApiError(wRes, "Get workflow")
      if (!wOk) { spinner.stop("Failed", 1); process.exitCode = 1; prompts.outro("Done"); return }

      const wData = (await wRes.json()) as { data?: any }
      const w = wData?.data ?? wData
      const tests: any[] = w?.settings?.eval_suite?.tests ?? []
      const suiteName = w?.settings?.eval_suite?.name ?? `Eval Suite`

      if (tests.length === 0) {
        spinner.stop("No test cases", 1)
        prompts.log.error(`No test cases defined. Use: ${highlight(`iris workflows eval add ${args.workflowId}`)}`)
        prompts.outro("Done")
        return
      }

      spinner.stop(`${suiteName} (${tests.length} tests)`)

      const evalSpinner = prompts.spinner()
      evalSpinner.start("Fetching latest evaluation\u2026")

      const evalRes = await irisFetch(`/api/v1/workflows/${args.workflowId}/evaluations/latest`)
      if (!evalRes.ok) {
        evalSpinner.stop("No evaluation results yet", 1)
        prompts.log.info(dim("Run the workflow first to generate evaluation results."))
        prompts.outro("Done")
        return
      }

      const evalData = (await evalRes.json()) as { data?: any }
      const evaluation = evalData?.data ?? evalData

      evalSpinner.stop("Results loaded")

      if (args.json) {
        console.log(JSON.stringify(evaluation, null, 2))
        if (args["exit-code"]) {
          const results: any[] = evaluation?.results ?? []
          const anyFailed = results.some((r: any) => r.passed === false || r.status === "failed")
          if (anyFailed) process.exitCode = 1
        }
        return
      }

      const results: any[] = evaluation?.results ?? []
      const score = evaluation?.score ?? 0
      const badge = badgeFor(score)

      printDivider()
      console.log(`  ${bold("Score:")} ${score}%  ${badge}`)
      console.log(`  ${bold("Run ID:")} ${dim(String(evaluation?.id ?? "N/A"))}`)
      console.log(`  ${bold("Date:")} ${dim(String(evaluation?.created_at ?? "N/A"))}`)
      console.log()

      if (results.length > 0) {
        console.log(`  ${bold("#")}   ${bold("Test")}                               ${bold("Status")}`)
        console.log()
        for (let i = 0; i < results.length; i++) {
          const r = results[i]
          const name = String(r.name ?? r.test_name ?? `Test ${i + 1}`).slice(0, 34).padEnd(34)
          const passed = r.passed !== false && r.status !== "failed"
          const status = passed
            ? `${UI.Style.TEXT_SUCCESS}\u2713 pass${UI.Style.TEXT_NORMAL}`
            : `${UI.Style.TEXT_DANGER}\u2717 fail${UI.Style.TEXT_NORMAL}`
          console.log(`  ${dim(String(i + 1).padStart(2))}  ${name} ${status}`)
          if (!passed && r.reason) {
            console.log(`      ${dim(String(r.reason).slice(0, 100))}`)
          }
        }
      }

      console.log()
      printDivider()

      if (args["exit-code"]) {
        const anyFailed = results.some((r: any) => r.passed === false || r.status === "failed")
        if (anyFailed) process.exitCode = 1
      }

      prompts.outro(dim(`iris workflows eval history ${args.workflowId}`))
    } catch (err) {
      spinner.stop("Error", 1)
      process.exitCode = 1
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const WorkflowsEvalHistoryCommand = cmd({
  command: "history <workflowId>",
  describe: "show evaluation score trend",
  builder: (yargs) =>
    yargs
      .positional("workflowId", { describe: "workflow ID", type: "number", demandOption: true })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`\u25C8  Eval History \u2014 Workflow #${args.workflowId}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Loading trend data\u2026")

    try {
      const res = await irisFetch(`/api/v1/workflows/${args.workflowId}/evaluations/trend`)
      const ok = await handleApiError(res, "Get eval trend")
      if (!ok) { spinner.stop("Failed", 1); process.exitCode = 1; prompts.outro("Done"); return }

      const data = (await res.json()) as { data?: any[] }
      const runs: any[] = Array.isArray(data) ? data : (data?.data ?? [])

      spinner.stop(`${runs.length} evaluation(s)`)

      if (args.json) {
        console.log(JSON.stringify(runs, null, 2))
        return
      }

      if (runs.length === 0) {
        prompts.log.warn("No evaluation history yet")
        prompts.outro("Done")
        return
      }

      printDivider()
      console.log(`  ${bold("Run")}   ${bold("Score")}   ${bold("Pass Rate")}   ${bold("Badge")}   ${bold("Date")}`)
      console.log()

      const scores: number[] = []
      for (let i = 0; i < runs.length; i++) {
        const r = runs[i]
        const score = Number(r.score ?? 0)
        scores.push(score)
        const passRate = r.pass_rate != null ? `${r.pass_rate}%` : "\u2014"
        const badge = badgeFor(score)
        const date = r.created_at ? String(r.created_at).slice(0, 16) : "\u2014"
        const runNum = String(r.run_number ?? i + 1).padStart(3)
        console.log(`  ${dim(runNum)}    ${String(score).padStart(3)}%    ${passRate.padStart(7)}       ${badge}     ${dim(date)}`)
      }

      console.log()
      console.log(`  Trend: ${trendArrow(scores)}`)
      console.log()
      printDivider()

      prompts.outro(dim(`iris workflows eval run ${args.workflowId}`))
    } catch (err) {
      spinner.stop("Error", 1)
      process.exitCode = 1
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const WorkflowsEvalCommand = cmd({
  command: "eval",
  describe: "manage and run workflow test cases",
  builder: (yargs) =>
    yargs
      .command(WorkflowsEvalListCommand)
      .command(WorkflowsEvalAddCommand)
      .command(WorkflowsEvalRunCommand)
      .command(WorkflowsEvalHistoryCommand)
      .demandCommand(0)
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" }),
  async handler(args) {
    // Default action: run eval list if workflowId-like arg present, else show help
    const positional = (args._ ?? []) as (string | number)[]
    const maybeId = positional.find((a) => typeof a === "number" || /^\d+$/.test(String(a)))
    if (maybeId) {
      await WorkflowsEvalListCommand.handler({ ...args, workflowId: Number(maybeId) } as any)
    } else {
      prompts.intro("\u25C8  Workflow Eval")
      prompts.log.info("Usage:")
      prompts.log.info(dim("  iris workflows eval list <workflowId>       List test cases"))
      prompts.log.info(dim("  iris workflows eval add <workflowId>        Add a test case"))
      prompts.log.info(dim("  iris workflows eval run <workflowId>        View latest results"))
      prompts.log.info(dim("  iris workflows eval history <workflowId>    Score trend"))
      prompts.outro("Done")
    }
  },
})

const WorkflowsHubCommand = cmd({
  command: "hub",
  describe: "browse and import campaign templates",
  builder: (yargs) =>
    yargs
      .command(WorkflowsHubListCommand)
      .command(WorkflowsHubImportCommand)
      .command(WorkflowsHubInspectCommand)
      .demandCommand(0)
      .option("category", { describe: "filter by category", type: "string" })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    // Default action: run hub list
    await WorkflowsHubListCommand.handler(args as any)
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
      .command(WorkflowsGenerateCommand)
      .command(WorkflowsUpdateCommand)
      .command(WorkflowsPullCommand)
      .command(WorkflowsPushCommand)
      .command(WorkflowsDiffCommand)
      .command(WorkflowsDeleteCommand)
      .command(WorkflowsRunCommand)
      .command(WorkflowsStatusCommand)
      .command(WorkflowsRunsCommand)
      .command(WorkflowsEvalCommand)
      .command(WorkflowsHubCommand)
      .demandCommand(),
  async handler() {},
})
