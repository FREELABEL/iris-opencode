import { cmd } from "./cmd"
import { UI } from "../ui"
import { irisFetch, requireAuth, requireUserId, dim, bold, success, writeJson } from "./iris-api"
import { resolveLocalNode } from "./hive-local-node"
import { describeUptime } from "./hive-uptime"
import { exitCodeForResult, verdictForResult, renderOutput, fromHiveTask } from "./hive-script-result"

// ============================================================================
// iris hive nodes / run
//
// Node management + remote command execution for your own Hive nodes.
// Talks to iris-api (https://freelabel.net by default).
// ============================================================================

const IRIS_API = process.env.IRIS_API_URL ?? "https://freelabel.net"

export async function hiveFetch(path: string, options: RequestInit = {}) {
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

// SECURITY (#145949): strip live secrets from a node record before it can reach
// stdout / --json / MCP transcripts. Defense-in-depth behind the server-side fix
// (fl-iris-api ComputeNodeController::formatNode no longer emits api_key).
function redactNode(node: HiveNode): HiveNode {
  if (!node || typeof node !== "object") return node
  const { api_key, api_secret, api_secret_hash, ...safe } = node as unknown as Record<string, unknown>
  void api_key
  void api_secret
  void api_secret_hash
  return safe as unknown as HiveNode
}

export async function fetchNodes(userId: number): Promise<HiveNode[]> {
  const res = await hiveFetch(`/api/v6/nodes/?user_id=${userId}`)
  if (!res.ok) throw new Error(`Failed to fetch nodes: ${res.status} ${await res.text()}`)
  const data = (await res.json()) as { nodes: HiveNode[] }
  return (data.nodes ?? []).map(redactNode)
}

export async function resolveNode(userId: number, target: string): Promise<HiveNode | null> {
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
      await writeJson(nodes)
      return
    }

    if (nodes.length === 0) {
      const installHint = process.platform === "win32" ? "irm https://heyiris.io/install-code.ps1 | iex" : "curl heyiris.io/install-code | bash"
      console.log(dim(`No nodes registered. Install on a machine: ${installHint}`))
      return
    }

    // Detect local node for the "(you)" marker.
    //
    // This used to read ONLY config.node_id — a key nothing ever writes — then fall back to
    // `n.name.includes(os.hostname())`. Both always failed, so "(you)" never appeared: macOS
    // rewrites the hostname on each mDNS collision, so one machine showed as -5054 (registered),
    // -8435 (daemon) and -8436 (os.hostname) in a single run. The daemon knew its own node_id all
    // along. See hive-local-node.ts.
    let configNodeId: string | null = null
    try {
      const fs = require("fs"), path = require("path")
      const configPath = path.join(require("os").homedir(), ".iris", "config.json")
      if (fs.existsSync(configPath)) {
        configNodeId = JSON.parse(fs.readFileSync(configPath, "utf-8")).node_id || null
      }
    } catch {}

    let daemonNodeId: string | null = null
    try {
      const res = await fetch("http://localhost:3200/health", { signal: AbortSignal.timeout(1500) })
      if (res.ok) daemonNodeId = ((await res.json()) as any)?.node_id ?? null
    } catch { /* daemon not running — fall through to the weaker sources */ }

    const local = resolveLocalNode({
      daemonNodeId,
      configNodeId,
      hostname: require("os").hostname(),
      nodes: nodes.map((n) => ({ id: String(n.id), name: String(n.name) })),
    })
    const localNodeId = local.nodeId

    console.log()
    console.log(bold("  Name                          Status       Active  Last heartbeat   IP"))
    console.log(dim("  " + "─".repeat(80)))
    for (const n of nodes) {
      // The hostname `includes` check is gone: it compared a mutating name against a frozen one
      // and could never match. resolveLocalNode already did the hostname work, on a stem, and
      // refused to guess when several nodes shared one.
      const isLocal = localNodeId !== null && String(n.id) === localNodeId
      const youTag = isLocal ? success(local.uncertain ? " (you?)" : " (you)") : ""
      const name = n.name.padEnd(28)
      const status = statusBadge(n.connection_status).padEnd(22)
      const active = String(n.active_tasks ?? 0).padStart(2)
      const cap = String(n.max_concurrent ?? "?")
      const slot = `${active}/${cap}`.padEnd(7)
      const heartbeat = timeAgo(n.last_heartbeat_at).padEnd(15)
      const ip = n.last_ip ?? dim("—")
      console.log(`  ${name}${youTag}  ${status}  ${slot}  ${heartbeat}  ${ip}`)
      console.log(`    ${dim("id:")} ${n.id}`)

      // Which BUILD, and can it serve local data sources.
      //
      // Nothing surfaced this, so a fleet where 10 of 11 nodes ran daemons predating
      // `bridge_call` looked healthy: the stale ones were correctly EXCLUDED from routing
      // and completely invisible while being excluded, so Obsidian/Mail/Calendar silently
      // worked on exactly one machine (#178758). A fleet you cannot inventory cannot be
      // rolled out to.
      // IS IT STAYING UP? (#182434 — Gap 1)
      //
      // ONLINE here means "has not missed a heartbeat", and a crash-looping daemon heartbeats
      // once per restart, so it never misses one. This line is what separates a machine that
      // has been up for hours from one dying every thirty seconds — the two were identical in
      // this table while work kept being dispatched to both.
      const up = describeUptime(n as any, Date.now())
      if (up.kind === "looping") {
        console.log(
          `    ${UI.Style.TEXT_DANGER}⚠ ${up.label} · ${up.restarts} restarts in the last ${up.windowLabel} — ` +
            `crash-looping; work sent here will hang to timeout${UI.Style.TEXT_NORMAL}`,
        )
      } else if (up.kind === "stable") {
        console.log(`    ${dim("uptime:")} ${up.label}`)
      } else {
        // NOT MEASURED, said as such. Rendering this as "up 0s" would recreate the bug.
        console.log(`    ${dim(`uptime: unknown — ${up.reason}`)}`)
      }

      const ver = (n as any).daemon_version
      const caps = (n as any).bridge_capabilities
      if (ver || caps) {
        const bits: string[] = []
        if (ver) bits.push(`${dim("daemon:")} ${ver}`)
        if (caps && typeof caps === "object") {
          const ready = Object.entries(caps).filter(([, v]: any) => v?.available).map(([k]) => k)
          bits.push(ready.length ? `${dim("local:")} ${ready.join(", ")}` : dim("local: none available"))
        }
        console.log(`    ${bits.join(dim("  ·  "))}`)
      } else if (n.connection_status === "online") {
        // Online but silent about capabilities means an OLD daemon — say so plainly rather
        // than leaving a gap the reader fills in with "probably fine".
        console.log(`    ${UI.Style.TEXT_WARNING}⚠ daemon predates bridge_call — cannot serve local data sources; update it${UI.Style.TEXT_NORMAL}`)
      }
    }

    const stale = nodes.filter((n) => n.connection_status === "online" && !(n as any).bridge_capabilities).length
    console.log()
    console.log(dim(`  ${nodes.length} node(s).  Run on one: iris hive run <name|id> "<command>"`))
    if (stale > 0) {
      console.log(`  ${UI.Style.TEXT_WARNING}${stale} online node(s) run an outdated daemon and are excluded from local data-source routing.${UI.Style.TEXT_NORMAL}`)
    }
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
      await writeJson(node)
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
  describe: "run a shell command on a Hive node and stream the output back (fails fast on the first error unless --no-fail-fast is given — see `command`)",
  builder: (yargs) =>
    yargs
      .positional("target", { describe: "node name or id", type: "string", demandOption: true })
      .positional("command", { describe: "shell command (quote it). Runs with `set -e` by default, so it stops at the first failing statement instead of running the rest — pass --no-fail-fast to run without it", type: "string", demandOption: true })
      .option("timeout", { describe: "task timeout in seconds", type: "number", default: 60 })
      .option("title", { describe: "task title shown in the dashboard", type: "string" })
      .option("priority", { describe: "task priority 1-10 (higher = sooner)", type: "number" })
      .option("queue", { alias: "fire-and-forget", describe: "queue the task and exit immediately (don't wait for completion)", type: "boolean", default: false })
      .option("user-id", { describe: "user ID", type: "number" })
      .option("fail-fast", { describe: "stop at the first failing statement (`set -e`)", type: "boolean", default: true })
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

    // Wrap as a bash script (sandbox_execute treats prompt as a script body).
    // `set -e` is opt-out (--no-fail-fast) rather than always-on — it used to
    // be silently forced, so a script written assuming shell semantics (e.g.
    // "run these three checks, report all three") could stop after the first
    // non-zero exit with no indication why (#182005).
    const failFast = argv["fail-fast"] !== false
    if (failFast && !command.startsWith("#!") && !argv.json) {
      console.log(dim("→ running with `set -e` (stop at first failure) — pass --no-fail-fast to disable"))
    }
    const script = command.startsWith("#!")
      ? command
      : failFast
        ? `#!/bin/bash\nset -e\n${command}`
        : `#!/bin/bash\n${command}`
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
        await writeJson({ task_id: taskId, status: created.task.status, dispatched: created.dispatched })
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
      await writeJson(final)
      return
    }

    // The exit-code and output contract lives in hive-script-result.ts, written after two
    // measured incidents. This handler used to re-derive a weaker version of it inline and
    // got it wrong in the exact way that module exists to prevent: an unknown exit code
    // printed as "?" underneath a green check (#182016).
    //
    // The field-name half of the same bug: the daemon submits the exit code under
    // metadata.exit_code (coding-agent-bridge task-executor.js, submitResult), and this
    // read result.exit_code, which nothing ever sets. Both are read now, metadata first
    // because that is the one the daemon actually writes.
    const runResult = fromHiveTask(final)

    const exitCode = exitCodeForResult(runResult)
    const verdict = verdictForResult(runResult)

    // renderOutput keeps the TAIL, because the failure is at the bottom of a log, and it
    // distinguishes truncation by the node from truncation here.
    const OUTPUT_LINES = 500
    const out = renderOutput(runResult.stdout, OUTPUT_LINES)
    const err = renderOutput(runResult.stderr, OUTPUT_LINES)

    console.log()
    if (out.lines.length) {
      console.log(bold("─── output ───"))
      console.log(out.lines.join("\n"))
      if (out.notice) console.log(dim(`  (${out.notice})`))
    }
    if (err.lines.length) {
      console.log(bold("─── stderr ───"))
      console.log(err.lines.join("\n"))
      if (err.notice) console.log(dim(`  (${err.notice})`))
    }
    if (final.error) {
      console.log(bold("─── error ───"))
      console.log(final.error)
    }
    console.log()

    // Never a green check over an unknown exit code. "exit=?" beside a ✓ reads as success,
    // and that is how a transport returning nothing at all (#181633, #182004) went on
    // looking healthy for two days.
    const tag = verdict === "completed" ? success("✓") : dim("✗")
    const exitLabel =
      typeof runResult.exit_code !== "number"
        ? dim("unknown — the node reported none")
        : runResult.exit_code_source === "error_text"
          ? `${runResult.exit_code} ${dim("(inferred from the node's error text, not reported — #182004)")}`
          : String(runResult.exit_code)
    console.log(
      `  ${tag} ${verdict}  ${dim("exit=")}${exitLabel}  ${dim("duration=")}${final.duration_ms ?? "?"}ms`,
    )

    // Exit with the command's own code, so `iris hive run <node> "..." && next` means what
    // it says. A timeout is 124 (distinct, so CI can retry only those) per the contract.
    if (exitCode !== 0) process.exit(exitCode)
  },
})

export const HiveNodesCommandExport = HiveNodesCommand
export const HiveRunCommandExport = HiveRunCommand
