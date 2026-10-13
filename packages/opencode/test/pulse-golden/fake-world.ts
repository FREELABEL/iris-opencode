/**
 * Preload for the Pulse golden test (#189244). Loaded with `bun --preload` into a CLI
 * subprocess, BEFORE the CLI imports anything, so the run sees a world that cannot vary:
 *
 *  - the clock is pinned to GOLDEN_NOW, so "3d ago", window cutoffs and observed_at are fixed;
 *  - every network call (IRIS API, the local bridge, anything else) is answered from the route
 *    table in GOLDEN_ROUTES — no request leaves the process. An unmatched request gets a 404 and
 *    is appended to GOLDEN_LOG, which is how a fixture is grown.
 *
 * Routes may carry a `delay` (ms). The lead route reads its channels concurrently and lists them
 * in COMPLETION order, so distinct delays are what make that order deterministic.
 */
import { appendFileSync, readFileSync } from "fs"

const now = Date.parse(process.env.GOLDEN_NOW ?? "")
if (!Number.isFinite(now)) throw new Error("fake-world: GOLDEN_NOW is required")

const RealDate = Date
class PinnedDate extends RealDate {
  constructor(...args: any[]) {
    if (args.length === 0) super(now)
    else super(...(args as [any]))
  }
  static now() {
    return now
  }
}
;(globalThis as any).Date = PinnedDate

interface Route {
  method?: string
  /** Substring of `pathname + search`; or, with `regex: true`, a pattern tested against it. */
  match: string
  regex?: boolean
  /** Substring the request BODY must contain — execute-direct carries its action in the body. */
  bodyMatch?: string
  status?: number
  body?: unknown
  delay?: number
}

const routes: Route[] = JSON.parse(readFileSync(process.env.GOLDEN_ROUTES ?? "", "utf8"))
const log = process.env.GOLDEN_LOG

const realFetch = globalThis.fetch
globalThis.fetch = (async (input: any, init?: any) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
  // data: and file: URLs (wasm modules, bundled assets) are not the network.
  if (url.protocol !== "http:" && url.protocol !== "https:") return realFetch(input, init)
  const method = String(init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET")).toUpperCase()
  const target = url.pathname + url.search
  const sent = typeof init?.body === "string" ? init.body : ""
  const route = routes.find(
    (r) =>
      (!r.method || r.method === method) &&
      (r.regex ? new RegExp(r.match).test(target) : target.includes(r.match)) &&
      (!r.bodyMatch || sent.includes(r.bodyMatch)),
  )
  if (!route) {
    if (log) appendFileSync(log, `${method} ${url.host}${target}${sent ? ` ${sent.slice(0, 160)}` : ""}\n`)
    return new Response(JSON.stringify({ message: "golden: no route" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    })
  }
  if (route.delay) await new Promise((r) => setTimeout(r, route.delay))
  const body = typeof route.body === "string" ? route.body : JSON.stringify(route.body ?? {})
  return new Response(body, { status: route.status ?? 200, headers: { "Content-Type": "application/json" } })
}) as typeof fetch
