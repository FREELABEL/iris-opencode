import { describe, expect, test } from "bun:test"
import golden from "./hive-scripts.golden.json"
import { clampTimeout, pickNode, readDoctor, readSource, readTask, scriptDigest, TERMINAL } from "@/iris/hive-scripts"

// #188817 — the sidecar's reading of iris-api for Hive › Scripts. Real payloads: the run of
// console-demo on iris-hive-001 (2026-10-09 21:19:32 UTC) and mambo-status's doctor verdict.

describe("readTask", () => {
  test("the real run: stage timestamps, stdout, exit code from result.metadata", () => {
    const t = readTask(golden.task)!
    expect(t.status).toBe("completed")
    expect(t.terminal).toBe(true)
    expect(t.createdAt).toBe("2026-10-09T21:19:32+00:00")
    expect(t.arrivedAt).toBe("2026-10-09T21:19:32.722Z")
    expect(t.completedAt).toBe("2026-10-09T21:19:55+00:00")
    expect(t.stdout.split("\n")).toEqual(["console demo starting on ca93b63ecc77", "console demo done"])
    expect(t.stderr).toBe("")
    expect(t.exitCode).toBe(0)
    expect(t.exitCodeSource).toBe("metadata")
    expect(t.nodeName).toBe("iris-hive-001")
  })
  test("a running task is not terminal and has no exit code", () => {
    const t = readTask({ ...golden.task, status: "running", completed_at: null, result: null, metadata: null })!
    expect(t.terminal).toBe(false)
    expect(t.exitCode).toBeNull()
    expect(t.completedAt).toBeNull()
    expect(t.stdout).toBe("")
  })
  test("the separated stream wins over the merged one", () => {
    const t = readTask({ id: "x", status: "completed", result: { output: "a\nb", stdout: "a", stderr: "b" } })!
    expect(t.stdout).toBe("a")
    expect(t.stderr).toBe("b")
  })
  test("an exit code recovered from prose is labelled as inferred", () => {
    const t = readTask({ id: "x", status: "failed", error: "Process exited with code 42" })!
    expect(t.exitCode).toBe(42)
    expect(t.exitCodeSource).toBe("error_text")
  })
  test("unknown statuses are not terminal successes", () => {
    expect(TERMINAL.has("dispatched")).toBe(false)
    // a task between stages is still live — the panel keeps polling it
    for (const status of ["pending", "queued", "dispatched", "assigned"]) expect(readTask({ id: "x", status })!.terminal).toBe(false)
    expect(readTask({ id: "x", status: "succeeded" })!.terminal).toBe(true)
    expect(readTask(null)).toBeNull()
  })
})

describe("readDoctor", () => {
  test("keeps the hub's count and every unmet reason", () => {
    const d = readDoctor(golden.doctor)!
    expect(d.slug).toBe("mambo-status")
    expect(d.requires).toEqual(["bluetooth", "python3"])
    expect(d.eligible_online).toBe(0)
    expect(d.blocked.length).toBe(5)
    expect(d.blocked[0].verdict?.unmet?.[0].requirement).toBe("bluetooth")
  })
  test("a missing count is null, never zero", () => {
    expect(readDoctor({ slug: "x" })!.eligible_online).toBeNull()
  })
})

describe("run", () => {
  test("source is hashed the way the CLI pins it", () => {
    const s = readSource({ slug: "a", script_content: "echo hi\n", runtime: "bash", auto_pull: 0 })!
    expect(s.sha256).toBe(scriptDigest("echo hi\n"))
    expect(s.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(s.autoPull).toBe(false)
  })
  test("the hash of the real run's script matches what the hub recorded", () => {
    const content = '#!/bin/bash\n# iris: arg=seconds default=20\n# iris: timeout=120\n# A harmless demo for the Hive console: prints, waits, prints again.\necho "console demo starting on $(hostname)"\nsleep "${SECONDS_ARG:-${SECONDS:-20}}"\necho "console demo done"'
    expect(scriptDigest(content)).toBe(golden.task.config.script_sha256)
  })
  test("node resolution: id, name, id prefix, name prefix", () => {
    const nodes = [
      { id: "01a1-mac", name: "Alexs-MacBook-Pro-11711" },
      { id: "01a1-hive", name: "iris-hive-001" },
    ]
    expect(pickNode(nodes, "01a1-hive")?.name).toBe("iris-hive-001")
    expect(pickNode(nodes, "IRIS-HIVE-001")?.id).toBe("01a1-hive")
    expect(pickNode(nodes, "01a1-m")?.name).toBe("Alexs-MacBook-Pro-11711")
    expect(pickNode(nodes, "alexs")?.id).toBe("01a1-mac")
    expect(pickNode(nodes, "nope")).toBeUndefined()
  })
  test("timeout clamps like the CLI", () => {
    expect(clampTimeout(undefined)).toBe(120)
    expect(clampTimeout(5)).toBe(30)
    expect(clampTimeout(99999)).toBe(3600)
    expect(clampTimeout(600)).toBe(600)
  })
})
