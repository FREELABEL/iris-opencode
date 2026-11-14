import { describe, expect, test } from "bun:test"
import {
  LOCAL_OAUTH_PROVIDERS,
  LocalOAuthError,
  awaitLoopbackCode,
  buildAuthorizeUrl,
  exchangeCode,
  generateState,
  loopbackRedirectUri,
} from "./integration-oauth-local"

const clio = LOCAL_OAUTH_PROVIDERS.clio!

describe("generateState", () => {
  test("is long enough to be a real CSRF guard", () => {
    expect(generateState().length).toBeGreaterThanOrEqual(32)
  })

  test("does not repeat", () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateState()))
    expect(seen.size).toBe(200)
  })
})

describe("loopbackRedirectUri", () => {
  test("binds to 127.0.0.1, never a public interface", () => {
    expect(loopbackRedirectUri(8787)).toBe("http://127.0.0.1:8787/callback")
  })
})

describe("buildAuthorizeUrl", () => {
  const url = () =>
    new URL(
      buildAuthorizeUrl(clio, {
        clientId: "abc123",
        redirectUri: "http://127.0.0.1:8787/callback",
        state: "s-1",
      }),
    )

  test("targets Clio's authorize endpoint", () => {
    expect(url().origin + url().pathname).toBe("https://app.clio.com/oauth/authorize")
  })

  test("carries the OAuth params", () => {
    const p = url().searchParams
    expect(p.get("response_type")).toBe("code")
    expect(p.get("client_id")).toBe("abc123")
    expect(p.get("state")).toBe("s-1")
  })

  test("encodes the redirect_uri so the loopback port survives round-tripping", () => {
    expect(url().searchParams.get("redirect_uri")).toBe("http://127.0.0.1:8787/callback")
  })

  test("never leaks the client secret into the browser URL", () => {
    expect(url().toString()).not.toContain("secret")
  })
})

describe("exchangeCode", () => {
  const originalFetch = globalThis.fetch

  function stubFetch(res: { ok: boolean; status: number; body: string }, capture?: (init: RequestInit) => void) {
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      capture?.(init)
      return {
        ok: res.ok,
        status: res.status,
        text: async () => res.body,
      } as unknown as Response
    }) as unknown as typeof fetch
  }

  const restore = () => {
    globalThis.fetch = originalFetch
  }

  test("returns the token set on success", async () => {
    stubFetch({ ok: true, status: 200, body: JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 3600 }) })
    try {
      const tokens = await exchangeCode(clio, { clientId: "id", clientSecret: "sec", code: "c", redirectUri: "r" })
      expect(tokens.access_token).toBe("at")
      expect(tokens.refresh_token).toBe("rt")
    } finally {
      restore()
    }
  })

  test("replays the SAME redirect_uri — a mismatch here is the classic invalid_grant", async () => {
    let sentBody = ""
    stubFetch({ ok: true, status: 200, body: JSON.stringify({ access_token: "at" }) }, (init) => {
      sentBody = String(init.body)
    })
    try {
      await exchangeCode(clio, {
        clientId: "id",
        clientSecret: "sec",
        code: "c",
        redirectUri: "http://127.0.0.1:8787/callback",
      })
      const params = new URLSearchParams(sentBody)
      expect(params.get("redirect_uri")).toBe("http://127.0.0.1:8787/callback")
      expect(params.get("grant_type")).toBe("authorization_code")
    } finally {
      restore()
    }
  })

  test("surfaces the provider's own error text rather than a generic failure", async () => {
    stubFetch({ ok: false, status: 400, body: '{"error":"invalid_grant"}' })
    try {
      await expect(
        exchangeCode(clio, { clientId: "id", clientSecret: "sec", code: "bad", redirectUri: "r" }),
      ).rejects.toThrow(/invalid_grant/)
    } finally {
      restore()
    }
  })

  test("rejects a 200 that carries no access token", async () => {
    stubFetch({ ok: true, status: 200, body: JSON.stringify({ token_type: "Bearer" }) })
    try {
      await expect(
        exchangeCode(clio, { clientId: "id", clientSecret: "sec", code: "c", redirectUri: "r" }),
      ).rejects.toBeInstanceOf(LocalOAuthError)
    } finally {
      restore()
    }
  })

  test("rejects a non-JSON body instead of throwing a parse error at the caller", async () => {
    stubFetch({ ok: true, status: 200, body: "<html>maintenance</html>" })
    try {
      await expect(
        exchangeCode(clio, { clientId: "id", clientSecret: "sec", code: "c", redirectUri: "r" }),
      ).rejects.toThrow(/non-JSON/)
    } finally {
      restore()
    }
  })
})

const fetchNoKeepAlive = (url: string) => fetch(url, { headers: { Connection: "close" } })

describe("awaitLoopbackCode", () => {
  // Ports are picked per-test so a leaked listener from one case cannot make the
  // next one pass for the wrong reason.
  let port = 34871

  test("resolves with the code when the state matches", async () => {
    const p = port++
    const state = generateState()
    const waiter = awaitLoopbackCode({ provider: clio, port: p, state })
    const res = await fetchNoKeepAlive(`http://127.0.0.1:${p}/callback?code=the-code&state=${state}`)
    expect(res.status).toBe(200)
    expect(await waiter).toBe("the-code")
  })

  test("rejects a mismatched state and does NOT hand back the code", async () => {
    const p = port++
    const waiter = awaitLoopbackCode({ provider: clio, port: p, state: generateState() })
    const res = await fetchNoKeepAlive(`http://127.0.0.1:${p}/callback?code=attacker-code&state=not-ours`)
    expect(res.status).toBe(400)
    await expect(waiter).rejects.toThrow(/State mismatch/)
  })

  test("rejects a callback with no state at all", async () => {
    const p = port++
    const waiter = awaitLoopbackCode({ provider: clio, port: p, state: generateState() })
    await fetchNoKeepAlive(`http://127.0.0.1:${p}/callback?code=no-state`)
    await expect(waiter).rejects.toThrow(/State mismatch/)
  })

  test("propagates a provider denial", async () => {
    const p = port++
    const state = generateState()
    const waiter = awaitLoopbackCode({ provider: clio, port: p, state })
    await fetchNoKeepAlive(`http://127.0.0.1:${p}/callback?error=access_denied&error_description=User+said+no&state=${state}`)
    await expect(waiter).rejects.toThrow(/User said no/)
  })

  test("releases the port after failure, so a retry can bind it again", async () => {
    const p = port++
    const first = awaitLoopbackCode({ provider: clio, port: p, state: generateState() })
    await fetchNoKeepAlive(`http://127.0.0.1:${p}/callback?code=x&state=wrong`)
    await expect(first).rejects.toThrow()

    // Binding the same port again is the assertion — it throws if the listener leaked.
    const state = generateState()
    const second = awaitLoopbackCode({ provider: clio, port: p, state })
    await fetchNoKeepAlive(`http://127.0.0.1:${p}/callback?code=retry-code&state=${state}`)
    expect(await second).toBe("retry-code")
  })

  test("times out rather than hanging forever", async () => {
    const p = port++
    await expect(
      awaitLoopbackCode({ provider: clio, port: p, state: generateState(), timeoutMs: 50 }),
    ).rejects.toThrow(/Timed out/)
  })
})
