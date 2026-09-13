import { describe, test, expect, afterEach } from "bun:test"
import { mkdtempSync, writeFileSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import {
  deriveName,
  isPidAlive,
  parseEntry,
  probeSessionServer,
  resolvePeer,
  type PeerEntry,
} from "./hive-peer-registry"

/**
 * A2A addressing (epic #182718, S1).
 *
 * WHAT SHAPED THESE TESTS. Three false signals measured on a live machine 2026-09-12, each of
 * which a naive implementation would reproduce:
 *
 *  1. Every session server shares one SQLite DB, so `/session` on ANY port lists EVERY session.
 *     Addressing a SESSION is therefore meaningless; you address a PROCESS.
 *  2. Unknown paths return HTTP **200** with the SPA's HTML. A status-code liveness check calls
 *     a dead or unrelated port healthy, so `probeSessionServer` asserts on the BODY.
 *  3. Ports vanish — `:55087` answered and was gone twenty minutes later. Entries are never
 *     trusted without a liveness check.
 *
 * These assert the decisions, not the plumbing: an ambiguous name must ERROR rather than pick,
 * because mis-delivering an instruction is worse than not delivering it.
 */

const made: string[] = []
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true })
})

function peer(name: string, over: Partial<PeerEntry> = {}): PeerEntry {
  return {
    name,
    port: 40000,
    pid: 1,
    url: "http://127.0.0.1:40000",
    directory: `/w/${name}`,
    ts: new Date().toISOString(),
    ...over,
  }
}

describe("deriveName — a name a human would actually type", () => {
  test("is the directory basename", () => {
    expect(deriveName("/Users/x/sites/frontend", 99)).toBe("frontend")
    expect(deriveName("/Users/x/sites/freelabel/", 99)).toBe("freelabel")
  })

  test("never returns an empty name — a nameless entry is unaddressable", () => {
    for (const bad of ["", "/", ".", "   "]) {
      expect(deriveName(bad, 4242)).toBe("pid-4242")
    }
  })
})

describe("parseEntry — malformed files are skipped, never thrown on", () => {
  test("a good entry round-trips", () => {
    const e = parseEntry(JSON.stringify(peer("frontend", { port: 1234, pid: 77 })))
    expect(e?.name).toBe("frontend")
    expect(e?.port).toBe(1234)
    expect(e?.pid).toBe(77)
  })

  test("garbage, truncation and wrong types return null rather than crashing the listing", () => {
    for (const bad of [
      "",
      "not json",
      "{",
      "{}",
      '{"name":"x"}',
      '{"name":"x","port":0,"pid":1}',
      '{"name":"","port":1,"pid":1}',
      '{"name":"x","port":"1234","pid":1}',
      '{"name":"x","port":1234,"pid":-1}',
    ]) {
      expect(parseEntry(bad)).toBeNull()
    }
  })

  test("url is defaulted, never left undefined, so callers cannot build a half URL", () => {
    const e = parseEntry('{"name":"x","port":1234,"pid":5}')
    expect(e?.url).toBe("http://127.0.0.1:1234")
  })
})

describe("isPidAlive", () => {
  test("this process is alive; pid 0 and negatives are not", () => {
    expect(isPidAlive(process.pid)).toBe(true)
    expect(isPidAlive(0)).toBe(false)
    expect(isPidAlive(-1)).toBe(false)
  })

  test("an almost-certainly-dead pid reads dead", () => {
    // 2^22 is above every default pid_max on macOS and Linux.
    expect(isPidAlive(4_194_303)).toBe(false)
  })
})

describe("probeSessionServer — asserts on the BODY, because 200 means nothing here", () => {
  test("a closed port is not live", async () => {
    // Port 1 is privileged and unbound in any normal environment.
    expect(await probeSessionServer(1, 300)).toBe(false)
  })

  test("HTTP 200 serving the SPA's HTML is NOT a session server", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response("<!doctype html><html>OpenCode</html>", {
        headers: { "content-type": "text/html" },
      }),
    })
    try {
      expect(await probeSessionServer(server.port!, 1000)).toBe(false)
    } finally {
      server.stop(true)
    }
  })

  test("a JSON object is not enough — /session must be an ARRAY", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ sessions: [] }),
    })
    try {
      expect(await probeSessionServer(server.port!, 1000)).toBe(false)
    } finally {
      server.stop(true)
    }
  })

  test("a JSON array IS a session server", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json([{ id: "ses_abc" }]),
    })
    try {
      expect(await probeSessionServer(server.port!, 1000)).toBe(true)
    } finally {
      server.stop(true)
    }
  })
})

describe("resolvePeer — ambiguity is an error, never a guess", () => {
  const peers = [peer("frontend", { pid: 11 }), peer("backend", { pid: 12 }), peer("freelabel", { pid: 13 })]

  test("exact name wins", () => {
    const r = resolvePeer(peers, "backend")
    expect("peer" in r && r.peer.pid).toBe(12)
  })

  test("a unique prefix resolves, case-insensitively", () => {
    expect("peer" in resolvePeer(peers, "back")).toBe(true)
    expect("peer" in resolvePeer(peers, "BACK")).toBe(true)
  })

  test("an ambiguous prefix REFUSES and names the candidates", () => {
    const r = resolvePeer(peers, "f")
    expect("error" in r).toBe(true)
    if ("error" in r) {
      expect(r.error).toContain("ambiguous")
      expect(r.error).toContain("frontend")
      expect(r.error).toContain("freelabel")
    }
  })

  test("two live sessions sharing a name REFUSE rather than pick one", () => {
    const dup = [peer("api", { pid: 21 }), peer("api", { pid: 22 })]
    const r = resolvePeer(dup, "api")
    expect("error" in r).toBe(true)
    if ("error" in r) {
      expect(r.error).toContain("21")
      expect(r.error).toContain("22")
    }
  })

  test("an unknown name lists what IS live, so the error is actionable", () => {
    const r = resolvePeer(peers, "nope")
    expect("error" in r).toBe(true)
    if ("error" in r) expect(r.error).toContain("frontend")
  })

  test("with nothing live it says so instead of naming nobody", () => {
    const r = resolvePeer([], "frontend")
    expect("error" in r && r.error).toContain("none live")
  })

  test("an empty name is refused", () => {
    expect("error" in resolvePeer(peers, "   ")).toBe(true)
  })
})
