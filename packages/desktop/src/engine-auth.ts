// The window's side of the engine password (#190647).
//
// lib.rs now starts the engine with a per-launch OPENCODE_SERVER_PASSWORD and hands it to this
// window through the `engine_credentials` command. The sidecar connection carries it as
// `http.password`, which covers everything that goes through the app's server plumbing: the SDK
// and its /event stream, health and protocol probes, terminal websockets (auth_token), dictation
// and spoken replies (setDictationAuth), and terminal mode.
//
// That is not every request. Around thirty IRIS panels (titlebar pills, Settings > Account and
// Security, the IRIS tab, allowance, the command palette, onboarding, card notices …) call the
// engine's /iris routes with a bare `fetch(base + path)`. Each was written for an engine with no
// password, and each would fail closed — silently, as an empty panel. Rather than thread a header
// through every one of them (and every one added next month), the desktop wraps `fetch` once: a
// request to THIS engine's origin that carries no Authorization gets this engine's. Requests to
// anywhere else are untouched, so the credential never travels to another host.

export type EngineCredentials = { username: string; password: string }

export function basicAuthorization(credentials: EngineCredentials) {
  return `Basic ${btoa(`${credentials.username}:${credentials.password}`)}`
}

/** Both loopback spellings of the engine's origin: the window uses 127.0.0.1, some callers localhost. */
export function engineOrigins(port: number) {
  return new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`])
}

function urlOf(input: RequestInfo | URL): URL | undefined {
  try {
    if (input instanceof URL) return input
    if (typeof Request !== "undefined" && input instanceof Request) return new URL(input.url)
    return new URL(String(input))
  } catch {
    // Relative URLs resolve against the app's own origin (tauri://…), never the engine's.
    return undefined
  }
}

/**
 * `base`, except that a request to one of `origins` without an Authorization header is sent with
 * `authorization`. An explicit header (the SDK's own, or anything a caller set) always wins.
 */
export function withEngineAuth(
  base: typeof globalThis.fetch,
  origins: Set<string>,
  authorization: string,
): typeof globalThis.fetch {
  const wrapped = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input)
    if (!url || !origins.has(url.origin)) return base(input, init)

    const isRequest = typeof Request !== "undefined" && input instanceof Request
    const headers = new Headers(init?.headers ?? (isRequest ? (input as Request).headers : undefined))
    if (headers.has("authorization")) return base(input, init)
    headers.set("authorization", authorization)

    if (isRequest && !init) return base(new Request(input as Request, { headers }))
    return base(input, { ...init, headers })
  }
  return Object.assign(wrapped, base) as typeof globalThis.fetch
}
