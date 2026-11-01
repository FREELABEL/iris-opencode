import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { cmd } from "./cmd"
import { UI } from "../ui"
import { irisFetch, requireAuth, requireUserId, dim, bold, success, writeJson } from "./iris-api"
import { resolveLocalNode } from "./hive-local-node"
import { describeUptime } from "./hive-uptime"
import { describeIsolation } from "./hive-isolation"
import { exitCodeForResult, verdictForResult, renderOutput, fromHiveTask, TIMEOUT_EXIT } from "./hive-script-result"
import { CliUsageError } from "../json-error"
import { currentDelegationOrigin } from "./hive-delegation-origin"
import { buildHiveRunBody, ENDED_STATUSES, dispatchableConnection, queuedReport, statusLine, stoppedWaitingNote, type CreatedTask } from "./hive-run-body"
import { busyOverrideHint } from "./hive-task-create"
import { listEnvelope, listFooter } from "./pagination-args"

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

export interface HiveNode {
  id: string
  name: string
  status: string
  connection_status: "online" | "offline" | "paused" | string
  capabilities?: Record<string, unknown>
  max_concurrent?: number
  active_tasks?: number
  /** Why a node with free slots is refusing work, e.g. "CPU at 97%" (#192109). */
  busy_reason?: string | null
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
  if (!res.ok) {
    const body = await res.text()
    // 401/403/404 are answers about the request — most often --user-id naming an account this
    // login is not — and the API says which, in words. Thrown raw they surfaced as "Unexpected
    // error" and a screen of minified source (#191479).
    if ([401, 403, 404].includes(res.status)) {
      let said = ""
      try {
        const j = JSON.parse(body)
        said = j.error || j.message || ""
      } catch {}
      throw new CliUsageError(said || `The Hive API refused to list nodes for user ${userId} (HTTP ${res.status}). Check: iris auth whoami`)
    }
    throw new Error(`Failed to fetch nodes: ${res.status} ${body.slice(0, 300)}`)
  }
  const data = (await res.json()) as { nodes: HiveNode[] }
  return (data.nodes ?? []).map(redactNode)
}

/**
 * Exact id first, then name (case-insensitive), then id prefix, then name prefix.
 *
 * #190299: a machine re-registered keeps its name, so one name can belong to a live node and a
 * dead one. "First listed" picked the dead MacBook (last heartbeat 2026-09-13) over the live one
 * beside it. Among nodes sharing a name: online first, then the most recent heartbeat.
 * `sameName` says how many matched, so callers can say the name was ambiguous.
 */
export function pickNode(nodes: HiveNode[], target: string): { node: HiveNode | null; sameName: number } {
  const exact = nodes.find((n) => n.id === target)
  if (exact) return { node: exact, sameName: 1 }
  const t = target.toLowerCase()
  const best = (list: HiveNode[]) =>
    [...list].sort(
      (a, b) =>
        Number(b.connection_status === "online") - Number(a.connection_status === "online") ||
        Date.parse(b.last_heartbeat_at ?? "") - Date.parse(a.last_heartbeat_at ?? "") ||
        0,
    )[0] ?? null
  for (const match of [
    (n: HiveNode) => n.name.toLowerCase() === t,
    (n: HiveNode) => n.id.startsWith(target),
    (n: HiveNode) => n.name.toLowerCase().startsWith(t),
  ]) {
    const hits = nodes.filter(match)
    if (hits.length) return { node: best(hits), sameName: hits.length }
  }
  return { node: null, sameName: 0 }
}

export async function resolveNode(userId: number, target: string): Promise<HiveNode | null> {
  const { node, sameName } = pickNode(await fetchNodes(userId), target)
  if (node && sameName > 1) {
    console.error(dim(`  ${sameName} nodes match "${target}" — using ${node.id} (${node.connection_status}, heartbeat ${timeAgo(node.last_heartbeat_at)}). Pass the id to choose another.`))
  }
  return node
}

/**
 * Dispatch one task and wait for it to finish — the create-then-poll that `hive run` and
 * `hive tasks create` each do inline, as a function another command can call. Same endpoints,
 * same terminal set, same bound (the task's own timeout plus 30 s of slack). Returns the final
 * task, or `null` when it was still running at the bound (the task is NOT cancelled).
 */
export async function dispatchTaskAndWait(
  userId: number,
  payload: Record<string, unknown>,
  onStatus?: (status: string) => void,
): Promise<{ taskId: string; final: Record<string, unknown> | null }> {
  const createRes = await hiveFetch(`/api/v6/nodes/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  })
  if (!createRes.ok) throw new Error(`Task creation failed: HTTP ${createRes.status} ${(await createRes.text().catch(() => "")).slice(0, 500)}`)
  const created = (await createRes.json()) as { task: { id: string; status: string } }
  const taskId = created.task.id
  const timeoutSec = Number(payload.timeout_seconds ?? 300)
  const deadline = Date.now() + (timeoutSec + 30) * 1000
  const terminal = new Set(["succeeded", "completed", "failed", "cancelled", "timeout", "errored", "expired"])
  let last = created.task.status
  onStatus?.(last)
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500))
    const r = await hiveFetch(`/api/v6/nodes/tasks/${taskId}?user_id=${userId}`)
    if (!r.ok) throw new Error(`Poll failed for task ${taskId}: HTTP ${r.status}`)
    const t = ((await r.json()) as { task: Record<string, unknown> }).task
    const st = String(t.status ?? "")
    if (st !== last) {
      last = st
      onStatus?.(st)
    }
    if (terminal.has(st)) return { taskId, final: t }
  }
  return { taskId, final: null }
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

    // WHICH COMMIT each node runs, and whether it is behind main (#191614). Best effort: offline,
    // rate-limited or a GitHub outage leaves "behind" unknown rather than failing the list.
    const { commitViews } = await import("./daemon-update-fleet")
    const views = await commitViews(nodes.map((n) => (n as any).daemon_version))

    if (argv.json) {
      // The list contract (#191863): the nodes endpoint returns every node, so the total is exact.
      const rows = nodes.map((n, i) => ({ ...n, daemon_commit: views.byIndex[i].commit, daemon_drift: views.byIndex[i].drift, behind_main: views.byIndex[i].behind, main_commit: views.main }))
      await writeJson(listEnvelope(rows, { resource: "nodes", complete: true }))
      return
    }

    if (nodes.length === 0) {
      const installHint = process.platform === "win32" ? "irm https://heyiris.io/install-code.ps1 | iex" : "curl heyiris.io/install-code | bash"
      // One instruction everywhere (#191478): install IRIS on the machine, or — if it already has
      // it — `iris hive connect` there. The daemon enrolls itself either way.
      console.log(dim(`No nodes registered. On the machine to add: ${installHint}  (already has IRIS? run: iris hive connect)`))
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
      const configPath = path.join(os.homedir(), ".iris", "config.json")
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
      hostname: os.hostname(),
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
      // Disk, live from the heartbeat (#188700). Only said when it is a problem — a full disk is how
      // a node silently stops completing work, and nothing else in this list would show it.
      const diskNote = describeDiskLive((n as any).disk_live)
      if (diskNote) console.log(`    ${diskNote}`)

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

      const cv = views.byIndex[nodes.indexOf(n)]
      const cvText = cv.text.replace("<name>", n.name)
      if (n.busy_reason) console.log(`    ${UI.Style.TEXT_WARNING}not taking work: ${n.busy_reason}${UI.Style.TEXT_NORMAL}`)
      console.log(`    ${dim("daemon commit:")} ${cv.behind || cv.drift ? `${UI.Style.TEXT_WARNING}${cvText}${UI.Style.TEXT_NORMAL}` : cvText}`)
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

      // ── Whether scripts on this machine are CONTAINED. ─────────────────────────────
      // The decision lives in describeIsolation() with its own tests; this only prints it.
      const isoLine = describeIsolation((n as any).permissions?.isolation, n.connection_status === "online")
      if (isoLine) {
        const detail = isoLine.detail ? ` ${dim(`(${isoLine.detail})`)}` : ""
        if (isoLine.tone === "warn") {
          console.log(`    ${UI.Style.TEXT_WARNING}${isoLine.text}${UI.Style.TEXT_NORMAL}${detail}`)
        } else {
          console.log(`    ${dim(isoLine.text)}${isoLine.detail ? ` ${dim(isoLine.detail)}` : ""}`)
        }
      }
    }

    const stale = nodes.filter((n) => n.connection_status === "online" && !(n as any).bridge_capabilities).length
    console.log()
    console.log(dim(`  ${listFooter(listEnvelope(nodes, { resource: "nodes", complete: true }).meta, "nodes")}.  Run on one: iris hive run <name|id> "<command>"`))
    const behind = views.byIndex.filter((v) => v.behind).length
    if (behind > 0) console.log(`  ${UI.Style.TEXT_WARNING}${behind} node(s) behind main.${UI.Style.TEXT_NORMAL} ${dim("Update every machine: iris hive rollout --dry-run, then iris hive rollout")}`)
    if (stale > 0) {
      console.log(`  ${UI.Style.TEXT_WARNING}${stale} online node(s) run an outdated daemon and are excluded from local data-source routing.${UI.Style.TEXT_NORMAL}`)
    }
    for (const d of duplicateNames(nodes)) {
      console.log(
        `  ${UI.Style.TEXT_WARNING}${d.count} nodes are named ${d.name}.${UI.Style.TEXT_NORMAL} ` +
          dim(`Remove the stale one: iris hive nodes remove ${d.staleIds.join(" / ")}`),
      )
    }
  },
})

/**
 * Names held by more than one node, with the ids of every copy except the one a name resolves to
 * (online first, then most recent heartbeat). A re-enrolled machine keeps its name, so the old
 * registration lingers and every by-name command has to guess (#191481).
 */
export function duplicateNames(nodes: HiveNode[]): { name: string; count: number; staleIds: string[] }[] {
  const byName = new Map<string, HiveNode[]>()
  for (const n of nodes) byName.set(n.name.toLowerCase(), [...(byName.get(n.name.toLowerCase()) ?? []), n])
  const out: { name: string; count: number; staleIds: string[] }[] = []
  for (const group of byName.values()) {
    if (group.length < 2) continue
    const keep = pickNode(group, group[0].name).node
    out.push({ name: group[0].name, count: group.length, staleIds: group.filter((n) => n !== keep).map((n) => n.id) })
  }
  return out
}

/** Online, or a heartbeat in the last 10 minutes: a machine that is probably still there. */
export function looksAlive(n: HiveNode, now = Date.now()): boolean {
  if (n.connection_status === "online") return true
  const t = Date.parse(n.last_heartbeat_at ?? "")
  return Number.isFinite(t) && now - t < 10 * 60_000
}

// ============================================================================
// nodes remove  (#191481)
// ============================================================================

const HiveNodesRemoveCommand = cmd({
  command: "remove <id>",
  aliases: ["rm"],
  describe: "remove a node registration — e.g. the stale copy left when a machine re-enrolled",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "the node's FULL id (names repeat — that is the problem this solves)", type: "string", demandOption: true })
      .option("force", { describe: "remove it even though it looks online", type: "boolean", default: false })
      .option("yes", { describe: "do not ask (required without a terminal)", type: "boolean", default: false })
      .option("user-id", { describe: "user ID", type: "number" })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(argv) {
    await requireAuth()
    const userId = await requireUserId(argv["user-id"] as number | undefined)
    if (!userId) process.exit(1)
    const id = String(argv.id)

    // Exact id only: a name or a prefix could match the LIVE machine instead of the stale one.
    const node = (await fetchNodes(userId)).find((n) => n.id === id)
    if (!node) {
      throw new CliUsageError(`No node with id ${id}. Copy the full id from: iris hive nodes list`)
    }
    if (looksAlive(node) && !argv.force) {
      throw new CliUsageError(
        `${node.name} (${id}) looks online (heartbeat ${timeAgo(node.last_heartbeat_at)}). Removing it would cut off a live machine. Pass --force if you mean it.`,
      )
    }
    if (!argv.yes) {
      if (!process.stdin.isTTY) {
        throw new CliUsageError(`Removing a node needs a yes — run it at a terminal, or pass --yes.`)
      }
      const { createInterface } = await import("node:readline")
      const rl = createInterface({ input: process.stdin, output: process.stderr })
      const answer: string = await new Promise((r) =>
        rl.question(`Remove ${node.name} (${id}, last heartbeat ${timeAgo(node.last_heartbeat_at)})? [y/N] `, r),
      )
      rl.close()
      if (!/^y(es)?$/i.test(answer.trim())) {
        console.error("Not removed.")
        process.exit(1)
      }
    }

    const res = await hiveFetch(`/api/v6/nodes/${encodeURIComponent(id)}?user_id=${userId}`, { method: "DELETE" })
    if (!res.ok) throw new Error(`Could not remove ${id}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`)
    if (argv.json) await writeJson({ removed: id, name: node.name })
    else console.log(`${success("✓")} removed ${bold(node.name)} ${dim(id)}`)
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
    if (node.busy_reason) console.log(`  ${dim("not taking work:")}   ${UI.Style.TEXT_WARNING}${node.busy_reason}${UI.Style.TEXT_NORMAL}`)
    console.log(`  ${dim("completed total:")}   ${node.total_tasks_completed ?? 0}`)
    console.log(`  ${dim("last heartbeat:")}    ${timeAgo(node.last_heartbeat_at)}`)
    if (node.last_ip) console.log(`  ${dim("last ip:")}           ${node.last_ip}`)
    if (node.capabilities) {
      console.log(`  ${dim("capabilities:")}      ${Object.keys(node.capabilities).join(", ")}`)
    }
    if (node.hardware_profile) {
      for (const line of formatHardware(node.hardware_profile)) {
        console.log(`  ${dim(line.label.padEnd(18))}${line.value}`)
      }
    }
    console.log()
  },
})


// ============================================================================
// Hardware, rendered from the shape the daemon actually sends (#184614).
//
// The old renderer read a FLAT profile — `hw.cpu_cores`, `hw.memory_gb`, `hw.os`
// — and the daemon has sent a NESTED one (`cpu.cores`, `memory.total_gb`,
// `os.label`) since schema_version 2. So every node printed
//
//     hardware:   ? cores · ?GB · [object Object]
//
// on every field at once, identically on every machine. That is worse than
// printing nothing: hardware is the reason to pick one node over another, and a
// field that is present, wrong, and the same everywhere reads as "we do not
// collect this" when in fact the daemon logs the right values at startup.
//
// `[object Object]` is the tell — a nested object concatenated instead of read.
// Flat keys are kept as fallbacks so an older daemon still renders.
// ============================================================================

type HwLine = { label: string; value: string }

/** "3h ago" for a detected_at stamp, or null when there isn't one to trust. */
export function hwAge(detectedAt: unknown, now = new Date()): string | null {
  if (!detectedAt) return null
  const t = Date.parse(String(detectedAt))
  if (Number.isNaN(t)) return null
  const ms = now.getTime() - t
  if (ms < 0) return null
  const d = Math.floor(ms / 86400e3)
  if (d > 0) return `${d}d ago`
  const h = Math.floor(ms / 3600e3)
  if (h > 0) return `${h}h ago`
  const m = Math.floor(ms / 60e3)
  return m > 0 ? `${m}m ago` : "just now"
}

function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN
  return Number.isFinite(n) ? n : null
}

/** Exported for tests: the renderer is where this bug lived, so pin it. */
export function formatHardware(profile: unknown): HwLine[] {
  const hw = (profile ?? {}) as Record<string, any>
  const lines: HwLine[] = []

  const cpuModel = hw.cpu?.model ?? hw.cpu_model ?? null
  const cores = num(hw.cpu?.cores ?? hw.cpu_cores ?? hw.cpus)
  const memGb = num(hw.memory?.total_gb ?? hw.memory_gb ?? hw.ram_gb)
  const osLabel =
    hw.os?.label ??
    [hw.os?.platform ?? hw.platform, hw.os?.arch ?? hw.arch].filter(Boolean).join("-") ??
    null

  const head = [
    cpuModel ? String(cpuModel) : null,
    cores !== null ? `${cores} cores` : null,
    memGb !== null ? `${memGb}GB` : null,
    osLabel || null,
  ].filter(Boolean)
  // Say "not reported" rather than "?" per field. A row of question marks looks
  // like a broken renderer — which is exactly what it was, for long enough that
  // it got filed as a bug instead of read as missing data.
  lines.push({ label: "hardware:", value: head.length ? head.join(" · ") : "not reported by this node" })

  const gpu = hw.gpu
  if (gpu && gpu.available) {
    const vram = num(gpu.vram_gb)
    lines.push({
      label: "gpu:",
      value: [gpu.name ?? gpu.type ?? "present", vram !== null ? `${vram}GB` : null].filter(Boolean).join(" · "),
    })
  }

  const diskFree = num(hw.disk?.available_gb)
  const diskTotal = num(hw.disk?.total_gb)
  if (diskFree !== null || diskTotal !== null) {
    // The profile is detected once, at daemon start. Free space is the field most
    // likely to have moved since, and a stale number presented as current is the
    // same defect class as the one above — present, plausible, and wrong. Date it.
    const age = hwAge(hw.detected_at)
    lines.push({
      label: "disk:",
      value: `${diskFree ?? "?"}GB free${diskTotal !== null ? ` of ${diskTotal}GB` : ""}${age ? ` ${dim(`(measured ${age})`)}` : ""}`,
    })
  }

  const ollama = hw.ollama
  if (ollama?.available) {
    const models: any[] = Array.isArray(ollama.models) ? ollama.models : []
    lines.push({
      label: "ollama:",
      value: `${num(ollama.model_count) ?? models.length} model(s)${models.length ? ` — ${models.map((m) => m?.name).filter(Boolean).join(", ")}` : ""}`,
    })
  }

  return lines
}

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
      .command(HiveNodesRemoveCommand)
      .demandCommand(1, "Specify: list, show, remove"),
  async handler() {},
})

// ============================================================================
// run — execute a shell command on a specific node and wait for output
// ============================================================================

// `expired` ends a task too (#187568) — one that never started in time. Without it a task that
// expired while queued kept `hive run` waiting to its own timeout (#191559).
export const TERMINAL_TASK_STATUSES = ENDED_STATUSES

/**
 * Poll ONE task — the one a dispatch created — until it reaches a terminal status.
 *
 * #187990: `iris hive run` printed a failure (exit 1, 1000ms, no output) that belonged to a
 * DIFFERENT task, while its own task completed with the right output. Task ids are UUIDv7, so
 * tasks dispatched seconds apart share their first 8 characters, and the 8-character form is all
 * `run` printed. This function is the contract that keeps `run` honest:
 *
 *   - it asks for the FULL id it was given, never a prefix and never "the latest task";
 *   - it refuses a record whose id is not that id, rather than reporting someone else's result
 *     as this command's — a wrong answer that looks right is worse than an error.
 *
 * Pure apart from the injected fetch, so the regression test drives it with a fake server.
 */
export async function waitForTask(
  taskId: string,
  opts: {
    fetchTask: (id: string) => Promise<any>
    initialStatus?: string
    deadlineMs: number
    intervalMs?: number
    onStatus?: (task: any) => void
    sleep?: (ms: number) => Promise<void>
    now?: () => number
  },
): Promise<any | null> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const now = opts.now ?? Date.now
  const deadline = now() + opts.deadlineMs
  let lastStatus = opts.initialStatus
  let attempt = 0
  while (now() < deadline) {
    // An explicit intervalMs wins (the regression tests drive time themselves); otherwise
    // back off from 100ms, so the first check happens while a short command is still fresh.
    await sleep(opts.intervalMs ?? pollDelayMs(++attempt))
    const t = await opts.fetchTask(taskId)
    if (!t || typeof t !== "object") throw new Error(`Poll for task ${taskId} returned no task`)
    if (t.id !== undefined && String(t.id) !== taskId) {
      throw new Error(
        `Poll for task ${taskId} returned a different task (${t.id}) — refusing to report its result as this one's (#187990)`,
      )
    }
    if (t.status !== lastStatus) {
      opts.onStatus?.(t)
      lastStatus = t.status
    }
    if (TERMINAL_TASK_STATUSES.has(t.status)) return t
  }
  return null
}

/**
 * How long to wait before the next poll of a task (#190406).
 *
 * The first poll used to be a flat 1500ms after dispatch, so a command that finished in 50ms
 * was discovered up to 1.5s late — on every command, which is most of why `hive run` felt slow
 * next to ssh. Start at 100ms and double, capped at 1500ms: a short task is seen almost at once,
 * and a long one settles back to the old rate instead of hammering the API.
 */
export function pollDelayMs(attempt: number): number {
  return Math.min(100 * 2 ** Math.max(0, attempt - 1), 1500)
}

const HiveRunCommand = cmd({
  command: "run <target> <command>",
  describe: "run a shell command on a Hive node and stream the output back (fails fast on the first error unless --no-fail-fast is given — see `command`)",
  builder: (yargs) =>
    yargs
      .positional("target", { describe: "node name or id", type: "string", demandOption: true })
      .positional("command", { describe: "shell command (quote it). Runs with `set -e` by default, so it stops at the first failing statement instead of running the rest — pass --no-fail-fast to run without it", type: "string", demandOption: true })
      .option("timeout", {
        describe: "task timeout in seconds (default 300 — a repo build or pre-push hook routinely exceeds 60; use --queue for jobs longer than that)",
        type: "number",
        default: 300,
      })
      .option("title", { describe: "task title shown in the dashboard", type: "string" })
      .option("priority", { describe: "task priority 1-10 (higher = sooner)", type: "number" })
      .option("queue", { alias: "fire-and-forget", describe: "queue the task and exit immediately (don't wait for completion)", type: "boolean", default: false })
      .option("force", { describe: "run it on this node even though it reports high CPU/memory (a full or offline node still refuses)", type: "boolean", default: false })
      // #191559 — a full node is a normal, transient state: wait for a slot (up to --timeout) instead
      // of failing. A literal --no-wait-for-slot flag, same reason as --no-fail-fast below.
      .option("wait-for-slot", { describe: "if the node is full or busy, wait in its queue for a free slot (up to --timeout) instead of failing", type: "boolean", default: true })
      .option("no-wait-for-slot", { describe: "fail at once if the node is full or busy", type: "boolean", default: false })
      .option("user-id", { describe: "user ID", type: "number" })
      // boolean-negation is disabled globally (src/index.ts), so `--no-fail-fast` is NOT the
      // negation of `--fail-fast` — it must be its own literal flag or the parser rejects the
      // exact spelling the help text advertises (#184593, same defect in 6 places).
      .option("fail-fast", { describe: "stop at the first failing statement (`set -e`)", type: "boolean", default: true })
      .option("no-fail-fast", { describe: "run every statement even after one fails (no `set -e`)", type: "boolean", default: false })
      .option("json", { describe: "JSON output (full task object)", type: "boolean", default: false }),
  async handler(argv) {
    await requireAuth()
    const userId = await requireUserId(argv["user-id"] as number | undefined)
    if (!userId) process.exit(1)

    const target = String(argv.target)
    const command = String(argv.command)
    const timeoutSec = Math.max(30, Math.min(3600, Number(argv.timeout) || 300))

    const node = await resolveNode(userId, target)
    if (!node) {
      console.error(`No node matching "${target}". Run: iris hive nodes list`)
      process.exit(1)
    }

    if (!dispatchableConnection(node.connection_status)) {
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
    const failFast = argv["fail-fast"] !== false && !argv["no-fail-fast"]
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

    // From inside an `iris` session, the session that sent this hears it start and gets its report
    // — even with --queue, or when this process is killed mid-wait (#188667).
    const origin = await currentDelegationOrigin()
    // #191559 — wait for a slot unless told not to. A waiting run must START within --timeout
    // (not_after); --queue leaves the deadline to the platform's own bound.
    const waitForSlot = argv["wait-for-slot"] !== false && !argv["no-wait-for-slot"]
    const notAfter = waitForSlot && !argv.queue ? new Date(Date.now() + timeoutSec * 1000).toISOString() : undefined
    const createRes = await hiveFetch(`/api/v6/nodes/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        buildHiveRunBody({ userId, nodeId: node.id, title, script, timeoutSec, priority: clampedPriority, origin, force: Boolean(argv.force), waitForSlot, notAfter }),
      ),
    })

    if (!createRes.ok) {
      console.error(`Task creation failed: ${createRes.status} ${await createRes.text()}`)
      process.exit(1)
    }

    const created = (await createRes.json()) as {
      task: CreatedTask
      dispatched: boolean
    }
    const taskId = created.task.id

    // Fire-and-forget mode: print task id and exit
    if (argv.queue) {
      // #191575 — the created task's STATUS decides what is printed and the exit code: a task the
      // platform refused at creation is not "dispatched", and a fire-and-forget caller must know.
      const q = queuedReport(created.task, node.name)
      if (argv.json) {
        await writeJson({ task_id: taskId, status: created.task.status, dispatched: created.dispatched, error: created.task.error ?? null })
        if (!q.ok) process.exit(q.exitCode)
        return
      }
      if (!q.ok) {
        console.error(q.headline)
        if (q.detail) console.error(`  ${q.detail}`)
        const hint = busyOverrideHint(created.task.error)
        if (hint) console.error(dim(`  ${hint}`))
        process.exit(q.exitCode)
      }
      console.log(success(q.headline))
      if (q.detail) console.log(dim(`  ${q.detail}`))
      if (origin) console.log(dim("  status and report will appear in this session"))
      console.log(dim(`  Check later:  iris hive tasks get ${taskId}`))
      return
    }

    if (!argv.json) {
      // The FULL id. Task ids are UUIDv7 — time-ordered — so tasks created seconds apart share
      // their first 8 characters, and a shortened id here pointed people at the wrong task
      // when they went to look it up or cancel it (#187990).
      console.log(`${dim("→")} task ${taskId}  status=${created.task.status}`)
      if (created.task.status === "pending") console.log(`${dim("→")} ${statusLine(undefined, created.task)}`)
      console.log(dim("waiting for completion..."))
    }

    // Poll EXACTLY the task this dispatch created, by its full id (#187990). See waitForTask.
    let final: any = null
    let lastStatus: string | undefined = created.task.status
    // A run that may wait for a slot first gets that wait on top of its own timeout (#191559).
    const waitedSec = (notAfter ? 2 * timeoutSec : timeoutSec) + 30
    try {
      final = await waitForTask(taskId, {
        initialStatus: created.task.status,
        deadlineMs: waitedSec * 1000,
        fetchTask: async (id) => {
          const r = await hiveFetch(`/api/v6/nodes/tasks/${encodeURIComponent(id)}?user_id=${userId}`)
          if (!r.ok) throw new Error(`Poll failed: ${r.status} ${await r.text()}`)
          return ((await r.json()) as { task: any }).task
        },
        onStatus: (t) => {
          const prev = lastStatus
          lastStatus = t.status
          if (argv.json) return
          // #190219: a terminal status is NOT printed here. The final line below is the one
          // verdict; printing the raw server word too put "status=failed" above "✓ completed".
          // #191560: a task sent back to the queue says so, instead of a bare "status=pending".
          const line = statusLine(prev, t)
          if (line) console.log(`${dim("→")} ${line}`)
        },
      })
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e))
      process.exit(1)
    }

    // #190219: the CLI's own wait ran out. Ask once more before giving up — the task may have
    // finished in the gap — and never call that a task failure: the task is not cancelled.
    let stoppedWaiting = false
    if (!final) {
      stoppedWaiting = true
      try {
        const r = await hiveFetch(`/api/v6/nodes/tasks/${encodeURIComponent(taskId)}?user_id=${userId}`)
        const t = r.ok ? ((await r.json()) as { task: any }).task : null
        if (t && String(t.id ?? taskId) === taskId && TERMINAL_TASK_STATUSES.has(t.status)) final = t
      } catch {
        /* the report below says we stopped waiting */
      }
    }

    if (argv.json) {
      if (final) await writeJson(final)
      else await writeJson({ task_id: taskId, status: "unknown", stopped_waiting_after_s: waitedSec })
      if (!final) process.exit(TIMEOUT_EXIT)
      return
    }

    const report = hiveRunReport(final, taskId, stoppedWaiting ? waitedSec : undefined, lastStatus)
    for (const line of report.lines) console.log(line)

    // Exit with the command's own code, so `iris hive run <node> "..." && next` means what
    // it says. A timeout is 124 (distinct, so CI can retry only those) per the contract.
    const exitCode = report.exitCode
    if (exitCode !== 0) process.exit(exitCode)
  },
})

/**
 * The report `iris hive run` prints once its wait ends (#190219). Pure, so it is tested.
 *
 * Where "failed" + "Request timeout" came from: NOT the CLI. The node daemon's result POST has
 * a 30 s socket timeout (coding-agent-bridge cloud-client.js `Request timeout`); when it fires
 * after the command already finished, the executor's catch re-submits the task as
 * status=failed, error="Request timeout" — while metadata.exit_code still holds the command's
 * real 0. The CLI printed the raw status (→ status=failed), then the error under an
 * "─── error ───" heading, then "✓ completed exit=0", in one output.
 *
 * Now: one final state, taken from the reported exit code (the task's real exit); an error
 * beside a successful exit is a delivery note, not an error; and if the CLI's own wait ran
 * out the line says "stopped waiting after Ns", never "failed".
 */
export function hiveRunReport(
  final: any | null,
  taskId: string,
  stoppedWaitingAfterSec?: number,
  lastStatus?: string,
): { lines: string[]; exitCode: number } {
  const lines: string[] = []
  const footer = dim(`  task ${taskId}  ·  iris hive tasks get ${taskId}`)
  if (!final) {
    // #191560 — say what the platform last said, not "still running": a task its machine had
    // already killed sat "pending" while this line claimed it was running on the node.
    lines.push(
      `  ${dim("…")} stopped waiting after ${stoppedWaitingAfterSec ?? "?"}s  ${dim(`— ${stoppedWaitingNote(lastStatus ?? "running")}`)}`,
    )
    lines.push(footer)
    return { lines, exitCode: TIMEOUT_EXIT }
  }

  const runResult = fromHiveTask(final)
  const exitCode = exitCodeForResult(runResult)
  const verdict = verdictForResult(runResult)

  // renderOutput keeps the TAIL, because the failure is at the bottom of a log, and it
  // distinguishes truncation by the node from truncation here.
  const OUTPUT_LINES = 500
  const out = renderOutput(runResult.stdout, OUTPUT_LINES)
  const err = renderOutput(runResult.stderr, OUTPUT_LINES)

  lines.push("")
  if (out.lines.length) {
    lines.push(bold("─── output ───"))
    lines.push(out.lines.join("\n"))
    if (out.notice) lines.push(dim(`  (${out.notice})`))
  }
  if (err.lines.length) {
    lines.push(bold("─── stderr ───"))
    lines.push(err.lines.join("\n"))
    if (err.notice) lines.push(dim(`  (${err.notice})`))
  }
  if (final.error) {
    if (exitCode === 0) {
      // The command succeeded; the error is about delivering its result, not about running it.
      lines.push(dim(`  note: the node reported "${String(final.error).trim()}" while delivering the result — the command itself exited 0`))
    } else {
      lines.push(bold("─── error ───"))
      lines.push(String(final.error))
      const hint = busyOverrideHint(final.error)
      if (hint) lines.push(dim(`  ${hint}`))
    }
  }
  lines.push("")

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
  const late = stoppedWaitingAfterSec ? `  ${dim(`(stopped waiting after ${stoppedWaitingAfterSec}s; it finished after)`)}` : ""
  lines.push(`  ${tag} ${verdict}  ${dim("exit=")}${exitLabel}  ${dim("duration=")}${final.duration_ms ?? "?"}ms${late}`)
  lines.push(footer)
  return { lines, exitCode }
}

export const HiveNodesCommandExport = HiveNodesCommand
export const HiveRunCommandExport = HiveRunCommand

/** One line about a node's disk when it is a problem, else null (#188700). Exported for tests. */
export function describeDiskLive(d: unknown): string | null {
  if (!d || typeof d !== "object") return null
  const disk = d as { free_gb?: number; total_gb?: number; low?: boolean; last_write_error?: { code?: string; file?: string } }
  const err = disk.last_write_error?.code
    ? ` · last write failed: ${disk.last_write_error.code}${disk.last_write_error.file ? ` (${disk.last_write_error.file})` : ""}`
    : ""
  if (!disk.low && !err) return null
  return `⚠ disk: ${disk.free_gb ?? "?"} GB free of ${disk.total_gb ?? "?"} GB${err}`
}
