import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import {
  buildInstructions,
  gatherProfile,
  refreshInstructions,
  instructionsNow,
  readCache,
  isFresh,
  isProfileTitle,
  cachePath,
  localProfilePath,
  MAX_INSTRUCTIONS,
  type IrisRunner,
} from "./mcp-profile"

// Eval #189927 gap 1: `iris mcp serve` returned no `instructions` on initialize, so a
// freshly connected agent knew nothing about the user until it thought to search.

const BOARDS = JSON.stringify({
  data: [
    { id: 772, name: "IRIS Business OS, Inc. — Formation", is_owner: true },
    { id: 773, name: "Someone else's board", is_owner: false },
    { id: 766, name: "Lexicon setup test — delete me", is_owner: true },
    { id: 746, name: "IRIS Contracts & Network", is_owner: true },
  ],
})

/** A fake `iris` that answers the three commands the profile uses, and records calls. */
function fakeIris(over: Partial<Record<"list" | "search" | "get-item", string | Error>> = {}): IrisRunner & { calls: string[][] } {
  const calls: string[][] = []
  const run = (async (args: string[]) => {
    calls.push(args)
    const key = args[1] as "list" | "search" | "get-item"
    const v =
      over[key] ??
      {
        list: BOARDS,
        search: JSON.stringify({ items: [{ id: 9001, title: "IRIS Profile", bloq_id: 772 }] }),
        "get-item": JSON.stringify({ id: 9001, title: "IRIS Profile", content: "Voice: short and plain.\nNever: send email without asking.\nTimezone: America/Chicago." }),
      }[key]
    if (v instanceof Error) throw v
    return v
  }) as IrisRunner & { calls: string[][] }
  run.calls = calls
  return run
}

describe("connect-time profile", () => {
  let home: string
  let prevHome: string | undefined
  let prevItem: string | undefined

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "iris-profile-"))
    prevHome = process.env.OPENCODE_TEST_HOME
    prevItem = process.env.IRIS_PROFILE_ITEM
    process.env.OPENCODE_TEST_HOME = home
    delete process.env.IRIS_PROFILE_ITEM
  })

  afterEach(() => {
    if (prevHome === undefined) delete process.env.OPENCODE_TEST_HOME
    else process.env.OPENCODE_TEST_HOME = prevHome
    if (prevItem === undefined) delete process.env.IRIS_PROFILE_ITEM
    else process.env.IRIS_PROFILE_ITEM = prevItem
    fs.rmSync(home, { recursive: true, force: true })
  })

  test("builds from the Atlas 'IRIS Profile' item, owned boards and memory guidance", async () => {
    const data = await gatherProfile(fakeIris(), home)
    const text = buildInstructions(data)
    expect(text).toContain("Never: send email without asking.")
    expect(text).toContain("from Atlas item #9001")
    expect(text).toContain("IRIS Contracts & Network (#746)")
    expect(text).not.toContain("Someone else's board") // not owned
    expect(text).not.toContain("delete me") // scratch board
    expect(text).toContain('iris_memory {action:"search"')
    // The profile states a timezone, so the machine's is not added on top of it.
    expect(text.match(/Timezone:/g)?.length).toBe(1)
    expect(text).not.toContain("read and write dates and times in it")
  })

  test("never takes a profile from a board the user does not own", async () => {
    const run = fakeIris({ search: JSON.stringify({ items: [{ id: 5, title: "IRIS Profile", bloq_id: 773 }] }) })
    const data = await gatherProfile(run, home)
    expect(data.profile).toBeUndefined()
    expect(run.calls.some((c) => c[1] === "get-item")).toBe(false)
  })

  test("ignores fuzzy matches — only an item titled 'IRIS Profile' counts", () => {
    expect(isProfileTitle("IRIS Profile")).toBe(true)
    expect(isProfileTitle("iris profile — Alex")).toBe(true)
    expect(isProfileTitle("[LOW] iris profile social prints doubled @@ handles")).toBe(false)
    expect(isProfileTitle("IRIS Profiles roadmap")).toBe(false)
  })

  test("an explicit IRIS_PROFILE_ITEM skips discovery", async () => {
    process.env.IRIS_PROFILE_ITEM = "4242"
    const run = fakeIris()
    const data = await gatherProfile(run, home)
    expect(run.calls.some((c) => c[1] === "search")).toBe(false)
    expect(run.calls.find((c) => c[1] === "get-item")?.[2]).toBe("4242")
    expect(data.profile?.source).toBe("Atlas item #4242")
  })

  test("~/.iris/profile.md wins and needs no network", async () => {
    fs.mkdirSync(path.join(home, ".iris"), { recursive: true })
    fs.writeFileSync(localProfilePath(home), "Call me Alex. Never use emojis.")
    const run = fakeIris()
    const data = await gatherProfile(run, home)
    expect(data.profile).toEqual({ text: "Call me Alex. Never use emojis.", source: "~/.iris/profile.md" })
    expect(run.calls.some((c) => c[1] === "search" || c[1] === "get-item")).toBe(false)
    // and it is in the instant (no-cache) text too
    expect(instructionsNow(home)).toContain("Never use emojis.")
  })

  test("signed out / offline: falls back to static guidance, never throws", async () => {
    const err = new Error("401 Unauthorized")
    const entry = await refreshInstructions(fakeIris({ list: err, search: err, "get-item": err }), home)
    expect(entry.text).toContain("No personal profile is set yet")
    expect(entry.text).toContain('iris_memory {action:"search"')
  })

  test("a failed refresh does not overwrite a richer cached profile", async () => {
    const good = await refreshInstructions(fakeIris(), home)
    expect(good.text).toContain("Never: send email")
    const err = new Error("offline")
    const after = await refreshInstructions(fakeIris({ list: err, search: err, "get-item": err }), home)
    expect(after.text).toBe(good.text)
    expect(readCache(home)?.text).toBe(good.text)
  })

  test("caches to disk; instructionsNow serves the cache without running anything", async () => {
    await refreshInstructions(fakeIris(), home)
    expect(fs.existsSync(cachePath(home))).toBe(true)
    expect(isFresh(readCache(home))).toBe(true)
    expect(isFresh(readCache(home), Date.now() + 7 * 3600_000)).toBe(false)
    expect(instructionsNow(home)).toContain("Never: send email without asking.")
  })

  test("editing ~/.iris/profile.md invalidates an older cache immediately", async () => {
    await refreshInstructions(fakeIris(), home)
    expect(instructionsNow(home)).toContain("Never: send email")
    fs.mkdirSync(path.join(home, ".iris"), { recursive: true })
    fs.writeFileSync(localProfilePath(home), "New rule: always cite sources.")
    const future = new Date(Date.now() + 5000)
    fs.utimesSync(localProfilePath(home), future, future)
    expect(readCache(home)).toBeUndefined()
    expect(instructionsNow(home)).toContain("New rule: always cite sources.")
  })

  test("stays under the size cap with a huge profile and many boards", () => {
    const text = buildInstructions({
      profile: { text: "rule. ".repeat(2000), source: "~/.iris/profile.md" },
      projects: Array.from({ length: 6 }, (_, i) => ({ id: i, name: "x".repeat(70) })),
      timezone: "America/Chicago",
    })
    expect(text.length).toBeLessThanOrEqual(MAX_INSTRUCTIONS)
    expect(text).toContain('iris_memory {action:"search"') // guidance survives the cap
  })
})

describe("instructions reach the client on initialize", () => {
  async function connect(server: Server) {
    const [a, b] = InMemoryTransport.createLinkedPair()
    await server.connect(a)
    const client = new Client({ name: "t", version: "0" })
    await client.connect(b)
    return client
  }

  test("constructor instructions are returned by initialize", async () => {
    const server = new Server({ name: "IRIS OS", version: "1.0.0" }, { capabilities: { tools: {} }, instructions: "RULES-A" })
    const client = await connect(server)
    expect(client.getInstructions()).toBe("RULES-A")
    await client.close()
  })

  // mcp-serve.ts swaps in a background refresh by assigning the SDK's `_instructions`.
  // If an SDK upgrade renames that field, this fails instead of the refresh going silent.
  test("a refresh assigned before connect is what initialize returns", async () => {
    const server = new Server({ name: "IRIS OS", version: "1.0.0" }, { capabilities: { tools: {} }, instructions: "STALE" })
    ;(server as unknown as { _instructions?: string })._instructions = "FRESH"
    const client = await connect(server)
    expect(client.getInstructions()).toBe("FRESH")
    await client.close()
  })
})
