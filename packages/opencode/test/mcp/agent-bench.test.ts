import { describe, expect, test } from "bun:test"
import { matches, parseStream } from "../../script/agent-bench/run"

describe("agent-bench scoring (#193064)", () => {
  test("a call passes only on the right tool and command", () => {
    const accept = [{ tool: "iris_run", command: "^hive tasks" }, { tool: "hive_sessions" }]
    expect(matches({ tool: "iris_run", input: { command: "hive tasks --limit 5" } }, accept)).toBe(true)
    expect(matches({ tool: "iris_run", input: { command: "iris hive tasks" } }, accept)).toBe(true)
    expect(matches({ tool: "iris_run", input: { command: "hive nodes" } }, accept)).toBe(false)
    expect(matches({ tool: "hive_sessions", input: {} }, accept)).toBe(true)
    expect(matches({ tool: "hive_wait", input: {} }, accept)).toBe(false)
  })
  test("action-matched tools", () => {
    expect(matches({ tool: "iris_memory", input: { action: "search" } }, [{ tool: "iris_memory", action: "search" }])).toBe(true)
    expect(matches({ tool: "iris_memory", input: { action: "add" } }, [{ tool: "iris_memory", action: "search" }])).toBe(false)
  })
  test("only IRIS tool calls are read from the stream, plus the final result", () => {
    const lines = [
      JSON.stringify({ type: "system", subtype: "init" }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "ok" }, { type: "tool_use", name: "mcp__iris__iris_run", input: { command: "hive nodes" } }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "mcp__other__x", input: {} }] } }),
      "not json",
      JSON.stringify({ type: "result", num_turns: 3, total_cost_usd: 0.01, is_error: false }),
    ].join("\n")
    const { calls, result } = parseStream(lines)
    expect(calls).toEqual([{ tool: "iris_run", input: { command: "hive nodes" } }])
    expect(result.num_turns).toBe(3)
  })
})
