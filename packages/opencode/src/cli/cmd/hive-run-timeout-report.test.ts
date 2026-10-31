import { describe, expect, test } from "bun:test"
import { hiveRunReport } from "./platform-hive-nodes"

// #190219 — the task record the CLI got back on 2026-10-20 (task 01a15ab4-…): the node's own
// result POST hit its 30 s socket timeout after the command finished, so the daemon re-filed
// it as status=failed, error="Request timeout", with metadata.exit_code still 0.
const ID = "01a15ab4-10d5-71f8-b778-85622087a929"
const delivered = { id: ID, status: "failed", error: "Request timeout", duration_ms: 33000, metadata: { exit_code: 0 }, result: { stdout: "ok\n" } }
const plain = (lines: string[]) => lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "")

describe("hiveRunReport (#190219)", () => {
  test("a 33 s command that exited 0 prints no 'failed' and no error heading", () => {
    const r = hiveRunReport(delivered, ID)
    const text = plain(r.lines)
    expect(r.exitCode).toBe(0)
    expect(text).toContain("✓ completed")
    expect(text).not.toContain("failed")
    expect(text).not.toContain("─── error ───")
    expect(text).toContain("Request timeout") // still visible, as a delivery note
  })
  test("a real failure keeps its error block and exit code", () => {
    const r = hiveRunReport({ ...delivered, error: "Process exited with code 3", metadata: { exit_code: 3 } }, ID)
    expect(r.exitCode).toBe(3)
    expect(plain(r.lines)).toContain("─── error ───")
  })
  test("the CLI's own wait running out says 'stopped waiting after Ns', not failed", () => {
    const r = hiveRunReport(null, ID, 90)
    const text = plain(r.lines)
    expect(text).toContain("stopped waiting after 90s")
    expect(text).not.toContain("failed")
    expect(r.exitCode).toBe(124)
  })
  test("a task that finished after the wait reports its real exit", () => {
    const r = hiveRunReport({ ...delivered, error: null }, ID, 90)
    expect(r.exitCode).toBe(0)
    expect(plain(r.lines)).toContain("stopped waiting after 90s")
  })
})

