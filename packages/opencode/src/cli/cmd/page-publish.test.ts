import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import yargs from "yargs"
import { PublishCmd } from "./platform-pages"

const realFetch = globalThis.fetch
const realKey = process.env.IRIS_API_KEY
let calls: { url: string; method: string }[]
let versions: any[]

beforeEach(() => {
  process.env.IRIS_API_KEY = "test-key"
  process.exitCode = 0
  calls = []
  versions = []
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input?.url ?? input)
    const method = String(init?.method ?? "GET").toUpperCase()
    calls.push({ url, method })
    if (url.includes("/by-slug/")) {
      return Response.json({ data: { id: 548, slug: "demo", status: "published", current_version: 3, published_at: "2026-10-24T02:00:00Z" } })
    }
    if (url.endsWith("/versions")) return Response.json({ data: { data: versions } })
    return Response.json({ success: true, data: { status: "published" } })
  }) as unknown as typeof fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
  if (realKey === undefined) delete process.env.IRIS_API_KEY
  else process.env.IRIS_API_KEY = realKey
  process.exitCode = 0
})

async function run(argv: string[]) {
  await yargs(argv).command(PublishCmd).strict().exitProcess(false).fail(() => {}).parseAsync().catch(() => {})
}

describe("pages publish draft safety (#191069)", () => {
  test("refuses unpublished versions by another user without publishing", async () => {
    versions = [
      { version_number: 2, changed_by: 42, created_at: "2026-10-24T02:02:00Z" },
      { version_number: 3, changed_by: 193, created_at: "2026-10-24T02:03:00Z" },
    ]

    await run(["publish", "demo"])

    expect(process.exitCode).toBe(1)
    expect(calls.some((call) => call.method === "POST" && call.url.endsWith("/publish"))).toBe(false)
  })

  test("publishes when no unpublished versions exist", async () => {
    versions = [{ version_number: 3, changed_by: 193, created_at: "2026-10-24T01:59:00Z" }]

    await run(["publish", "demo"])

    expect(process.exitCode).toBe(0)
    expect(calls.some((call) => call.method === "POST" && call.url.endsWith("/publish"))).toBe(true)
  })

  test("include-others opts in to the interactive confirmation path", async () => {
    versions = [{ version_number: 2, changed_by: 42, created_at: "2026-10-24T02:02:00Z" }]

    await run(["publish", "demo", "--include-others"])

    expect(calls.some((call) => call.method === "POST" && call.url.endsWith("/publish"))).toBe(true)
  })
})
