import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { Effect } from "effect"

// DNS-rebinding guard (#192113). A page can point its own DNS name at 127.0.0.1; it cannot change
// the Host its browser sends. Wraps everything, the web shell included: the shell is served before
// API auth so a signed-out browser reaches its sign-in screen, and a rebound name must not get it.
//
// Pairing and LAN access keep working, because every address this server advertises is allowed.
// Any other name (a tailnet name, a reverse proxy) is opt-in: OPENCODE_SERVER_ALLOWED_HOSTS.
export const ALLOWED_HOSTS_ENV = "OPENCODE_SERVER_ALLOWED_HOSTS"

export function isLoopbackName(hostname: string) {
  const name = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "")
  return (
    name === "localhost" ||
    name === "::1" ||
    name === "0:0:0:0:0:0:0:1" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name)
  )
}

export function parseAllowedHosts(value: string | undefined) {
  return (value ?? "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean)
}

export function hostAllowed(host: string | undefined, allowed: () => Iterable<string>) {
  const full = (host ?? "").trim().toLowerCase()
  // HTTP/1.1 requires a Host and every browser sends one, so absent is not a browser. Auth still applies.
  if (host === undefined) return true
  if (!full) return false
  const bracket = /^\[([^\]]+)\](?::\d+)?$/.exec(full)
  const name = bracket ? bracket[1]! : full.replace(/:\d+$/, "")
  if (isLoopbackName(name)) return true
  for (const entry of allowed()) {
    const value = entry.trim().toLowerCase()
    if (value === full || value === name) return true
  }
  return false
}

/** The hosts of the URLs a server advertises, plus its bound name and the configured extras. */
export function allowedHosts(input: {
  readonly hostname: string
  readonly urls: ReadonlyArray<string>
  readonly extra?: ReadonlyArray<string>
}) {
  const hosts = new Set(input.extra ?? [])
  if (input.hostname !== "0.0.0.0" && input.hostname !== "::" && input.hostname !== "[::]") hosts.add(input.hostname)
  for (const url of input.urls) {
    const host = URL.parse(url)?.host
    if (host) hosts.add(host)
  }
  return hosts
}

export const hostGuard =
  (allowed: () => Iterable<string>) =>
  <E, R>(app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      if (hostAllowed(request.headers.host, allowed)) return yield* app
      return HttpServerResponse.text(
        `Host not allowed. To reach this server by another name, start it with ${ALLOWED_HOSTS_ENV}.`,
        { status: 403 },
      )
    })

export * as HostGuard from "./host-guard"
