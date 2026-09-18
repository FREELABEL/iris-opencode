import { describe, expect, test } from "bun:test"
import { classifyNodeKeyStatus, lanAddress, probeNodeKey, NODE_KEY_FIX } from "./node-key"

const fakeFetch = (status: number) => (async () => new Response("{}", { status })) as unknown as typeof fetch

describe("classifyNodeKeyStatus", () => {
  test("only a 401 means the key is dead", () => {
    expect(classifyNodeKeyStatus(200)).toBe("valid")
    expect(classifyNodeKeyStatus(401)).toBe("rejected")
  })

  test("a 403 is a suspended node, NOT a dead key — re-registering it would mint a second node", () => {
    expect(classifyNodeKeyStatus(403)).toBe("suspended")
  })

  test("anything else claims nothing", () => {
    for (const s of [404, 429, 500, 502]) expect(classifyNodeKeyStatus(s)).toBe("unreachable")
  })
})

describe("probeNodeKey", () => {
  test("posts the key to the heartbeat and classifies the answer", async () => {
    let seen: { url?: string; auth?: string } = {}
    const f = (async (url: string, init: RequestInit) => {
      seen = { url, auth: (init.headers as Record<string, string>).Authorization }
      return new Response("{}", { status: 401 })
    }) as unknown as typeof fetch
    expect(await probeNodeKey("node_live_x", "https://freelabel.net/", f)).toBe("rejected")
    expect(seen.url).toBe("https://freelabel.net/api/v6/node-agent/heartbeat")
    expect(seen.auth).toBe("Bearer node_live_x")
  })

  test("a network failure is unreachable, never rejected", async () => {
    const boom = (async () => {
      throw new Error("offline")
    }) as unknown as typeof fetch
    expect(await probeNodeKey("k", "https://x", boom)).toBe("unreachable")
    expect(await probeNodeKey("k", "https://x", fakeFetch(200))).toBe("valid")
  })

  test("the fix it names is the command that actually mints a node key", () => {
    expect(NODE_KEY_FIX).toBe("iris hive connect --force")
  })
})

describe("lanAddress", () => {
  test("skips loopback and IPv6, returns the first external IPv4", () => {
    expect(
      lanAddress({
        lo0: [{ family: "IPv4", internal: true, address: "127.0.0.1" }],
        en0: [
          { family: "IPv6", internal: false, address: "fe80::1" },
          { family: "IPv4", internal: false, address: "192.168.4.41" },
        ],
      }),
    ).toBe("192.168.4.41")
  })

  test("accepts the numeric family some Node versions report", () => {
    expect(lanAddress({ en0: [{ family: 4, internal: false, address: "10.0.0.2" }] })).toBe("10.0.0.2")
  })

  test("no external interface → undefined, so doctor skips the check instead of probing 0.0.0.0", () => {
    expect(lanAddress({ lo0: [{ family: "IPv4", internal: true, address: "127.0.0.1" }] })).toBeUndefined()
  })
})
