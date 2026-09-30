/**
 * CLI-native OAuth for integrations that we drive ourselves rather than through
 * Composio or the web UI.
 *
 * Why this exists: `iris integrations connect <type>` asks the server for an
 * authorize URL, which means a provider with no server-side case (Clio, and the
 * same story for DocuSign/QuickBooks) simply cannot be connected from the binary.
 * This module closes the loop entirely inside the CLI — loopback listener, token
 * exchange, then hand the tokens to fl-api to persist.
 *
 * Deliberately NOT reusing src/mcp/oauth-callback.ts: that one is a process-wide
 * singleton on a fixed port shared with MCP auth, and when the port is already
 * held it returns without a server and waits forever. This is single-shot and
 * parameterised, so two flows can never collide.
 */

export interface LocalOAuthProvider {
  slug: string
  label: string
  authorizeUrl: string
  tokenUrl: string
  /** Extra params to append to the authorize URL (e.g. scope, access_type). */
  authorizeParams?: Record<string, string>
  /**
   * Provider-hosted out-of-band redirect for desktop/CLI apps — shows the code
   * on screen for the user to paste. Lets `--paste` work with no local listener,
   * which matters on locked-down machines and over SSH.
   */
  oobRedirectUri?: string
  /** Region caveats worth printing before someone burns an afternoon. */
  note?: string
  /**
   * Host written into the loopback redirect URI. Providers that match the redirect
   * byte-for-byte against what the app registered (LinkedIn) need the exact string the
   * user registered — `localhost`, not `127.0.0.1`. The listener still binds 127.0.0.1.
   */
  loopbackHost?: string
  /**
   * A FIXED default port for providers that require the redirect (port included) to be
   * registered on the app, so the user registers it once. Overridden by --port.
   */
  defaultPort?: number
  /**
   * Named scope sets, sent space-separated as `scope`. `default` is used unless another
   * set is asked for. Each set is complete on its own (not additive), so what is sent is
   * exactly what the set lists.
   */
  scopeSets?: Record<string, string[]>
  /**
   * Which API persists the token set: "fl" (fl-api — Clio's service lives there) or
   * "iris" (fl-iris-api — where the native LinkedIn service reads its row).
   */
  storeBase?: "fl" | "iris"
  /** Mark the stored credential as a native sign-in (`credentials.provider = "native"`). */
  nativeCredential?: boolean
  /**
   * Store the app's client id/secret with the token set WHEN a refresh token came back, so
   * the server can refresh without its own env. Encrypted server-side like every token.
   */
  storeAppCredentialsForRefresh?: boolean
  /** A read-only command that proves the connection works. */
  verifyCommand?: string
  /** Lines printed before the browser opens: what the app must have registered. */
  setup?: string[]
}

export const LOCAL_OAUTH_PROVIDERS: Record<string, LocalOAuthProvider> = {
  clio: {
    slug: "clio",
    label: "Clio",
    authorizeUrl: "https://app.clio.com/oauth/authorize",
    tokenUrl: "https://app.clio.com/oauth/token",
    oobRedirectUri: "https://app.clio.com/oauth/approval",
    note: "US region (app.clio.com). Tokens minted here are NOT valid against the EU/CA/AU hosts.",
    storeBase: "fl",
    verifyCommand: "iris integrations exec clio list_matters",
  },
  /**
   * LinkedIn, native (2026-09-29). Composio's LinkedIn toolkit sent a retired
   * LinkedIn-Version and its fresh connections expired within seconds, so IRIS signs in
   * itself and fl-iris-api's LinkedInIntegrationService spends the token.
   *
   * LinkedIn matches redirect_uri EXACTLY against the app's registered list, port
   * included, and has no out-of-band redirect — hence the fixed localhost:8765.
   * Org scopes are opt-in: asking for scopes the app has not been approved for makes
   * LinkedIn reject the whole authorization, member scopes included.
   */
  linkedin: {
    slug: "linkedin",
    label: "LinkedIn",
    authorizeUrl: "https://www.linkedin.com/oauth/v2/authorization",
    tokenUrl: "https://www.linkedin.com/oauth/v2/accessToken",
    loopbackHost: "localhost",
    defaultPort: 8765,
    scopeSets: {
      // "Sign In with LinkedIn using OpenID Connect" + "Share on LinkedIn" (self-serve).
      default: ["openid", "profile", "email", "w_member_social"],
      // + "Community Management API" (LinkedIn must approve the app first).
      org: [
        "openid",
        "profile",
        "email",
        "w_member_social",
        "w_organization_social",
        "r_organization_social",
        "rw_organization_admin",
      ],
    },
    storeBase: "iris",
    nativeCredential: true,
    storeAppCredentialsForRefresh: true,
    verifyCommand: "iris integrations exec linkedin get_my_info",
    note: "Access tokens last about 60 days. Refresh tokens are only issued to some LinkedIn partner apps; without one, run this command again when IRIS asks.",
    setup: [
      "LinkedIn app (developer.linkedin.com → your app):",
      "  Auth → Authorized redirect URLs: add the Redirect URI above, exactly.",
      "  Products: \"Sign In with LinkedIn using OpenID Connect\" + \"Share on LinkedIn\" (post as yourself).",
      "  Company pages also need \"Community Management API\" (LinkedIn approves it) — then connect with --org.",
    ],
  },
}

export interface TokenSet {
  access_token: string
  refresh_token?: string
  token_type?: string
  expires_in?: number
  /** Space-separated scopes the provider actually granted (LinkedIn returns it). */
  scope?: string
  refresh_token_expires_in?: number
}

export class LocalOAuthError extends Error {}

/** Cryptographically random state — this is the CSRF guard, not a nonce for show. */
export function generateState(): string {
  const bytes = new Uint8Array(24)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
}

export function loopbackRedirectUri(port: number, path = "/callback", host = "127.0.0.1"): string {
  return `http://${host}:${port}${path}`
}

/** The redirect URI a provider's loopback flow uses — the string the user must register. */
export function providerRedirectUri(provider: LocalOAuthProvider, port?: number): string {
  return loopbackRedirectUri(port ?? provider.defaultPort ?? 8787, "/callback", provider.loopbackHost ?? "127.0.0.1")
}

/**
 * The scopes to request: the named set, or the provider's `default`. Undefined when the
 * provider declares no scope sets (Clio — scopes live on its app, not the URL).
 */
export function resolveScopes(provider: LocalOAuthProvider, set?: string): string[] | undefined {
  const sets = provider.scopeSets
  if (!sets) {
    if (set && set !== "default") {
      throw new LocalOAuthError(`${provider.label} has no scope sets; drop --scope-set/--org.`)
    }
    return undefined
  }
  const name = set ?? "default"
  const scopes = sets[name]
  if (!scopes) {
    throw new LocalOAuthError(`Unknown ${provider.label} scope set "${name}". Available: ${Object.keys(sets).join(", ")}.`)
  }
  return scopes
}

export function buildAuthorizeUrl(
  provider: LocalOAuthProvider,
  opts: { clientId: string; redirectUri: string; state: string; scopes?: string[] },
): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    state: opts.state,
    ...(provider.authorizeParams ?? {}),
  })
  if (opts.scopes && opts.scopes.length > 0) params.set("scope", opts.scopes.join(" "))
  // URLSearchParams writes a space as "+"; a literal "+" is already "%2B", so this only
  // touches spaces. %20 is what LinkedIn documents for its space-separated scope list.
  return `${provider.authorizeUrl}?${params.toString().replace(/\+/g, "%20")}`
}

/**
 * For providers with no out-of-band page: in paste mode the browser lands on the
 * (unanswered) loopback redirect and the user pastes that URL from the address bar.
 * A bare code is accepted too. A pasted URL must carry OUR state — the same CSRF rule
 * the listener enforces.
 */
export function parsePastedCallback(input: string, expectedState: string): string {
  const text = input.trim()
  if (!/^https?:\/\//i.test(text)) return text
  const url = new URL(text)
  const error = url.searchParams.get("error")
  if (error) throw new LocalOAuthError(`Denied: ${url.searchParams.get("error_description") || error}`)
  const state = url.searchParams.get("state")
  if (!state || state !== expectedState) {
    throw new LocalOAuthError("State mismatch — this callback did not come from this session.")
  }
  const code = url.searchParams.get("code")
  if (!code) throw new LocalOAuthError("No authorization code in the pasted URL.")
  return code
}

/**
 * The body POSTed to /api/v1/users/{id}/integrations for a freshly minted token set.
 * Pure, so the exact shape each provider stores is testable without a network.
 */
export function buildSavePayload(
  provider: LocalOAuthProvider,
  tokens: TokenSet,
  opts: { clientId: string; clientSecret: string; name?: string; bloq?: number; now?: number },
): Record<string, unknown> {
  const now = opts.now ?? Date.now()
  const expiresIn = Number(tokens.expires_in ?? 3600)
  const credentials: Record<string, unknown> = {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token ?? null,
    token_type: tokens.token_type ?? "Bearer",
    expires_in: expiresIn,
    // ISO8601 on purpose: the server-side service Carbon::parse()s this and
    // rewrites it in the same shape on refresh. A unix int throws there.
    expires_at: new Date(now + expiresIn * 1000).toISOString(),
  }
  if (provider.nativeCredential) credentials.provider = "native"
  if (tokens.scope) credentials.scope = tokens.scope
  if (tokens.refresh_token_expires_in) credentials.refresh_token_expires_in = tokens.refresh_token_expires_in
  // Only when there IS something to refresh — no reason to hold an app secret otherwise.
  if (provider.storeAppCredentialsForRefresh && tokens.refresh_token) {
    credentials.client_id = opts.clientId
    credentials.client_secret = opts.clientSecret
  }

  const payload: Record<string, unknown> = { type: provider.slug, status: "active", credentials }
  if (opts.name) payload.name = opts.name
  if (opts.bloq) payload.bloq_id = opts.bloq
  return payload
}

export type StoreTarget = "fl" | "iris"
export type IntegrationSender = (path: string, init: RequestInit, target: StoreTarget) => Promise<Response>

/** Persist the token set on the API the provider's service reads from. */
export function persistTokens(
  send: IntegrationSender,
  provider: LocalOAuthProvider,
  userId: number | string,
  payload: Record<string, unknown>,
): Promise<Response> {
  return send(
    `/api/v1/users/${userId}/integrations`,
    { method: "POST", body: JSON.stringify(payload) },
    provider.storeBase ?? "fl",
  )
}

/**
 * Exchange an authorization code for tokens.
 *
 * redirectUri MUST be byte-identical to the one used at authorize time — every
 * provider validates it again here, and a mismatch surfaces as an opaque
 * `invalid_grant` that looks like a bad code.
 */
export async function exchangeCode(
  provider: LocalOAuthProvider,
  opts: { clientId: string; clientSecret: string; code: string; redirectUri: string },
): Promise<TokenSet> {
  const res = await fetch(provider.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: opts.code,
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      redirect_uri: opts.redirectUri,
    }).toString(),
  })

  const text = await res.text()
  if (!res.ok) {
    // Surface the provider's own words — "invalid_grant" alone sends people
    // hunting the wrong bug. Truncated so a stray HTML error page can't flood
    // the terminal.
    throw new LocalOAuthError(`${provider.label} token exchange failed (HTTP ${res.status}): ${text.slice(0, 300)}`)
  }

  let parsed: TokenSet
  try {
    parsed = JSON.parse(text) as TokenSet
  } catch {
    throw new LocalOAuthError(`${provider.label} returned a non-JSON token response: ${text.slice(0, 200)}`)
  }

  if (!parsed?.access_token) {
    throw new LocalOAuthError(`${provider.label} returned no access token`)
  }
  return parsed
}

const SUCCESS_HTML = (label: string) => `<!DOCTYPE html>
<html><head><title>Connected</title><style>
body{font-family:system-ui,-apple-system,sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#0f1117;color:#e6e8ee}
.c{text-align:center;padding:2rem}h1{color:#4ade80;margin:0 0 .75rem;font-size:1.35rem}p{color:#9aa1b1;margin:0}
</style></head><body><div class="c"><h1>${label} authorized</h1><p>You can close this window and return to your terminal.</p></div>
<script>setTimeout(function(){window.close()},1500)</script></body></html>`

const ERROR_HTML = (label: string, msg: string) => `<!DOCTYPE html>
<html><head><title>Authorization failed</title><style>
body{font-family:system-ui,-apple-system,sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#0f1117;color:#e6e8ee}
.c{text-align:center;padding:2rem;max-width:34rem}h1{color:#f87171;margin:0 0 .75rem;font-size:1.35rem}
.e{color:#fca5a5;font-family:ui-monospace,monospace;margin-top:1rem;padding:.85rem;background:rgba(248,113,113,.1);border-radius:.5rem;word-break:break-word}
</style></head><body><div class="c"><h1>${label} authorization failed</h1><div class="e">${msg}</div></div></body></html>`

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!)
}

type LoopbackOutcome = { ok: true; code: string } | { ok: false; error: Error }

/**
 * Serve a single-shot loopback listener and resolve with the authorization code.
 *
 * Two ordering rules make this behave, and both were learned the hard way:
 *
 *  1. The outcome is recorded but NOT settled from inside the request handler.
 *     Tearing the server down the instant we have a code force-closes the socket
 *     before the response flushes, so the browser shows ECONNRESET instead of
 *     "authorized" — or, on the failure paths, instead of the reason it failed.
 *  2. This promise settles only after the listener has actually stopped, so by
 *     the time a caller sees the result (or the error) the port is free and a
 *     retry can bind it immediately.
 */
export async function awaitLoopbackCode(opts: {
  provider: LocalOAuthProvider
  port: number
  path?: string
  state: string
  timeoutMs?: number
  /** Grace period for the response to flush before the socket closes. */
  flushMs?: number
}): Promise<string> {
  const path = opts.path ?? "/callback"
  const timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000
  const flushMs = opts.flushMs ?? 25

  let outcome: LoopbackOutcome | null = null
  let markHandled: () => void = () => {}
  const handled = new Promise<void>((resolve) => {
    markHandled = resolve
  })

  const finish = (result: LoopbackOutcome) => {
    // First callback wins; a second request must not overwrite the verdict.
    if (outcome) return
    outcome = result
    // Next tick, so the Response we are about to return gets written first.
    setTimeout(markHandled, 0)
  }

  const server = Bun.serve({
    port: opts.port,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname !== path) return new Response("Not found", { status: 404 })

      const fail = (msg: string) => {
        finish({ ok: false, error: new LocalOAuthError(msg) })
        return new Response(ERROR_HTML(opts.provider.label, escapeHtml(msg)), {
          status: 400,
          headers: { "Content-Type": "text/html" },
        })
      }

      const error = url.searchParams.get("error")
      if (error) {
        const description = url.searchParams.get("error_description") || error
        return fail(`${opts.provider.label} denied the request: ${description}`)
      }

      const state = url.searchParams.get("state")
      // Checked before the code is even read: a callback we did not initiate must
      // never have its code exchanged, whatever else the query string contains.
      if (!state || state !== opts.state) {
        return fail("State mismatch — this callback did not come from this session.")
      }

      const code = url.searchParams.get("code")
      if (!code) return fail("No authorization code in the callback.")

      finish({ ok: true, code })
      return new Response(SUCCESS_HTML(opts.provider.label), { headers: { "Content-Type": "text/html" } })
    },
  })

  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs)
  })

  try {
    await Promise.race([handled, timedOut])
    // Let the in-flight response reach the browser before the socket goes away.
    if (outcome) await Bun.sleep(flushMs)
  } finally {
    if (timer) clearTimeout(timer)
    server.stop()
  }

  // Re-widened deliberately: `outcome` is only ever assigned inside the request
  // handler closure, which TS's control-flow analysis cannot see — without this
  // it narrows to `never` here and every property access errors.
  const result = outcome as LoopbackOutcome | null
  if (!result) throw new LocalOAuthError("Timed out waiting for the browser callback.")
  if (!result.ok) throw result.error
  return result.code
}
