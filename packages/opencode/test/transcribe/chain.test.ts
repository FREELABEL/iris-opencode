import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { ChainError, transcribeWithFallback } from "../../src/transcribe/chain"

// A stand-in for the IRIS platform. Each provider follows a script of HTTP statuses, consumed
// one per request; 200 answers with a transcript naming the provider.
const script: Record<string, number[]> = {}
const calls: string[] = []
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const provider = String((await req.formData()).get("provider"))
    calls.push(provider)
    const status = script[provider]?.shift() ?? 500
    if (status === 200) return Response.json({ success: true, data: { text: `heard by ${provider}`, provider } })
    return Response.json({ success: false, message: `${provider} said ${status}` }, { status })
  },
})
afterAll(() => server.stop(true))
beforeEach(() => {
  calls.length = 0
  for (const k of Object.keys(script)) delete script[k]
})

const remote = { apiUrl: `http://127.0.0.1:${server.port}`, bloqId: "42" }
const audio = new Uint8Array([1, 2, 3, 4])
const run = (providers = ["xai", "openai"]) =>
  transcribeWithFallback(audio, { filename: "d.wav", remote, providers, local: false, backoffMs: [1, 1] })

describe("transcribeWithFallback", () => {
  test("retries a transient failure on the same engine before moving on", async () => {
    script.xai = [503, 500, 200]
    const result = await run()
    expect(result.text).toBe("heard by xai")
    expect(calls).toEqual(["xai", "xai", "xai"])
    expect(result.attempts.map((a) => a.ok)).toEqual([false, false, true])
  })

  test("falls through to the next engine once retries run out", async () => {
    script.xai = [500, 500, 500]
    script.openai = [200]
    const result = await run()
    expect(result.provider).toBe("openai")
    expect(calls).toEqual(["xai", "xai", "xai", "openai"])
  })

  test("does not retry a 4xx — it moves straight to the next engine", async () => {
    script.xai = [400]
    script.openai = [200]
    const result = await run()
    expect(result.provider).toBe("openai")
    expect(calls).toEqual(["xai", "openai"])
  })

  test("retries a 429", async () => {
    script.xai = [429, 200]
    expect((await run()).provider).toBe("xai")
    expect(calls).toEqual(["xai", "xai"])
  })

  test("total failure throws every attempt and names each engine's last error", async () => {
    script.xai = [403]
    script.openai = [500, 500, 500]
    const err = await run().catch((e) => e)
    expect(err).toBeInstanceOf(ChainError)
    expect(err.attempts).toHaveLength(4)
    expect(err.message).toContain("xai: xai said 403")
    expect(err.message).toContain("openai: openai said 500")
  })

  test("with no account and no on-device engine, says how to set one up", async () => {
    const err = await transcribeWithFallback(audio, { filename: "d.wav", remote: null, local: false }).catch((e) => e)
    expect(err).toBeInstanceOf(ChainError)
    expect(err.message).toContain("iris auth login")
    expect(calls).toEqual([])
  })

  test("an unreachable platform counts as transient and is retried", async () => {
    const err = await transcribeWithFallback(audio, {
      filename: "d.wav",
      remote: { apiUrl: "http://127.0.0.1:1", bloqId: "42" },
      providers: ["xai"],
      local: false,
      backoffMs: [1, 1],
    }).catch((e) => e)
    expect(err.attempts.map((a: { status: number }) => a.status)).toEqual([0, 0, 0])
  })
})
