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
let posted: Array<{ url: string; body: any; auth?: string }> = []

beforeEach(() => {
  posted = []
  delete process.env.IRIS_TELEMETRY
  delete process.env.IRIS_MCP
  // Capture what would go on the wire. Combined with the Auth stub above this
  // makes every assertion below run on every machine, logged in or not.
  globalThis.fetch = (async (url: any, init: any) => {
    posted.push({
      url: String(url),
      body: init?.body ? JSON.parse(init.body) : undefined,
      // Captured because WHICH token attributed the row is the whole point of
      // the resolution tests below — asserting only on the body would let a
      // wrong-identity regression through.
      auth: init?.headers?.Authorization,
    })
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

/**
 * Token resolution — the bug that made the whole MCP beta invisible.
 *
 * flush() used to read the token from Auth.get("iris") alone, which only ever
 * looks at auth.json on disk. iris-exec spawns the binary in a container with
 * IRIS_API_KEY in the ENVIRONMENT and no auth.json, so every span from the
 * connector was dropped at `if (!key) return false` — silently, by design, since
 * telemetry may never complain. The tests below are the regression guard: they
 * describe the two environments the binary actually runs in.
 */
describe("Beacon token resolution", () => {
  const saved = { key: process.env.IRIS_API_KEY, fl: process.env.FL_API_TOKEN, home: process.env.HOME }

  const restore = (k: "IRIS_API_KEY" | "FL_API_TOKEN" | "HOME", v: string | undefined) => {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }

  afterEach(() => {
    restore("IRIS_API_KEY", saved.key)
    restore("FL_API_TOKEN", saved.fl)
    restore("HOME", saved.home)
  })

  test("attributes spans from IRIS_API_KEY when there is no auth.json (the MCP case)", async () => {
    process.env.IRIS_API_KEY = "env-mcp-token"
    Beacon.span("run_start", { trace_id: "t-env", command: "leads" })
    await Beacon.flush()

    expect(posted.length).toBe(1)
    expect(posted[0].auth).toBe("Bearer env-mcp-token")
  })

  test("prefers the environment over the stored token", async () => {
    // A caller that set IRIS_API_KEY for this process means THAT identity — the
    // container runs one user's command with one user's minted key, and whatever
    // happens to be cached on the box is not it. Auth is stubbed at the top of
    // this file to return "test-iris-token", so the env value winning is the
    // observable difference.
    process.env.IRIS_API_KEY = "env-wins"
    Beacon.span("run_start", { trace_id: "t-pref", command: "pages" })
    await Beacon.flush()

    expect(posted.length).toBe(1)
    expect(posted[0].auth).toBe("Bearer env-wins")
  })

  test("falls back to the stored token when the environment carries none", async () => {
    delete process.env.IRIS_API_KEY
    delete process.env.FL_API_TOKEN
    Beacon.span("run_start", { trace_id: "t-stored", command: "bug" })
    await Beacon.flush()

    expect(posted.length).toBe(1)
    expect(posted[0].auth).toBe("Bearer test-iris-token")
  })

  test("accepts FL_API_TOKEN when IRIS_API_KEY is absent", async () => {
    delete process.env.IRIS_API_KEY
    process.env.FL_API_TOKEN = "fl-token"
    Beacon.span("run_start", { trace_id: "t-fl", command: "leads" })
    await Beacon.flush()

    expect(posted.length).toBe(1)
    expect(posted[0].auth).toBe("Bearer fl-token")
  })

  // The join between a run and what it cost rests entirely on this being stable.
  // If two callers in one process get two ids, the run_start span says one thing,
  // the X-Iris-Trace-Id header on the model-proxy call says another, and the spend
  // row points at a run that never existed — silently, and unrecoverably, because
  // nothing downstream can tell a wrong trace id from a right one. (#179797)
  test("traceId() is stable across callers within a process", () => {
    const first = Beacon.traceId()
    const second = Beacon.traceId()

    expect(first).toBe(second)
    expect(first).toMatch(/^[0-9a-f]{32}$/)
  })

  test("newTraceId() still mints a fresh id, and is not the process id", () => {
    const process1 = Beacon.traceId()
    const fresh = Beacon.newTraceId()

    expect(fresh).not.toBe(process1)
    expect(Beacon.traceId()).toBe(process1)
  })

  // NOT TESTED HERE: "sends nothing when no token exists anywhere". The last leg
  // of the cascade reads ~/.iris/sdk/.env, and Bun caches os.homedir() at first
  // call, so HOME cannot be redirected at an empty dir from inside a test — the
  // result would depend on whether the machine running it happens to be logged
  // in. That branch (`if (!key) return false`) is unchanged from before the
  // cascade existed; what regressed, and what is guarded above, is precedence.
})
