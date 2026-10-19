import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { FRESH_MS, loadIrisModels, modelsFromManifest, modelsFromSeed } from "./iris-models"

// #188596 — the TUI's IRIS models follow the server's live list, like IRIS Desktop.

const manifest = {
  data: [
    {
      id: "iris/iris-ai",
      name: "IRIS AI",
      available: true,
      tool_calling: true,
      reasoning: true,
      modalities: { input: ["text", "image", "hologram"], output: ["text"] },
      limits: { context: 1000000, output: 384000 },
      pricing: { input: 0.15, output: 0.6 },
    },
    { id: "iris/gpt-5.6-sol", name: "GPT-5.6 Sol", available: false, pricing: { input: 4, output: 20 } },
    { id: "openai/gpt-x", available: true },
  ],
}
const seed = modelsFromSeed({ "seed-model": { name: "Seed", tools: true } })

function tempCache() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "iris-models-")), "iris-models.json")
}

function serve(body: unknown, status = 200) {
  let calls = 0
  const fetcher = (async () => {
    calls++
    return new Response(JSON.stringify(body), { status })
  }) as unknown as typeof fetch
  return { fetcher, calls: () => calls }
}

describe("modelsFromManifest", () => {
  test("offers only available iris models, in the v1 shape v2 migrates", () => {
    expect(modelsFromManifest(manifest)).toEqual({
      "iris-ai": {
        name: "IRIS AI",
        tool_call: true,
        reasoning: true,
        modalities: { input: ["text", "image"], output: ["text"] },
        limit: { context: 1000000, output: 384000 },
        cost: { input: 0.15, output: 0.6 },
      },
    })
  })

  test("a model switched off on the server is not offered", () => {
    expect(Object.keys(modelsFromManifest(manifest)!)).not.toContain("gpt-5.6-sol")
  })

  test("an empty or malformed response is no list at all, never an empty picker", () => {
    expect(modelsFromManifest({ data: [] })).toBeUndefined()
    expect(modelsFromManifest({ data: [{ id: "iris/x", available: false }] })).toBeUndefined()
    expect(modelsFromManifest({ error: "nope" })).toBeUndefined()
    expect(modelsFromManifest(null)).toBeUndefined()
  })
})

describe("loadIrisModels", () => {
  const base = { baseURL: "https://example.test/api/v6/openai", seed }

  test("fetches the live list and caches it", async () => {
    const cacheFile = tempCache()
    const server = serve(manifest)
    const result = await loadIrisModels({ ...base, cacheFile, fetch: server.fetcher, now: 1000 })
    expect(result.source).toBe("live")
    expect(Object.keys(result.models)).toEqual(["iris-ai"])
    expect(JSON.parse(fs.readFileSync(cacheFile, "utf8")).at).toBe(1000)
  })

  test("a fresh cache answers without a request", async () => {
    const cacheFile = tempCache()
    await loadIrisModels({ ...base, cacheFile, fetch: serve(manifest).fetcher, now: 1000 })
    const server = serve(manifest)
    const result = await loadIrisModels({ ...base, cacheFile, fetch: server.fetcher, now: 1000 + FRESH_MS - 1 })
    expect(result.source).toBe("cache")
    expect(server.calls()).toBe(0)
  })

  test("a stale cache is refreshed, so a server-side change reaches the TUI", async () => {
    const cacheFile = tempCache()
    await loadIrisModels({ ...base, cacheFile, fetch: serve(manifest).fetcher, now: 1000 })
    const switchedOff = { data: [{ ...manifest.data[0], id: "iris/hy3", name: "Hy3" }] }
    const result = await loadIrisModels({ ...base, cacheFile, fetch: serve(switchedOff).fetcher, now: 1000 + FRESH_MS })
    expect(result.source).toBe("live")
    expect(Object.keys(result.models)).toEqual(["hy3"])
  })

  test("offline: the last cache at any age, then the bundled list", async () => {
    const offline = (async () => {
      throw new TypeError("fetch failed")
    }) as unknown as typeof fetch
    const cacheFile = tempCache()
    expect((await loadIrisModels({ ...base, cacheFile, fetch: offline })).source).toBe("bundled")
    await loadIrisModels({ ...base, cacheFile, fetch: serve(manifest).fetcher, now: 1 })
    const result = await loadIrisModels({ ...base, cacheFile, fetch: offline, now: 1 + 365 * 24 * 3600 * 1000 })
    expect(result.source).toBe("stale-cache")
    expect(Object.keys(result.models)).toEqual(["iris-ai"])
  })

  test("a server error or an empty list falls back instead of emptying the picker", async () => {
    expect((await loadIrisModels({ ...base, cacheFile: tempCache(), fetch: serve({}, 500).fetcher })).source).toBe(
      "bundled",
    )
    expect((await loadIrisModels({ ...base, cacheFile: tempCache(), fetch: serve({ data: [] }).fetcher })).source).toBe(
      "bundled",
    )
  })

  test("a cache written for another endpoint is not reused", async () => {
    const cacheFile = tempCache()
    await loadIrisModels({ ...base, cacheFile, fetch: serve(manifest).fetcher, now: 1000 })
    const server = serve(manifest)
    await loadIrisModels({ ...base, baseURL: "https://other.test/api/v6/openai", cacheFile, fetch: server.fetcher, now: 1001 })
    expect(server.calls()).toBe(1)
  })

  test("a hung server costs at most the timeout, then falls back", async () => {
    const hung = ((_: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)))) as unknown as typeof fetch
    const started = Date.now()
    const result = await loadIrisModels({ ...base, cacheFile: tempCache(), fetch: hung })
    expect(result.source).toBe("bundled")
    expect(Date.now() - started).toBeLessThan(3000)
  })
})
