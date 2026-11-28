import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { lineDiff, parseAudienceFile, stableJson } from "./platform-brands-audience"

// #194612 — `iris brands audience show|set|template|validate`, run through the real CLI against a
// stand-in fl-api. The stand-in applies PATCH /api/v1/brands/{id} the way fl-api does: `metadata`
// is REPLACED whole. So "the design tokens survive a set" is a real check. A fictional brand; nothing
// here reaches a real one.

const AUDIENCE = {
  schema: "audience.v1",
  segments: [{ id: "studio-owner", name: "Small studio owner", priority: "primary", market: "b2b", firmographics: { company_size: "2-10" }, evidence: { confidence: "observed" } }],
}
const META = { design_tokens: { colors: { primary: { DEFAULT: "#0f766e" } } }, transcription_glossary: "Northwind" }
let server: ReturnType<typeof Bun.serve>
let home: string
let brand: any
const seen: Array<{ method: string; path: string; body: any }> = []

beforeEach(() => {
  brand = { id: 41, name: "Northwind Studio", slug: "northwind-studio", status: "active", personas: [{ id: 1, name: "Studio voice", is_default: true }], metadata: structuredClone({ ...META, audience: AUDIENCE }) }
  seen.length = 0
})
beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const body = req.method === "GET" ? null : await req.json().catch(() => null)
      seen.push({ method: req.method, path: url.pathname + url.search, body })
      if (req.headers.get("authorization") !== "Bearer test-key") return Response.json({ error: "no" }, { status: 401 })
      const ok = (data: unknown) => Response.json({ success: true, data })
      if (url.pathname === "/api/v1/brands" && url.searchParams.get("slug") === "northwind-studio") return ok({ data: [brand] })
      if (url.pathname === "/api/v1/brands") return ok({ data: [] })
      if (url.pathname === "/api/v1/brands/41") {
        if (req.method === "PATCH" && body?.metadata) brand.metadata = body.metadata // replaced, not merged — as fl-api does
        return ok(brand)
      }
      return Response.json({ success: false }, { status: 404 })
    },
  })
  home = mkdtempSync(join(tmpdir(), "iris-audience-e2e-"))
})
afterAll(() => {
  server?.stop(true)
  if (home) rmSync(home, { recursive: true, force: true })
})

async function iris(...args: string[]): Promise<{ code: number; out: string; err: string; json: any }> {
  const p = Bun.spawn([process.execPath, "run", "--conditions=browser", join(import.meta.dir, "..", "..", "index.ts"), "brands", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      IRIS_FL_API_URL: `http://127.0.0.1:${server.port}`,
      IRIS_API_URL: `http://127.0.0.1:${server.port}`,
      IRIS_API_KEY: "test-key",
      IRIS_USER_ID: "1",
      HOME: home,
      XDG_DATA_HOME: join(home, "data"),
      XDG_CONFIG_HOME: join(home, "config"),
      XDG_STATE_HOME: join(home, "state"),
      XDG_CACHE_HOME: join(home, "cache"),
      NO_COLOR: "1",
    },
  })
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
  let json: any = null
  try {
    json = JSON.parse(out.slice(out.indexOf("{")))
  } catch {}
  return { code, out, err, json }
}
const file = (name: string, text: string) => {
  const f = join(home, name)
  writeFileSync(f, text)
  return f
}
const patches = () => seen.filter((s) => s.method === "PATCH")
/** Calls to the brand routes. (The CLI also checks for updates and the like at start; those are not brand reads.) */
const brandCalls = () => seen.filter((s) => s.path.startsWith("/api/v1/brands"))

describe("iris brands audience (#194612)", () => {
  test("template prints a commented audience.v1 that parses as YAML", async () => {
    const r = await iris("audience", "template")
    expect(r.code).toBe(0)
    expect(r.out).toContain("schema: audience.v1")
    expect(r.out).toContain("# REQUIRED.")
    expect((parseAudienceFile("t.yaml", r.out) as any).schema).toBe("audience.v1")
  }, 60000)

  test("validate exits 1 with the path of each problem, and 0 for a good file", async () => {
    const bad = file("bad.json", JSON.stringify({ schema: "audience.v1", segments: [{ name: "A", priority: "top", demographics: { age_band: ["40-50"] } }] }))
    const r = await iris("audience", "validate", "--file", bad)
    expect(r.code).toBe(1)
    expect(r.err).toContain("segments[0].priority")
    expect(r.err).toContain("segments[0].demographics.age_band[0]")
    expect(r.err).toContain("segments[0].evidence.confidence")
    const good = file("good.yaml", "schema: audience.v1\nsegments:\n  - name: Weekend maker\n    market: b2c\n    evidence:\n      confidence: assumed\n")
    const g = await iris("audience", "validate", "--file", good, "--json")
    expect(g.code).toBe(0)
    expect(g.json.summary).toEqual(["Weekend maker (assumed): b2c"])
    expect(brandCalls()).toHaveLength(0) // validate never reads a brand
  }, 60000)

  test("show reads the audience by slug, readable and as JSON", async () => {
    const r = await iris("audience", "show", "northwind-studio", "--json")
    expect(r.code).toBe(0)
    expect(r.json.audience).toEqual(AUDIENCE)
    expect(r.json.summary).toEqual(["Small studio owner (observed): primary · b2b · 2-10 people"])
    const t = await iris("audience", "show", "41")
    expect(t.code).toBe(0)
    expect(t.out).toContain("Small studio owner")
    expect(t.out).toContain("company_size: 2-10")
  }, 60000)

  test("set --dry-run shows the diff and writes nothing", async () => {
    const f = file("next.yaml", "schema: audience.v1\nsegments:\n  - id: studio-owner\n    name: Small studio owner\n    priority: secondary\n    market: b2b\n    evidence:\n      confidence: validated\n")
    const r = await iris("audience", "set", "41", "--file", f, "--dry-run")
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/^- +"priority": "primary"/m)
    expect(r.out).toMatch(/^\+ +"priority": "secondary"/m)
    expect(r.out).toContain("design_tokens, transcription_glossary")
    expect(patches()).toHaveLength(0)
  }, 60000)

  test("set writes only metadata.audience — the design tokens and glossary are kept — and reads it back", async () => {
    const f = file("set.yaml", "schema: audience.v1\nsegments:\n  - name: Weekend maker\n    summary: ''\n    market: b2c\n    evidence:\n      confidence: assumed\n")
    const r = await iris("audience", "set", "northwind-studio", "--file", f, "--json")
    expect(r.code).toBe(0)
    expect(r.json.kept).toEqual(["design_tokens", "transcription_glossary"])
    expect(patches()).toHaveLength(1)
    const sent = patches()[0]!.body
    expect(Object.keys(sent)).toEqual(["metadata"])
    expect(sent.metadata.design_tokens).toEqual(META.design_tokens)
    expect(sent.metadata.transcription_glossary).toBe(META.transcription_glossary)
    expect(sent.metadata.audience).toEqual({ schema: "audience.v1", segments: [{ name: "Weekend maker", market: "b2c", evidence: { confidence: "assumed" } }] })
    expect(brand.metadata.design_tokens).toEqual(META.design_tokens)
  }, 60000)

  test("set refuses an invalid file before it reads or writes the brand", async () => {
    const f = file("invalid.json", JSON.stringify({ schema: "audience.v1", segments: [{ name: "A", evidence: { confidence: "sure" } }] }))
    const r = await iris("audience", "set", "41", "--file", f, "--json")
    expect(r.code).toBe(1)
    expect(r.json.errors.map((e: any) => e.path)).toEqual(["segments[0].evidence.confidence"])
    expect(brandCalls()).toHaveLength(0)
  }, 60000)

  test("the AI-voice commands are described as Voices, and `voices` is the same command as `personas`", async () => {
    const flat = (r: { out: string; err: string }) => (r.out + r.err).replace(/\s+/g, " ")
    const help = flat(await iris("--help"))
    expect(help).toContain("iris brands personas Voices (the brand's AI voice: tone, system prompt, hashtags) [aliases: voices]")
    expect(help).toContain("iris brands audience who the brand sells to")
    expect(flat(await iris("voices", "--help"))).toContain("list a brand's voices")
  }, 60000)
})

describe("helpers", () => {
  test("lineDiff marks what goes and what comes", () => {
    expect(lineDiff("a\nb\nc", "a\nx\nc")).toEqual(["  a", "- b", "+ x", "  c"])
  })
  test("stableJson ignores key order", () => {
    expect(stableJson({ b: 1, a: { d: 2, c: 3 } })).toBe(stableJson({ a: { c: 3, d: 2 }, b: 1 }))
  })
})
