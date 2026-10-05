import { afterAll, describe, expect, test } from "bun:test"
import { describeRemoteConfig, resolveBoard, transcribeRemote } from "../../src/transcribe/remote"

// Dictation must work for a signed-in person with no board configured: the desktop showed
// "Dictation needs a board … Set default_bloq_id in ~/.iris/config.json" (#188013). The platform
// now files such a take under the person's own board, and says which one at /v1/transcribe/scope.
const seen: { path: string; bloq: string | null; auth: string | null }[] = []
let scopeHits = 0
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === "/api/v1/transcribe/scope") {
      scopeHits++
      if (req.headers.get("authorization") !== "Bearer " + "k".repeat(64)) return Response.json({ success: false }, { status: 401 })
      return Response.json({ success: true, data: { bloq_id: 77, source: "owned_board", name: "Mine" } })
    }
    const form = await req.formData()
    seen.push({ path: url.pathname, bloq: (form.get("bloq_id") as string) ?? null, auth: req.headers.get("authorization") })
    return Response.json({ success: true, data: { text: "hi", provider: "xai" } })
  },
})
afterAll(() => server.stop(true))
const apiUrl = `http://127.0.0.1:${server.port}`
const token = "k".repeat(64)

describe("no board configured", () => {
  test("a signed-in person is configured for cloud dictation without a board", () => {
    const { mkdtempSync, writeFileSync } = require("node:fs") as typeof import("node:fs")
    const { tmpdir } = require("node:os") as typeof import("node:os")
    const { join } = require("node:path") as typeof import("node:path")
    const p = join(mkdtempSync(join(tmpdir(), "iris-board-")), "c.json")
    writeFileSync(p, JSON.stringify({ api_url: "https://x" }))
    const prev = { k: process.env["IRIS_API_KEY"], u: process.env["IRIS_API_URL"], b: process.env["IRIS_TRANSCRIBE_BLOQ_ID"] }
    process.env["IRIS_API_KEY"] = token
    delete process.env["IRIS_API_URL"]
    delete process.env["IRIS_TRANSCRIBE_BLOQ_ID"]
    try {
      const r = describeRemoteConfig(p)
      expect(r.reason).toBeUndefined()
      expect(r.config).toEqual({ apiUrl: "https://x", token, bloqId: undefined })
    } finally {
      for (const [k, v] of [["IRIS_API_KEY", prev.k], ["IRIS_API_URL", prev.u], ["IRIS_TRANSCRIBE_BLOQ_ID", prev.b]] as const)
        v === undefined ? delete process.env[k] : (process.env[k] = v)
    }
  })

  test("the take is sent without a board, so the platform files it under the person's own", async () => {
    await transcribeRemote(new Uint8Array([1, 2]), { apiUrl, token })
    expect(seen.at(-1)?.bloq).toBeNull()
    expect(seen.at(-1)?.auth).toBe(`Bearer ${token}`)
  })

  test("a configured board is still sent", async () => {
    await transcribeRemote(new Uint8Array([1, 2]), { apiUrl, token, bloqId: "42" })
    expect(seen.at(-1)?.bloq).toBe("42")
  })

  test("resolveBoard asks the platform once and remembers the answer", async () => {
    const before = scopeHits
    expect(await resolveBoard({ apiUrl, token })).toBe("77")
    expect(await resolveBoard({ apiUrl, token })).toBe("77")
    expect(scopeHits - before).toBe(1)
  })

  test("resolveBoard prefers a configured board and does not ask", async () => {
    const before = scopeHits
    expect(await resolveBoard({ apiUrl, token, bloqId: "5" })).toBe("5")
    expect(scopeHits).toBe(before)
  })

  test("resolveBoard is undefined, not a throw, when the platform cannot say", async () => {
    expect(await resolveBoard({ apiUrl, token: "z".repeat(64) })).toBeUndefined()
  })
})
