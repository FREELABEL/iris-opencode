import { describe, expect, test } from "bun:test"
import { inventoryFromNodes } from "./hive-inventory"

/**
 * Field shapes recorded from `iris hive nodes list --json` on 2026-10-31 (names changed), so a
 * daemon schema change fails here rather than in a plan an agent wrote from a wrong inventory.
 */
const NOW = Date.parse("2026-10-31T05:15:00+00:00")
const SERVER = {
  id: 1,
  name: "server",
  connection_status: "online",
  max_concurrent: 3,
  active_tasks: 1,
  last_heartbeat_at: "2026-10-31T05:14:50+00:00",
  hardware_profile: {
    os: { label: "linux-x64" },
    cpu: { model: "Intel(R) Core(TM) i5-6500 CPU @ 3.20GHz", cores: 4 },
    memory: { total_gb: 31.2 },
    disk: { total_gb: 1873.7, available_gb: 1300 },
    gpu: { name: null, type: null, vram_gb: null, available: false },
  },
  disk_live: { low: false, free_gb: 1317.8, total_gb: 2011.9, updated_at: "2026-10-31T05:14:13+00:00" },
  local_llm: { server: "ollama", available: true, models: ["qwen3:14b", "phi4:latest"] },
  inference: { enabled: true, url: "https://x", models: ["qwen3:14b"], updated_at: "2026-10-31T05:14:13+00:00" },
}
const OFFLINE = {
  name: "laptop",
  connection_status: "offline",
  max_concurrent: 3,
  active_tasks: 0,
  hardware_profile: {
    cpu: { model: "Apple M1 Pro", cores: 10 },
    memory: { total_gb: 16 },
    disk: { total_gb: 460.4, available_gb: 0.1 },
    gpu: { name: "Apple M1 Pro", type: "metal", vram_gb: 16, available: true },
  },
  disk_live: null,
  local_llm: {},
  inference: {},
}

describe("inventoryFromNodes", () => {
  const checks = [{ node_id: "1", state: "ok", ok: true, reason: "Reachable", checked_at: null, model_server_tested: true }]
  const { nodes, summary } = inventoryFromNodes([SERVER, OFFLINE], NOW, checks)
  const server = nodes.find((n) => n.name === "server")!
  const laptop = nodes.find((n) => n.name === "laptop")!

  test("reads the nested hardware profile the daemon sends", () => {
    expect(server).toMatchObject({ online: true, cpu_model: SERVER.hardware_profile.cpu.model, cpu_cores: 4, memory_gb: 31.2 })
  })

  test("prefers the live disk measurement over the startup profile", () => {
    expect(server.free_disk_gb).toBe(1317.8)
  })

  test("free slots are what is left, and an offline machine has none", () => {
    expect(server.free_slots).toBe(2)
    expect(laptop.free_slots).toBe(0)
  })

  test("an offline machine is listed, not hidden, and its old disk number is not presented as current", () => {
    expect(laptop.online).toBe(false)
    expect(laptop.free_disk_gb).toBeNull()
  })

  test("only a model that is reachable counts as serving; installed is not serving", () => {
    expect(server.models_serving).toEqual(["hive/qwen3:14b"])
    expect(server.models_installed).toEqual(["phi4:latest", "qwen3:14b"])
    expect(laptop.models_serving).toEqual([])
  })

  test("a stale inference report does not count as serving", () => {
    const stale = { ...SERVER, inference: { ...SERVER.inference, updated_at: "2026-10-31T04:00:00+00:00" } }
    expect(inventoryFromNodes([stale], NOW, checks).nodes[0].models_serving).toEqual([])
  })

  test("a machine's report with no check through its tunnel does not count as serving (#192146)", () => {
    expect(inventoryFromNodes([SERVER], NOW).nodes[0].models_serving).toEqual([])
    expect(inventoryFromNodes([SERVER], NOW, [{ ...checks[0], state: "tunnel_down", ok: false }]).nodes[0].models_serving).toEqual([])
  })

  test("no GPU, an unreported GPU and a real GPU are three different answers", () => {
    expect(server.gpu).toEqual({ available: false, name: null, type: null, vram_gb: null })
    expect(laptop.gpu).toEqual({ available: true, name: "Apple M1 Pro", type: "metal", vram_gb: 16 })
    expect(inventoryFromNodes([{ name: "bare" }], NOW).nodes[0].gpu).toEqual({ available: null, name: null, type: null, vram_gb: null })
  })

  test("what was never measured is null, never 0", () => {
    const bare = inventoryFromNodes([{ name: "bare", connection_status: "online" }], NOW).nodes[0]
    expect(bare).toMatchObject({ cpu_cores: null, memory_gb: null, free_disk_gb: null, free_slots: null })
  })

  test("the summary adds up only what can take work now", () => {
    expect(summary).toEqual({ nodes: 2, online: 1, free_slots: 2, models_serving: ["hive/qwen3:14b"] })
  })
})
