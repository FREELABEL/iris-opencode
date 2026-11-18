import { describe, expect, test } from "bun:test"
import { buildTaskPayload, busyOverrideHint } from "./hive-task-create"
import { buildHiveRunBody } from "./hive-run-body"
import { hiveRunReport } from "./platform-hive-nodes"

// #191603 — a node the server calls busy from CPU/memory pressure can be overridden with --force.
// The server's own refusal text, measured 2026-10-28 on the MacBook ("CPU at 486%").
const NODE = "01a10379-0c9f-73c5-bf83-157496a21589"
const PRESSURE =
  `Pinned to node ${NODE}, which is busy (CPU at 486%). Refusing to run it on a different machine — ` +
  "pass allow_node_fallback to opt into rerouting to any capable node, or force to send it to this node anyway."
const plain = (lines: string[]) => lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "")

describe("--force on dispatch (#191603)", () => {
  test("tasks create sends force only with a node", () => {
    const base = { userId: 193, type: "sandbox_execute", prompt: "uptime", config: {} }
    expect(buildTaskPayload({ ...base, nodeId: NODE, force: true }).force).toBe(true)
    expect("force" in buildTaskPayload({ ...base, nodeId: NODE })).toBe(false)
    expect("force" in buildTaskPayload({ ...base, force: true })).toBe(false)
  })

  test("hive run sends force when asked, and not otherwise", () => {
    const base = { userId: 193, nodeId: NODE, title: "t", script: "#!/bin/bash\nuptime", timeoutSec: 60 }
    expect(buildHiveRunBody({ ...base, force: true }).force).toBe(true)
    expect("force" in buildHiveRunBody(base)).toBe(false)
  })

  test("a pressure refusal tells the user to rerun with --force", () => {
    expect(busyOverrideHint(PRESSURE)).toContain("rerun with --force")
    expect(busyOverrideHint('{"error":"cannot_rerun","message":"Node \\"mac\\" cannot take the re-run: memory at 93% — pass force"}')).toContain("--force")
  })

  test("no --force hint for a full node, an offline one, or an unrelated error", () => {
    expect(busyOverrideHint(`Pinned to node ${NODE}, which is busy (at capacity (3/3 tasks)).`)).toBeNull()
    expect(busyOverrideHint(`Pinned to node ${NODE}, which is offline or cannot accept work right now.`)).toBeNull()
    expect(busyOverrideHint("Request timeout")).toBeNull()
    expect(busyOverrideHint(undefined)).toBeNull()
  })

  test("hive run's report prints the override under the error", () => {
    const failed = { id: "t1", status: "failed", error: PRESSURE, duration_ms: 0, result: null }
    expect(plain(hiveRunReport(failed, "t1").lines)).toContain("or rerun with --force")
  })
})
