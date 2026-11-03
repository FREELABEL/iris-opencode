import { cmd } from "./cmd"
import { requireAuth, requireUserId, writeJson, dim, bold, success } from "./iris-api"
import { fleet, inferenceChecks, rowsFromNodes, type InferenceCheck } from "./platform-hive-models"

/**
 * `iris hive inventory` — the machines you own as one planning answer (#191914).
 *
 * Asked to design a system, an agent reaches for cloud because nothing puts your own hardware in
 * front of it. The fleet already reports all of this; `nodes list --json` carries it inside a full
 * per-node record of sessions and schedules. This is the part a plan needs.
 *
 * Absent is not equal: what was never measured is null, never 0, so a plan cannot read "unknown
 * disk" as "no disk" or "unknown GPU" as "no GPU".
 */

export interface InventoryNode {
  name: string
  online: boolean
  os: string | null
  cpu_model: string | null
  cpu_cores: number | null
  memory_gb: number | null
  gpu: { available: boolean | null; name: string | null; type: string | null; vram_gb: number | null }
  free_disk_gb: number | null
  free_slots: number | null
  models_serving: string[]
  models_installed: string[]
  last_heartbeat_at: string | null
}

const num = (v: unknown) => (typeof v === "number" ? v : null)

/** Pure, so it is tested without a fleet. */
export function inventoryFromNodes(raw: any[], now = Date.now(), checks?: InferenceCheck[] | null) {
  const nodes: InventoryNode[] = raw.map((n) => {
    const hw = n?.hardware_profile ?? {}
    const online = n?.connection_status === "online" || n?.connection_status === "busy"
    const rows = rowsFromNodes([n], now, checks)
    const max = num(n?.max_concurrent)
    const active = num(n?.active_tasks)
    return {
      name: String(n?.name ?? n?.id ?? "?"),
      online,
      os: hw.os?.label ?? null,
      cpu_model: hw.cpu?.model ?? null,
      cpu_cores: num(hw.cpu?.cores),
      memory_gb: num(hw.memory?.total_gb),
      gpu: {
        available: typeof hw.gpu?.available === "boolean" ? hw.gpu.available : null,
        name: hw.gpu?.name ?? null,
        type: hw.gpu?.type ?? null,
        vram_gb: num(hw.gpu?.vram_gb),
      },
      // The startup profile is days old on a machine that has not restarted, so it is only a
      // fallback for a machine that is up. On an offline one it would read as current.
      free_disk_gb: num(n?.disk_live?.free_gb) ?? (online ? num(hw.disk?.available_gb) : null),
      free_slots: !online ? 0 : max === null || active === null ? null : Math.max(0, max - active),
      models_serving: rows.filter((r) => r.reachable).map((r) => `hive/${r.model}`),
      models_installed: rows.map((r) => r.model),
      last_heartbeat_at: n?.last_heartbeat_at ?? null,
    }
  })
  const up = nodes.filter((n) => n.online)
  return {
    nodes,
    summary: {
      nodes: nodes.length,
      online: up.length,
      free_slots: up.reduce((sum, n) => sum + (n.free_slots ?? 0), 0),
      models_serving: [...new Set(up.flatMap((n) => n.models_serving))].sort(),
    },
  }
}

const shown = (v: number | null, unit: string) => (v === null ? "?" : `${Math.round(v)}${unit}`)

export const HiveInventoryCommand = cmd({
  command: "inventory",
  describe: "the machines you own as one answer for planning — compute, GPU, disk, free slots, models serving now",
  builder: (yargs) =>
    yargs
      .option("json", { type: "boolean", default: false })
      .option("user-id", { type: "number" })
      .example("$0 hive inventory --json", "read this before designing a system, to place it on hardware you own"),
  async handler(argv) {
    await requireAuth()
    const userId = await requireUserId(argv["user-id"] as number | undefined)
    if (!userId) process.exit(1)
    const [raw, checks] = await Promise.all([fleet(userId), inferenceChecks(userId)])
    const { nodes, summary } = inventoryFromNodes(raw, Date.now(), checks)
    if (argv.json) return void (await writeJson({ nodes, summary }))
    console.log()
    if (!nodes.length) return void console.log(dim("  No machines yet. Connect one: iris how-to view hive-dispatch"))
    for (const n of nodes) {
      const gpu = n.gpu.available === null ? "GPU ?" : n.gpu.available ? (n.gpu.name ?? "GPU") : "no GPU"
      console.log(`  ${n.online ? success("●") : dim("○")} ${bold(n.name.padEnd(26))} ${shown(n.cpu_cores, " cores").padEnd(9)} ${shown(n.memory_gb, "GB").padEnd(6)} ${shown(n.free_disk_gb, "GB free").padEnd(11)} ${gpu}`)
      if (n.online) console.log(dim(`    ${n.free_slots ?? "?"} free slots · ${n.models_serving.join(", ") || "no models serving"}`))
    }
    console.log()
    console.log(dim(`  ${summary.online} of ${summary.nodes} online · ${summary.free_slots} free slots · ${summary.models_serving.length} models serving`))
  },
})
