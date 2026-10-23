import { describe, expect, test } from "bun:test"
import { basicAuthorization, engineOrigins, withEngineAuth } from "./engine-auth"

// #190647 — the engine now has a per-launch password. The IRIS panels call it with a bare fetch,
// so the desktop wraps fetch: this engine's requests get its credential; nothing else does.

const AUTH = basicAuthorization({ username: "opencode", password: "per-launch" })

function recorder() {
  const calls: { url: string; authorization: string | null }[] = []
  const base = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    calls.push({ url: request.url, authorization: request.headers.get("authorization") })
    return new Response("ok")
  }) as typeof globalThis.fetch
  return { calls, fetch: withEngineAuth(base, engineOrigins(49244), AUTH) }
}

describe("withEngineAuth", () => {
  test("the header is the engine's Basic format", () => {
    expect(AUTH).toBe(`Basic ${btoa("opencode:per-launch")}`)
  })

  test("a bare fetch to the engine (an IRIS panel) gets the credential", async () => {
    const r = recorder()
    await r.fetch("http://127.0.0.1:49244/iris/me")
    await r.fetch(new URL("http://localhost:49244/iris/allowance"))
    await r.fetch(new Request("http://127.0.0.1:49244/iris/security", { method: "POST" }))
    await r.fetch("http://127.0.0.1:49244/iris/accounts/switch", { method: "POST", headers: { "content-type": "application/json" } })
    expect(r.calls.map((c) => c.authorization)).toEqual([AUTH, AUTH, AUTH, AUTH])
  })

  test("an explicit Authorization (the SDK's own) is left alone", async () => {
    const r = recorder()
    await r.fetch("http://127.0.0.1:49244/session", { headers: { Authorization: "Basic other" } })
    await r.fetch(new Request("http://127.0.0.1:49244/session", { headers: { authorization: "Basic req" } }))
    expect(r.calls.map((c) => c.authorization)).toEqual(["Basic other", "Basic req"])
  })

  test("the credential never goes to another host or port", async () => {
    const r = recorder()
    await r.fetch("https://heyiris.io/api/v1/me")
    await r.fetch("http://127.0.0.1:49245/session")
    await r.fetch("http://evil.example:49244/session")
    await r.fetch("https://127.0.0.1:49244/session")
    expect(r.calls.map((c) => c.authorization)).toEqual([null, null, null, null])
  })

  test("relative and unparseable URLs pass through untouched", async () => {
    const calls: unknown[] = []
    const base = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push([input, init])
      return new Response("ok")
    }) as typeof globalThis.fetch
    const f = withEngineAuth(base, engineOrigins(49244), AUTH)
    await f("/assets/x.json")
    expect(calls).toEqual([["/assets/x.json", undefined]])
  })
})
