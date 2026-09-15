import { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect, Stream } from "effect"
import { HttpBody, HttpClient, HttpClientRequest, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { createHash } from "node:crypto"
import { ProxyUtil } from "../proxy-util"

let embeddedUIPromise: Promise<Record<string, string> | null> | undefined

export const UI_UPSTREAM = new URL("https://app.opencode.ai")

export const csp = (hash = "") =>
  `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'${hash ? ` 'sha256-${hash}'` : ""}; style-src 'self' 'unsafe-inline'; img-src 'self' data: https: blob:; font-src 'self' data:; media-src 'self' data:; connect-src * data: blob:`
export const DEFAULT_CSP = csp()

export function themePreloadHash(body: string) {
  return body.match(/<script\b(?![^>]*\bsrc\s*=)[^>]*\bid=(['"])oc-theme-preload-script\1[^>]*>([\s\S]*?)<\/script>/i)
}

export function cspForHtml(body: string) {
  const match = themePreloadHash(body)
  return csp(match ? createHash("sha256").update(match[2]).digest("base64") : "")
}

function requestBody(request: HttpServerRequest.HttpServerRequest) {
  if (request.method === "GET" || request.method === "HEAD") return HttpBody.empty
  const len = request.headers["content-length"]
  return HttpBody.stream(request.stream, request.headers["content-type"], len === undefined ? undefined : Number(len))
}

function proxyResponseHeaders(headers: Record<string, string>) {
  const result = new Headers(headers)
  // FetchHttpClient exposes decoded response bodies, so forwarding upstream
  // transfer metadata makes browsers decode already-decoded assets again.
  result.delete("content-encoding")
  result.delete("content-length")
  result.delete("transfer-encoding")
  return result
}

export function upstreamURL(path: string) {
  return new URL(path, UI_UPSTREAM).toString()
}

export function embeddedUI(disableEmbeddedWebUi: boolean) {
  if (disableEmbeddedWebUi) return Promise.resolve(null)
  return (embeddedUIPromise ??=
    // @ts-expect-error - generated file at build time
    import("opencode-web-ui.gen.ts").then((module) => module.default as Record<string, string>).catch(() => null))
}

function notFound() {
  return HttpServerResponse.jsonUnsafe({ error: "Not Found" }, { status: 404 })
}

/**
 * Path prefixes that are API surface and never documents.
 *
 * Anything under one of these that reaches the UI catch-all matched no route, and the only
 * honest answer is 404. Add a prefix here when you add an API root; a missing entry does not
 * break a working route, it only lets a MISSING one keep pretending to exist.
 */
const API_ROOTS = ["/iris/"] as const

export function isApiPath(path: string) {
  return API_ROOTS.some((root) => path.startsWith(root))
}

/** Did the caller ask for JSON? Then index.html is never a valid answer to give it. */
function acceptsJson(request: HttpServerRequest.HttpServerRequest) {
  return (request.headers["accept"] ?? "").includes("application/json")
}

function embeddedUIResponse(file: string, body: Uint8Array) {
  const mime = FSUtil.mimeType(file)
  const headers = new Headers({ "content-type": mime })
  if (mime.startsWith("text/html")) {
    headers.set("content-security-policy", cspForHtml(new TextDecoder().decode(body)))
  }
  return HttpServerResponse.raw(body, { headers })
}

export function serveEmbeddedUIEffect(
  requestPath: string,
  fs: FSUtil.Interface,
  embeddedWebUI: Record<string, string>,
  wantsJson = false,
) {
  // An EXACT file is served whatever the caller's Accept header says — a real asset is a real
  // asset. Only the index.html FALLBACK is refused for a JSON caller, because that fallback is
  // the step that turns "no such path" into "here is a web page, status 200".
  const exact = embeddedWebUI[requestPath.replace(/^\//, "")]
  if (!exact && wantsJson) return Effect.succeed(notFound())

  const file = exact ?? embeddedWebUI["index.html"] ?? null
  if (!file) return Effect.succeed(notFound())

  return fs.readFile(file).pipe(
    Effect.map((body) => embeddedUIResponse(file, body)),
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(notFound())),
  )
}

export function serveUIEffect(
  request: HttpServerRequest.HttpServerRequest,
  services: { fs: FSUtil.Interface; client: HttpClient.HttpClient; disableEmbeddedWebUi: boolean },
) {
  return Effect.gen(function* () {
    const embeddedWebUI = yield* Effect.promise(() => embeddedUI(services.disableEmbeddedWebUi))
    const path = new URL(request.url, "http://localhost").pathname

    /*
     * AN UNIMPLEMENTED API ROUTE MUST 404, NOT RETURN A WEB PAGE.
     *
     * This handler is mounted as router.add("*", "/*"), so every request no API router claimed
     * lands here and is answered with index.html. For a browser NAVIGATION that is exactly
     * right — the SPA owns its own paths and index.html boots it. For an API call it is a lie
     * with real cost: the caller asked for JSON and got 200 plus a web page, so a route that
     * does not exist is indistinguishable from one that does.
     *
     * Measured 2026-09-15 on the card editor (#185485/#185506): GET /iris/item/185442/share is
     * not implemented, returned 200 and `<!doctype html>`, the client ran JSON.parse on it and
     * threw `SyntaxError: Unexpected token '<'`, and the error boundary took down the ENTIRE
     * session view. Not the one section — the app. The ticket expected unwired sections to read
     * "Not connected"; nothing got far enough to render that.
     *
     * Both halves of the condition matter. The prefix catches our own API whatever the caller
     * sends, and the Accept header catches every other fetch that wanted JSON, including ones
     * under roots nobody has listed yet.
     */
    if (isApiPath(path)) return notFound()

    if (embeddedWebUI) return yield* serveEmbeddedUIEffect(path, services.fs, embeddedWebUI, acceptsJson(request))

    const response = yield* services.client.execute(
      HttpClientRequest.make(request.method)(upstreamURL(path), {
        headers: ProxyUtil.headers(request.headers, { host: UI_UPSTREAM.host }),
        body: requestBody(request),
      }),
    )
    const headers = proxyResponseHeaders(response.headers)

    // Same hole on the dev path: vite also answers an unknown path with index.html, so a JSON
    // caller proxied upstream gets the same 200-and-a-web-page. Judged on the way back because
    // upstream is the only thing that knows whether the path was real.
    if (acceptsJson(request) && response.headers["content-type"]?.includes("text/html")) {
      return notFound()
    }

    if (response.headers["content-type"]?.includes("text/html")) {
      const body = yield* response.text
      headers.set("Content-Security-Policy", cspForHtml(body))
      return HttpServerResponse.text(body, { status: response.status, headers })
    }

    headers.set("Content-Security-Policy", csp())
    return HttpServerResponse.stream(response.stream.pipe(Stream.catchCause(() => Stream.empty)), {
      status: response.status,
      headers,
    })
  })
}
