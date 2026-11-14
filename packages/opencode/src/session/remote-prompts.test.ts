import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { RemotePrompts } from "./remote-prompts"
import { SystemPrompt } from "./system"

/**
 * IP-07 (#189850) — the IRIS-authored system prompts are served by the private API
 * and never compiled into the public binary. These tests pin the resolution rules:
 * remote when available, the cache when the network is not, the shipped (upstream)
 * fallback when neither is — and NO network call at all for a signed-out user.
 */

const HOUR = 60 * 60 * 1000
let dir: string
let cacheFile: string
let now: number
let calls: { token: string; etag?: string }[]

function okResponse(version: string, prompts: Record<string, string>) {
  return new Response(JSON.stringify({ version, prompts }), {
    status: 200,
    headers: { ETag: `"${version}"`, "Content-Type": "application/json" },
  })
}

function setup(opts: { token?: string; fetcher?: RemotePrompts.Fetcher }) {
  RemotePrompts.configure({
    cacheFile,
    now: () => now,
    token: async () => opts.token ?? "tok",
    fetcher: async (input) => {
      calls.push({ token: input.token, etag: input.etag })
      if (!opts.fetcher) throw new Error("no fetcher in this test")
      return opts.fetcher(input)
    },
  })
}

async function writeCache(version: string, fetchedAt: number, prompts: Record<string, string>) {
  await fs.writeFile(cacheFile, JSON.stringify({ version, fetchedAt, prompts }))
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "remote-prompts-"))
  cacheFile = path.join(dir, "prompts.json")
  now = Date.UTC(2026, 9, 19)
  calls = []
})

afterEach(async () => {
  RemotePrompts.reset()
  await fs.rm(dir, { recursive: true, force: true })
})

describe("RemotePrompts (IP-07 #189850)", () => {
  test("uses the remote text when the fetch returns 200", async () => {
    setup({ fetcher: async () => okResponse("abcdef012345", { "session.beast": "REMOTE BEAST" }) })
    expect(await RemotePrompts.get("session.beast", "FALLBACK")).toBe("REMOTE BEAST")
    // an id the server did not send falls back
    expect(await RemotePrompts.get("session.gemini", "FALLBACK")).toBe("FALLBACK")
    expect(calls).toHaveLength(1)
    expect(calls[0].token).toBe("tok")
  })

  test("writes the cache file with mode 0600", async () => {
    setup({ fetcher: async () => okResponse("abcdef012345", { "iris.identity": "ID" }) })
    await RemotePrompts.get("iris.identity", "FALLBACK")
    const stat = await fs.stat(cacheFile)
    expect(stat.mode & 0o777).toBe(0o600)
    const saved = JSON.parse(await fs.readFile(cacheFile, "utf8"))
    expect(saved).toEqual({ version: "abcdef012345", fetchedAt: now, prompts: { "iris.identity": "ID" } })
  })

  test("a fresh cache (<= 24h) is used without touching the network", async () => {
    await writeCache("aaaaaaaaaaaa", now - 23 * HOUR, { "session.qwen": "CACHED" })
    setup({ fetcher: async () => okResponse("bbbbbbbbbbbb", { "session.qwen": "NEW" }) })
    expect(await RemotePrompts.get("session.qwen", "FALLBACK")).toBe("CACHED")
    expect(calls).toHaveLength(0)
  })

  test("a stale cache is revalidated with If-None-Match; 304 reuses it and bumps fetchedAt", async () => {
    await writeCache("aaaaaaaaaaaa", now - 25 * HOUR, { "session.qwen": "CACHED" })
    setup({ fetcher: async () => new Response(null, { status: 304 }) })
    expect(await RemotePrompts.get("session.qwen", "FALLBACK")).toBe("CACHED")
    expect(calls).toHaveLength(1)
    expect(calls[0].etag).toBe('"aaaaaaaaaaaa"')
    const saved = JSON.parse(await fs.readFile(cacheFile, "utf8"))
    expect(saved.fetchedAt).toBe(now)
    expect(saved.version).toBe("aaaaaaaaaaaa")
  })

  test("network error with a stale cache uses the stale cache", async () => {
    await writeCache("aaaaaaaaaaaa", now - 48 * HOUR, { "session.anthropic": "STALE" })
    setup({
      fetcher: async () => {
        throw new Error("ECONNREFUSED")
      },
    })
    expect(await RemotePrompts.get("session.anthropic", "FALLBACK")).toBe("STALE")
    expect(calls).toHaveLength(1)
  })

  test("no cache and a network error falls back to the shipped text", async () => {
    setup({
      fetcher: async () => {
        throw new Error("ECONNREFUSED")
      },
    })
    expect(await RemotePrompts.get("session.anthropic", "FALLBACK")).toBe("FALLBACK")
  })

  test("a non-200/304 answer (e.g. 401) is treated like a network failure", async () => {
    await writeCache("aaaaaaaaaaaa", now - 48 * HOUR, { "session.anthropic": "STALE" })
    setup({ fetcher: async () => new Response("{}", { status: 401 }) })
    expect(await RemotePrompts.get("session.anthropic", "FALLBACK")).toBe("STALE")
  })

  test("a fetch slower than the timeout does not block the session", async () => {
    setup({ fetcher: () => new Promise<Response>(() => {}) })
    RemotePrompts.configure({ timeoutMs: 50 })
    const started = Date.now()
    expect(await RemotePrompts.get("session.gemini", "FALLBACK")).toBe("FALLBACK")
    expect(Date.now() - started).toBeLessThan(1000)
  })

  test("with no token the fetcher is NEVER called", async () => {
    setup({ token: "", fetcher: async () => okResponse("abcdef012345", { "session.beast": "REMOTE" }) })
    expect(await RemotePrompts.get("session.beast", "FALLBACK")).toBe("FALLBACK")
    expect(calls).toHaveLength(0)
  })

  test("with no token a stale cache is still used, offline", async () => {
    await writeCache("aaaaaaaaaaaa", now - 48 * HOUR, { "session.beast": "STALE" })
    setup({ token: "", fetcher: async () => okResponse("abcdef012345", { "session.beast": "REMOTE" }) })
    expect(await RemotePrompts.get("session.beast", "FALLBACK")).toBe("STALE")
    expect(calls).toHaveLength(0)
  })

  test("only one fetch per process, even under concurrent calls", async () => {
    setup({
      fetcher: async () => {
        await Bun.sleep(20)
        return okResponse("abcdef012345", { "session.beast": "B", "session.gemini": "G" })
      },
    })
    const results = await Promise.all([
      RemotePrompts.get("session.beast", "x"),
      RemotePrompts.get("session.gemini", "x"),
      RemotePrompts.get("session.beast", "x"),
      RemotePrompts.get("iris.identity", "x"),
    ])
    expect(results).toEqual(["B", "G", "B", "x"])
    await RemotePrompts.get("session.beast", "x")
    expect(calls).toHaveLength(1)
  })

  test("a malformed 200 body is ignored, never thrown", async () => {
    setup({ fetcher: async () => new Response("not json", { status: 200 }) })
    expect(await RemotePrompts.get("session.beast", "FALLBACK")).toBe("FALLBACK")
  })
})

describe("SystemPrompt.header identity (IP-07 #189850)", () => {
  test("includes the remote iris.identity when available", async () => {
    setup({ fetcher: async () => okResponse("abcdef012345", { "iris.identity": "REMOTE IDENTITY" }) })
    const header = await SystemPrompt.header("openai")
    expect(header[0]).toBe("REMOTE IDENTITY")
  })

  test("uses the neutral one-line fallback otherwise", async () => {
    setup({ token: "" })
    const header = await SystemPrompt.header("openai")
    expect(header[0]).toBe(SystemPrompt.IDENTITY_FALLBACK)
    expect(header[0]).not.toContain("heyiris")
    expect(header[0].split("\n")).toHaveLength(1)
  })
})

describe("RemotePrompts under test (IP-07 #189850)", () => {
  test("OPENCODE_DISABLE_REMOTE_PROMPTS keeps the real defaults off the network", async () => {
    // The preload sets this flag. Without it, a test run on a machine with a real
    // IRIS token made one real request to the API through the default fetcher.
    expect(process.env["OPENCODE_DISABLE_REMOTE_PROMPTS"]).toBe("true")
    const realFetch = globalThis.fetch
    let fetched = 0
    globalThis.fetch = (async () => {
      fetched++
      throw new Error("network must not be touched")
    }) as unknown as typeof fetch
    try {
      RemotePrompts.reset()
      RemotePrompts.configure({ cacheFile: path.join(os.tmpdir(), `rp-none-${process.pid}.json`) })
      expect(await RemotePrompts.get("iris.identity", "FALLBACK")).toBe("FALLBACK")
      expect(fetched).toBe(0)
    } finally {
      globalThis.fetch = realFetch
      RemotePrompts.reset()
    }
  })
})
