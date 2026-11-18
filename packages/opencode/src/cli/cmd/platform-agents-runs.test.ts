import { describe, test, expect } from "bun:test"
import { ms, reasonLines, runLine, runPath, runRef, runsPath, scoreText, stepText } from "./platform-agents-runs"

/**
 * `iris agents runs|replay` (#190085). The paths are the contract with iris-api's
 * AgentRunsController; the lines are what a person reads when a run went badly.
 */

describe("requests", () => {
  test("paths", () => {
    expect(runsPath({})).toBe("/api/v6/agent-runs?limit=20")
    expect(runsPath({ agent: 42, flagged: true, days: 7, limit: 5 })).toBe("/api/v6/agent-runs?agent_id=42&flagged=1&days=7&limit=5")
    expect(runPath("3f9c2a1b")).toBe("/api/v6/agent-runs/3f9c2a1b")
  })
  test("a run reference is checked offline — 8+ hex characters", () => {
    expect(runRef("3F9C2A1B")).toBe("3f9c2a1b")
    expect(runRef("3f9c2a1b-0b1c-4d2e-9f00-123456789abc")).toBe("3f9c2a1b-0b1c-4d2e-9f00-123456789abc")
    expect(runRef("3f9c")).toHaveProperty("error")
    expect(runRef("my-run!!")).toHaveProperty("error")
    expect(runRef(undefined)).toHaveProperty("error")
  })
})

describe("lines", () => {
  test("durations and scores", () => {
    expect(ms(240)).toBe("240ms")
    expect(ms(2400)).toBe("2.4s")
    expect(ms(75_000)).toBe("1m 15s")
    expect(ms(undefined)).toBe("—")
    expect(scoreText(0.6)).toBe("0.60")
    expect(scoreText(null)).toBe("—")
  })

  test("a run line leads with the flag, the id prefix and the score", () => {
    const line = runLine({ run_id: "3f9c2a1b-0000", score: 0.4, status: "completed", agent_name: "Support agent", tool_calls: 3, tool_errors: 1, duration_ms: 4200, flagged: true, source: "slack" })
    expect(line.startsWith("⚑ 3f9c2a1b  0.40  completed")).toBe(true)
    expect(line).toContain("3 tools (1 failed), 4.2s")
  })

  test("a replay step shows argument names, never values, and skips bare iteration markers", () => {
    expect(stepText({ type: "iteration", iteration: 1, at_ms: 0 })).toBeNull()
    expect(stepText({ type: "tool_call", iteration: 1, at_ms: 400, tool: "lookup_customer", detail: { args: { email: "string(20)" }, fingerprint: "ab12cd34" } }))
      .toBe("  +400ms #1 → lookup_customer(email)")
    expect(stepText({ type: "tool_result", iteration: 1, at_ms: 1600, tool: "lookup_customer", status: "error", duration_ms: 1200, detail: { error: "CRM timed out" } }))
      .toBe("   +1.6s #1 ← lookup_customer error 1.2s — CRM timed out")
    expect(stepText({ type: "tool_skipped", iteration: 2, at_ms: 2000, tool: "lookup_customer", status: "skipped" })).toContain("skipped (same call again)")
    expect(stepText({ type: "done", iteration: 3, at_ms: 4200, status: "completed", detail: { chars: 21 } })).toBe("   +4.2s #3 done: completed (21 chars)")
  })

  test("each deduction is explained", () => {
    expect(reasonLines({ score_reasons: [{ code: "tool_errors", points: 0.4, detail: "1 of 1 tool calls failed" }] })).toEqual(["−0.40  1 of 1 tool calls failed"])
    expect(reasonLines({})).toEqual([])
  })
})
