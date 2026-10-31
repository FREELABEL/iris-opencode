import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import yargs from "yargs"
import { PushCmd, QrCmd, SetCmd, closestComponentTypes, componentErrors, setPathProblem } from "./platform-pages"

/**
 * #190867–#190872 — `iris pages` reported success for work that never landed, and refused
 * with output nobody could read. Pure checks first, then the real commands with the network
 * mocked, asserting the exit code a script would see.
 */
const TYPES = new Set(["Hero", "HeroSection", "SiteFooter", "SiteNavigation", "FeatureGrid", "PricingTable"])

describe("componentErrors", () => {
  test("#190869 duplicate component ids are refused", () => {
    const r = componentErrors({ components: [{ type: "Hero", id: "a" }, { type: "SiteFooter", id: "a" }] }, TYPES)
    expect(r.valid).toBe(false)
    expect(r.errors.join("\n")).toContain('id "a" is already used by components[0]')
  })
  test("unique ids pass", () => {
    expect(componentErrors({ components: [{ type: "Hero", id: "a" }, { type: "SiteFooter", id: "b" }] }, TYPES).valid).toBe(true)
  })
  test("#190872 unknown type names the closest matches, not every type", () => {
    const r = componentErrors({ components: [{ type: "HeroSecton", id: "x" }] }, TYPES)
    const text = r.errors.join("\n")
    expect(text).toContain("did you mean")
    expect(text).toContain("HeroSection")
    expect(text).toContain("iris pages component-registry")
    expect(text).not.toContain("PricingTable")
  })
  test("closestComponentTypes caps the list", () => {
    expect(closestComponentTypes("Zzz", TYPES, 3)).toHaveLength(3)
  })
})

describe("setPathProblem (#190870)", () => {
  const page = { components: [{ props: {} }], theme: {} }
  test("an unknown first segment is refused", () => {
    expect(setPathProblem("totally.nonexistent.path", page)).toContain("Path not found")
  })
  test("prototype keys are refused by name", () => {
    expect(setPathProblem("__proto__.polluted", page)).toContain("__proto__")
    expect(setPathProblem("components.0.constructor", page)).toContain("constructor")
  })
  test("real paths, and new leaves under real keys, are allowed", () => {
    expect(setPathProblem("components.0.props.title", page)).toBeNull()
    expect(setPathProblem("theme.mode", page)).toBeNull()
    expect(setPathProblem("css", page)).toBeNull()
  })
})

const realFetch = globalThis.fetch
const realKey = process.env.IRIS_API_KEY
let dir: string
let calls: { url: string; method: string }[]

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pages-safety-"))
  process.env.IRIS_API_KEY = "test-key"
  process.exitCode = 0
  calls = []
})
afterEach(() => {
  globalThis.fetch = realFetch
  if (realKey === undefined) delete process.env.IRIS_API_KEY
  else process.env.IRIS_API_KEY = realKey
  process.exitCode = 0
  rmSync(dir, { recursive: true, force: true })
})

const PAGE = { id: 548, slug: "demo", title: "Demo", status: "draft", current_version: 3, json_content: { components: [{ type: "Hero", id: "h", props: { title: "t" } }] } }

function mockApi(handler: (url: string, method: string, body: any) => Response | undefined) {
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input?.url ?? input)
    const method = String(init?.method ?? "GET").toUpperCase()
    calls.push({ url, method })
    const body = init?.body ? (() => { try { return JSON.parse(init.body) } catch { return init.body } })() : null
    const r = handler(url, method, body)
    if (r) return r
    return new Response(JSON.stringify({ data: PAGE }), { status: 200, headers: { "content-type": "application/json" } })
  }) as unknown as typeof fetch
}
const json = (data: any, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } })

async function run(cmd: any, argv: string[]) {
  const out: string[] = []
  const w1 = process.stdout.write.bind(process.stdout), w2 = process.stderr.write.bind(process.stderr)
  ;(process.stdout as any).write = (c: any) => { out.push(String(c)); return true }
  ;(process.stderr as any).write = (c: any) => { out.push(String(c)); return true }
  try {
    await yargs(argv).command(cmd).strict().exitProcess(false).fail(() => {}).parseAsync().catch(() => {})
  } finally {
    ;(process.stdout as any).write = w1
    ;(process.stderr as any).write = w2
  }
  return out.join("")
}

function writePage(content: any) {
  const pages = join(dir, "pages")
  mkdirSync(pages, { recursive: true })
  writeFileSync(join(pages, "demo.json"), typeof content === "string" ? content : JSON.stringify(content))
  return pages
}

describe("push exit codes (#190868)", () => {
  test("missing local file exits 1", async () => {
    mockApi(() => undefined)
    await run(PushCmd, ["push", "demo", "--dir", join(dir, "nowhere")])
    expect(process.exitCode).toBe(1)
  })
  test("malformed JSON exits 1", async () => {
    mockApi(() => undefined)
    const pages = writePage("{not json")
    await run(PushCmd, ["push", "demo", "--dir", pages])
    expect(process.exitCode).toBe(1)
  })
  test("no json_content or components exits 1", async () => {
    mockApi(() => undefined)
    const pages = writePage({ title: "x" })
    await run(PushCmd, ["push", "demo", "--dir", pages])
    expect(process.exitCode).toBe(1)
  })
  test("a duplicate id is refused before upload and exits 1 (#190869)", async () => {
    mockApi(() => undefined)
    const pages = writePage({ json_content: { components: [{ type: "Hero", id: "a" }, { type: "Hero", id: "a" }] } })
    await run(PushCmd, ["push", "demo", "--dir", pages])
    expect(process.exitCode).toBe(1)
    expect(calls.some((c) => c.method === "PUT")).toBe(false)
  })
  test("a server refusal exits 1", async () => {
    mockApi((url, method) => (method === "PUT" ? json({ success: false, message: "Component validation failed" }, 422) : undefined))
    const pages = writePage({ json_content: PAGE.json_content })
    await run(PushCmd, ["push", "demo", "--dir", pages])
    expect(process.exitCode).toBe(1)
  })
})

describe("push says when the server merged (#190867)", () => {
  test("a merged save is reported as a merge, not a plain push", async () => {
    mockApi((url, method) =>
      method === "PUT" ? json({ success: true, data: { ...PAGE, current_version: 5, merge: { merged: true, base_version: 2, merged_with_version: 4 } } }) : undefined,
    )
    const pages = writePage({ _base: { version: 2 }, json_content: PAGE.json_content })
    const out = await run(PushCmd, ["push", "demo", "--dir", pages])
    expect(out).toContain("MERGED")
    expect(out).toContain("v4")
    expect(process.exitCode).toBe(0)
  })
})

describe("set refuses a path that does not exist (#190870)", () => {
  test("unknown first segment: refused, exit 1, nothing written", async () => {
    mockApi(() => undefined)
    await run(SetCmd, ["set", "demo", "totally.nonexistent.path", "x"])
    expect(process.exitCode).toBe(1)
    expect(calls.some((c) => c.method === "PUT")).toBe(false)
  })
  test("__proto__: refused, exit 1, nothing written", async () => {
    mockApi(() => undefined)
    await run(SetCmd, ["set", "demo", "__proto__.polluted", "yes"])
    expect(process.exitCode).toBe(1)
    expect(calls.some((c) => c.method === "PUT")).toBe(false)
  })
})

describe("qr refuses a page that does not exist (#190871)", () => {
  test("no short URL is minted and it exits 1", async () => {
    mockApi((url) => (url.includes("/by-slug/") ? json({ message: "Page not found" }, 404) : json({ data: { short_url: "x" } })))
    await run(QrCmd, ["qr", "no-such-page-zzz"])
    expect(process.exitCode).toBe(1)
    expect(calls.some((c) => c.url.includes("short-url"))).toBe(false)
  })
})
