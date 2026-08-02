import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test"

// Stub auth BEFORE importing the beacon: flush() bails out before ever calling
// fetch when there is no iris token, which would leave the assertions below
// silently unexercised on a machine that happens not to be logged in.
mock.module("../src/auth", () => ({
  Auth: { get: async () => ({ key: "test-iris-token" }) },
}))

const { Beacon } = await import("../src/telemetry/beacon")

/**
 * Trace-spine emitter (#178533).
 *
 * The contract that matters here is not "does it POST" — it is that telemetry
 * can never break the thing it observes, and that spans carry SHAPES, never
 * values. Both are asserted below.
 */

const realFetch = globalThis.fetch
let posted: Array<{ url: string; body: any }> = []

beforeEach(() => {
  posted = []
  delete process.env.IRIS_TELEMETRY
  delete process.env.IRIS_MCP
  // Capture what would go on the wire. Combined with the Auth stub above this
  // makes every assertion below run on every machine, logged in or not.
  globalThis.fetch = (async (url: any, init: any) => {
    posted.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : undefined })
    return new Response("{}", { status: 202 })
  }) as any
})

afterEach(async () => {
  globalThis.fetch = realFetch
  await Beacon.flush().catch(() => {})
})

describe("Beacon id generation", () => {
  test("trace ids fit the char(32) column", () => {
    const id = Beacon.newTraceId()
    expect(id.length).toBe(32)
    expect(id).toMatch(/^[0-9a-f]+$/)
  })

  test("span ids fit the char(16) column", () => {
    expect(Beacon.newSpanId().length).toBe(16)
  })

  test("ids do not collide across a realistic burst", () => {
    const ids = new Set(Array.from({ length: 2000 }, () => Beacon.newTraceId()))
    expect(ids.size).toBe(2000)
  })
})

describe("Beacon.span", () => {
  test("never throws, even on a malformed span", () => {
    expect(() => Beacon.span("tool_call", { trace_id: undefined as any })).not.toThrow()
    expect(() => Beacon.span("tool_call", null as any)).not.toThrow()
  })

  test("returns synchronously — it must not block the run it observes", () => {
    const started = Date.now()
    for (let i = 0; i < 500; i++) {
      Beacon.span("tool_call", { trace_id: "t", tool_name: "read", outcome: "ok", duration_ms: 1 })
    }
    expect(Date.now() - started).toBeLessThan(250)
  })

  test("batches a burst into one request rather than one POST per span", async () => {
    for (let i = 0; i < 5; i++) {
      Beacon.span("tool_call", { trace_id: "trace-batch", tool_name: "read", outcome: "ok" })
    }
    await Beacon.flush()

    expect(posted.length).toBe(1)
    expect(posted[0].body.events.length).toBe(5)
    expect(posted[0].url).toContain("/api/v6/telemetry/errors")
  })

  test("honours the IRIS_TELEMETRY opt-out", async () => {
    process.env.IRIS_TELEMETRY = "0"
    Beacon.span("tool_call", { trace_id: "t-off", tool_name: "read", outcome: "ok" })
    await Beacon.flush()
    expect(posted.length).toBe(0)
  })

  test("tags spans as source=mcp when running under MCP", async () => {
    process.env.IRIS_MCP = "1"
    Beacon.span("tool_call", { trace_id: "t-mcp", tool_name: "iris_run", outcome: "ok" })
    await Beacon.flush()
    expect(posted.length).toBe(1)
    expect(posted[0].body.events[0].source).toBe("mcp")
  })

  test("carries shapes, not values — no argument or payload fields on the wire", async () => {
    Beacon.span("tool_call", {
      trace_id: "t-phi",
      tool_name: "read_patient_record",
      outcome: "ok",
      duration_ms: 42,
    })
    await Beacon.flush()

    expect(posted.length).toBe(1)
    const ev = posted[0].body.events[0]
    expect(ev.tool_name).toBe("read_patient_record")
    expect(ev.duration_ms).toBe(42)
    // The span shape has no field capable of carrying an argument value or
    // model output. If one is ever added, this fails and forces the review.
    for (const banned of ["input", "output", "args", "arguments", "prompt", "response", "text", "content"]) {
      expect(ev[banned]).toBeUndefined()
    }
  })

  test("flush is safe to call on an empty buffer", async () => {
    expect(await Beacon.flush()).toBe(true)
    expect(posted.length).toBe(0)
  })
})
