import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { askAgent, askProvenance } from "./platform-agents-ask"

/**
 * `iris agents ask` (#182785). The request shape is the contract: the same V6 stream and
 * conversation as `iris chat -a`, plus a provenance stamp. Asserted against a mocked fetch so
 * the real request builder (streamAgentChat) and conversation resolver run unmodified.
 */

const AT = new Date("2026-10-19T21:00:00.000Z")
const originalFetch = globalThis.fetch
let calls: Array<{ url: string; method: string; body: any }> = []

function sse(events: unknown[]): Response {
  const text = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("")
  return new Response(text, { status: 200, headers: { "Content-Type": "text/event-stream" } })
}

beforeEach(() => {
  calls = []
  process.env.IRIS_USER_ID = "193"
  process.env.IRIS_API_KEY = "test-token"
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const method = (init.method ?? "GET").toUpperCase()
    calls.push({ url: String(url), method, body: init.body ? JSON.parse(String(init.body)) : null })
    if (String(url).includes("/api/v6/chat/conversation")) {
      return new Response(JSON.stringify({ data: { conversation_id: "conv_642_193" } }), { status: 200, headers: { "Content-Type": "application/json" } })
    }
    if (String(url).endsWith("/api/v6/chat/stream")) {
      return sse([{ type: "thinking" }, { type: "done", content: "The door is closed.", iterations: 1, status: "completed" }])
    }
    return new Response("{}", { status: 404 })
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("askAgent request shape", () => {
  test("joins the agent's canonical conversation and stamps provenance with --from", async () => {
    const r = await askAgent({ agentId: 642, prompt: "is the door closed?", from: 420, now: () => AT })

    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual(["GET /api/v6/chat/conversation", "POST /api/v6/chat/stream"])
    const body = calls[1]!.body
    expect(body.query).toBe("is the door closed?")
    expect(body.agent_id).toBe(642)
    expect(body.user_id).toBe(193)
    expect(body.thread_id).toBe("conv_642_193")
    expect(body.metadata).toEqual({ from_agent_id: 420, via: "cli", at: "2026-10-19T21:00:00.000Z" })

    expect(r).toEqual({ ok: true, answer: "The door is closed.", agent_id: 642, conversation_id: "conv_642_193" })
  })

  test("without --from the stamp still says how it came in, and names no agent", async () => {
    await askAgent({ agentId: 642, prompt: "hi", now: () => AT })
    expect(calls[1]!.body.metadata).toEqual({ via: "cli", at: "2026-10-19T21:00:00.000Z" })
  })

  test("--thread pins the conversation without asking the server for one", async () => {
    const r = await askAgent({ agentId: 642, prompt: "hi", thread: "t-9", now: () => AT })
    expect(calls.map((c) => c.method)).toEqual(["POST"])
    expect(calls[0]!.body.thread_id).toBe("t-9")
    expect(r.conversation_id).toBe("t-9")
  })

  test("askProvenance ignores a non-id --from", () => {
    expect(askProvenance(0, AT)).toEqual({ via: "cli", at: AT.toISOString() })
    expect(askProvenance(Number.NaN, AT)).toEqual({ via: "cli", at: AT.toISOString() })
  })
})

describe("`iris agents ask` is wired", () => {
  const src = readFileSync(join(import.meta.dir, "platform-agents.ts"), "utf8")
  test("registered with --from and --json", () => {
    expect(src).toContain(".command(AgentsAskCommand)")
    expect(src).toMatch(/command: "ask <agent> <prompt>"/)
    expect(src).toMatch(/option\("from"/)
  })
})
