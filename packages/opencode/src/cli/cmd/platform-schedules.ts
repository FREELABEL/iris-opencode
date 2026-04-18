import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { irisFetch, requireAuth, requireUserId, handleApiError, printDivider, printKV, dim, bold, success, IRIS_API } from "./iris-api"

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

function timeUntil(dateStr: string | null | undefined): string {
  if (!dateStr) return ""
  const now = Date.now()
  const target = new Date(String(dateStr)).getTime()
  const diff = target - now
  if (isNaN(target)) return ""
  if (diff < 0) return "overdue"
  if (diff < 60_000) return `${Math.round(diff / 1000)}s`
  if (diff < 3600_000) return `${Math.round(diff / 60_000)}m`
  if (diff < 86400_000) return `${Math.round(diff / 3600_000)}h`
  return `${Math.round(diff / 86400_000)}d`
}

function taskLabel(s: Record<string, any>): string {
  const data = s.data ?? {}
  return data.task_type ?? data.type ?? s.task_name ?? ""
}

function executionEnv(s: Record<string, any>): { label: string; icon: string } {
  const data = s.data ?? {}
  const taskName = String(s.task_name ?? "")
  const dataType = String(data.type ?? "")
  const taskType = String(data.task_type ?? "")

  // Hive = dispatched to local daemon on user's machine
  if (dataType === "hive_task_dispatch" || taskName === "hive_task_dispatch"
      || ["discover", "som_batch", "som", "social_stats_sync", "leadgen"].includes(taskType)) {
    return { label: "hive", icon: "⬡" }
  }

  // Heartbeat = runs on iris-api
  if (dataType === "heartbeat" || taskName === "heartbeat") {
    return { label: "iris", icon: "◉" }
  }

  // Agent task = spawned by heartbeat or scheduler, runs on fl-api
  if (dataType === "agent_task") {
    const source = String(data.source ?? data.created_from ?? "")
    if (source.includes("heartbeat")) return { label: "auto", icon: "⟳" }
    return { label: "cloud", icon: "☁" }
  }

  // Listener = event-driven
  if (dataType === "listener") {
    return { label: "hook", icon: "⚡" }
  }

  // Unknown / legacy (no type set)
  return { label: "cloud", icon: "☁" }
}

function printSchedule(s: Record<string, any>, showCountdown = true): void {
  const name = bold(String(s.name ?? s.title ?? s.task_name ?? `Schedule #${s.id}`))
  const id = dim(`#${s.id}`)
  const status = s.status ? `  ${statusColor(String(s.status))}` : ""
  const freq = s.frequency ?? s.cron_expression ?? s.interval
  const freqStr = freq ? `  ${dim(String(freq))}` : ""

  // Task type label
  const tl = taskLabel(s)
  const typeStr = tl ? `  ${dim(`[${tl}]`)}` : ""

  // Countdown to next run
  let countdown = ""
  if (showCountdown && s.next_run_at && s.status === "scheduled") {
    const until = timeUntil(String(s.next_run_at))
    countdown = until ? `  ${UI.Style.TEXT_HIGHLIGHT}⏱ ${until}${UI.Style.TEXT_NORMAL}` : ""
  }

  console.log(`  ${name}  ${id}${status}${freqStr}${typeStr}${countdown}`)

  // Show prompt/description on second line
  const prompt = s.data?.prompt ?? s.prompt ?? s.description ?? ""
  if (prompt) {
    console.log(`    ${dim(String(prompt).slice(0, 100))}`)
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
      .option("limit", { describe: "max results", type: "number", default: 50 })
      .option("active", { describe: "show only active/scheduled/running jobs (hide completed one-offs)", type: "boolean", default: false })
      .option("latest", { describe: "include latest execution result for each job", type: "boolean", default: false })
      .option("agent-id", { describe: "filter by agent ID", type: "number" })
      .option("json", { describe: "JSON output", type: "boolean" })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  IRIS Schedules")

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
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
      let schedules: any[] = data?.data ?? []

      // --active: filter to scheduled/running/paused only (skip completed/cancelled one-offs)
      if (args.active) {
        schedules = schedules.filter((s: any) => {
          const status = String(s.status ?? "").toLowerCase()
          return ["scheduled", "running", "paused", "active", "enabled"].includes(status)
        })
      }

      // Resolve bloq names in one batch
      const bloqIds = [...new Set(schedules.map((s: any) => s.bloq_id).filter(Boolean))]
      const bloqNames: Record<number, string> = {}
      if (bloqIds.length > 0) {
        try {
          const bloqRes = await irisFetch(`/api/v1/users/${userId}/bloqs?ids=${bloqIds.join(",")}`)
          if (bloqRes.ok) {
            const bloqData = (await bloqRes.json()) as any
            for (const b of (bloqData?.data ?? bloqData ?? [])) {
              if (b?.id && b?.name) bloqNames[b.id] = b.name
            }
          }
        } catch {}
      }

      // --latest: fetch last execution for each job (parallel)
      const latestExecs: Record<number, any> = {}
      if (args.latest && schedules.length > 0) {
        const execPromises = schedules.map(async (s: any) => {
          try {
            const execRes = await irisFetch(
              `/api/v1/users/${userId}/bloqs/scheduled-jobs/${s.id}/executions?per_page=1`
            )
            if (execRes.ok) {
              const execData = (await execRes.json()) as any
              const execs = execData?.data ?? []
              if (execs.length > 0) latestExecs[s.id] = execs[0]
            }
          } catch {}
        })
        await Promise.all(execPromises)
      }

      spinner.stop(`${schedules.length} schedule(s)${args.active ? " (active)" : ""}`)

      if (args.json) {
        console.log(JSON.stringify(schedules.map((s: any) => ({
          id: s.id,
          name: s.name ?? s.title ?? s.task_name,
          status: s.status,
          env: executionEnv(s).label,
          bloq_id: s.bloq_id ?? null,
          bloq_name: s.bloq_id ? (bloqNames[s.bloq_id] ?? null) : null,
          frequency: s.frequency,
          task_type: taskLabel(s),
          prompt: s.data?.prompt ?? s.prompt,
          next_run_at: s.next_run_at,
          time_until: timeUntil(s.next_run_at),
          last_run_at: s.last_run_at,
        })), null, 2))
        prompts.outro("Done")
        return
      }

      if (schedules.length === 0) {
        prompts.log.warn(args.active ? "No active schedules. Use without --active to see all." : "No schedules found")
        prompts.outro("Done")
        return
      }

      // Group by execution environment
      const groups: Record<string, { icon: string; label: string; description: string; items: any[] }> = {
        hive: { icon: "⬡", label: "HIVE", description: "local machine", items: [] },
        iris: { icon: "◉", label: "IRIS", description: "cloud heartbeats", items: [] },
        auto: { icon: "⟳", label: "AUTO", description: "spawned by heartbeat", items: [] },
        cloud: { icon: "☁", label: "CLOUD", description: "agent tasks", items: [] },
        hook: { icon: "⚡", label: "HOOKS", description: "event listeners", items: [] },
      }

      for (const s of schedules) {
        const env = executionEnv(s)
        const group = groups[env.label] ?? groups["cloud"]
        group.items.push(s)
      }

      // Render each group
      for (const [, group] of Object.entries(groups)) {
        if (group.items.length === 0) continue

        console.log()
        console.log(`  ${group.icon} ${bold(group.label)} ${dim(`(${group.description})`)}`)
        printDivider()

        for (const s of group.items) {
          const id = dim(`#${s.id}`)
          const status = String(s.status ?? "").toLowerCase()

          // Status badge — detect stuck jobs (running + once + old)
          let badge = ""
          if (status === "running") {
            const freq = String(s.frequency ?? "").toLowerCase()
            const createdAt = s.created_at ? new Date(String(s.created_at)).getTime() : 0
            const age = Date.now() - createdAt
            const isStuck = freq === "once" && age > 3600_000 // once + older than 1 hour
            if (isStuck) {
              badge = `${UI.Style.TEXT_DANGER}⚠ stuck${UI.Style.TEXT_NORMAL}`
            } else {
              badge = `${UI.Style.TEXT_HIGHLIGHT}running${UI.Style.TEXT_NORMAL}`
            }
          } else if (status === "paused") {
            badge = `${UI.Style.TEXT_WARNING}paused${UI.Style.TEXT_NORMAL}`
          } else if (status === "scheduled") {
            const until = timeUntil(s.next_run_at)
            badge = until === "overdue"
              ? `${UI.Style.TEXT_DANGER}⚠ overdue${UI.Style.TEXT_NORMAL}`
              : `${UI.Style.TEXT_HIGHLIGHT}⏱ ${until}${UI.Style.TEXT_NORMAL}`
          } else {
            badge = statusColor(status)
          }

          // Frequency — clean up ugly underscores
          const freq = String(s.frequency ?? "").replace(/_/g, " ")

          // Name — prefer agent name from data, avoid repeating task_name as prompt
          const agentName = s.data?.agent_name ?? ""
          const name = agentName || String(s.name ?? s.title ?? s.task_name ?? "").slice(0, 50)

          // Origin tag — show where this task came from
          const createdFrom = String(s.data?.created_from ?? s.data?.source ?? "")
          const originTag = createdFrom.includes("heartbeat") ? dim(" (via heartbeat)") : ""

          // Description — short, one line, no repeats
          const tl = taskLabel(s)
          const prompt = s.data?.prompt ?? s.prompt ?? ""
          let desc = ""
          if (tl && tl !== name && tl !== s.task_name) desc = tl
          if (prompt && prompt !== name && prompt !== s.task_name && !prompt.startsWith(name)) {
            // Deduplicate — if prompt just repeats task_name multiple times, skip it
            const unique = [...new Set(prompt.split(/[.!?\n]+/).map((s: string) => s.trim()).filter(Boolean))]
            const cleaned = unique.slice(0, 2).join(". ").slice(0, 60)
            if (cleaned && cleaned !== name) {
              desc = desc ? `${desc}: ${cleaned}` : cleaned
            }
          }

          // Bloq context — try eager-loaded relationship first, then batch lookup
          const bloqId = s.bloq_id as number | null
          const bloqName = s.bloq?.name ?? (bloqId ? bloqNames[bloqId] : null)
          const bloqTag = bloqName ? dim(` → ${bloqName}`) : bloqId ? dim(` → bloq #${bloqId}`) : ""

          console.log(`  ${id}  ${badge.padEnd(12)}  ${dim(freq.padEnd(12))}  ${bold(name)}${originTag}`)
          if (bloqTag || desc) {
            const parts = [bloqTag, desc ? dim(desc) : ""].filter(Boolean)
            console.log(`        ${parts.join("  ")}`)
          }

          // Latest execution result
          const exec = latestExecs[s.id]
          if (exec) {
            const execStatus = exec.status === "completed"
              ? `${UI.Style.TEXT_SUCCESS}✓${UI.Style.TEXT_NORMAL}`
              : exec.status === "failed"
              ? `${UI.Style.TEXT_DANGER}✗${UI.Style.TEXT_NORMAL}`
              : dim(exec.status ?? "?")
            const when = exec.completed_at
              ? timeUntil(exec.completed_at) === "overdue" ? dim("just now") : dim(`${timeUntil(exec.completed_at)} ago`)
              : ""
            const model = exec.model_used ? dim(`[${exec.model_used}]`) : ""
            const tokens = exec.tokens_used ? dim(`${Number(exec.tokens_used).toLocaleString()} tok`) : ""
            const preview = String(exec.response_preview ?? exec.response ?? "").replace(/\n/g, " ").slice(0, 70)

            console.log(`        ${execStatus} ${when}  ${model}  ${tokens}`)
            if (preview) console.log(`        ${dim(`"${preview}${preview.length >= 70 ? "…" : ""}"`)}`)
          }
        }
      }

      console.log()
      prompts.outro(
        `${dim("iris schedules get <id>")}  ·  ${dim("iris schedules history <id>")}`,
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
    yargs
      .positional("id", { describe: "schedule ID", type: "number", demandOption: true })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Schedule #${args.id}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
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
    yargs
      .positional("id", { describe: "schedule ID", type: "number", demandOption: true })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Run Schedule #${args.id}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
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
      .option("limit", { describe: "max results", type: "number", default: 10 })
      .option("full", { describe: "show full response (not just preview)", type: "boolean", default: false })
      .option("json", { describe: "JSON output", type: "boolean" })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Schedule History #${args.id}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
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

      if (args.json) {
        console.log(JSON.stringify(runs, null, 2))
        prompts.outro("Done")
        return
      }

      for (const r of runs) {
        const statusBadge = r.status === "completed"
          ? `${UI.Style.TEXT_SUCCESS}✓ completed${UI.Style.TEXT_NORMAL}`
          : r.status === "failed"
          ? `${UI.Style.TEXT_DANGER}✗ failed${UI.Style.TEXT_NORMAL}`
          : statusColor(String(r.status ?? "?"))

        const when = r.completed_at ?? r.started_at ?? r.created_at
        const ago = when ? timeUntil(String(when)) : ""
        const agoStr = ago === "overdue" ? dim("just now") : ago ? dim(`${ago} ago`) : ""

        console.log()
        printDivider()
        console.log(`  ${bold(`Run #${r.id}`)}  ${statusBadge}  ${agoStr}`)

        // Metadata line
        const meta: string[] = []
        if (r.model_used) meta.push(`model: ${r.model_used}`)
        if (r.tokens_used) meta.push(`${Number(r.tokens_used).toLocaleString()} tokens`)
        if (r.started_at && r.completed_at) {
          const dur = Math.round((new Date(r.completed_at).getTime() - new Date(r.started_at).getTime()) / 1000)
          meta.push(`${dur}s`)
        }
        if (r.execution_source) meta.push(r.execution_source)
        if (meta.length) console.log(`  ${dim(meta.join("  ·  "))}`)

        // Tools used
        if (r.functions_executed) {
          try {
            const tools = JSON.parse(r.functions_executed)
            if (Array.isArray(tools) && tools.length > 0) {
              console.log(`  ${dim("tools: " + tools.join(", "))}`)
            }
          } catch {}
        }

        // Error
        if (r.error_message) {
          console.log(`  ${UI.Style.TEXT_DANGER}error: ${String(r.error_message).slice(0, 200)}${UI.Style.TEXT_NORMAL}`)
        }

        // Response
        const response = String(r.response ?? r.response_preview ?? r.summary ?? "")
        if (response) {
          console.log()
          if (args.full) {
            // Full response with word wrap
            const lines = response.split("\n")
            for (const line of lines) {
              console.log(`  ${dim(line)}`)
            }
          } else {
            // Preview (first 3 lines or 200 chars)
            const preview = response.replace(/\n/g, " ").slice(0, 200)
            console.log(`  ${dim(`"${preview}${response.length > 200 ? "…" : ""}"`)}`)
          }
        }
      }
      console.log()
      printDivider()

      if (!args.full) {
        prompts.log.info(dim(`Tip: iris schedules history ${args.id} --full  — show complete responses`))
      }
      prompts.outro("Done")
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

// ============================================================================
// Inspect — show agent config, system prompt, model, tools for a schedule
// ============================================================================

const SchedulesInspectCommand = cmd({
  command: "inspect <id>",
  describe: "show the agent config, system prompt, and tools for a scheduled job",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "schedule ID", type: "number", demandOption: true })
      .option("json", { describe: "JSON output", type: "boolean" })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Inspect Schedule #${args.id}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Loading…")

    try {
      // Fetch all schedules and find the one we want (the individual GET returns only data column)
      const res = await irisFetch(`/api/v1/users/${userId}/bloqs/scheduled-jobs?per_page=200`)
      const ok = await handleApiError(res, "Get schedules")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const allData = (await res.json()) as { data?: any[] }
      const schedule = (allData?.data ?? []).find((s: any) => s.id === args.id)
      if (!schedule) {
        spinner.stop("Not found", 1)
        process.exitCode = 1
        prompts.log.error(`Schedule #${args.id} not found`)
        prompts.outro("Done")
        return
      }

      // Fetch agent details if agent_id exists
      let agent: any = null
      if (schedule.agent_id) {
        try {
          const agentRes = await irisFetch(`/api/v1/users/${userId}/bloqs/agents/${schedule.agent_id}`)
          if (agentRes.ok) {
            const agentData = (await agentRes.json()) as any
            agent = agentData?.data ?? agentData
          }
        } catch {}
      }

      spinner.stop(bold(schedule.task_name ?? `Schedule #${args.id}`))

      if (args.json) {
        console.log(JSON.stringify({ schedule, agent }, null, 2))
        prompts.outro("Done")
        return
      }

      // Schedule info
      printDivider()
      printKV("ID", schedule.id)
      printKV("Status", schedule.status)
      printKV("Frequency", schedule.frequency)
      printKV("Next run", schedule.next_run_at)
      printKV("Bloq", schedule.bloq?.name ?? (schedule.bloq_id ? `#${schedule.bloq_id}` : null))
      printKV("Created", schedule.created_at)
      printDivider()

      // Agent config
      if (agent) {
        console.log()
        console.log(`  ${bold("Agent Config")}`)
        printDivider()
        printKV("Agent ID", agent.id)
        printKV("Name", agent.name)
        printKV("Model", agent.model ?? agent.settings?.model)
        printKV("Heartbeat mode", agent.heartbeat_mode)
        printKV("Heartbeat freq", agent.settings?.heartbeat_frequency ?? agent.settings?.frequency)

        // System prompt
        const systemPrompt = agent.system_prompt ?? agent.instructions ?? agent.settings?.system_prompt
        if (systemPrompt) {
          console.log()
          console.log(`  ${bold("System Prompt")}`)
          printDivider()
          const lines = String(systemPrompt).split("\n").slice(0, 20)
          for (const line of lines) {
            console.log(`  ${dim(line)}`)
          }
          if (String(systemPrompt).split("\n").length > 20) {
            console.log(`  ${dim(`... (${String(systemPrompt).split("\\n").length} total lines)`)}`)
          }
        }

        // Tools / capabilities
        const tools = agent.settings?.tools ?? agent.capabilities ?? agent.settings?.capabilities
        if (tools && (Array.isArray(tools) ? tools.length : Object.keys(tools).length)) {
          console.log()
          console.log(`  ${bold("Tools / Capabilities")}`)
          printDivider()
          const toolList = Array.isArray(tools) ? tools : Object.keys(tools)
          console.log(`  ${dim(toolList.join(", "))}`)
        }

        // Integrations
        const integrations = agent.settings?.integrations ?? []
        if (Array.isArray(integrations) && integrations.length) {
          console.log()
          console.log(`  ${bold("Integrations")}`)
          printDivider()
          console.log(`  ${dim(integrations.join(", "))}`)
        }

        printDivider()
      }

      // Task prompt
      const prompt = schedule.prompt ?? schedule.data?.prompt
      if (prompt) {
        console.log()
        console.log(`  ${bold("Task Prompt")}`)
        printDivider()
        for (const line of String(prompt).split("\n").slice(0, 10)) {
          console.log(`  ${dim(line)}`)
        }
      }

      console.log()
      prompts.log.info(dim(`Edit agent: iris agents update ${schedule.agent_id}`))
      prompts.log.info(dim(`Run history: iris schedules history ${args.id} --full`))
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
      .option("disable", { describe: "disable the schedule", type: "boolean", default: false })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" }),
  async handler(args) {
    UI.empty()
    const action = args.disable ? "Disable" : "Enable"
    prompts.intro(`◈  ${action} Schedule #${args.id}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start(`${action === "Enable" ? "Enabling" : "Disabling"}…`)

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

const SchedulesCreateCommand = cmd({
  command: "create",
  describe: "create a scheduled job (any type: agent, heartbeat, competitor crawl, SEO check, hive)",
  builder: (yargs) =>
    yargs
      .option("type", {
        describe: "job type",
        type: "string",
        choices: ["agent_task", "heartbeat", "competitor_intelligence", "seo_rank_check", "hive_task_dispatch", "custom_script", "code_workflow", "browser_workflow", "agentic_browser"],
        demandOption: true,
      })
      .option("frequency", {
        describe: "run frequency",
        type: "string",
        choices: ["once", "hourly", "every_2_hours", "every_4_hours", "every_6_hours", "every_8_hours", "every_12_hours", "daily", "weekdays", "weekly", "monthly"],
        default: "daily",
      })
      .option("agent", { describe: "agent ID (required — used for scheduling)", type: "number", demandOption: true })
      .option("name", { describe: "job name/task_name", type: "string" })
      .option("prompt", { describe: "task prompt (for agent_task type)", type: "string" })
      .option("time", { describe: "time of day to run (HH:MM, 24h)", type: "string", default: "09:00" })
      .option("timezone", { describe: "timezone", type: "string", default: "America/New_York" })
      .option("max-runs", { describe: "max number of executions (null = unlimited)", type: "number" })
      .option("params", { describe: "JSON params for tool jobs (e.g., sources, keywords, domain)", type: "string" })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Create Schedule: ${args.type}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { prompts.outro("Done"); return }

    // Parse params JSON
    let params: Record<string, unknown> = {}
    if (args.params) {
      try {
        params = JSON.parse(args.params)
      } catch {
        prompts.log.error("Invalid JSON in --params")
        prompts.outro("Done")
        return
      }
    }

    // Build default names based on type
    const typeNames: Record<string, string> = {
      agent_task: "Scheduled Agent Task",
      heartbeat: "Heartbeat",
      competitor_intelligence: "Competitor Intelligence Crawl",
      seo_rank_check: "SEO Rank Check",
      hive_task_dispatch: "Hive Task Dispatch",
      custom_script: "Custom Script",
      code_workflow: "Code Workflow",
      browser_workflow: "Browser Workflow",
      agentic_browser: "AI Browser Agent",
    }
    const taskName = args.name ?? typeNames[args.type] ?? args.type

    // Build default prompts based on type
    const typePrompts: Record<string, string> = {
      agent_task: args.prompt ?? "Execute scheduled task",
      heartbeat: "Run heartbeat check",
      competitor_intelligence: "Crawl competitor sources and ingest into knowledge base",
      seo_rank_check: "Check keyword rankings vs competitors",
      hive_task_dispatch: "Dispatch Hive campaign task",
      custom_script: "Execute custom script on Hive node",
      code_workflow: "Execute code workflow on Hive node",
      browser_workflow: "Execute Playwright browser automation on Hive node",
      agentic_browser: "AI browser agent — give it a goal, it navigates autonomously",
    }
    const prompt = args.prompt ?? typePrompts[args.type] ?? taskName

    const payload: Record<string, unknown> = {
      agent_id: args.agent,
      task_name: taskName,
      prompt,
      time: args.time,
      frequency: args.frequency,
      timezone: args.timezone,
      data: {
        type: args.type,
        params,
        ...params,
      },
    }

    if (args["max-runs"]) {
      payload.max_runs = args["max-runs"]
    }

    const spinner = prompts.spinner()
    spinner.start("Creating schedule…")

    try {
      const res = await irisFetch(`/api/v1/users/${userId}/bloqs/scheduled-jobs`, {
        method: "POST",
        body: JSON.stringify(payload),
      })
      const ok = await handleApiError(res, "Create schedule")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const data = (await res.json()) as { data?: any }
      const job = data?.data ?? data
      spinner.stop(success(`Created #${job.id ?? "?"}`))

      printDivider()
      printKV("ID", job.id)
      printKV("Type", args.type)
      printKV("Name", taskName)
      printKV("Frequency", args.frequency)
      printKV("Time", args.time)
      printKV("Agent", args.agent)
      printKV("Status", job.status ?? "scheduled")
      printKV("Next Run", job.next_run_at ?? "pending")
      if (Object.keys(params).length > 0) {
        printKV("Params", JSON.stringify(params).slice(0, 100))
      }
      printDivider()

      prompts.log.info(dim(`iris schedule list   — view all schedules`))
      prompts.log.info(dim(`iris schedule run ${job.id ?? "<id>"}  — trigger now`))
      prompts.outro(success("Schedule created"))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const SchedulesDeleteCommand = cmd({
  command: "delete <id>",
  aliases: ["rm"],
  describe: "delete a scheduled job",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "schedule ID", type: "number", demandOption: true })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Delete Schedule #${args.id}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Deleting…")

    try {
      const res = await irisFetch(`/api/v1/users/${userId}/bloqs/scheduled-jobs/${args.id}`, {
        method: "DELETE",
      })
      const ok = await handleApiError(res, "Delete schedule")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      spinner.stop(success("Deleted"))
      prompts.outro("Done")
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

// ============================================================================
// Diagnose — test the full execution chain for a scheduled job
// ============================================================================

const SchedulesDiagnoseCommand = cmd({
  command: "diagnose [id]",
  describe: "test the full execution chain — scheduler, dispatch, worker, daemon",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "schedule ID to diagnose (or omit for full system check)", type: "number" })
      .option("user-id", { describe: "user ID", type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Schedule Diagnostics")

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { prompts.outro("Done"); return }

    const checks: { name: string; status: "pass" | "fail" | "warn"; detail: string }[] = []

    const check = (name: string, status: "pass" | "fail" | "warn", detail: string) => {
      checks.push({ name, status, detail })
      const icon = status === "pass" ? `${UI.Style.TEXT_SUCCESS}✓${UI.Style.TEXT_NORMAL}` :
                   status === "fail" ? `${UI.Style.TEXT_DANGER}✗${UI.Style.TEXT_NORMAL}` :
                   `${UI.Style.TEXT_WARNING}⚠${UI.Style.TEXT_NORMAL}`
      console.log(`  ${icon} ${bold(name)}: ${dim(detail)}`)
    }

    console.log()

    // 1. fl-api health (scheduler runs here)
    try {
      const res = await irisFetch("/api/v1/pages?per_page=1")
      check("fl-api", res.ok ? "pass" : "fail", res.ok ? "reachable" : `HTTP ${res.status}`)
    } catch (e) {
      check("fl-api", "fail", `unreachable: ${e instanceof Error ? e.message : String(e)}`)
    }

    // 2. iris-api health (heartbeat executor runs here)
    try {
      const res = await irisFetch("/api/health", {}, IRIS_API)
      if (res.ok) {
        const data = await res.json() as any
        check("iris-api", "pass", `DB: ${data.database ?? "?"}, AI: ${Object.keys(data).filter(k => k.startsWith("ai_")).map(k => `${k.replace("ai_","")}=${(data[k] as any)?.status ?? "?"}`).join(", ") || "not checked"}`)
      } else {
        check("iris-api", "fail", `HTTP ${res.status}`)
      }
    } catch (e) {
      check("iris-api", "fail", `unreachable: ${e instanceof Error ? e.message : String(e)}`)
    }

    // 3. Local daemon (hive tasks execute here)
    try {
      const res = await fetch("http://localhost:3200/health", { signal: AbortSignal.timeout(3000) })
      if (res.ok) {
        const data = await res.json() as any
        const daemon = data.daemon ?? {}
        check("daemon", "pass", `node: ${daemon.node_id?.slice(0, 12) ?? "?"}, status: ${daemon.status ?? "?"}`)
      } else {
        check("daemon", "fail", `HTTP ${res.status}`)
      }
    } catch {
      check("daemon", "fail", "not running on localhost:3200 — run: iris-daemon start")
    }

    // 4. Daemon Pusher connection
    try {
      const res = await fetch("http://localhost:3200/health", { signal: AbortSignal.timeout(3000) })
      if (res.ok) {
        const data = await res.json() as any
        const configRes = await fetch("http://localhost:3200/daemon/queue", { signal: AbortSignal.timeout(3000) })
        if (configRes.ok) {
          const q = await configRes.json() as any
          check("daemon-queue", q.paused ? "warn" : "pass", `active: ${q.active_tasks ?? 0}, paused: ${q.paused ? "YES" : "no"}, capacity: ${q.capacity ?? "?"}`)
        }
      }
    } catch {}

    // 5. Redis (queue backend)
    try {
      const res = await irisFetch("/api/health", {}, IRIS_API)
      if (res.ok) {
        check("redis-queue", "pass", "iris-api is up (Redis is the queue backend)")
      }
    } catch {
      check("redis-queue", "warn", "could not verify")
    }

    // 6. If specific job ID given, check its state
    if (args.id) {
      console.log()
      console.log(`  ${bold("Job #" + args.id)}`)
      printDivider()

      try {
        const res = await irisFetch(`/api/v1/users/${userId}/bloqs/scheduled-jobs?per_page=200`)
        if (res.ok) {
          const all = ((await res.json()) as any)?.data ?? []
          const job = all.find((s: any) => s.id === args.id)
          if (job) {
            const env = executionEnv(job)
            check("job-exists", "pass", `${job.task_name ?? "?"} | ${job.frequency ?? "?"} | ${env.icon} ${env.label}`)
            check("job-status", job.status === "scheduled" ? "pass" : job.status === "running" ? "warn" : "fail",
              `${job.status}${job.status === "running" ? " (may be stuck — check run_count)" : ""}`)

            const nextRun = job.next_run_at ? new Date(job.next_run_at) : null
            if (nextRun) {
              const until = timeUntil(job.next_run_at)
              check("next-run", until === "overdue" ? "warn" : "pass", `${job.next_run_at} (${until})`)
            }

            // Agent check
            if (job.agent_id) {
              const agent = job.agent
              if (agent) {
                check("agent", "pass", `#${agent.id} ${agent.name} | mode: ${agent.heartbeat_mode} | model: ${agent.config?.model ?? agent.settings?.model ?? "default"}`)
                if (agent.initial_prompt) check("agent-mission", "pass", `${String(agent.initial_prompt).slice(0, 80)}...`)
                else check("agent-mission", "warn", "no initial_prompt set — using generic heartbeat prompt")
                if (agent.settings?.system_prompt) check("agent-identity", "pass", "custom system_prompt set")
                if (agent.settings?.heartbeat_tools) check("agent-tools", "pass", `filtered: ${JSON.stringify(agent.settings.heartbeat_tools)}`)
              }
            }

            // Bloq check
            if (job.bloq) {
              check("bloq", "pass", `#${job.bloq.id} ${job.bloq.name}`)
            } else if (job.bloq_id) {
              check("bloq", "warn", `#${job.bloq_id} (name not loaded)`)
            }

            // Execution check
            try {
              const execRes = await irisFetch(`/api/v1/users/${userId}/bloqs/scheduled-jobs/${args.id}/executions?per_page=1`)
              if (execRes.ok) {
                const execs = ((await execRes.json()) as any)?.data ?? []
                if (execs.length > 0) {
                  const e = execs[0]
                  check("last-execution", e.status === "completed" ? "pass" : "fail",
                    `#${e.id} ${e.status} | ${e.model_used ?? "?"} | ${e.tokens_used ? Number(e.tokens_used).toLocaleString() + " tok" : "?"}`)
                  if (e.error_message) check("last-error", "fail", String(e.error_message).slice(0, 120))
                } else {
                  check("last-execution", "warn", "no executions yet")
                }
              }
            } catch {}
          } else {
            check("job-exists", "fail", `job #${args.id} not found`)
          }
        }
      } catch (e) {
        check("job-lookup", "fail", `${e instanceof Error ? e.message : String(e)}`)
      }
    }

    // Summary
    console.log()
    printDivider()
    const passed = checks.filter(c => c.status === "pass").length
    const failed = checks.filter(c => c.status === "fail").length
    const warned = checks.filter(c => c.status === "warn").length
    console.log(`  ${passed} passed, ${warned} warnings, ${failed} failed`)

    if (failed > 0) {
      console.log()
      console.log(`  ${bold("Fix these:")}`)
      for (const c of checks.filter(c => c.status === "fail")) {
        console.log(`    ${UI.Style.TEXT_DANGER}✗${UI.Style.TEXT_NORMAL} ${c.name}: ${c.detail}`)
      }
    }

    prompts.outro("Done")
  },
})

const SchedulesFrequencyCommand = cmd({
  command: "frequency <agent-id> <freq>",
  aliases: ["freq"],
  describe: "update heartbeat frequency for an agent",
  builder: (yargs) =>
    yargs
      .positional("agent-id", { describe: "agent ID", type: "number", demandOption: true })
      .positional("freq", {
        describe: "frequency",
        type: "string",
        demandOption: true,
        choices: ["every_5_minutes", "every_10_minutes", "every_15_minutes", "every_30_minutes", "hourly", "every_2_hours", "every_4_hours", "every_6_hours", "every_12_hours", "daily", "weekly"],
      }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Set frequency → ${args.freq}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Updating…")

    try {
      const res = await irisFetch(`/api/v1/monitor/enable-heartbeat`, {
        method: "POST",
        body: JSON.stringify({ agent_id: args["agent-id"], frequency: args.freq }),
      }, IRIS_API)

      if (!res.ok) {
        spinner.stop("Failed", 1)
        prompts.log.error(`HTTP ${res.status}`)
        prompts.outro("Done")
        return
      }

      const data = (await res.json()) as any
      spinner.stop(`${success("✓")} ${data?.data?.agent_name ?? `Agent #${args["agent-id"]}`} → ${args.freq}`)
      prompts.outro(dim("iris schedules list --latest"))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

export const PlatformSchedulesCommand = cmd({
  command: "schedules",
  aliases: ["schedule"],
  describe: "manage scheduled jobs — create, list, run, toggle, delete (all job types)",
  builder: (yargs) =>
    yargs
      .command(SchedulesCreateCommand)
      .command(SchedulesListCommand)
      .command(SchedulesGetCommand)
      .command(SchedulesRunCommand)
      .command(SchedulesHistoryCommand)
      .command(SchedulesInspectCommand)
      .command(SchedulesToggleCommand)
      .command(SchedulesDeleteCommand)
      .command(SchedulesDiagnoseCommand)
      .command(SchedulesFrequencyCommand)
      .demandCommand(),
  async handler() {},
})
