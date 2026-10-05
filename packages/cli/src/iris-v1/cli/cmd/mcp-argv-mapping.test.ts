import { describe, expect, test } from "bun:test"
import { buildAgentAskArgs } from "./mcp-serve"

/**
 * THE ARGV-MAPPING TEST. A declared input must actually reach the child process.
 *
 * `--thread` and `--fresh` were declared in iris_agent's inputSchema, documented, visible to
 * every caller — and never forwarded. They shipped INERT. Nothing catches that class:
 *   - types don't: MCP args arrive as `unknown` in a JSON blob
 *   - --help doesn't: it renders the SCHEMA, not the mapping
 *   - running the tool doesn't: it succeeds either way, it just ignores you
 * The only witness is the argv itself, which is why buildAgentAskArgs returns a value.
 *
 * These assert MAPPING, not behaviour: that what a caller asked for appears in the argv the
 * CLI is invoked with. That is precisely the step that was missing.
 */
describe("iris_agent ask → iris chat argv", () => {
  const base = { agentId: 642, message: "what is MRR?", timeoutSecs: 120 }

  test("a named thread reaches argv as --thread", () => {
    const r = buildAgentAskArgs({ ...base, thread: "q3-planning" })

    expect(r.ok).toBe(true)
    if (!r.ok) return
    // The regression itself: this used to be accepted and dropped.
    expect(r.args).toContain("--thread")
    expect(r.args[r.args.indexOf("--thread") + 1]).toBe("q3-planning")
    expect(r.thread).toBe("q3-planning")
  })

  test("fresh:true synthesises a thread and forwards it", () => {
    const r = buildAgentAskArgs({ ...base, fresh: true, threadSuffix: "deadbeef" })

    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.thread).toBe("fresh_deadbeef")
    expect(r.args[r.args.indexOf("--thread") + 1]).toBe("fresh_deadbeef")
  })

  test("an explicit thread wins over fresh, as the schema promises", () => {
    // The tool description says fresh is "Ignored if `thread` is given". A description that
    // disagrees with the mapping is the same defect one layer up.
    const r = buildAgentAskArgs({ ...base, thread: "keep-me", fresh: true, threadSuffix: "x" })

    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.thread).toBe("keep-me")
  })

  test("neither thread nor fresh means no --thread at all", () => {
    const r = buildAgentAskArgs({ ...base })

    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.args).not.toContain("--thread")
    expect(r.thread).toBeNull()
  })

  test("model reaches argv as -m, and timeout as --timeout", () => {
    const r = buildAgentAskArgs({ ...base, timeoutSecs: 300, model: "gpt-4.1-nano" })

    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.args[r.args.indexOf("-m") + 1]).toBe("gpt-4.1-nano")
    expect(r.args[r.args.indexOf("--timeout") + 1]).toBe("300")
  })

  test("a model carrying shell metacharacters is refused, not escaped", () => {
    const r = buildAgentAskArgs({ ...base, model: "nano; rm -rf /" })

    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain("invalid characters")
  })

  test("the message is always last so it cannot be read as a flag value", () => {
    const r = buildAgentAskArgs({ ...base, thread: "t", model: "gpt-4.1-nano" })

    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.args[r.args.length - 1]).toBe("what is MRR?")
  })

  test("a non-string thread is ignored rather than stringified into argv", () => {
    // `unknown` in, argv out. {} would otherwise become "[object Object]" — a thread id that
    // is silently wrong is worse than one that is absent.
    const r = buildAgentAskArgs({ ...base, thread: { evil: true } })

    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.args).not.toContain("--thread")
  })
})
