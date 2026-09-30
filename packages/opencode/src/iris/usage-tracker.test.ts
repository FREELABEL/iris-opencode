import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { UsageTracker } from "./usage-tracker"

const home = () => mkdtempSync(join(tmpdir(), "iris-track-"))
function capture() {
  const calls: any[] = []
  const fetchImpl = (async (url: any, init: any) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) })
    return new Response("{}", { status: 202 })
  }) as any
  return { calls, fetchImpl }
}
const map = (payload: any, seen = new UsageTracker.Seen()) => UsageTracker.toUsageEvent(payload, seen)

const SECRET = "SECRET-CONTENT /Users/someone/private/file.ts"
const user = {
  id: "msg_u1",
  sessionID: "ses_1",
  role: "user",
  agent: "build",
  model: { providerID: "iris", modelID: "gpt-5-nano" },
  time: { created: 1 },
  summary: { title: SECRET, diffs: [] },
  system: SECRET,
}
const assistant = {
  id: "msg_a1",
  sessionID: "ses_1",
  role: "assistant",
  parentID: "msg_u1",
  modelID: "gpt-5-nano",
  providerID: "iris",
  mode: "build",
  agent: "build",
  path: { cwd: SECRET, root: SECRET },
  cost: 0.01,
  tokens: { input: 1200, output: 300, reasoning: 50, cache: { read: 800, write: 0 } },
  time: { created: 1000, completed: 3500 },
  finish: "stop",
}
const tool = (status: string) => ({
  type: "message.part.updated",
  properties: {
    sessionID: "ses_1",
    part: {
      id: "prt_1",
      type: "tool",
      callID: "call_1",
      tool: "bash",
      state: { status, input: { command: SECRET }, output: SECRET, title: SECRET, time: { start: 100, end: 400 } },
    },
  },
})

describe("desktop usage tracker (#186171)", () => {
  test("a user message becomes message_sent with model and agent — never its content", () => {
    const e = map({ type: "message.updated", properties: { sessionID: "ses_1", info: user } })
    expect(e).toEqual({
      source: "desktop",
      event_type: "message_sent",
      severity: "info",
      model: "gpt-5-nano",
      provider: "iris",
      context: { agent: "build" },
    })
  })

  test("an answer counts once, when finished, with duration and token counts", () => {
    const seen = new UsageTracker.Seen()
    const streaming = { ...assistant, time: { created: 1000 } }
    expect(map({ type: "message.updated", properties: { info: streaming } }, seen)).toBeUndefined()
    const done = map({ type: "message.updated", properties: { info: assistant } }, seen)
    expect(done).toEqual({
      source: "desktop",
      event_type: "response_done",
      severity: "info",
      model: "gpt-5-nano",
      provider: "iris",
      outcome: "ok",
      duration_ms: 2500,
      context: { agent: "build", finish: "stop", tokens_in: 1200, tokens_out: 300, tokens_reasoning: 50, tokens_cache_read: 800 },
    })
    expect(map({ type: "message.updated", properties: { info: assistant } }, seen)).toBeUndefined()
  })

  test("a stopped answer is aborted, a failed one carries only the error's class name", () => {
    const aborted = map({
      type: "message.updated",
      properties: { info: { ...assistant, id: "a2", time: { created: 1 }, error: { name: "MessageAbortedError", data: { message: SECRET } } } },
    })
    expect(aborted?.outcome).toBe("aborted")
    expect(aborted?.context?.error_kind).toBeUndefined()
    const failed = map({
      type: "message.updated",
      properties: { info: { ...assistant, id: "a3", time: { created: 1 }, error: { name: "APIError", data: { message: SECRET } } } },
    })
    expect(failed?.outcome).toBe("error")
    expect(failed?.context?.error_kind).toBe("APIError")
  })

  test("a tool run counts once when it ends, never while pending or running", () => {
    const seen = new UsageTracker.Seen()
    expect(map(tool("running"), seen)).toBeUndefined()
    expect(map(tool("completed"), seen)).toEqual({
      source: "desktop",
      event_type: "tool_run",
      severity: "info",
      tool_name: "bash",
      outcome: "ok",
      duration_ms: 300,
    })
    expect(map(tool("completed"), seen)).toBeUndefined()
    expect(map(tool("error"))?.outcome).toBe("error")
  })

  test("sessions: top-level only; errors: the person pressing stop is not one", () => {
    const info = { id: "ses_1", title: SECRET, directory: SECRET }
    expect(map({ type: "session.created", properties: { sessionID: "ses_1", info } })?.event_type).toBe("session_start")
    expect(map({ type: "session.created", properties: { info: { ...info, id: "ses_2", parentID: "ses_1" } } })).toBeUndefined()
    expect(map({ type: "session.error", properties: { error: { name: "MessageAbortedError" } } })).toBeUndefined()
    expect(map({ type: "session.error", properties: { error: { name: "ProviderAuthError", data: { message: SECRET } } } })).toEqual({
      source: "desktop",
      event_type: "session_error",
      severity: "error",
      context: { error_kind: "ProviderAuthError" },
    })
    expect(map({ type: "permission.replied", properties: { reply: "always" } })?.context).toEqual({ reply: "always" })
  })

  test("nothing from a real payload leaks: no text, paths, titles or tool input", () => {
    const seen = new UsageTracker.Seen()
    const out = [
      map({ type: "message.updated", properties: { info: user } }, seen),
      map({ type: "message.updated", properties: { info: assistant } }, seen),
      map(tool("completed"), seen),
      map({ type: "session.created", properties: { info: { id: "s9", title: SECRET, directory: SECRET } } }, seen),
      map({ type: "message.part.updated", properties: { part: { type: "text", text: SECRET } } }, seen),
      map({ type: "message.part.delta", properties: { delta: SECRET } }, seen),
    ]
    expect(JSON.stringify(out)).not.toContain("SECRET")
    expect(JSON.stringify(out)).not.toContain("/Users/")
  })

  test("batches, flushes at the batch size, and posts source=desktop to the ingest", async () => {
    const { calls, fetchImpl } = capture()
    const t = UsageTracker.create({ token: () => "t", apiBase: "http://capture", version: "1.18.99", env: {}, home: home(), fetchImpl, batchSize: 3 })
    t.observe({ type: "message.updated", properties: { info: user } })
    t.observe({ type: "message.updated", properties: { info: assistant } })
    expect(calls).toHaveLength(0)
    t.observe(tool("completed"))
    await t.flush()
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe("http://capture/api/v6/telemetry/errors")
    expect(calls[0].body.events.map((e: any) => e.event_type)).toEqual(["message_sent", "response_done", "tool_run"])
    expect(t.pending).toBe(0)
  })

  test("opted out, or malformed input: nothing queued, nothing thrown", async () => {
    const { calls, fetchImpl } = capture()
    const h = home()
    mkdirSync(join(h, ".iris"), { recursive: true })
    writeFileSync(join(h, ".iris", "telemetry.json"), JSON.stringify({ enabled: false }))
    const t = UsageTracker.create({ token: () => "t", apiBase: "http://capture", version: "1", env: {}, home: h, fetchImpl })
    t.observe({ type: "message.updated", properties: { info: user } })
    t.observe(null)
    t.observe({ type: "message.updated", properties: { info: null } })
    await t.stop()
    expect(t.pending).toBe(0)
    expect(calls).toEqual([])
  })
})
