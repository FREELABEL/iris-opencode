import { describe, test, expect } from "bun:test"
import { agentId, callLine, controlPath, livePath, sendControl, stepLine, unseenCalls } from "./platform-agents-watch"

/**
 * `iris agents watch|take-over|hand-back` (#187921). The paths are the contract with iris-api's
 * AgentRunLiveController; the lines are what answers "is it stuck?" in a terminal.
 */

const run = (over: any = {}) => ({
  run_id: "r-1",
  agent_id: 42,
  status: "running",
  seconds_since_last_event: 2,
  current_step: { iteration: 212, max_iterations: 500, phase: "tool", tool: "drive_rename", seconds_on_step: 2 },
  recent_tool_calls: [],
  takeover: null,
  ...over,
})

describe("requests", () => {
  test("paths", () => {
    expect(livePath(42)).toBe("/api/v1/agents/42/live?limit=10")
    expect(controlPath("r/1", "take-over")).toBe("/api/v1/runs/r%2F1/take-over")
    expect(controlPath("r-1", "hand-back")).toBe("/api/v1/runs/r-1/hand-back")
  })
  test("agent id is validated offline", () => {
    expect(agentId("42")).toBe(42)
    expect(agentId("my-agent")).toHaveProperty("error")
    expect(agentId(undefined)).toHaveProperty("error")
  })
})

describe("stepLine", () => {
  test("says what, which step and how long — not 'Thinking'", () => {
    expect(stepLine(run())).toBe("step 212/500: running drive_rename for 2s")
    expect(stepLine(run({ current_step: { iteration: 3, phase: "thinking", seconds_on_step: 75 } }))).toBe(
      "step 3: deciding next action for 1m 15s",
    )
  })
  test("flags silence, and says who is driving when paused", () => {
    expect(stepLine(run({ seconds_since_last_event: 300 }))).toContain("no activity for 5m 0s, may be stuck")
    expect(stepLine(run({ status: "paused", takeover: { status: "paused" } }))).toContain("PAUSED after step 212/500")
    expect(stepLine(run({ takeover: { status: "pause_requested" } }))).toBe("pausing after step 212/500…")
    expect(stepLine(null)).toBe("nothing running for this agent")
  })
})

describe("tool calls", () => {
  const c = (at: string, status = "success", extra: any = {}) => ({
    tool: "drive_rename", iteration: 1, args: { file_id: "string(2)" }, args_fingerprint: "ab", status, started_at: at, duration_ms: 2100, ...extra,
  })
  test("each finished call is printed once; a running one waits", () => {
    const seen = new Set<string>()
    expect(unseenCalls([c("t1"), c("t2", "running")], seen)).toHaveLength(1)
    expect(unseenCalls([c("t1"), c("t2")], seen).map((x) => x.started_at)).toEqual(["t2"])
    expect(unseenCalls([c("t1"), c("t2")], seen)).toHaveLength(0)
  })
  test("callLine shows argument names only", () => {
    expect(callLine(c("t1"))).toBe("#1 drive_rename success 2.1s (file_id)")
    expect(callLine(c("t1", "error", { error: "token=[redacted]" }))).toBe("#1 drive_rename error 2.1s (file_id) — token=[redacted]")
  })
})

describe("take-over / hand-back against a fake iris-api", () => {
  function fakeServer(current: any) {
    const calls: string[] = []
    const fetcher = async (path: string, init: RequestInit) => {
      calls.push(`${init.method} ${path} ${init.body ?? ""}`.trim())
      const json = (status: number, body: unknown) =>
        new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
      if (/^\/api\/v1\/agents\/42\/live/.test(path)) return json(200, { success: true, run: current })
      if (/^\/api\/v1\/agents\/\d+\/live/.test(path)) return json(404, { message: "Agent not found" })
      if (path === "/api/v1/runs/r-1/take-over") return json(202, { success: true, message: "The agent will pause after the step it is on finishes." })
      if (path === "/api/v1/runs/r-1/hand-back") return json(202, { success: true, message: "Handed back" })
      return json(404, {})
    }
    return { calls, fetcher }
  }

  test("resolves the agent's run, then posts to it; the message rides along on hand-back only", async () => {
    const srv = fakeServer(run())
    const t = await sendControl(42, "take-over", "ignored", srv.fetcher)
    expect("runId" in t && t.runId).toBe("r-1")
    const h = await sendControl(42, "hand-back", "  skip the archive  ", srv.fetcher)
    expect("res" in h && h.res.status).toBe(202)
    expect(srv.calls).toEqual([
      "GET /api/v1/agents/42/live?limit=1",
      "POST /api/v1/runs/r-1/take-over {}",
      "GET /api/v1/agents/42/live?limit=1",
      'POST /api/v1/runs/r-1/hand-back {"message":"skip the archive"}',
    ])
  })

  test("no run, or not yours, is a sentence — and nothing is posted", async () => {
    const idle = fakeServer(null)
    expect(await sendControl(42, "take-over", undefined, idle.fetcher)).toEqual({ error: "This agent has no recent run to take over." })
    const stranger = fakeServer(run())
    expect(await sendControl(7, "hand-back", undefined, stranger.fetcher)).toEqual({ error: "Agent not found (or not yours)." })
    expect(stranger.calls.some((c) => c.startsWith("POST"))).toBe(false)
  })
})
