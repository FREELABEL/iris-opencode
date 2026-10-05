import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import {
  planProviders,
  runWebSearch,
  providerDef,
  normalizeProviderName,
  readPreferredProvider,
  writePreferredProvider,
  type Exec,
} from "./web-search"

const opts = { limit: 5, news: false }

// Shapes captured from production on 2026-09-17 (trimmed).
const TAVILY = {
  query: "best coffee in austin",
  answer: "Flattrack and Houndstooth are highly regarded.",
  results: [{ title: "A Barista's Guide", url: "https://journiest.com/x", content: "Flattrack Coffee…", score: 0.9, published_date: null }],
}
const COMPOSIO = {
  results: {
    search_parameters: { q: "best coffee in austin" },
    organic_results: [{ title: "Reddit thread", link: "https://reddit.com/r/austin/x", snippet: "Proud Mary has the best coffee" }],
    news_results: [{ title: "Crusoe raises", link: "https://wsj.com/x", snippet: "…", published_at: "2026-09-18 02:59:02 UTC" }],
  },
}

describe("planProviders", () => {
  test("nothing connected → an error that names how to connect each provider", () => {
    const p = planProviders([], {})
    expect(p.order).toEqual([])
    expect(p.error).toContain("iris integrations connect tavily")
    expect(p.error).toContain("iris integrations connect composio-search")
  })

  test("default order prefers the provider that synthesises an answer", () => {
    expect(planProviders(["composio-search", "tavily"], {}).order).toEqual(["tavily", "composio-search"])
  })

  test("a saved preference goes first when connected", () => {
    expect(planProviders(["tavily", "composio-search"], { preferred: "google" }).order).toEqual(["composio-search", "tavily"])
  })

  test("a saved preference that is not connected is ignored, not fatal", () => {
    const p = planProviders(["composio-search"], { preferred: "tavily" })
    expect(p.order).toEqual(["composio-search"])
    expect(p.outcomes).toEqual([{ provider: "tavily", state: "not_connected" }])
  })

  test("a forced provider that is not connected refuses instead of substituting another", () => {
    const p = planProviders(["composio-search"], { forced: "tavily" })
    expect(p.order).toEqual([])
    expect(p.error).toContain("tavily is not connected")
  })

  test("an unknown forced provider lists the known ones", () => {
    expect(planProviders(["tavily"], { forced: "bing" }).error).toContain("Known: tavily, composio-search")
  })

  test("aliases resolve", () => {
    expect(normalizeProviderName("Google")).toBe("composio-search")
    expect(normalizeProviderName("serpapi")).toBe("composio-search")
    expect(normalizeProviderName(" TAVILY ")).toBe("tavily")
  })
})

describe("normalizers produce one shape", () => {
  test("tavily", () => {
    const a = providerDef("tavily")!.normalize(TAVILY, "q", opts)
    expect(a.answer).toBe(TAVILY.answer)
    expect(a.results[0]).toEqual({ title: "A Barista's Guide", url: "https://journiest.com/x", snippet: "Flattrack Coffee…", published: null })
  })

  test("composio-search web reads organic_results, and has no answer without an answer box", () => {
    const a = providerDef("composio-search")!.normalize(COMPOSIO, "q", opts)
    expect(a.answer).toBeNull()
    expect(a.results[0].url).toBe("https://reddit.com/r/austin/x")
  })

  test("composio-search news reads news_results with the timestamp", () => {
    const a = providerDef("composio-search")!.normalize(COMPOSIO, "q", { limit: 5, news: true })
    expect(a.results[0].url).toBe("https://wsj.com/x")
    expect(a.results[0].published).toBe("2026-09-18 02:59:02 UTC")
  })

  test("limit is applied and garbage does not throw", () => {
    const many = { results: Array.from({ length: 12 }, (_, i) => ({ title: `t${i}`, url: `u${i}` })) }
    expect(providerDef("tavily")!.normalize(many, "q", { limit: 3, news: false }).results).toHaveLength(3)
    expect(providerDef("composio-search")!.normalize(undefined, "q", opts).results).toEqual([])
  })

  test("news switches the function each provider is called with", () => {
    expect(providerDef("tavily")!.action({ limit: 5, news: true })).toBe("search_news")
    expect(providerDef("composio-search")!.action({ limit: 5, news: true })).toBe("search_news")
  })
})

describe("runWebSearch", () => {
  const plan = planProviders(["tavily", "composio-search"], {})

  test("first provider answers → the second is reported as not needed, never called", async () => {
    const calls: string[] = []
    const exec: Exec = async (id) => { calls.push(id); return id === "tavily" ? TAVILY : COMPOSIO }
    const r = await runWebSearch("q", plan, exec, opts)
    expect(calls).toEqual(["tavily"])
    expect(r.answers.map((a) => a.provider)).toEqual(["tavily"])
    expect(r.outcomes).toEqual([
      { provider: "tavily", state: "ok", count: 1 },
      { provider: "composio-search", state: "not_tried" },
    ])
  })

  test("a failure falls through AND is reported — results are never unattributed", async () => {
    const exec: Exec = async (id) => { if (id === "tavily") throw new Error("usage limit exceeded"); return COMPOSIO }
    const r = await runWebSearch("q", plan, exec, opts)
    expect(r.answers[0].provider).toBe("composio-search")
    expect(r.outcomes[0]).toEqual({ provider: "tavily", state: "error", reason: "usage limit exceeded" })
  })

  test("every provider failing returns no answers and every reason", async () => {
    const exec: Exec = async (id) => { throw new Error(`${id} down`) }
    const r = await runWebSearch("q", plan, exec, opts)
    expect(r.answers).toEqual([])
    expect(r.outcomes.map((o) => o.state)).toEqual(["error", "error"])
  })

  test("--all calls every connected provider", async () => {
    const exec: Exec = async (id) => (id === "tavily" ? TAVILY : COMPOSIO)
    const r = await runWebSearch("q", plan, exec, { ...opts, all: true })
    expect(r.answers.map((a) => a.provider).sort()).toEqual(["composio-search", "tavily"])
  })

  test("the provider receives its own parameter names", async () => {
    const seen: Record<string, unknown>[] = []
    const exec: Exec = async (_id, _a, p) => { seen.push(p); return TAVILY }
    await runWebSearch("coffee", planProviders(["tavily"], {}), exec, { limit: 3, news: false })
    expect(seen[0]).toEqual({ query: "coffee", max_results: 3, include_answer: true })
  })
})

describe("saved preference", () => {
  test("merges into config.json without touching other keys", () => {
    const path = join(mkdtempSync(join(tmpdir(), "iris-ws-")), "config.json")
    writeFileSync(path, JSON.stringify({ token: "keep-me", search: { sources: ["bloq"] } }))
    writePreferredProvider("composio-search", path)
    const cfg = JSON.parse(readFileSync(path, "utf-8"))
    expect(cfg.token).toBe("keep-me")
    expect(cfg.search).toEqual({ sources: ["bloq"], web_provider: "composio-search" })
    expect(readPreferredProvider(path)).toBe("composio-search")
  })

  test("refuses to overwrite a config it cannot parse", () => {
    const path = join(mkdtempSync(join(tmpdir(), "iris-ws-")), "config.json")
    writeFileSync(path, "{not json")
    expect(() => writePreferredProvider("tavily", path)).toThrow()
    expect(readFileSync(path, "utf-8")).toBe("{not json")
  })
})
