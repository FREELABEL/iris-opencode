import { cmd } from "./cmd"
import { irisFetch, requireAuth, requireUserId, dim, bold, success } from "./iris-api"

// ============================================================================
// iris hive nodes / run
//
// Node management + remote command execution for your own Hive nodes.
// Talks to iris-api (https://freelabel.net by default).
// ============================================================================

const IRIS_API = process.env.IRIS_API_URL ?? "https://freelabel.net"

async function hiveFetch(path: string, options: RequestInit = {}) {
  return irisFetch(path, options, IRIS_API)
}

interface HiveNode {
  id: string
  name: string
  status: string
  connection_status: "online" | "offline" | "paused" | string
  capabilities?: Record<string, unknown>
  max_concurrent?: number
  active_tasks?: number
  total_tasks_completed?: number
  last_heartbeat_at?: string | null
  last_ip?: string | null
  hardware_profile?: Record<string, unknown> | null
  created_at?: string
}

function statusBadge(s: string): string {
  if (s === "online") return success("● online")
  if (s === "paused") return `${dim("◌ paused")}`
  return dim("○ " + s)
}

function timeAgo(iso: string | null | undefined): string {
  if (!iso) return dim("never")
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`
  return `${Math.floor(ms / 86_400_000)}d ago`
}

async function fetchNodes(userId: number): Promise<HiveNode[]> {
  const res = await hiveFetch(`/api/v6/nodes/?user_id=${userId}`)
  if (!res.ok) throw new Error(`Failed to fetch nodes: ${res.status} ${await res.text()}`)
  const data = (await res.json()) as { nodes: HiveNode[] }
  return data.nodes ?? []
}

async function resolveNode(userId: number, target: string): Promise<HiveNode | null> {
  const nodes = await fetchNodes(userId)
  // Exact ID match first, then name (case-insensitive), then prefix
  return (
    nodes.find((n) => n.id === target) ??
    nodes.find((n) => n.name.toLowerCase() === target.toLowerCase()) ??
    nodes.find((n) => n.id.startsWith(target)) ??
    nodes.find((n) => n.name.toLowerCase().startsWith(target.toLowerCase())) ??
    null
  )
}

// ============================================================================
// nodes list
// ============================================================================

const HiveNodesListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list your registered Hive nodes",
  builder: (yargs) =>
    yargs
      .option("status", { describe: "filter by status (online/offline/paused)", type: "string" })
      .option("json", { describe: "JSON output", type: "boolean", default: false })
      .option("user-id", { describe: "user ID", type: "number" }),
  async handler(argv) {
    await requireAuth()
    const userId = await requireUserId(argv["user-id"] as number | undefined)
    if (!userId) process.exit(1)

    let nodes = await fetchNodes(userId)
    if (argv.status) {
      nodes = nodes.filter((n) => n.connection_status === argv.status)
    }

    if (argv.json) {
      console.log(JSON.stringify(nodes, null, 2))
      return
    }

    if (nodes.length === 0) {
      console.log(dim("No nodes registered. Install on a machine: curl heyiris.io/install-code | bash"))
      return
    }

    console.log()
    console.log(bold("  Name                          Status       Active  Last heartbeat   IP"))
    console.log(dim("  " + "─".repeat(80)))
    for (const n of nodes) {
      const name = n.name.padEnd(28)
      const status = statusBadge(n.connection_status).padEnd(22)
      const active = String(n.active_tasks ?? 0).padStart(2)
      const cap = String(n.max_concurrent ?? "?")
      const slot = `${active}/${cap}`.padEnd(7)
      const heartbeat = timeAgo(n.last_heartbeat_at).padEnd(15)
      const ip = n.last_ip ?? dim("—")
      console.log(`  ${name}  ${status}  ${slot}  ${heartbeat}  ${ip}`)
      console.log(`    ${dim("id:")} ${n.id}`)
    }
    console.log()
    console.log(dim(`  ${nodes.length} node(s).  Run on one: iris hive run <name|id> "<command>"`))
  },
})

// ============================================================================
// nodes show
// ============================================================================

const HiveNodesShowCommand = cmd({
  command: "show <target>",
  describe: "show details for a node (by name or id)",
  builder: (yargs) =>
    yargs
      .positional("target", { describe: "node name or id", type: "string", demandOption: true })
      .option("user-id", { describe: "user ID", type: "number" })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(argv) {
    await requireAuth()
    const userId = await requireUserId(argv["user-id"] as number | undefined)
    if (!userId) process.exit(1)

    const node = await resolveNode(userId, String(argv.target))
    if (!node) {
      console.error(`No node matching "${argv.target}"`)
      process.exit(1)
    }

    if (argv.json) {
      console.log(JSON.stringify(node, null, 2))
      return
    }

    console.log()
    console.log(`${bold(node.name)}  ${statusBadge(node.connection_status)}`)
    console.log(`  ${dim("id:")}                ${node.id}`)
    console.log(`  ${dim("active tasks:")}      ${node.active_tasks ?? 0} / ${node.max_concurrent ?? "?"}`)
    console.log(`  ${dim("completed total:")}   ${node.total_tasks_completed ?? 0}`)
    console.log(`  ${dim("last heartbeat:")}    ${timeAgo(node.last_heartbeat_at)}`)
    if (node.last_ip) console.log(`  ${dim("last ip:")}           ${node.last_ip}`)
    if (node.capabilities) {
      console.log(`  ${dim("capabilities:")}      ${Object.keys(node.capabilities).join(", ")}`)
    }
    if (node.hardware_profile) {
      const hw = node.hardware_profile as Record<string, unknown>
      const cpu = hw.cpu_cores ?? hw.cpus ?? "?"
      const mem = hw.memory_gb ?? hw.ram_gb ?? "?"
      const os = hw.os ?? hw.platform ?? "?"
      console.log(`  ${dim("hardware:")}          ${cpu} cores · ${mem}GB · ${os}`)
    }
    console.log()
  },
})

// ============================================================================
// nodes (root)
// ============================================================================

const HiveNodesCommand = cmd({
  command: "nodes",
  describe: "manage your Hive compute nodes",
  builder: (yargs) =>
    yargs
      .command(HiveNodesListCommand)
      .command(HiveNodesShowCommand)
      .demandCommand(1, "Specify: list, show"),
  async handler() {},
})

// ============================================================================
// run — execute a shell command on a specific node and wait for output
// ============================================================================

const HiveRunCommand = cmd({
  command: "run <target> <command>",
  describe: "run a shell command on a Hive node and stream the output back",
  builder: (yargs) =>
    yargs
      .positional("target", { describe: "node name or id", type: "string", demandOption: true })
      .positional("command", { describe: "shell command (quote it)", type: "string", demandOption: true })
      .option("timeout", { describe: "task timeout in seconds", type: "number", default: 60 })
      .option("title", { describe: "task title shown in the dashboard", type: "string" })
      .option("priority", { describe: "task priority 1-10 (higher = sooner)", type: "number" })
      .option("queue", { alias: "fire-and-forget", describe: "queue the task and exit immediately (don't wait for completion)", type: "boolean", default: false })
      .option("user-id", { describe: "user ID", type: "number" })
      .option("json", { describe: "JSON output (full task object)", type: "boolean", default: false }),
  async handler(argv) {
    await requireAuth()
    const userId = await requireUserId(argv["user-id"] as number | undefined)
    if (!userId) process.exit(1)

    const target = String(argv.target)
    const command = String(argv.command)
    const timeoutSec = Math.max(30, Math.min(3600, Number(argv.timeout) || 60))

    const node = await resolveNode(userId, target)
    if (!node) {
      console.error(`No node matching "${target}". Run: iris hive nodes list`)
      process.exit(1)
    }

    if (node.connection_status !== "online") {
      console.error(
        `Node "${node.name}" is ${node.connection_status}. ` +
          `Last heartbeat ${timeAgo(node.last_heartbeat_at)}. Cannot dispatch.`,
      )
      process.exit(2)
    }

    if (!argv.json) {
      console.log(`${dim("→")} dispatching to ${bold(node.name)} (${node.id.slice(0, 8)})`)
    }

    // Wrap as a bash script (sandbox_execute treats prompt as a script body)
    const script = command.startsWith("#!") ? command : `#!/bin/bash\nset -e\n${command}`
    const title = (argv.title as string | undefined) ?? `iris hive run: ${command.slice(0, 60)}`

    const priority = argv.priority as number | undefined
    const clampedPriority = priority ? Math.max(1, Math.min(10, Math.round(priority))) : undefined

    const createRes = await hiveFetch(`/api/v6/nodes/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_id: userId,
        title,
        type: "sandbox_execute",
        node_id: node.id,
        prompt: script,
        config: { timeout_seconds: timeoutSec },
        timeout_seconds: timeoutSec,
        ...(clampedPriority ? { priority: clampedPriority } : {}),
      }),
    })

    if (!createRes.ok) {
      console.error(`Task creation failed: ${createRes.status} ${await createRes.text()}`)
      process.exit(1)
    }

    const created = (await createRes.json()) as {
      task: { id: string; status: string }
      dispatched: boolean
    }
    const taskId = created.task.id

    // Fire-and-forget mode: print task id and exit
    if (argv.queue) {
      if (argv.json) {
        console.log(JSON.stringify({ task_id: taskId, status: created.task.status, dispatched: created.dispatched }, null, 2))
        return
      }
      console.log(`${success("✓")} dispatched task ${bold(taskId)}  status=${created.task.status}`)
      console.log(dim(`  Check later:  iris hive tasks --task ${taskId}`))
      return
    }

    if (!argv.json) {
      console.log(`${dim("→")} task ${taskId.slice(0, 8)}  status=${created.task.status}`)
      console.log(dim("waiting for completion..."))
    }

    // Poll until terminal (succeeded / failed / cancelled / timeout). Bound by timeout + 30s slack.
    const deadline = Date.now() + (timeoutSec + 30) * 1000
    const terminal = new Set(["succeeded", "completed", "failed", "cancelled", "timeout", "errored"])
    let lastStatus = created.task.status
    let final: any = null

    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1500))
      const r = await hiveFetch(`/api/v6/nodes/tasks/${taskId}?user_id=${userId}`)
      if (!r.ok) {
        console.error(`Poll failed: ${r.status} ${await r.text()}`)
        process.exit(1)
      }
      const body = (await r.json()) as { task: any }
      const t = body.task
      if (!argv.json && t.status !== lastStatus) {
        console.log(`${dim("→")} status=${t.status}${t.progress ? `  progress=${t.progress}%` : ""}`)
        lastStatus = t.status
      }
      if (terminal.has(t.status)) {
        final = t
        break
      }
    }

    if (!final) {
      console.error(`Timed out after ${timeoutSec + 30}s waiting for task ${taskId}`)
      process.exit(124)
    }

    if (argv.json) {
      console.log(JSON.stringify(final, null, 2))
      return
    }

    const result = final.result ?? {}
    const output = result.output ?? result.stdout ?? ""
    const stderr = result.stderr ?? ""
    const exitCode = result.exit_code ?? result.exitCode

    console.log()
    if (output) {
      console.log(bold("─── output ───"))
      console.log(output)
    }
    if (stderr) {
      console.log(bold("─── stderr ───"))
      console.log(stderr)
    }
    if (final.error) {
      console.log(bold("─── error ───"))
      console.log(final.error)
    }
    console.log()
    const ok = final.status === "succeeded" || final.status === "completed"
    const tag = ok ? success("✓") : dim("✗")
    console.log(
      `  ${tag} ${final.status}  ${dim("exit=")}${exitCode ?? "?"}  ${dim("duration=")}${final.duration_ms ?? "?"}ms`,
    )

    if (!ok) process.exit(1)
  },
})

export const HiveNodesCommandExport = HiveNodesCommand
export const HiveRunCommandExport = HiveRunCommand
