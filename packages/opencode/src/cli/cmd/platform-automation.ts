import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import {
  irisFetch,
  requireAuth,
  requireUserId,
  printDivider,
  printKV,
  dim,
  bold,
  success,
  highlight,
  isNonInteractive,
} from "./iris-api"

// ============================================================================
// Endpoint constants — mirror PHP AutomationsResource paths exactly so the
// behavior is byte-compatible with what V6 backend expects.
// ============================================================================
//
//   create:  POST   /api/v1/workflows/templates
//   execute: POST   /api/v1/workflows/{id}/execute/v6
//   status:  GET    /api/v1/workflows/runs/{runId}
//   runs:    GET    /api/v1/workflows/runs?...
//   list:    GET    /api/v1/users/{userId}/workflows?...
//   delete:  DELETE /api/v1/workflows/{id}
//   cancel:  POST   /api/v1/workflows/runs/{runId}/cancel

// ============================================================================
// Helpers
// ============================================================================

function safeJsonParse<T = unknown>(raw: string, label: string): T {
  try {
    return JSON.parse(raw) as T
  } catch (err) {
    throw new Error(`Invalid JSON in --${label}: ${(err as Error).message}`)
  }
}

function statusColor(status?: string): string {
  switch (status) {
    case "completed":
      return UI.Style.TEXT_SUCCESS
    case "running":
      return UI.Style.TEXT_WARNING ?? UI.Style.TEXT_HIGHLIGHT
    case "failed":
      return UI.Style.TEXT_DANGER
    default:
      return UI.Style.TEXT_DIM
  }
}

function colorStatus(status?: string): string {
  return `${statusColor(status)}${status ?? "unknown"}${UI.Style.TEXT_NORMAL}`
}

// ============================================================================
// Subcommands
// ============================================================================

const CreateCommand = cmd({
  command: "create",
  describe: "create a V6 automation (goal-driven workflow)",
  builder: (yargs) =>
    yargs
      .option("name", { describe: "automation name", type: "string" })
      .option("agent-id", { describe: "agent ID", type: "number" })
      .option("goal", { describe: "goal description", type: "string" })
      .option("outcomes", { describe: "outcomes JSON array", type: "string" })
      .option("success-criteria", { describe: "success criteria JSON array", type: "string" })
      .option("max-iterations", { describe: "max ReAct iterations", type: "number", default: 10 })
      .option("description", { describe: "automation description", type: "string" })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    const token = await requireAuth()
    if (!token) return

    // Hard-validate required flags up front so non-TTY callers fail fast
    const missing: string[] = []
    if (!args.name) missing.push("name")
    if (!args["agent-id"]) missing.push("agent-id")
    if (!args.goal) missing.push("goal")
    if (!args.outcomes) missing.push("outcomes")
    if (missing.length > 0) {
      const msg = `Missing required: ${missing.map((m) => "--" + m).join(", ")}`
      if (args.json) console.log(JSON.stringify({ ok: false, error: msg }))
      else {
        prompts.log.error(msg)
        console.log(`  ${dim("Example:")}`)
        console.log(`  ${dim("  iris automation create --name='Email' --agent-id=55 \\")}`)
        console.log(`  ${dim("    --goal='Send email to client' \\")}`)
        console.log(`  ${dim("    --outcomes='[{\"type\":\"email\",\"description\":\"Sent\"}]'")}`)
      }
      process.exitCode = 2
      return
    }

    let outcomes: unknown
    try {
      outcomes = safeJsonParse(args.outcomes as string, "outcomes")
    } catch (err) {
      const msg = (err as Error).message
      if (args.json) console.log(JSON.stringify({ ok: false, error: msg }))
      else prompts.log.error(msg)
      process.exitCode = 1
      return
    }

    let successCriteria: unknown = []
    if (args["success-criteria"]) {
      try {
        successCriteria = safeJsonParse(args["success-criteria"] as string, "success-criteria")
      } catch (err) {
        const msg = (err as Error).message
        if (args.json) console.log(JSON.stringify({ ok: false, error: msg }))
        else prompts.log.error(msg)
        process.exitCode = 1
        return
      }
    }

    if (!args.json) {
      UI.empty()
      prompts.intro("◈  Create V6 Automation")
      printDivider()
      printKV("Name", args.name)
      printKV("Agent ID", args["agent-id"])
      printKV("Goal", args.goal)
      printKV("Outcomes", Array.isArray(outcomes) ? `${(outcomes as unknown[]).length} outcome(s)` : "1")
      printKV("Max iterations", args["max-iterations"])
      printDivider()
    }

    try {
      const userId = await requireUserId()
      if (!userId) { prompts.outro("Done"); return }
      const res = await irisFetch(`/api/v1/users/${userId}/bloqs/workflow-templates`, {
        method: "POST",
        body: JSON.stringify({
          name: args.name,
          agent_id: args["agent-id"],
          goal: args.goal,
          outcomes,
          success_criteria: successCriteria,
          max_iterations: args["max-iterations"],
          description: args.description,
        }),
      })
      if (!res.ok) {
        const text = await res.text()
        if (args.json) console.log(JSON.stringify({ ok: false, status: res.status, error: text.slice(0, 300) }))
        else {
          prompts.log.error(`Failed (HTTP ${res.status})`)
          console.log(`  ${dim(text.slice(0, 300))}`)
          prompts.outro("Done")
        }
        process.exitCode = 1
        return
      }
      const automation = (await res.json()) as any
      if (args.json) {
        console.log(JSON.stringify(automation, null, 2))
        return
      }
      const id = automation?.id ?? automation?.data?.id ?? "N/A"
      console.log(`  ${success("✓")} Automation created`)
      printKV("ID", id)
      prompts.outro(dim(`iris automation execute ${id}`))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (args.json) console.log(JSON.stringify({ ok: false, error: msg }))
      else prompts.log.error(`Failed: ${msg}`)
      process.exitCode = 1
    }
  },
})

const ExecuteCommand = cmd({
  command: "execute <id>",
  aliases: ["run"],
  describe: "execute an automation by ID",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "automation ID", type: "number", demandOption: true })
      .option("inputs", { describe: "execution inputs JSON object", type: "string" })
      .option("wait", { describe: "wait for completion", type: "boolean", default: false })
      .option("interval", { describe: "poll interval seconds (with --wait)", type: "number", default: 2 })
      .option("timeout", { describe: "timeout seconds (with --wait)", type: "number", default: 300 })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    const token = await requireAuth()
    if (!token) return

    const id = args.id as number
    let inputs: unknown = {}
    if (args.inputs) {
      try {
        inputs = safeJsonParse(args.inputs as string, "inputs")
      } catch (err) {
        const msg = (err as Error).message
        if (args.json) console.log(JSON.stringify({ ok: false, error: msg }))
        else prompts.log.error(msg)
        process.exitCode = 1
        return
      }
    }

    if (!args.json) {
      UI.empty()
      prompts.intro(`◈  Execute Automation #${id}`)
    }

    try {
      const res = await irisFetch(`/api/v1/workflows/${id}/execute/v6`, {
        method: "POST",
        body: JSON.stringify({ inputs }),
      })
      if (!res.ok) {
        const text = await res.text()
        if (args.json) console.log(JSON.stringify({ ok: false, status: res.status, error: text.slice(0, 300) }))
        else prompts.log.error(`Failed (HTTP ${res.status}): ${text.slice(0, 200)}`)
        process.exitCode = 1
        return
      }
      const run = (await res.json()) as any
      const runId = run?.run_id ?? run?.data?.run_id

      if (args.json) {
        console.log(JSON.stringify(run, null, 2))
        if (args.wait && runId) {
          await pollUntilDone(String(runId), args.timeout as number, args.interval as number, true)
        }
        return
      }

      console.log(`  ${success("✓")} Execution started`)
      printDivider()
      printKV("Run ID", runId ?? "N/A")
      printKV("Automation", run?.workflow_id ?? "N/A")
      printKV("Status", colorStatus(run?.status))
      printKV("Progress", `${run?.progress ?? 0}%`)
      printDivider()

      if (args.wait && runId) {
        console.log()
        prompts.log.info("Waiting for completion (Ctrl+C to stop)…")
        const final = await pollUntilDone(String(runId), args.timeout as number, args.interval as number, false)
        if (final?.status === "completed") {
          console.log(`  ${success("✓")} Completed`)
          prompts.outro("Done")
        } else {
          prompts.log.error(`Run ${final?.status ?? "did not complete"}`)
          prompts.outro("Done")
          process.exitCode = 1
        }
      } else {
        prompts.outro(dim(`iris automation monitor ${runId}`))
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (args.json) console.log(JSON.stringify({ ok: false, error: msg }))
      else prompts.log.error(`Failed: ${msg}`)
      process.exitCode = 1
    }
  },
})

async function pollUntilDone(
  runId: string,
  timeoutSeconds: number,
  intervalSeconds: number,
  jsonOutput: boolean,
): Promise<any | null> {
  const deadline = Date.now() + timeoutSeconds * 1000
  while (Date.now() < deadline) {
    const res = await irisFetch(`/api/v1/workflows/runs/${runId}`)
    if (!res.ok) {
      throw new Error(`Status fetch failed (HTTP ${res.status})`)
    }
    const status = (await res.json()) as any
    if (jsonOutput) {
      console.log(JSON.stringify(status))
    } else {
      const ts = new Date().toISOString().slice(11, 19)
      console.log(`  ${dim(`[${ts}]`)} ${colorStatus(status?.status)}  ${dim(`progress ${status?.progress ?? 0}%`)}`)
    }
    if (status?.status === "completed" || status?.status === "failed") {
      return status
    }
    await new Promise((r) => setTimeout(r, intervalSeconds * 1000))
  }
  throw new Error(`Timed out after ${timeoutSeconds}s waiting for run ${runId}`)
}

const StatusCommand = cmd({
  command: "status <runId>",
  aliases: ["get"],
  describe: "get automation run status",
  builder: (yargs) =>
    yargs
      .positional("runId", { describe: "run ID", type: "string", demandOption: true })
      .option("detailed", { alias: "d", describe: "show tool result details", type: "boolean", default: false })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    const token = await requireAuth()
    if (!token) return
    const runId = args.runId as string

    try {
      const res = await irisFetch(`/api/v1/workflows/runs/${runId}`)
      if (!res.ok) {
        const text = await res.text()
        if (args.json) console.log(JSON.stringify({ ok: false, status: res.status, error: text.slice(0, 200) }))
        else prompts.log.error(`Failed to get status (HTTP ${res.status})`)
        process.exitCode = 1
        return
      }
      const status = (await res.json()) as any

      if (args.json) {
        console.log(JSON.stringify(status, null, 2))
        return
      }

      UI.empty()
      prompts.intro(`◈  Run ${runId}`)
      printDivider()
      printKV("Status", colorStatus(status.status))
      printKV("Automation", status.workflow_name ?? "N/A")
      printKV("Progress", `${status.progress ?? 0}%`)
      printKV("Started", status.started_at ?? "N/A")
      printKV("Completed", status.completed_at ?? "N/A")
      printDivider()

      const results = status.results
      if (status.status === "completed" && results) {
        console.log()
        console.log(`  ${bold("Results")}`)
        printKV("Iterations", results.iterations)
        printKV("Tools used", (results.tools_used ?? []).join(", "))

        if (results.content) {
          console.log()
          console.log(`  ${bold("Content")}`)
          console.log(`  ${dim(String(results.content).slice(0, 500))}`)
        }

        if (Array.isArray(results.outcomes_delivered)) {
          console.log()
          console.log(`  ${bold("Outcomes Delivered")}`)
          for (const outcome of results.outcomes_delivered) {
            console.log(`  ${success("✓")} ${outcome.description}`)
            if (outcome.data && typeof outcome.data === "object") {
              for (const [k, v] of Object.entries(outcome.data)) {
                console.log(`     ${dim(k + ":")} ${v}`)
              }
            }
          }
        }

        if (args.detailed && Array.isArray(results.tool_results)) {
          console.log()
          console.log(`  ${bold("Tool Results (detailed)")}`)
          results.tool_results.forEach((tr: any, i: number) => {
            console.log(`  ${highlight(`Call #${i + 1}:`)}`)
            console.log(JSON.stringify(tr, null, 2))
          })
        }
      }

      if (status.status === "failed" && status.error) {
        console.log()
        prompts.log.error(String(status.error))
      }

      prompts.outro("Done")
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (args.json) console.log(JSON.stringify({ ok: false, error: msg }))
      else prompts.log.error(`Failed: ${msg}`)
      process.exitCode = 1
    }
  },
})

const MonitorCommand = cmd({
  command: "monitor <runId>",
  aliases: ["watch"],
  describe: "monitor an automation run with live updates",
  builder: (yargs) =>
    yargs
      .positional("runId", { describe: "run ID", type: "string", demandOption: true })
      .option("interval", { describe: "polling interval seconds", type: "number", default: 2 })
      .option("timeout", { describe: "timeout seconds", type: "number", default: 300 })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    const token = await requireAuth()
    if (!token) return
    const runId = args.runId as string

    if (!args.json) {
      UI.empty()
      prompts.intro(`◈  Monitor ${runId}`)
      console.log(`  ${dim("Press Ctrl+C to stop")}`)
      console.log()
    }

    try {
      const final = await pollUntilDone(runId, args.timeout as number, args.interval as number, args.json as boolean)
      if (!args.json) {
        console.log()
        if (final?.status === "completed") {
          console.log(`  ${success("✓")} Completed`)
        } else {
          prompts.log.error(`Run ${final?.status}`)
        }
        prompts.outro("Done")
      }
      if (final?.status !== "completed") process.exitCode = 1
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (args.json) console.log(JSON.stringify({ ok: false, error: msg }))
      else prompts.log.error(msg)
      process.exitCode = 1
    }
  },
})

const ListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list all automations",
  builder: (yargs) =>
    yargs
      .option("agent-id", { describe: "filter by agent ID", type: "number" })
      .option("page", { describe: "page number", type: "number", default: 1 })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    const token = await requireAuth()
    if (!token) return
    const userId = await requireUserId()
    if (!userId) return

    const params = new URLSearchParams()
    if (args["agent-id"]) params.set("agent_id", String(args["agent-id"]))
    if (args.page) params.set("page", String(args.page))
    const qs = params.toString() ? `?${params.toString()}` : ""

    try {
      const res = await irisFetch(`/api/v1/users/${userId}/bloqs/workflow-templates${qs}`)
      if (!res.ok) {
        const text = await res.text()
        if (args.json) console.log(JSON.stringify({ ok: false, status: res.status, error: text.slice(0, 200) }))
        else prompts.log.error(`Failed (HTTP ${res.status})`)
        process.exitCode = 1
        return
      }
      const result = (await res.json()) as any
      if (args.json) {
        console.log(JSON.stringify(result, null, 2))
        return
      }
      const automations = result?.data ?? []
      UI.empty()
      prompts.intro("◈  V6 Automations")
      if (automations.length === 0) {
        prompts.log.warn("No automations found.")
        prompts.outro(dim("Create one: iris automation create --help"))
        return
      }
      printDivider()
      for (const a of automations) {
        const goal = String(a.agent_config?.goal ?? "").slice(0, 80)
        const outcomesCount = (a.agent_config?.outcomes ?? []).length
        console.log(`  ${bold(a.name ?? `#${a.id}`)}  ${dim("#" + a.id)}`)
        console.log(`     ${dim("Agent:")} ${a.agent_id ?? "N/A"}  ${dim("Outcomes:")} ${outcomesCount}`)
        if (goal) console.log(`     ${dim("Goal:")}  ${goal}`)
        console.log()
      }
      printDivider()
      if (result.pagination) {
        const p = result.pagination
        console.log(`  ${dim(`Page ${p.current_page} of ${p.last_page} (${p.total} total)`)}`)
      }
      prompts.outro("Done")
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (args.json) console.log(JSON.stringify({ ok: false, error: msg }))
      else prompts.log.error(`Failed: ${msg}`)
      process.exitCode = 1
    }
  },
})

const RunsCommand = cmd({
  command: "runs",
  aliases: ["history"],
  describe: "list automation runs",
  builder: (yargs) =>
    yargs
      .option("automation-id", { describe: "filter by automation ID", type: "number" })
      .option("status", { describe: "filter by status", choices: ["pending", "running", "completed", "failed"] as const })
      .option("page", { describe: "page number", type: "number", default: 1 })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    const token = await requireAuth()
    if (!token) return

    const params = new URLSearchParams()
    if (args["automation-id"]) params.set("automation_id", String(args["automation-id"]))
    if (args.status) params.set("status", String(args.status))
    if (args.page) params.set("page", String(args.page))
    const qs = params.toString() ? `?${params.toString()}` : ""

    try {
      const res = await irisFetch(`/api/v1/workflows/runs${qs}`)
      if (!res.ok) {
        const text = await res.text()
        if (args.json) console.log(JSON.stringify({ ok: false, status: res.status, error: text.slice(0, 200) }))
        else prompts.log.error(`Failed (HTTP ${res.status})`)
        process.exitCode = 1
        return
      }
      const result = (await res.json()) as any
      if (args.json) {
        console.log(JSON.stringify(result, null, 2))
        return
      }
      const runs = result?.data ?? []
      UI.empty()
      prompts.intro("◈  Automation Runs")
      if (runs.length === 0) {
        prompts.log.warn("No runs found.")
        prompts.outro("Done")
        return
      }
      printDivider()
      for (const r of runs) {
        const shortRun = String(r.run_id ?? "").slice(0, 8)
        console.log(`  ${bold(shortRun)}  ${colorStatus(r.status)}  ${dim(`${r.progress ?? 0}%`)}`)
        console.log(`     ${dim("Workflow:")} ${r.workflow_name ?? "N/A"}`)
        console.log(`     ${dim("Started:")}  ${r.started_at ?? "N/A"}`)
        console.log()
      }
      printDivider()
      if (result.pagination) {
        const p = result.pagination
        console.log(`  ${dim(`Page ${p.current_page} of ${p.last_page} (${p.total} total)`)}`)
      }
      prompts.outro("Done")
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (args.json) console.log(JSON.stringify({ ok: false, error: msg }))
      else prompts.log.error(`Failed: ${msg}`)
      process.exitCode = 1
    }
  },
})

const CancelCommand = cmd({
  command: "cancel <runId>",
  aliases: ["stop"],
  describe: "cancel a running automation",
  builder: (yargs) =>
    yargs
      .positional("runId", { describe: "run ID", type: "string", demandOption: true })
      .option("yes", { alias: "y", describe: "skip confirmation", type: "boolean", default: false })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    const token = await requireAuth()
    if (!token) return

    if (!args.yes) {
      if (isNonInteractive()) {
        const msg = "Refusing to cancel without --yes in non-interactive mode."
        if (args.json) console.log(JSON.stringify({ ok: false, error: msg }))
        else prompts.log.error(msg)
        process.exitCode = 2
        return
      }
      const confirmed = await prompts.confirm({ message: `Cancel automation run ${args.runId}?` })
      if (!confirmed || prompts.isCancel(confirmed)) {
        if (!args.json) prompts.outro("Cancelled")
        return
      }
    }

    try {
      const res = await irisFetch(`/api/v1/workflows/runs/${args.runId}/cancel`, { method: "POST" })
      if (!res.ok) {
        const text = await res.text()
        if (args.json) console.log(JSON.stringify({ ok: false, status: res.status, error: text.slice(0, 200) }))
        else prompts.log.error(`Failed (HTTP ${res.status})`)
        process.exitCode = 1
        return
      }
      if (args.json) console.log(JSON.stringify({ ok: true }))
      else console.log(`  ${success("✓")} Cancelled run ${args.runId}`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (args.json) console.log(JSON.stringify({ ok: false, error: msg }))
      else prompts.log.error(`Failed: ${msg}`)
      process.exitCode = 1
    }
  },
})

const DeleteCommand = cmd({
  command: "delete <id>",
  aliases: ["rm"],
  describe: "delete an automation",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "automation ID", type: "number", demandOption: true })
      .option("yes", { alias: "y", describe: "skip confirmation", type: "boolean", default: false })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    const token = await requireAuth()
    if (!token) return

    if (!args.yes) {
      if (isNonInteractive()) {
        const msg = "Refusing to delete without --yes in non-interactive mode."
        if (args.json) console.log(JSON.stringify({ ok: false, error: msg }))
        else prompts.log.error(msg)
        process.exitCode = 2
        return
      }
      const confirmed = await prompts.confirm({ message: `Delete automation #${args.id}? This cannot be undone.` })
      if (!confirmed || prompts.isCancel(confirmed)) {
        if (!args.json) prompts.outro("Cancelled")
        return
      }
    }

    try {
      const res = await irisFetch(`/api/v1/workflows/${args.id}`, { method: "DELETE" })
      if (!res.ok && res.status !== 204) {
        const text = await res.text()
        if (args.json) console.log(JSON.stringify({ ok: false, status: res.status, error: text.slice(0, 200) }))
        else prompts.log.error(`Failed (HTTP ${res.status})`)
        process.exitCode = 1
        return
      }
      if (args.json) console.log(JSON.stringify({ ok: true }))
      else console.log(`  ${success("✓")} Automation #${args.id} deleted`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (args.json) console.log(JSON.stringify({ ok: false, error: msg }))
      else prompts.log.error(`Failed: ${msg}`)
      process.exitCode = 1
    }
  },
})

// ============================================================================
// Root command
// ============================================================================

export const PlatformAutomationCommand = cmd({
  command: "automation",
  aliases: ["automations"],
  describe: "manage V6 Automations (goal-driven workflows)",
  builder: (yargs) =>
    yargs
      .command(CreateCommand)
      .command(ExecuteCommand)
      .command(StatusCommand)
      .command(MonitorCommand)
      .command(ListCommand)
      .command(RunsCommand)
      .command(CancelCommand)
      .command(DeleteCommand)
      .demandCommand(1),
  async handler() {},
})
