import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { RemoteCapabilities } from "./remote-capabilities"
import { loadIndex, loadMergedIndex, searchCapabilities, workspaceNotice, PlatformFindCommand, type Entry } from "./platform-find"

/**
 * IP-07 phase 2 (#189850) — workspace playbooks and skills are PRIVATE prose and are no longer
 * embedded in the public binary. `iris find` merges them in from GET /api/v1/cli/capabilities.
 * These tests pin the same rules as RemotePrompts: remote when available, the cache when the
 * network is not, embedded-only when neither is — and NO network call for a signed-out user,
 * who is told in one line why the playbooks are missing.
 */

const HOUR = 60 * 60 * 1000
let dir: string
let cacheFile: string
let now: number
let calls: { token: string; etag?: string }[]

const PLAYBOOK: Entry = {
  kind: "playbook",
  name: "zz-fixture-gap-analysis",
  describe: "fixture playbook that only the remote knows",
  aliases: [],
  run: "iris playbook run zz-fixture-gap-analysis",
  haystack: "zz-fixture-gap-analysis qqxyzzy fixture playbook",
}
const SKILL: Entry = { ...PLAYBOOK, kind: "skill", name: "zz-fixture-skill", run: "iris playbook run zz-fixture-skill" }

function okResponse(version: string, entries: unknown[]) {
  return new Response(JSON.stringify({ version, entries }), {
    status: 200,
    headers: { ETag: `"${version}"`, "Content-Type": "application/json" },
  })
}

function setup(opts: { token?: string; fetcher?: RemoteCapabilities.Fetcher }) {
  RemoteCapabilities.configure({
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

async function writeCache(version: string, fetchedAt: number, entries: unknown[]) {
  await fs.writeFile(cacheFile, JSON.stringify({ version, fetchedAt, entries }))
}

const names = (entries: Entry[]) => entries.map((e) => `${e.kind}:${e.name}`)

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "remote-caps-"))
  cacheFile = path.join(dir, "capabilities.json")
  now = Date.UTC(2026, 9, 19)
  calls = []
})

afterEach(async () => {
  RemoteCapabilities.reset()
  await fs.rm(dir, { recursive: true, force: true })
})

describe("RemoteCapabilities merge (IP-07 phase 2 #189850)", () => {
  test("signed in, 200: workspace entries are merged with the embedded ones and are searchable", async () => {
    setup({ fetcher: async () => okResponse("abcdef012345", [PLAYBOOK, SKILL]) })
    const { index, workspace } = await loadMergedIndex()
    const embedded = loadIndex()
    expect(workspace).toBe("remote")
    expect(index.entries.length).toBe(embedded.entries.length + 2)
    expect(names(index.entries)).toContain("playbook:zz-fixture-gap-analysis")
    expect(names(index.entries)).toContain("skill:zz-fixture-skill")
    expect(index.counts.playbook).toBe(1)
    expect(index.counts.skill).toBe(1)
    expect(index.counts.total).toBe(index.entries.length)
    expect(searchCapabilities(index, "qqxyzzy", undefined, 5).map((h) => h.e.name)).toContain(PLAYBOOK.name)
    expect(calls).toEqual([{ token: "tok", etag: undefined }])
  })

  test("malformed entries in a 200 body are dropped, valid ones kept", async () => {
    setup({ fetcher: async () => okResponse("abcdef012345", [PLAYBOOK, { kind: "playbook" }, "junk", null]) })
    const { entries } = await RemoteCapabilities.load()
    expect(names(entries)).toEqual(["playbook:zz-fixture-gap-analysis"])
  })

  test("writes the cache file with mode 0600", async () => {
    setup({ fetcher: async () => okResponse("abcdef012345", [PLAYBOOK]) })
    await RemoteCapabilities.load()
    const stat = await fs.stat(cacheFile)
    expect(stat.mode & 0o777).toBe(0o600)
    const saved = JSON.parse(await fs.readFile(cacheFile, "utf8"))
    expect(saved).toEqual({ version: "abcdef012345", fetchedAt: now, entries: [PLAYBOOK] })
  })

  test("a fresh cache (<= 24h) is used without touching the network", async () => {
    await writeCache("aaaaaaaaaaaa", now - 23 * HOUR, [PLAYBOOK])
    setup({ fetcher: async () => okResponse("bbbbbbbbbbbb", [SKILL]) })
    const r = await RemoteCapabilities.load()
    expect(names(r.entries)).toEqual(["playbook:zz-fixture-gap-analysis"])
    expect(calls).toHaveLength(0)
  })

  test("a stale cache is revalidated with If-None-Match; 304 reuses it and bumps fetchedAt", async () => {
    await writeCache("aaaaaaaaaaaa", now - 25 * HOUR, [PLAYBOOK])
    setup({ fetcher: async () => new Response(null, { status: 304 }) })
    const r = await RemoteCapabilities.load()
    expect(names(r.entries)).toEqual(["playbook:zz-fixture-gap-analysis"])
    expect(r.source).toBe("revalidated")
    expect(calls).toEqual([{ token: "tok", etag: '"aaaaaaaaaaaa"' }])
    const saved = JSON.parse(await fs.readFile(cacheFile, "utf8"))
    expect(saved.fetchedAt).toBe(now)
    expect(saved.version).toBe("aaaaaaaaaaaa")
  })

  test("network error with a stale cache uses the stale cache", async () => {
    await writeCache("aaaaaaaaaaaa", now - 48 * HOUR, [SKILL])
    setup({
      fetcher: async () => {
        throw new Error("ECONNREFUSED")
      },
    })
    const { index, workspace } = await loadMergedIndex()
    expect(workspace).toBe("stale-cache")
    expect(names(index.entries)).toContain("skill:zz-fixture-skill")
    expect(calls).toHaveLength(1)
  })

  test("network error and no cache: embedded only, and it says the workspace is unavailable", async () => {
    setup({
      fetcher: async () => {
        throw new Error("ECONNREFUSED")
      },
    })
    const { index, workspace } = await loadMergedIndex()
    expect(workspace).toBe("unavailable")
    expect(index.entries.length).toBe(loadIndex().entries.length)
    expect(workspaceNotice(workspace)).toBeTruthy()
  })

  test("a 404 (endpoint not deployed yet) is treated like a network failure, never thrown", async () => {
    setup({ fetcher: async () => new Response("{}", { status: 404 }) })
    const { index, workspace } = await loadMergedIndex()
    expect(workspace).toBe("unavailable")
    expect(index.entries.length).toBe(loadIndex().entries.length)
  })

  test("with no token the fetcher is NEVER called and only embedded entries are returned", async () => {
    setup({ token: "", fetcher: async () => okResponse("abcdef012345", [PLAYBOOK]) })
    const { index, workspace } = await loadMergedIndex()
    expect(calls).toHaveLength(0)
    expect(workspace).toBe("signed-out")
    expect(index.entries.length).toBe(loadIndex().entries.length)
    expect(names(index.entries)).not.toContain("playbook:zz-fixture-gap-analysis")
  })

  test("only one fetch per process, even under concurrent calls", async () => {
    setup({
      fetcher: async () => {
        await Bun.sleep(20)
        return okResponse("abcdef012345", [PLAYBOOK])
      },
    })
    const results = await Promise.all([loadMergedIndex(), loadMergedIndex(), RemoteCapabilities.load()])
    expect(results[0].workspace).toBe("remote")
    await loadMergedIndex()
    expect(calls).toHaveLength(1)
  })

  test("a fetch slower than the timeout does not block the command", async () => {
    setup({ fetcher: () => new Promise<Response>(() => {}) })
    RemoteCapabilities.configure({ timeoutMs: 50 })
    const started = Date.now()
    const { workspace } = await loadMergedIndex()
    expect(workspace).toBe("unavailable")
    expect(Date.now() - started).toBeLessThan(1000)
  })

  test("a remote entry never replaces an embedded one with the same kind:name", async () => {
    const embedded = loadIndex().entries[0]
    setup({ fetcher: async () => okResponse("abcdef012345", [{ ...embedded, describe: "HIJACKED" }]) })
    const { index } = await loadMergedIndex()
    const same = index.entries.filter((e) => e.kind === embedded.kind && e.name === embedded.name)
    expect(same).toHaveLength(1)
    expect(same[0].describe).toBe(embedded.describe)
  })
})

describe("the signed-out notice (IP-07 phase 2 #189850)", () => {
  test("names sign-in when signed out, says nothing when the workspace loaded", () => {
    expect(workspaceNotice("signed-out")).toContain("workspace playbooks and skills need sign-in")
    expect(workspaceNotice("unavailable")).toContain("workspace playbooks and skills")
    expect(workspaceNotice("remote")).toBeUndefined()
    expect(workspaceNotice("cache")).toBeUndefined()
    expect(workspaceNotice("revalidated")).toBeUndefined()
    expect(workspaceNotice("stale-cache")).toBeUndefined()
  })

  async function runFind(args: Record<string, unknown>) {
    const lines: string[] = []
    const log = console.log
    const exitCode = process.exitCode
    console.log = (...a: unknown[]) => void lines.push(a.map(String).join(" "))
    try {
      await (PlatformFindCommand.handler as (a: any) => Promise<void>)({ limit: 12, json: false, ...args })
    } finally {
      console.log = log
      process.exitCode = exitCode
    }
    return lines.join("\n")
  }

  test("`iris find` signed out prints the one-line notice, and makes no request", async () => {
    setup({ token: "", fetcher: async () => okResponse("abcdef012345", [PLAYBOOK]) })
    const out = await runFind({ query: ["genesis", "page"] })
    expect(out).toContain("workspace playbooks and skills need sign-in")
    expect(calls).toHaveLength(0)
  })

  test("`iris find` signed in prints no notice and finds the remote playbook", async () => {
    setup({ fetcher: async () => okResponse("abcdef012345", [PLAYBOOK]) })
    const out = await runFind({ query: ["qqxyzzy"] })
    expect(out).toContain("zz-fixture-gap-analysis")
    expect(out).not.toContain("need sign-in")
  })

  test("`iris find --json` signed out reports the workspace state for agents", async () => {
    setup({ token: "" })
    const out = await runFind({ query: ["genesis"], json: true })
    expect(JSON.parse(out).workspace).toEqual({ loaded: false, reason: "signed-out", notice: workspaceNotice("signed-out") })
  })
})

describe("RemoteCapabilities under test (IP-07 phase 2 #189850)", () => {
  test("OPENCODE_DISABLE_REMOTE_CAPABILITIES keeps the real defaults off the network", async () => {
    // The preload sets this flag, so a test run on a machine holding a real IRIS token never
    // reaches the API through the default fetcher.
    expect(process.env["OPENCODE_DISABLE_REMOTE_CAPABILITIES"]).toBe("true")
    const realFetch = globalThis.fetch
    let fetched = 0
    globalThis.fetch = (async () => {
      fetched++
      throw new Error("network must not be touched")
    }) as unknown as typeof fetch
    try {
      RemoteCapabilities.reset()
      RemoteCapabilities.configure({ cacheFile: path.join(os.tmpdir(), `rc-none-${process.pid}.json`) })
      const { workspace } = await loadMergedIndex()
      expect(workspace).toBe("signed-out")
      expect(fetched).toBe(0)
    } finally {
      globalThis.fetch = realFetch
      RemoteCapabilities.reset()
    }
  })
})
