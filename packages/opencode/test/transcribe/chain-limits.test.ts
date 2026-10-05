import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { ChainError, effectiveEngines, transcribeWithFallback } from "../../src/transcribe/chain"

// A stand-in for the IRIS platform that can answer with headers and a provider of its choosing,
// so the chain's handling of server LIMITS (413, 429 Retry-After) and of the provider the
// platform says it actually used can be pinned down.
type Reply = { status: number; retryAfter?: string; provider?: string | null; message?: string }
const script: Record<string, Reply[]> = {}
const calls: { provider: string; at: number }[] = []
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const provider = String((await req.formData()).get("provider"))
    calls.push({ provider, at: Date.now() })
    const reply = script[provider]?.shift() ?? { status: 500 }
    const headers: Record<string, string> = reply.retryAfter ? { "retry-after": reply.retryAfter } : {}
    if (reply.status === 200)
      return Response.json(
        {
          success: true,
          data: reply.provider === null ? { text: `heard` } : { text: `heard`, provider: reply.provider ?? provider },
        },
        { headers },
      )
    return Response.json(
      { success: false, message: reply.message ?? `${provider} said ${reply.status}` },
      { status: reply.status, headers },
    )
  },
})
afterAll(() => server.stop(true))
const savedProviders = process.env["IRIS_TRANSCRIBE_PROVIDERS"]
beforeEach(() => {
  calls.length = 0
  for (const k of Object.keys(script)) delete script[k]
  delete process.env["IRIS_TRANSCRIBE_PROVIDERS"]
})
afterEach(() => {
  if (savedProviders === undefined) delete process.env["IRIS_TRANSCRIBE_PROVIDERS"]
  else process.env["IRIS_TRANSCRIBE_PROVIDERS"] = savedProviders
})

const remote = { apiUrl: `http://127.0.0.1:${server.port}`, bloqId: "42" }
const audio = new Uint8Array([1, 2, 3, 4])
const run = (extra: Partial<Parameters<typeof transcribeWithFallback>[1]> = {}) =>
  transcribeWithFallback(audio, { filename: "d.wav", remote, local: false, backoffMs: [1, 1], ...extra })

describe("provider order", () => {
  test("defaults to Grok, then OpenRouter, then OpenAI — one explicit provider per attempt", async () => {
    script.xai = [{ status: 400 }]
    script.openrouter = [{ status: 400 }]
    script.openai = [{ status: 200 }]
    const result = await run()
    expect(calls.map((c) => c.provider)).toEqual(["xai", "openrouter", "openai"])
    expect(result.provider).toBe("openai")
  })

  test("IRIS_TRANSCRIBE_PROVIDERS still overrides the default", async () => {
    process.env["IRIS_TRANSCRIBE_PROVIDERS"] = "openai, xai"
    script.openai = [{ status: 200 }]
    await run()
    expect(calls.map((c) => c.provider)).toEqual(["openai"])
  })

  test("effectiveEngines lists the cloud order, then on-device whisper only when it is ready", () => {
    expect(effectiveEngines({ remote, local: false })).toEqual(["xai", "openrouter", "openai"])
    expect(effectiveEngines({ remote, local: true })).toEqual(["xai", "openrouter", "openai", "whisper-local"])
    expect(effectiveEngines({ remote: null, local: false })).toEqual([])
    expect(effectiveEngines({ remote: null, local: true })).toEqual(["whisper-local"])
  })
})

describe("the provider reported is the one that produced the text", () => {
  test("the platform's own answer wins over the one we asked for", async () => {
    // fl-api is gaining a server-side chain: asked for openrouter, it may answer from another.
    script.openrouter = [{ status: 200, provider: "openai" }]
    const result = await run({ providers: ["openrouter"] })
    expect(result.provider).toBe("openai")
  })

  test("with no provider in the reply, it is the engine we asked — not a hard-coded xai", async () => {
    script.openrouter = [{ status: 200, provider: null }]
    const result = await run({ providers: ["openrouter", "xai"] })
    expect(result.provider).toBe("openrouter")
  })
})

describe("413 — the recording is over a server limit", () => {
  test("is final: no retry, no other engine, and the error names the limit", async () => {
    script.xai = [{ status: 413, message: "The audio file may not be greater than 25600 kilobytes." }]
    script.openrouter = [{ status: 200 }]
    const err = await run({ providers: ["xai", "openrouter"] }).catch((e) => e)
    expect(err).toBeInstanceOf(ChainError)
    expect(calls.map((c) => c.provider)).toEqual(["xai"])
    expect(err.final).toBe(true)
    expect(err.status).toBe(413)
    expect(err.message).toContain("too long")
    expect(err.message).toContain("25 MB")
    expect(err.message).toContain("25600 kilobytes")
  })

  test("is final even when on-device whisper is available", async () => {
    script.xai = [{ status: 413 }]
    const err = await run({ providers: ["xai"], local: true }).catch((e) => e)
    expect(err.final).toBe(true)
    expect(err.attempts.map((a: { engine: string }) => a.engine)).toEqual(["xai"])
  })

  test("an ordinary total failure is not final", async () => {
    script.xai = [{ status: 400 }]
    const err = await run({ providers: ["xai"] }).catch((e) => e)
    expect(err.final).toBe(false)
  })
})

describe("429 — rate limited", () => {
  test("honours Retry-After (seconds) before the next try", async () => {
    script.xai = [{ status: 429, retryAfter: "1" }, { status: 200 }]
    const result = await run({ providers: ["xai"] })
    expect(result.provider).toBe("xai")
    expect(calls[1]!.at - calls[0]!.at).toBeGreaterThanOrEqual(950)
  })

  test("honours an HTTP-date Retry-After", async () => {
    const at = new Date(Date.now() + 1500).toUTCString()
    script.xai = [{ status: 429, retryAfter: at }, { status: 200 }]
    await run({ providers: ["xai"] })
    // HTTP dates have one-second resolution, so allow for the truncation.
    expect(calls[1]!.at - calls[0]!.at).toBeGreaterThanOrEqual(400)
  })

  test("caps the wait so a long Retry-After cannot stall the dictation", async () => {
    script.xai = [{ status: 429, retryAfter: "120" }, { status: 200 }]
    const started = Date.now()
    await run({ providers: ["xai"], maxRetryAfterMs: 50 })
    expect(Date.now() - started).toBeLessThan(1000)
  })

  test("the default cap is five seconds", async () => {
    const { MAX_RETRY_AFTER_MS } = await import("../../src/transcribe/chain")
    expect(MAX_RETRY_AFTER_MS).toBe(5000)
  })

  test("the wait applies before the next try even when that is another engine", async () => {
    // A 429 may be the platform's own rate limit, which the next engine shares.
    script.xai = [{ status: 429, retryAfter: "1" }]
    script.openai = [{ status: 200 }]
    const result = await run({ providers: ["xai", "openai"], backoffMs: [] })
    expect(result.provider).toBe("openai")
    expect(calls[1]!.at - calls[0]!.at).toBeGreaterThanOrEqual(950)
  })
})
