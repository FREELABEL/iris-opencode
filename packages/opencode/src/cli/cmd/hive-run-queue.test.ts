import { describe, expect, test } from "bun:test"
import { buildHiveRunBody, dispatchableConnection, queuedReport, statusLine, stoppedWaitingNote } from "./hive-run-body"

/**
 * `iris hive run` against a full or busy node (epic #191642 phase 0), measured 2026-10-28 from
 * iris-hive-001 to iris-hive-002 (3 slots).
 */
const base = { userId: 193, nodeId: "01a1801e-0000-7000-8000-000000000001", title: "iris hive run: sleep", script: "#!/bin/bash\nsleep 2", timeoutSec: 60 }

describe("#191559 — at capacity, wait for a slot instead of failing", () => {
  test("a run asks the platform to queue it on a full node, and bounds the wait", () => {
    const body = buildHiveRunBody({ ...base, waitForSlot: true, notAfter: "2026-10-28T06:00:00.000Z" })
    expect(body.allow_busy_queue).toBe(true)
    expect(body.not_after).toBe("2026-10-28T06:00:00.000Z")
  })

  test("--no-wait-for-slot sends neither", () => {
    const body = buildHiveRunBody({ ...base, waitForSlot: false })
    expect("allow_busy_queue" in body).toBe(false)
    expect("not_after" in body).toBe(false)
  })

  test("a FULL node is dispatchable — only a disconnected one is refused by the CLI", () => {
    // `busy` is what the platform calls a node with every slot taken. `--queue` printed
    // "Node is busy … Cannot dispatch" (rc=2) and queued nothing.
    expect(dispatchableConnection("busy")).toBe(true)
    expect(dispatchableConnection("online")).toBe(true)
    expect(dispatchableConnection("offline")).toBe(false)
    expect(dispatchableConnection(undefined)).toBe(false)
  })

  test("a queued run says it is queued and why", () => {
    expect(statusLine(undefined, { status: "pending", queued_reason: "busy (at capacity (3/3 tasks))" })).toBe(
      "queued — waiting for a free slot (busy (at capacity (3/3 tasks)))",
    )
  })
})

describe("#191575 — --queue never reports a refused task as dispatched", () => {
  test("a task the platform already failed is ✗ with its reason and a non-zero exit", () => {
    const r = queuedReport(
      { id: "01a180e9-c416", status: "failed", error: "Pinned to node 01a1801e, which is busy (CPU at 149%). Refusing to run it on a different machine" },
      "iris-hive-002",
    )
    expect(r.ok).toBe(false)
    expect(r.exitCode).not.toBe(0)
    expect(r.headline).toContain("✗")
    expect(r.headline).not.toContain("dispatched")
    expect(r.detail).toContain("CPU at 149%")
  })

  test("an expired task is not queued either", () => {
    expect(queuedReport({ id: "t", status: "expired" }, "n").exitCode).toBe(1)
  })

  test("a task waiting for a slot is reported QUEUED, with the reason", () => {
    const r = queuedReport({ id: "t", status: "pending", queued_reason: "busy (at capacity (3/3 tasks))" }, "iris-hive-002")
    expect(r).toMatchObject({ ok: true, exitCode: 0 })
    expect(r.headline).toContain("queued")
    expect(r.detail).toContain("at capacity (3/3 tasks)")
  })

  test("a task sent straight away is still dispatched", () => {
    expect(queuedReport({ id: "t", status: "dispatched" }, "n")).toMatchObject({ ok: true, exitCode: 0 })
  })
})

describe("#191560 — the CLI says what happened to a dropped task", () => {
  test("a task that goes back to pending after it was sent is called requeued, not 'pending'", () => {
    expect(statusLine("running", { status: "pending", progress: 1 })).toContain("requeued")
    expect(statusLine("dispatched", { status: "pending" })).toContain("requeued")
  })

  test("stopping the wait never claims a queued task is running on the node", () => {
    expect(stoppedWaitingNote("pending")).not.toContain("running on the node")
    expect(stoppedWaitingNote("pending")).toContain("not started")
    expect(stoppedWaitingNote("running")).toContain("running")
  })

  test("terminal statuses print no progress line (the final verdict does)", () => {
    for (const s of ["failed", "completed", "expired", "cancelled"]) expect(statusLine("running", { status: s })).toBeNull()
  })
})

describe("the command uses these rules", () => {
  const src = require("fs").readFileSync(require("path").join(__dirname, "platform-hive-nodes.ts"), "utf8") as string
  test("--queue decides from the created task's status", () => {
    expect(src).toMatch(/const q = queuedReport\(created\.task, node\.name\)/)
    expect(src).not.toMatch(/success\("✓"\)\} dispatched task/)
  })
  test("the connection check lets a full node through", () => {
    expect(src).toMatch(/if \(!dispatchableConnection\(node\.connection_status\)\)/)
  })
  test("a run waits for a slot unless told not to", () => {
    expect(src).toMatch(/waitForSlot, notAfter \}\)/)
  })
})
