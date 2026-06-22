import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, IRIS_API, requireAuth, requireUserId, handleApiError, printDivider, printKV, dim, bold, success } from "./iris-api"

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

// ── agent (unified dossier) ──
//
// Composes a single-agent dossier from the WORKING data layer (agent config +
// owned schedules + per-schedule executions on fl-api) instead of the dead
// /api/v6/agents/{id}/heartbeat-status endpoint (404, bug #146507). This is the
// keystone "unified agent dossier" — identity + context/tools + owned schedules
// + dormancy flags + run history + token burn, all reconciled in one view.

function ago(dateStr: string | null | undefined): string {
  if (!dateStr) return ""
  const t = new Date(String(dateStr)).getTime()
  if (isNaN(t)) return ""
  const diff = Date.now() - t
  if (diff < 0) return "just now"
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`
  if (diff < 3600_000) return `${Math.round(diff / 60_000)}m ago`
  if (diff < 86400_000) return `${Math.round(diff / 3600_000)}h ago`
  return `${Math.round(diff / 86400_000)}d ago`
}

// Positive number = overdue by that many ms (next_run_at in the past)
function overdueMs(nextRunAt: string | null | undefined): number {
  if (!nextRunAt) return 0
  const t = new Date(String(nextRunAt)).getTime()
  if (isNaN(t)) return 0
  const diff = Date.now() - t
  return diff > 0 ? diff : 0
}

function humanDur(ms: number): string {
  if (ms <= 0) return ""
  const h = Math.floor(ms / 3600_000)
  if (h >= 24) return `${Math.floor(h / 24)}d`
  if (h >= 1) return `${h}h`
  return `${Math.floor(ms / 60_000)}m`
}

const AgentCmd = cmd({
  command: "agent <id>",
  aliases: ["inspect", "dossier"],
  describe: "unified dossier for one agent — config, owned schedules, run history, dormancy",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "agent ID", type: "number", demandOption: true })
      .option("limit", { describe: "run-history rows to show", type: "number", default: 20 })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" })
      .option("json", { describe: "JSON output", type: "boolean" }),
  async handler(args) {
    if (!(await requireAuth())) return
    const userId = await requireUserId(args["user-id"])
    if (!userId) return

    const agentId = args.id

    // 1. Agent identity + context (config endpoint — works)
    let agent: any = null
    try {
      const aRes = await irisFetch(`/api/v1/users/${userId}/bloqs/agents/${agentId}`)
      if (aRes.ok) { const j = await getJson(aRes); agent = j?.data ?? j }
    } catch {}

    // 2. Schedules owned by this agent (works)
    let schedules: any[] = []
    try {
      const sRes = await irisFetch(`/api/v1/users/${userId}/bloqs/scheduled-jobs?agent_id=${agentId}&per_page=200`)
      if (!(await handleApiError(sRes, "Agent schedules"))) return
      const j = await getJson(sRes)
      schedules = j?.data ?? []
    } catch {}

    // 3. Executions per schedule (works) — gather for history + aggregates
    const execsBySchedule: Record<number, any[]> = {}
    await Promise.all(schedules.map(async (s: any) => {
      try {
        const eRes = await irisFetch(`/api/v1/users/${userId}/bloqs/scheduled-jobs/${s.id}/executions?per_page=10`)
        if (eRes.ok) { const j = await getJson(eRes); execsBySchedule[s.id] = j?.data ?? [] }
      } catch {}
    }))

    // Aggregate run history across all schedules
    const allExecs = Object.entries(execsBySchedule).flatMap(([sid, execs]) =>
      (execs ?? []).map((e: any) => ({ ...e, schedule_id: Number(sid) })))
    allExecs.sort((a, b) => new Date(String(b.completed_at ?? b.created_at ?? 0)).getTime()
      - new Date(String(a.completed_at ?? a.created_at ?? 0)).getTime())

    const totals = {
      runs: allExecs.length,
      completed: allExecs.filter((e) => e.status === "completed").length,
      failed: allExecs.filter((e) => e.status === "failed").length,
      tokens: allExecs.reduce((sum, e) => sum + (Number(e.tokens_used) || 0), 0),
    }

    // Dormancy: scheduled jobs whose next_run_at is in the past
    const dormant = schedules
      .map((s: any) => ({ s, over: overdueMs(s.next_run_at) }))
      .filter((x) => x.over > 0 && ["scheduled", "active", "enabled"].includes(String(x.s.status ?? "").toLowerCase()))
      .sort((a, b) => b.over - a.over)

    if (args.json) {
      console.log(JSON.stringify({
        agent: agent ? { id: agent.id, name: agent.name, model: agent.model ?? agent.settings?.model,
          heartbeat_mode: agent.heartbeat_mode, tools: agent.settings?.tools ?? agent.capabilities,
          integrations: agent.settings?.integrations } : { id: agentId },
        schedules: schedules.map((s: any) => ({ id: s.id, status: s.status, frequency: s.frequency,
          next_run_at: s.next_run_at, overdue_ms: overdueMs(s.next_run_at) })),
        totals,
        dormant: dormant.map((d) => ({ id: d.s.id, overdue: humanDur(d.over) })),
        history: allExecs.slice(0, args.limit),
      }, null, 2))
      return
    }

    // ── Identity ──
    console.log("")
    const hb = agent?.heartbeat_mode && agent.heartbeat_mode !== "off"
      ? `${UI.Style.TEXT_SUCCESS}${agent.heartbeat_mode} heartbeat${UI.Style.TEXT_NORMAL}` : dim("no heartbeat")
    console.log(bold(`Agent #${agentId}: ${agent?.name ?? "Unknown"}`) + `  ${hb}`)
    printDivider()
    if (agent) {
      printKV("Model", agent.model ?? agent.settings?.model ?? "-")
      printKV("Heartbeat freq", agent.settings?.heartbeat_frequency ?? agent.settings?.frequency ?? "-")
      const tools = agent.settings?.tools ?? agent.capabilities ?? agent.settings?.capabilities
      const toolList = Array.isArray(tools) ? tools : tools ? Object.keys(tools) : []
      if (toolList.length) printKV("Tools", toolList.slice(0, 12).join(", ") + (toolList.length > 12 ? ` +${toolList.length - 12}` : ""))
      const integrations = agent.settings?.integrations ?? []
      if (Array.isArray(integrations) && integrations.length) printKV("Integrations", integrations.join(", "))
    } else {
      console.log(`  ${dim("(agent config unavailable)")}`)
    }

    // ── Owned schedules ──
    console.log("")
    const stuck = schedules.filter((s: any) => {
      const st = String(s.status ?? "").toLowerCase()
      const freq = String(s.frequency ?? "").toLowerCase()
      const age = s.created_at ? Date.now() - new Date(String(s.created_at)).getTime() : 0
      return st === "running" && freq === "once" && age > 3600_000
    }).length
    const sched_summary = `${schedules.length} total · ${dormant.length} overdue · ${stuck} stuck`
    console.log(bold("Owned Schedules") + `  ${dim(sched_summary)}`)
    printDivider()
    if (schedules.length === 0) {
      console.log(`  ${dim("none")}`)
    } else {
      for (const s of schedules) {
        const over = overdueMs(s.next_run_at)
        const badge = over > 0 && ["scheduled", "active", "enabled"].includes(String(s.status ?? "").toLowerCase())
          ? `${UI.Style.TEXT_DANGER}⚠ overdue ${humanDur(over)}${UI.Style.TEXT_NORMAL}`
          : formatStatus(String(s.status ?? "-").toLowerCase())
        const name = String(s.data?.agent_name ?? s.name ?? s.title ?? s.task_name ?? "").slice(0, 44)
        const freq = String(s.frequency ?? "").replace(/_/g, " ")
        console.log(`  ${dim(`#${s.id}`)}  ${badge.padEnd(20)}  ${dim(freq.padEnd(10))}  ${bold(name)}`)
        const last = (execsBySchedule[s.id] ?? [])[0]
        if (last) {
          const ls = last.status === "completed" ? `${UI.Style.TEXT_SUCCESS}✓${UI.Style.TEXT_NORMAL}`
            : last.status === "failed" ? `${UI.Style.TEXT_DANGER}✗${UI.Style.TEXT_NORMAL}` : dim(last.status ?? "?")
          const model = last.model_used ? dim(`[${last.model_used}]`) : ""
          const tok = last.tokens_used ? dim(`${Number(last.tokens_used).toLocaleString()} tok`) : ""
          const err = last.error_message ? `${UI.Style.TEXT_DANGER}${String(last.error_message).slice(0, 40)}${UI.Style.TEXT_NORMAL}` : ""
          console.log(`        ${ls} ${dim(ago(last.completed_at ?? last.created_at))}  ${model}  ${tok}  ${err}`)
        }
      }
    }

    // ── Run history (reconciled across all schedules) ──
    if (allExecs.length > 0) {
      console.log("")
      console.log(bold(`Run History`) + `  ${dim(`(last ${Math.min(args.limit, allExecs.length)} across all schedules)`)}`)
      printDivider()
      for (const e of allExecs.slice(0, args.limit)) {
        const st = e.status === "completed" ? `${UI.Style.TEXT_SUCCESS}✓${UI.Style.TEXT_NORMAL}`
          : e.status === "failed" ? `${UI.Style.TEXT_DANGER}✗${UI.Style.TEXT_NORMAL}` : dim(e.status ?? "?")
        const d = e.duration_ms ? `${(e.duration_ms / 1000).toFixed(1)}s` : ""
        const model = e.model_used ? dim(`[${e.model_used}]`) : ""
        const tok = e.tokens_used ? dim(`${Number(e.tokens_used).toLocaleString()} tok`) : ""
        console.log(`  ${st}  ${dim(ago(e.completed_at ?? e.created_at).padEnd(9))}  ${dim(`#${e.schedule_id}`)}  ${model}  ${tok}  ${dim(d)}`)
      }
    }

    // ── Totals + dormancy verdict ──
    console.log("")
    console.log(bold("Totals") + dim(" (recent runs sampled)") + `  ${dim(`runs ${totals.runs} · ok ${totals.completed} · fail ${totals.failed} · ${totals.tokens.toLocaleString()} tok`)}`)
    printDivider()
    if (dormant.length > 0) {
      const worst = humanDur(dormant[0].over)
      console.log(`  ${UI.Style.TEXT_DANGER}⚠ DORMANT${UI.Style.TEXT_NORMAL}  ${dormant.length} schedule(s) overdue — worst ${worst} (#${dormant[0].s.id})`)
    } else if (schedules.length === 0) {
      console.log(`  ${dim("no schedules owned by this agent")}`)
    } else {
      console.log(`  ${success("✓ all schedules on time")}`)
    }
    console.log("")
    console.log(dim(`iris schedules inspect <id>  ·  iris agents update ${agentId}  ·  iris monitor loops`))
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

// ── briefing ──

const BriefingCmd = cmd({
  command: "briefing",
  aliases: ["brief", "morning"],
  describe: "enable or disable morning briefing on an agent or bloq",
  builder: (yargs) =>
    yargs
      .option("agent-id", { describe: "agent ID", type: "number" })
      .option("bloq-id", { describe: "bloq ID (auto-finds agent)", type: "number" })
      .option("time", { describe: "briefing time (HH:MM)", type: "string", default: "08:00" })
      .option("disable", { describe: "disable briefing", type: "boolean" })
      .option("json", { describe: "JSON output", type: "boolean" }),
  async handler(args) {
    if (!(await requireAuth())) return

    let agentId = args.agentId as number | undefined
    let bloqId = args.bloqId as number | undefined

    if (!agentId && !bloqId) {
      const id = await prompts.text({ message: "Agent ID or Bloq ID:" })
      if (prompts.isCancel(id) || !id) { prompts.log.info("Cancelled"); return }
      agentId = parseInt(String(id))
    }

    if (args.disable) {
      const res = await irisFetch("/api/v1/monitor/enable-heartbeat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent_id: agentId, bloq_id: bloqId,
          mode: "off", frequency: "daily"
        })
      }, IRIS_API)
      if (!(await handleApiError(res, "Disable briefing"))) return
      prompts.log.success(`${success("✓")} Briefing disabled`)
      return
    }

    const res = await irisFetch("/api/v1/monitor/enable-heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent_id: agentId,
        bloq_id: bloqId,
        mode: "briefing",
        frequency: "daily",
        briefing_time: args.time
      })
    }, IRIS_API)
    if (!(await handleApiError(res, "Enable briefing"))) return
    const body = await getJson(res)
    const data = body.data ?? body

    if (args.json) { console.log(JSON.stringify(data, null, 2)); return }

    console.log("")
    console.log(bold("Morning Briefing Enabled"))
    printDivider()
    printKV("Agent", `#${data.agent_id ?? agentId} ${data.agent_name ?? ""}`)
    printKV("Mode", "briefing")
    printKV("Time", String(args.time))
    printKV("Frequency", "daily")
    printKV("Data Sources", "Gmail + Calendar (auto-enabled)")
    printDivider()
    console.log(dim("Your briefing will be delivered daily at " + args.time))
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
      .command(BriefingCmd)
      .demandCommand(),
  async handler() {},
})
