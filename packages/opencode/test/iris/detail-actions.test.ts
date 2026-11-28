import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { mcpConfigCandidates, peerDeps, removeMcpServer, revokeHivePeer } from "../../src/iris/detail-actions"
import { publishSite, sitesDeps } from "../../src/iris/genesis-sites"
import { readSchemaFields } from "../../src/iris/platform"

type Call = { path: string; init?: RequestInit }
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const realPeer = { ...peerDeps }
const realSites = { ...sitesDeps }
afterEach(() => {
  Object.assign(peerDeps, realPeer)
  Object.assign(sitesDeps, realSites)
})

describe("revokeHivePeer (#194582)", () => {
  test("DELETEs the connection as the signed-in user", async () => {
    const calls: Call[] = []
    peerDeps.userId = async () => 42 as any
    peerDeps.fetch = async (p, init) => (calls.push({ path: p, init }), reply(200, { message: "Connection revoked" }))
    expect(await revokeHivePeer("3f2a9c1e-0000-4000-8000-00000000abcd")).toEqual({ ok: true })
    expect(calls).toHaveLength(1)
    expect(calls[0].path).toBe("/api/v6/nodes/connections/3f2a9c1e-0000-4000-8000-00000000abcd?user_id=42")
    expect(calls[0].init?.method).toBe("DELETE")
  })
  test("an id that is not a connection id never reaches a URL", async () => {
    const calls: Call[] = []
    peerDeps.userId = async () => 42 as any
    peerDeps.fetch = async (p, init) => (calls.push({ path: p, init }), reply(200, {}))
    for (const id of ["../nodes", "a/b", "x?user_id=1", ""]) expect((await revokeHivePeer(id)).ok).toBe(false)
    expect(calls).toHaveLength(0)
  })
  test("says why in words", async () => {
    peerDeps.userId = async () => 42 as any
    peerDeps.fetch = async () => reply(404, {})
    expect(await revokeHivePeer("abc")).toEqual({ ok: false, reason: "that connection no longer exists" })
    peerDeps.fetch = async () => reply(403, {})
    expect((await revokeHivePeer("abc")).reason).toContain("not part of")
    peerDeps.userId = async () => undefined as any
    expect((await revokeHivePeer("abc")).reason).toContain("not signed in")
  })
})

describe("publishSite (#194582)", () => {
  test("PUTs status published and returns the site read back", async () => {
    const calls: Call[] = []
    sitesDeps.userId = async () => 42 as any
    sitesDeps.fetch = async (p, init) => (calls.push({ path: p, init }), reply(200, { data: { id: 7, name: "Studio", slug: "studio", status: "published", pages: [] } }))
    const r = await publishSite(7)
    expect(r.ok).toBe(true)
    expect(r.site?.status).toBe("published")
    expect(calls[0].path).toBe("/api/v1/sites/7")
    expect(calls[0].init?.method).toBe("PUT")
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ status: "published" })
  })
  test("a site still draft after the write is not reported as live", async () => {
    sitesDeps.userId = async () => 42 as any
    sitesDeps.fetch = async () => reply(200, { data: { id: 7, name: "Studio", slug: "studio", status: "draft", pages: [] } })
    const r = await publishSite(7)
    expect(r.ok).toBe(false)
    expect(r.reason).toContain("still draft")
  })
  test("refuses a bad id without calling", async () => {
    let called = false
    sitesDeps.userId = async () => 42 as any
    sitesDeps.fetch = async () => ((called = true), reply(200, {}))
    expect((await publishSite(0)).ok).toBe(false)
    expect(called).toBe(false)
  })
})

describe("removeMcpServer (#194582)", () => {
  const made: string[] = []
  const tmp = async () => {
    const d = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-rm-"))
    made.push(d)
    return d
  }
  afterEach(async () => {
    for (const d of made.splice(0)) await fs.rm(d, { recursive: true, force: true })
  })

  test("takes it out of the project file, keeping comments and the other servers", async () => {
    const root = await tmp()
    const global = await tmp()
    await fs.mkdir(path.join(root, ".git"))
    const file = path.join(root, "opencode.jsonc")
    await fs.writeFile(file, `{\n  // the team's servers\n  "mcp": {\n    "docs": { "type": "remote", "url": "https://docs.example.test/mcp" },\n    "files": { "type": "local", "command": ["files-mcp"] }\n  }\n}\n`)
    const r = await removeMcpServer({ name: "docs", project: root, globalDir: global })
    expect(r).toEqual({ ok: true, file })
    const text = await fs.readFile(file, "utf8")
    expect(text).toContain("// the team's servers")
    expect(text).toContain('"files"')
    expect(text).not.toContain('"docs"')
  })

  test("falls back to the global settings, and a parent folder up to the repository root", async () => {
    const root = await tmp()
    const global = await tmp()
    await fs.mkdir(path.join(root, ".git"))
    await fs.mkdir(path.join(root, "app"))
    await fs.writeFile(path.join(global, "opencode.json"), JSON.stringify({ mcp: { tickets: { type: "remote", url: "https://t.example.test" } } }))
    const r = await removeMcpServer({ name: "tickets", project: path.join(root, "app"), globalDir: global })
    expect(r.ok).toBe(true)
    expect(r.file).toBe(path.join(global, "opencode.json"))
    expect(JSON.parse(await fs.readFile(r.file!, "utf8")).mcp).toEqual({})
    const c = mcpConfigCandidates(path.join(root, "app"), global)
    expect(c).toContain(path.join(root, "app", "opencode.json"))
    expect(c).toContain(path.join(root, ".opencode", "opencode.jsonc"))
    expect(c.some((f) => f.startsWith(path.dirname(root) + path.sep + "opencode"))).toBe(false)
  })

  test("defined nowhere it edits: nothing is written, and it says so", async () => {
    const root = await tmp()
    const global = await tmp()
    await fs.mkdir(path.join(root, ".git"))
    const file = path.join(root, "opencode.json")
    const before = JSON.stringify({ mcp: { other: { type: "local", command: ["x"] } } })
    await fs.writeFile(file, before)
    const r = await removeMcpServer({ name: "missing", project: root, globalDir: global })
    expect(r.ok).toBe(false)
    expect(r.reason).toContain("not in a settings file")
    expect(await fs.readFile(file, "utf8")).toBe(before)
  })
})

describe("schema fields carry required (#194582)", () => {
  test("required true or 1 reads as required; anything else is left out", () => {
    const f = readSchemaFields({ fields: [{ key: "name", type: "string", required: true }, { key: "age", type: "number", required: 1 }, { key: "note", type: "text" }] })
    expect(f.map((x) => x.required)).toEqual([true, true, undefined])
  })
})
