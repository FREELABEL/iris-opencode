import { describe, expect, test } from "bun:test"
import { formatHardware, hwAge } from "./platform-hive-nodes"

/**
 * `iris hive nodes show` printed every node's hardware as
 * `? cores · ?GB · [object Object]` (#184614) — every field broken at once, on two
 * different machines, while the daemon logged the right values at startup.
 *
 * The renderer read a FLAT profile; the daemon has sent a NESTED one since
 * schema_version 2. `[object Object]` is the tell: a nested object concatenated
 * rather than read.
 *
 * The measured payload, kept verbatim so a schema change fails here rather than in
 * front of someone choosing a node.
 */
const REAL = {
  detected_at: "2026-09-11T07:02:54.840Z",
  os: { platform: "darwin", arch: "arm64", release: "24.1.0", type: "Darwin", label: "darwin-arm64" },
  cpu: { model: "Apple M1 Pro", cores: 10, speed_mhz: 2400 },
  memory: { total_bytes: 17179869184, total_gb: 16 },
  disk: { total_gb: 460.4, available_gb: 0.1 },
  gpu: { available: true, type: "metal", name: "Apple M1 Pro", vram_gb: 16 },
  ollama: { available: true, model_count: 2, models: [{ name: "qwen3:4b" }, { name: "qwen3-coder:480b-cloud" }] },
}

describe("formatHardware", () => {
  test("reads the nested schema the daemon actually sends", () => {
    const hardware = formatHardware(REAL).find((l) => l.label === "hardware:")!.value
    expect(hardware).toBe("Apple M1 Pro · 10 cores · 16GB · darwin-arm64")
  })

  test("never emits [object Object] — the original symptom", () => {
    for (const line of formatHardware(REAL)) expect(line.value).not.toContain("[object Object]")
  })

  test("still renders an OLDER flat-profile daemon", () => {
    const flat = { cpu_cores: 8, memory_gb: 32, platform: "linux", arch: "x64" }
    expect(formatHardware(flat)[0].value).toBe("8 cores · 32GB · linux-x64")
  })

  /**
   * "?" per field is what made this read as missing data rather than a broken
   * renderer, for long enough that it got filed as a bug.
   */
  test("a genuinely empty profile says so, instead of printing question marks", () => {
    expect(formatHardware({})[0].value).toBe("not reported by this node")
    expect(formatHardware(null)[0].value).toBe("not reported by this node")
  })

  test("a GPU that is present is shown; one that is absent is not invented", () => {
    expect(formatHardware(REAL).some((l) => l.label === "gpu:")).toBe(true)
    expect(formatHardware({ ...REAL, gpu: { available: false } }).some((l) => l.label === "gpu:")).toBe(false)
  })

  test("disk carries when it was measured — a boot-time snapshot is not a current reading", () => {
    const disk = formatHardware(REAL).find((l) => l.label === "disk:")!.value
    expect(disk).toContain("0.1GB free of 460.4GB")
    expect(disk).toContain("measured")
  })

  test("a string-typed number still renders — some daemons send them quoted", () => {
    expect(formatHardware({ cpu: { cores: "10" }, memory: { total_gb: "16" } })[0].value).toBe("10 cores · 16GB")
  })
})

describe("hwAge", () => {
  const now = new Date("2026-09-11T23:02:54Z")
  test("reports hours and days for a real stamp", () => {
    expect(hwAge("2026-09-11T07:02:54.840Z", now)).toBe("15h ago") // floors, never rounds up
    expect(hwAge("2026-09-08T07:02:54.840Z", now)).toBe("3d ago")
  })
  test("refuses to answer rather than guessing", () => {
    expect(hwAge(null)).toBeNull()
    expect(hwAge("whenever")).toBeNull()
    expect(hwAge("2026-12-01T00:00:00Z", now)).toBeNull() // a future stamp is not "0m ago"
  })
})
