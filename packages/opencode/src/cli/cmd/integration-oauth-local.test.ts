import { describe, expect, test } from "bun:test"
import {
  LOCAL_OAUTH_PROVIDERS,
  LocalOAuthError,
  awaitLoopbackCode,
  buildAuthorizeUrl,
  exchangeCode,
  buildSavePayload,
  generateState,
  loopbackRedirectUri,
  parsePastedCallback,
  persistTokens,
  providerRedirectUri,
  resolveScopes,
  type StoreTarget,
} from "./integration-oauth-local"

const clio = LOCAL_OAUTH_PROVIDERS.clio!
const linkedin = LOCAL_OAUTH_PROVIDERS.linkedin!

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

describe("linkedin (native, 2026-09-29)", () => {
  test("is a CLI-native provider with LinkedIn's own OAuth endpoints", () => {
    expect(linkedin).toBeDefined()
    expect(linkedin.authorizeUrl).toBe("https://www.linkedin.com/oauth/v2/authorization")
    expect(linkedin.tokenUrl).toBe("https://www.linkedin.com/oauth/v2/accessToken")
    // LinkedIn has no out-of-band page; paste mode reuses the loopback redirect.
    expect(linkedin.oobRedirectUri).toBeUndefined()
  })

  test("redirects to the FIXED localhost:8765 the user registers once", () => {
    expect(providerRedirectUri(linkedin)).toBe("http://localhost:8765/callback")
    expect(providerRedirectUri(linkedin, 9001)).toBe("http://localhost:9001/callback")
    // Clio keeps its 127.0.0.1:8787 default.
    expect(providerRedirectUri(clio)).toBe("http://127.0.0.1:8787/callback")
  })

  const authorize = (scopes?: string[]) =>
    buildAuthorizeUrl(linkedin, {
      clientId: "li-client",
      redirectUri: providerRedirectUri(linkedin),
      state: "s-li",
      scopes,
    })

  test("carries the member scopes space-separated (%20) and the fixed-port redirect", () => {
    const raw = authorize(resolveScopes(linkedin))
    expect(raw).toContain("scope=openid%20profile%20email%20w_member_social")
    const p = new URL(raw).searchParams
    expect(p.get("scope")).toBe("openid profile email w_member_social")
    expect(p.get("redirect_uri")).toBe("http://localhost:8765/callback")
    expect(p.get("client_id")).toBe("li-client")
    expect(p.get("response_type")).toBe("code")
    expect(p.get("state")).toBe("s-li")
  })

  test("requests organization scopes ONLY when the org set is asked for", () => {
    const member = new URL(authorize(resolveScopes(linkedin))).searchParams.get("scope")!
    expect(member).not.toContain("organization")

    const org = new URL(authorize(resolveScopes(linkedin, "org"))).searchParams.get("scope")!.split(" ")
    expect(org).toEqual(expect.arrayContaining(["w_organization_social", "r_organization_social", "rw_organization_admin"]))
    // The org set still signs the member in and lets them post as themselves.
    expect(org).toEqual(expect.arrayContaining(["openid", "profile", "email", "w_member_social"]))
  })

  test("an unknown scope set is refused, naming the real ones", () => {
    expect(() => resolveScopes(linkedin, "admin")).toThrow(/default, org/)
    expect(resolveScopes(clio)).toBeUndefined()
  })

  test("Clio's authorize URL gains no scope param", () => {
    const u = buildAuthorizeUrl(clio, { clientId: "c", redirectUri: "http://127.0.0.1:8787/callback", state: "s" })
    expect(new URL(u).searchParams.has("scope")).toBe(false)
  })

  test("token exchange POSTs form-encoded client_id/secret to LinkedIn's token URL", async () => {
    const originalFetch = globalThis.fetch
    let sentUrl = ""
    let sent: RequestInit = {}
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      sentUrl = url
      sent = init
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ access_token: "li-at", expires_in: 5183999, scope: "email,openid,profile,w_member_social" }),
      } as unknown as Response
    }) as unknown as typeof fetch
    try {
      const tokens = await exchangeCode(linkedin, {
        clientId: "li-client",
        clientSecret: "li-secret",
        code: "li-code",
        redirectUri: "http://localhost:8765/callback",
      })
      expect(tokens.access_token).toBe("li-at")
      expect(sentUrl).toBe("https://www.linkedin.com/oauth/v2/accessToken")
      expect(sent.method).toBe("POST")
      expect((sent.headers as Record<string, string>)["Content-Type"]).toBe("application/x-www-form-urlencoded")
      const body = new URLSearchParams(String(sent.body))
      expect(body.get("grant_type")).toBe("authorization_code")
      expect(body.get("code")).toBe("li-code")
      expect(body.get("client_id")).toBe("li-client")
      expect(body.get("client_secret")).toBe("li-secret")
      expect(body.get("redirect_uri")).toBe("http://localhost:8765/callback")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("stores the LinkedIn token set on fl-iris-api, where the native service reads it", async () => {
    const calls: { path: string; init: RequestInit; target: StoreTarget }[] = []
    const send = async (path: string, init: RequestInit, target: StoreTarget) => {
      calls.push({ path, init, target })
      return new Response(JSON.stringify({ success: true, data: { id: 1 } }), { status: 201 })
    }
    const now = Date.UTC(2026, 8, 29, 12, 0, 0)
    const payload = buildSavePayload(
      linkedin,
      { access_token: "li-at", expires_in: 5184000, scope: "openid profile email w_member_social" },
      { clientId: "li-client", clientSecret: "li-secret", now },
    )

    const res = await persistTokens(send, linkedin, 5269, payload)

    expect(res.status).toBe(201)
    expect(calls).toHaveLength(1)
    expect(calls[0].target).toBe("iris")
    expect(calls[0].path).toBe("/api/v1/users/5269/integrations")
    expect(calls[0].init.method).toBe("POST")
    const body = JSON.parse(String(calls[0].init.body))
    expect(body.type).toBe("linkedin")
    expect(body.status).toBe("active")
    expect(body.credentials).toEqual({
      access_token: "li-at",
      refresh_token: null,
      token_type: "Bearer",
      expires_in: 5184000,
      expires_at: new Date(now + 5184000 * 1000).toISOString(),
      // Marks a native sign-in: the server skips Composio provisioning and clears
      // is_composio_backed on a row Composio used to own.
      provider: "native",
      scope: "openid profile email w_member_social",
    })
    // No refresh token → no reason to hold the app secret anywhere.
    expect(body.credentials.client_secret).toBeUndefined()
  })

  test("stores the app credentials with a refresh token, so the server can refresh", () => {
    const body = buildSavePayload(
      linkedin,
      { access_token: "li-at", refresh_token: "li-rt", expires_in: 5184000, refresh_token_expires_in: 31536000 },
      { clientId: "li-client", clientSecret: "li-secret" },
    ) as { credentials: Record<string, unknown> }
    expect(body.credentials.refresh_token).toBe("li-rt")
    expect(body.credentials.client_id).toBe("li-client")
    expect(body.credentials.client_secret).toBe("li-secret")
    expect(body.credentials.refresh_token_expires_in).toBe(31536000)
  })

  test("Clio still stores on fl-api, unmarked, without app credentials", async () => {
    let target: StoreTarget | undefined
    const body = buildSavePayload(clio, { access_token: "c", refresh_token: "r" }, { clientId: "i", clientSecret: "s" }) as {
      credentials: Record<string, unknown>
    }
    await persistTokens(async (_p, _i, t) => ((target = t), new Response("{}")), clio, 1, body)
    expect(target).toBe("fl")
    expect(body.credentials.provider).toBeUndefined()
    expect(body.credentials.client_secret).toBeUndefined()
  })

  test("paste mode accepts the landed redirect URL, checks state, and extracts the code", () => {
    expect(parsePastedCallback("http://localhost:8765/callback?code=abc123&state=s-li", "s-li")).toBe("abc123")
    expect(parsePastedCallback("  bare-code-value  ", "s-li")).toBe("bare-code-value")
    expect(() => parsePastedCallback("http://localhost:8765/callback?code=abc&state=other", "s-li")).toThrow(/State mismatch/)
    expect(() =>
      parsePastedCallback("http://localhost:8765/callback?error=user_cancelled_authorize&state=s-li", "s-li"),
    ).toThrow(/user_cancelled_authorize/)
  })
})
