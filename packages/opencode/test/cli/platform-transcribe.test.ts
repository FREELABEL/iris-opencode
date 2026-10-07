import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import {
  platformProviders,
  resolveBoard,
  resolvePlatformConfig,
  transcribePlatformChain,
} from "../../src/cli/lib/platform-transcribe"

// The CLI's default transcription path, ported from IRIS Desktop (#188304, #187808).
const TOKEN = "t".repeat(64)
let dir: string
let configPath: string
const savedPolicy = process.env.IRIS_TRANSCRIPTION_POLICY

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "iris-platform-"))
  configPath = join(dir, "config.json")
  writeFileSync(configPath, JSON.stringify({ api_url: "https://iris.test", default_bloq_id: 571, node_api_key: "node-key" }))
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))
afterEach(() => {
  if (savedPolicy === undefined) delete process.env.IRIS_TRANSCRIPTION_POLICY
  else process.env.IRIS_TRANSCRIPTION_POLICY = savedPolicy
})

/** A fake platform: each call takes the next reply; requests are recorded. */
function platform(replies: Array<() => Response>) {
  const calls: Array<{ url: string; provider: string | null; bloq: string | null; auth: string | null }> = []
  const fetcher = (async (url: string, init: RequestInit) => {
    const form = init.body as FormData
    calls.push({
      url,
      provider: form?.get?.("provider") as string | null,
      bloq: form?.get?.("bloq_id") as string | null,
      auth: (init.headers as Record<string, string>)?.Authorization ?? null,
    })
    const next = replies.shift()
    if (!next) throw new Error("no reply scripted")
    return next()
  }) as unknown as typeof fetch
  return { calls, fetcher }
}
const ok = (text: string, provider = "xai") => () => Response.json({ success: true, data: { text, provider } })
const fail = (status: number, message = "nope") => () => Response.json({ success: false, message }, { status })

describe("resolvePlatformConfig", () => {
  test("sovereign: refuses before reading any credential", async () => {
    process.env.IRIS_TRANSCRIPTION_POLICY = "sovereign"
    let read = false
    const r = await resolvePlatformConfig({ env: {}, configPath, token: async () => ((read = true), TOKEN) })
    expect("reason" in r).toBe(true)
    expect(read).toBe(false)
  })

  test("default policy: the config's api_url and board, with the person's token", async () => {
    delete process.env.IRIS_TRANSCRIPTION_POLICY
    const r = await resolvePlatformConfig({ env: {}, configPath, token: async () => TOKEN })
    expect(r).toEqual({ config: { apiUrl: "https://iris.test", token: TOKEN, bloqId: "571" } })
  })

  test("a node_api_key is never sent as the caller", async () => {
    delete process.env.IRIS_TRANSCRIPTION_POLICY
    const r = await resolvePlatformConfig({ env: {}, configPath, token: async () => "node-key" })
    expect("reason" in r).toBe(true)
  })
})

describe("transcribePlatformChain", () => {
  const cfg = { apiUrl: "https://iris.test", token: TOKEN, bloqId: "571" }
  const audio = new Uint8Array([1, 2, 3])

  test("posts to iris-api genesis/transcribe with the board and the bearer token", async () => {
    const p = platform([ok("hello")])
    const r = await transcribePlatformChain(audio, cfg, { env: {}, fetch: p.fetcher })
    expect(r).toEqual({ text: "hello", provider: "xai" })
    expect(p.calls).toEqual([
      { url: "https://iris.test/api/v1/genesis/transcribe", provider: "xai", bloq: "571", auth: `Bearer ${TOKEN}` },
    ])
  })

  test("moves to the next provider on a failure that can clear (429, 5xx, unreachable)", async () => {
    const p = platform([fail(429), fail(503), ok("third time", "openai")])
    const env = { IRIS_TRANSCRIBE_PROVIDERS: "xai,openrouter,openai" }
    const r = await transcribePlatformChain(audio, cfg, { env, fetch: p.fetcher })
    expect(p.calls.map((c) => c.provider)).toEqual(["xai", "openrouter", "openai"])
    expect(r.provider).toBe("openai")
  })

  test("a refusal (a PHI board, a bad scope) is NOT routed around to another provider", async () => {
    const p = platform([fail(403, "This board is marked PHI"), ok("should never be asked")])
    const env = { IRIS_TRANSCRIBE_PROVIDERS: "xai,openai" }
    await expect(transcribePlatformChain(audio, cfg, { env, fetch: p.fetcher })).rejects.toThrow(/PHI/)
    expect(p.calls).toHaveLength(1)
  })

  test("no board configured: the request is sent without one, and the platform files it", async () => {
    const p = platform([ok("hi")])
    await transcribePlatformChain(audio, { ...cfg, bloqId: undefined }, { env: {}, fetch: p.fetcher })
    expect(p.calls[0]!.bloq).toBeNull()
  })

  test("providers default to xai alone, as on Desktop", () => {
    expect(platformProviders({})).toEqual(["xai"])
  })
})

describe("resolveBoard", () => {
  test("asks /api/v1/transcribe/scope once and remembers the answer", async () => {
    let asked = 0
    const fetcher = (async () => (asked++, Response.json({ data: { bloq_id: 999 } }))) as unknown as typeof fetch
    const cfg = { apiUrl: "https://board.test", token: "b".repeat(64) }
    expect(await resolveBoard(cfg, fetcher)).toBe("999")
    expect(await resolveBoard(cfg, fetcher)).toBe("999")
    expect(asked).toBe(1)
  })

  test("a configured board is used without asking", async () => {
    const fetcher = (async () => {
      throw new Error("must not be called")
    }) as unknown as typeof fetch
    expect(await resolveBoard({ apiUrl: "x", token: TOKEN, bloqId: "5" }, fetcher)).toBe("5")
  })
})
