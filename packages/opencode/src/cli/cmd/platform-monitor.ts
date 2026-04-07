import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { irisFetch, IRIS_API, requireAuth, handleApiError, printDivider, printKV, dim, bold, success } from "./iris-api"

// ============================================================================
// Platform Monitor — port of MonitorCommand.php
// Uses IRIS_API (iris-api, not fl-api) for heartbeat/monitor endpoints
// Base: /api/v6/agents/heartbeat-status and related monitor endpoints
// ============================================================================

async function getJson(res: Response): Promise<any> { try { return await res.json() } catch { return {} } }

function formatStatus(s: string): string {
  const map: Record<string, string> = {
    completed: `${UI.Style.TEXT_SUCCESS}completed${UI.Style.TEXT_NORMAL}`,
    failed: `${UI.Style.TEXT_DANGER}failed${UI.Style.TEXT_NORMAL}`,
    running: `${UI.Style.TEXT_WARNING}running${UI.Style.TEXT_NORMAL}`,
    scheduled: `${UI.Style.TEXT_INFO}scheduled${UI.Style.TEXT_NORMAL}`,
    paused: `${UI.Style.TEXT_DIM}paused${UI.Style.TEXT_NORMAL}`,
    cancelled: `${UI.Style.TEXT_DIM}cancelled${UI.Style.TEXT_NORMAL}`,
  }
  return map[s] ?? s
}

// ── overview ──

const OverviewCmd = cmd({
  command: "overview",
  aliases: ["status", "dashboard"],
  describe: "platform-wide health dashboard",
  builder: (yargs) =>
    yargs
      .option("hours", { describe: "time window in hours", type: "number", default: 24 })
      .option("json", { describe: "JSON output", type: "boolean" }),
  async handler(args) {
    if (!(await requireAuth())) return
    const res = await irisFetch(`/api/v6/agents/heartbeat-status?hours=${args.hours}`, {}, IRIS_API)
    if (!(await handleApiError(res, "Monitor overview"))) return
    const body = await getJson(res)
    const data = body.data ?? body

    if (args.json) { console.log(JSON.stringify(data, null, 2)); return }

    console.log("")
    console.log(bold(`Platform Monitor (last ${args.hours}h)`))
    printDivider()

    const jobs = data.jobs ?? {}
    const byStatus = jobs.by_status ?? {}
    if (Object.keys(byStatus).length > 0) {
      console.log(bold("Jobs"))
      for (const [s, count] of Object.entries(byStatus)) {
        console.log(`  ${formatStatus(s)}  ${dim(String(count))}`)
      }
      console.log(`  ${bold("Total")}  ${jobs.total ?? "?"}`)
      console.log("")
    }

    const hbAgents = data.heartbeat_agents ?? []
    if (hbAgents.length > 0) {
      console.log(bold("Heartbeat Agents"))
      for (const a of hbAgents) {
        console.log(`  ${dim(`#${a.id}`)}  ${bold(String(a.name ?? "-").slice(0, 30))}  ${dim(a.heartbeat_mode ?? "-")}  ${dim(a.last_heartbeat_at ?? "never")}`)
      }
      console.log("")
    }

    const top = data.top_agents ?? []
    if (top.length > 0) {
      console.log(bold("Top Agents (Token Burn)"))
      for (const a of top.slice(0, 10)) {
        const failed = (a.failed ?? 0) > 0 ? `${UI.Style.TEXT_DANGER}${a.failed}${UI.Style.TEXT_NORMAL}` : "0"
        console.log(`  ${dim(`#${a.agent_id}`)}  ${bold(String(a.name ?? "-").slice(0, 25))}  execs:${a.total_executions ?? 0}  ok:${a.completed ?? 0}  fail:${failed}  tokens:${a.total_tokens ?? 0}`)
      }
      console.log("")
    }

    const alerts = data.alerts ?? []
    if (alerts.length > 0) {
      console.log(bold("Alerts"))
      for (const al of alerts) {
        const sev = al.severity === "critical" ? `${UI.Style.TEXT_DANGER}CRITICAL${UI.Style.TEXT_NORMAL}` :
          al.severity === "warning" ? `${UI.Style.TEXT_WARNING}WARNING${UI.Style.TEXT_NORMAL}` : dim("INFO")
        console.log(`  ${sev}  [${al.type}] ${al.message} (agent #${al.agent_id})`)
      }
    } else {
      console.log(`  ${success("No alerts")}`)
    }
    printDivider()
  },
})

// ── agent ──

const AgentCmd = cmd({
  command: "agent <id>",
  aliases: ["inspect"],
  describe: "deep-dive diagnostics for one agent",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "agent ID", type: "number", demandOption: true })
      .option("hours", { describe: "time window in hours", type: "number", default: 48 })
      .option("json", { describe: "JSON output", type: "boolean" }),
  async handler(args) {
    if (!(await requireAuth())) return
    const res = await irisFetch(`/api/v6/agents/${args.id}/heartbeat-status?hours=${args.hours}`, {}, IRIS_API)
    if (!(await handleApiError(res, "Agent monitor"))) return
    const body = await getJson(res)
    const data = body.data ?? body

    if (args.json) { console.log(JSON.stringify(data, null, 2)); return }

    const agent = data.agent ?? {}
    const stats = data.stats ?? {}
    console.log("")
    console.log(bold(`Agent #${args.id}: ${agent.name ?? "Unknown"}`))
    printDivider()
    printKV("Heartbeat Mode", agent.heartbeat_mode ?? "off")
    printKV("Last Heartbeat", agent.last_heartbeat_at ?? "never")
    console.log("")
    console.log(bold("Stats"))
    printKV("Total Executions", stats.total_executions ?? 0)
    printKV("Completed", stats.completed ?? 0)
    printKV("Failed", stats.failed ?? 0)
    printKV("Total Tokens", stats.total_tokens ?? 0)
    printKV("Active Jobs", stats.active_jobs ?? 0)

    const execs = data.executions ?? []
    if (execs.length > 0) {
      console.log("")
      console.log(bold("Recent Executions"))
      for (const e of execs.slice(0, 15)) {
        const d = e.duration_ms ? `${(e.duration_ms / 1000).toFixed(1)}s` : "-"
        const err = e.error_message ? `${UI.Style.TEXT_DANGER}${String(e.error_message).slice(0, 30)}${UI.Style.TEXT_NORMAL}` : ""
        console.log(`  ${dim(`#${e.id}`)}  ${formatStatus(e.status ?? "-")}  ${e.model_used ?? "-"}  ${e.tokens_used ?? "-"}  ${d}  ${err}`)
      }
    }
    printDivider()
  },
})

// ── loops ──

const LoopsCmd = cmd({
  command: "loops",
  aliases: ["detect"],
  describe: "loop detection — duplicates, rapid-fire, stuck jobs",
  builder: (yargs) =>
    yargs
      .option("hours", { describe: "time window in hours", type: "number", default: 24 })
      .option("json", { describe: "JSON output", type: "boolean" }),
  async handler(args) {
    if (!(await requireAuth())) return
    const res = await irisFetch(`/api/v6/agents/heartbeat-loops?hours=${args.hours}`, {}, IRIS_API)
    if (!(await handleApiError(res, "Loops"))) return
    const body = await getJson(res)
    const data = body.data ?? body

    if (args.json) { console.log(JSON.stringify(data, null, 2)); return }

    console.log("")
    console.log(bold(`Loop Detection (last ${args.hours}h)`))
    printDivider()
    let issues = false

    for (const [label, key] of [
      ["Duplicate Tasks", "duplicate_tasks"],
      ["High Run Count", "high_run_count"],
      ["Rapid-Fire Agents", "rapid_fire_agents"],
      ["Stuck Running", "stuck_running"],
    ] as const) {
      const rows = data[key] ?? []
      if (rows.length > 0) {
        issues = true
        console.log(bold(label))
        for (const r of rows) {
          console.log(`  ${dim(JSON.stringify(r).slice(0, 140))}`)
        }
        console.log("")
      }
    }

    if (!issues) console.log(`  ${success("No loops or anomalies detected")}`)
    printDivider()
  },
})

// ── kill ──

const KillCmd = cmd({
  command: "kill <id>",
  aliases: ["emergency"],
  describe: "emergency kill — disable heartbeat + pause all jobs",
  builder: (yargs) => yargs.positional("id", { describe: "agent ID", type: "number", demandOption: true }),
  async handler(args) {
    if (!(await requireAuth())) return
    const ok = await prompts.confirm({ message: `EMERGENCY KILL: disable heartbeat and pause ALL jobs for agent #${args.id}?` })
    if (!ok || prompts.isCancel(ok)) { prompts.log.info("Cancelled"); return }
    const res = await irisFetch(`/api/v6/agents/${args.id}/heartbeat-kill`, { method: "POST" }, IRIS_API)
    if (!(await handleApiError(res, "Kill agent"))) return
    const body = await getJson(res)
    const data = body.data ?? body
    prompts.log.success(`${success("✓")} Agent #${args.id} killed`)
    printKV("Jobs Paused", data.jobs_paused ?? 0)
    printKV("Tasks Cancelled", data.tasks_cancelled ?? 0)
    printKV("Heartbeat Disabled", data.heartbeat_disabled ? "Yes" : "No")
  },
})

export const PlatformMonitorCommand = cmd({
  command: "monitor",
  aliases: ["health"],
  describe: "platform health monitoring and heartbeat diagnostics",
  builder: (yargs) =>
    yargs
      .command(OverviewCmd)
      .command(AgentCmd)
      .command(LoopsCmd)
      .command(KillCmd)
      .demandCommand(),
  async handler() {},
})
