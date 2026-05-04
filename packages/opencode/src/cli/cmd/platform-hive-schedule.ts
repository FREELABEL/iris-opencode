import { cmd } from "./cmd"
import { irisFetch, requireAuth, requireUserId, dim, bold, success, highlight } from "./iris-api"

// ============================================================================
// iris hive schedule run / list / show / rm / pause / resume
//
// Cloud-side scheduling for hive node tasks. The cloud holds the schedule
// (in node_scheduled_tasks) and dispatches NodeTasks at the appointed time.
// Schedules survive your laptop being offline.
//
// Note: there's an existing `iris hive schedule` for LOCAL daemon scripts
// (talks to BRIDGE_URL). The two namespaces conflict, so this module
// registers `iris hive schedules` (plural) as the cloud-scheduling root.
// ============================================================================

const IRIS_API = process.env.IRIS_API_URL ?? "https://freelabel.net"

async function hiveFetch(path: string, options: RequestInit = {}) {
  return irisFetch(path, options, IRIS_API)
}

interface ScheduledTask {
  id: string
  node_id: string | null
  node?: { id: string; name: string; connection_status: string } | null
  name: string | null
  type: string
  schedule_kind: "cron" | "once"
  cron_expression: string | null
  run_at: string | null
  timezone: string
  next_run_at: string | null
  last_run_at: string | null
  last_dispatched_task_id: string | null
  run_count: number
  failure_count: number
  last_error: string | null
  status: "active" | "paused" | "completed" | "failed"
  priority: number | null
  timeout_seconds: number | null
  prompt?: string
}

function timeUntil(iso: string | null): string {
  if (!iso) return dim("—")
  const ms = new Date(iso).getTime() - Date.now()
  if (ms < 0) return dim("overdue")
  if (ms < 60_000) return `in ${Math.floor(ms / 1000)}s`
  if (ms < 3_600_000) return `in ${Math.floor(ms / 60_000)}m`
  if (ms < 86_400_000) return `in ${Math.floor(ms / 3_600_000)}h`
  return `in ${Math.floor(ms / 86_400_000)}d`
}

function statusBadge(s: string): string {
  if (s === "active") return success("● active")
  if (s === "paused") return dim("◌ paused")
  if (s === "completed") return dim("✓ completed")
  if (s === "failed") return dim("✗ failed")
  return dim(s)
}

// Parse a few simple natural-language --at expressions into ISO 8601.
// Falls back to letting the user pass an ISO string directly.
function parseAt(input: string): string {
  const s = input.trim()
  // ISO timestamp passes through
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return new Date(s).toISOString()
  // "tomorrow 9am", "today 5pm"
  const m = s.match(/^(today|tomorrow)(?:\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?$/i)
  if (m) {
    const day = new Date()
    if (m[1].toLowerCase() === "tomorrow") day.setDate(day.getDate() + 1)
    let hour = m[2] ? parseInt(m[2], 10) : 9
    const min = m[3] ? parseInt(m[3], 10) : 0
    const mer = (m[4] ?? "").toLowerCase()
    if (mer === "pm" && hour < 12) hour += 12
    if (mer === "am" && hour === 12) hour = 0
    day.setHours(hour, min, 0, 0)
    return day.toISOString()
  }
  // "+5m", "+2h", "+1d"
  const rel = s.match(/^\+(\d+)([smhd])$/)
  if (rel) {
    const n = parseInt(rel[1], 10)
    const unit = rel[2]
    const mult = unit === "s" ? 1000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000
    return new Date(Date.now() + n * mult).toISOString()
  }
  // Last resort: trust Date()
  const d = new Date(s)
  if (isNaN(d.getTime())) {
    throw new Error(`Could not parse --at value: "${input}". Try ISO 8601, "+5m", "tomorrow 9am".`)
  }
  return d.toISOString()
}

async function resolveNodeId(userId: number, target: string): Promise<{ id: string; name: string } | null> {
  const res = await hiveFetch(`/api/v6/nodes/?user_id=${userId}`)
  if (!res.ok) return null
  const data = (await res.json()) as { nodes: Array<{ id: string; name: string }> }
  const lower = target.toLowerCase()
  return (
    data.nodes.find((n) => n.id === target) ??
    data.nodes.find((n) => n.name.toLowerCase() === lower) ??
    data.nodes.find((n) => n.id.startsWith(target)) ??
    data.nodes.find((n) => n.name.toLowerCase().startsWith(lower)) ??
    null
  )
}

// ============================================================================
// run — create a scheduled task
// ============================================================================

const HiveSchedulesRunCommand = cmd({
  command: "run <target> <command>",
  describe: "schedule a command to run on a node — cloud holds the schedule",
  builder: (yargs) =>
    yargs
      .positional("target", { describe: "node name or id (or 'auto' for any available node)", type: "string", demandOption: true })
      .positional("command", { describe: "shell command (quote it)", type: "string", demandOption: true })
      .option("cron", { describe: 'cron expression e.g. "0 9 * * *"', type: "string" })
      .option("at", { describe: 'one-time fire — ISO 8601, "tomorrow 9am", or "+5m"', type: "string" })
      .option("name", { describe: "human-readable label", type: "string" })
      .option("timeout", { describe: "task timeout in seconds", type: "number", default: 60 })
      .option("priority", { describe: "task priority 1-10", type: "number" })
      .option("timezone", { describe: "timezone for cron (default UTC)", type: "string" })
      .option("user-id", { describe: "user ID", type: "number" })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(argv) {
    await requireAuth()
    const userId = await requireUserId(argv["user-id"] as number | undefined)
    if (!userId) process.exit(1)

    if (!argv.cron && !argv.at) {
      console.error("Need either --cron or --at")
      process.exit(2)
    }
    if (argv.cron && argv.at) {
      console.error("--cron and --at are mutually exclusive")
      process.exit(2)
    }

    const target = String(argv.target)
    const command = String(argv.command)

    let nodeId: string | null = null
    let nodeName = "auto"
    if (target.toLowerCase() !== "auto") {
      const node = await resolveNodeId(userId, target)
      if (!node) {
        console.error(`No node matching "${target}". Run: iris hive nodes list`)
        process.exit(1)
      }
      nodeId = node.id
      nodeName = node.name
    }

    const script = command.startsWith("#!") ? command : `#!/bin/bash\nset -e\n${command}`

    const body: Record<string, unknown> = {
      user_id: userId,
      name: argv.name ?? `${nodeName}: ${command.slice(0, 60)}`,
      type: "sandbox_execute",
      prompt: script,
      timeout_seconds: Math.max(30, Math.min(3600, Number(argv.timeout) || 60)),
      schedule_kind: argv.cron ? "cron" : "once",
    }
    if (nodeId) body.node_id = nodeId
    if (argv.priority) body.priority = Math.max(1, Math.min(10, Math.round(Number(argv.priority))))
    if (argv.timezone) body.timezone = String(argv.timezone)
    if (argv.cron) body.cron_expression = String(argv.cron)
    if (argv.at) body.run_at = parseAt(String(argv.at))

    const res = await hiveFetch(`/api/v6/nodes/scheduled-tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      console.error(`Schedule create failed: ${res.status} ${await res.text()}`)
      process.exit(1)
    }

    const { scheduled_task: t } = (await res.json()) as { scheduled_task: ScheduledTask }

    if (argv.json) {
      console.log(JSON.stringify(t, null, 2))
      return
    }

    console.log()
    console.log(`${success("✓")} scheduled ${bold(t.name ?? t.id)}`)
    console.log(`  ${dim("id:")}        ${t.id}`)
    console.log(`  ${dim("node:")}      ${t.node?.name ?? dim("auto")}`)
    console.log(`  ${dim("kind:")}      ${t.schedule_kind === "cron" ? `cron (${t.cron_expression})` : `once at ${t.run_at}`}`)
    if (t.next_run_at) console.log(`  ${dim("next:")}      ${t.next_run_at}  (${timeUntil(t.next_run_at)})`)
    console.log()
    console.log(dim(`  See it: iris hive schedules show ${t.id}`))
    console.log(dim(`  Cancel: iris hive schedules rm ${t.id}`))
  },
})

// ============================================================================
// list / ls
// ============================================================================

const HiveSchedulesListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list scheduled hive tasks",
  builder: (yargs) =>
    yargs
      .option("status", { describe: "filter by status", type: "string", choices: ["active", "paused", "completed", "failed"] })
      .option("user-id", { describe: "user ID", type: "number" })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(argv) {
    await requireAuth()
    const userId = await requireUserId(argv["user-id"] as number | undefined)
    if (!userId) process.exit(1)

    const params = new URLSearchParams({ user_id: String(userId) })
    if (argv.status) params.set("status", String(argv.status))
    const res = await hiveFetch(`/api/v6/nodes/scheduled-tasks?${params}`)
    if (!res.ok) {
      console.error(`List failed: ${res.status} ${await res.text()}`)
      process.exit(1)
    }
    const { scheduled_tasks: list } = (await res.json()) as { scheduled_tasks: ScheduledTask[] }

    if (argv.json) {
      console.log(JSON.stringify(list, null, 2))
      return
    }

    if (list.length === 0) {
      console.log(dim("No scheduled tasks."))
      console.log(dim('Create one: iris hive schedules run "<node>" "<cmd>" --cron "0 9 * * *"'))
      return
    }

    console.log()
    console.log(bold("  Status      Node             Schedule              Next run        Name"))
    console.log(dim("  " + "─".repeat(86)))
    for (const t of list) {
      const status = statusBadge(t.status).padEnd(20)
      const node = (t.node?.name ?? dim("auto")).padEnd(16)
      const sched = (t.schedule_kind === "cron" ? `cron ${t.cron_expression}` : `once`).padEnd(20)
      const next = timeUntil(t.next_run_at).padEnd(14)
      const name = t.name ?? dim("(unnamed)")
      console.log(`  ${status} ${node} ${sched} ${next} ${name}`)
      console.log(`    ${dim("id:")} ${t.id}  ${dim("runs:")} ${t.run_count}  ${dim("fails:")} ${t.failure_count}`)
    }
    console.log()
    console.log(dim(`  ${list.length} schedule(s).`))
  },
})

// ============================================================================
// show / rm / pause / resume / run-now
// ============================================================================

const HiveSchedulesShowCommand = cmd({
  command: "show <id>",
  describe: "show schedule details",
  builder: (yargs) =>
    yargs
      .positional("id", { type: "string", demandOption: true })
      .option("user-id", { describe: "user ID", type: "number" })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(argv) {
    await requireAuth()
    const userId = await requireUserId(argv["user-id"] as number | undefined)
    if (!userId) process.exit(1)

    const res = await hiveFetch(`/api/v6/nodes/scheduled-tasks/${argv.id}?user_id=${userId}`)
    if (!res.ok) {
      console.error(`Not found: ${res.status}`)
      process.exit(1)
    }
    const { scheduled_task: t } = (await res.json()) as { scheduled_task: ScheduledTask }

    if (argv.json) {
      console.log(JSON.stringify(t, null, 2))
      return
    }

    console.log()
    console.log(`${bold(t.name ?? t.id)}  ${statusBadge(t.status)}`)
    console.log(`  ${dim("id:")}            ${t.id}`)
    console.log(`  ${dim("node:")}          ${t.node ? t.node.name + " (" + t.node.connection_status + ")" : "auto"}`)
    console.log(`  ${dim("kind:")}          ${t.schedule_kind}`)
    if (t.cron_expression) console.log(`  ${dim("cron:")}          ${t.cron_expression}  (${t.timezone})`)
    if (t.run_at) console.log(`  ${dim("run_at:")}        ${t.run_at}`)
    if (t.next_run_at) console.log(`  ${dim("next:")}          ${t.next_run_at}  (${timeUntil(t.next_run_at)})`)
    if (t.last_run_at) console.log(`  ${dim("last:")}          ${t.last_run_at}`)
    console.log(`  ${dim("runs:")}          ${t.run_count}`)
    console.log(`  ${dim("failures:")}      ${t.failure_count}`)
    if (t.last_error) console.log(`  ${dim("last_error:")}    ${highlight(t.last_error)}`)
    if (t.last_dispatched_task_id) console.log(`  ${dim("last_task:")}     ${t.last_dispatched_task_id}`)
    if (t.prompt) {
      console.log()
      console.log(bold("  prompt:"))
      for (const line of t.prompt.split("\n").slice(0, 20)) console.log(`    ${line}`)
    }
    console.log()
  },
})

const HiveSchedulesRmCommand = cmd({
  command: "rm <id>",
  aliases: ["delete"],
  describe: "delete a schedule",
  builder: (yargs) =>
    yargs
      .positional("id", { type: "string", demandOption: true })
      .option("user-id", { describe: "user ID", type: "number" }),
  async handler(argv) {
    await requireAuth()
    const userId = await requireUserId(argv["user-id"] as number | undefined)
    if (!userId) process.exit(1)
    const res = await hiveFetch(`/api/v6/nodes/scheduled-tasks/${argv.id}?user_id=${userId}`, {
      method: "DELETE",
    })
    if (!res.ok) {
      console.error(`Delete failed: ${res.status}`)
      process.exit(1)
    }
    console.log(`${success("✓")} deleted ${argv.id}`)
  },
})

async function patchStatus(id: string, userId: number, status: "active" | "paused"): Promise<void> {
  const res = await hiveFetch(`/api/v6/nodes/scheduled-tasks/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user_id: userId, status }),
  })
  if (!res.ok) {
    console.error(`Update failed: ${res.status} ${await res.text()}`)
    process.exit(1)
  }
}

const HiveSchedulesPauseCommand = cmd({
  command: "pause <id>",
  describe: "pause a schedule (won't fire until resumed)",
  builder: (yargs) =>
    yargs.positional("id", { type: "string", demandOption: true }).option("user-id", { type: "number" }),
  async handler(argv) {
    await requireAuth()
    const userId = await requireUserId(argv["user-id"] as number | undefined)
    if (!userId) process.exit(1)
    await patchStatus(String(argv.id), userId, "paused")
    console.log(`${success("✓")} paused ${argv.id}`)
  },
})

const HiveSchedulesResumeCommand = cmd({
  command: "resume <id>",
  describe: "resume a paused schedule",
  builder: (yargs) =>
    yargs.positional("id", { type: "string", demandOption: true }).option("user-id", { type: "number" }),
  async handler(argv) {
    await requireAuth()
    const userId = await requireUserId(argv["user-id"] as number | undefined)
    if (!userId) process.exit(1)
    await patchStatus(String(argv.id), userId, "active")
    console.log(`${success("✓")} resumed ${argv.id}`)
  },
})

const HiveSchedulesRunNowCommand = cmd({
  command: "run-now <id>",
  describe: "fire a schedule immediately (in addition to its schedule)",
  builder: (yargs) =>
    yargs.positional("id", { type: "string", demandOption: true }).option("user-id", { type: "number" }),
  async handler(argv) {
    await requireAuth()
    const userId = await requireUserId(argv["user-id"] as number | undefined)
    if (!userId) process.exit(1)
    const res = await hiveFetch(`/api/v6/nodes/scheduled-tasks/${argv.id}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userId }),
    })
    if (!res.ok) {
      console.error(`Run failed: ${res.status} ${await res.text()}`)
      process.exit(1)
    }
    const { dispatched_task_id } = (await res.json()) as { dispatched_task_id: string }
    console.log(`${success("✓")} dispatched task ${dispatched_task_id}`)
  },
})

// ============================================================================
// schedules (root)
// ============================================================================

const HiveSchedulesCommand = cmd({
  command: "schedules",
  describe: "cloud-side scheduling for hive node tasks (cron + one-time)",
  builder: (yargs) =>
    yargs
      .command(HiveSchedulesRunCommand)
      .command(HiveSchedulesListCommand)
      .command(HiveSchedulesShowCommand)
      .command(HiveSchedulesRmCommand)
      .command(HiveSchedulesPauseCommand)
      .command(HiveSchedulesResumeCommand)
      .command(HiveSchedulesRunNowCommand)
      .demandCommand(1, "Specify: run, list, show, rm, pause, resume, run-now"),
  async handler() {},
})

export const HiveSchedulesCommandExport = HiveSchedulesCommand
