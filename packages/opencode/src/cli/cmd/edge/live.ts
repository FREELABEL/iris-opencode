/**
 * A page served on this computer with LIVE data (#194353, epic #194350).
 *
 * Before this, `iris pages serve` was a frozen snapshot: the page's data was whatever an
 * anonymous export saw (nothing, for a private app), writes went nowhere, and a publish appeared
 * only when someone ran the command again. Live mode keeps the UI local and the data real:
 *
 *   the page document   fetched from IRIS on every load (so a publish shows on the next load),
 *                       with the owner's bound data put into it — and the last good copy kept on
 *                       disk, so with no network the page still opens with the last data it had
 *   /api/*              forwarded to IRIS with a PAGE SESSION, so saves, actions and connectors work
 *   anything missing    fetched from IRIS (a new asset after a publish)
 *
 * THE CREDENTIAL never enters the page. This process holds the CLI's own sign-in, trades it for a
 * one-time page code and the code for a page session (the same mechanism the Desktop app uses to
 * open a page signed in — PageSignInCodeController), and adds that session to requests it
 * forwards. The page only ever talks to localhost.
 *
 * WHO MAY USE IT: only the person at this computer, through the page itself.
 *   - Host must be localhost / 127.0.0.1 on our port. A public relay address (`--public`) or a
 *     DNS-rebinding hostname gets the frozen snapshot and no forwarding — anything else would put
 *     the owner's session on the internet.
 *   - A forwarded request must come from the page (Sec-Fetch-Site same-origin, or an Origin naming
 *     this server). Otherwise any website open in the same browser could drive localhost.
 */
import fs from "fs"
import http from "http"
import path from "path"
import type { LocalActions } from "./local-actions"

export interface LiveConfig {
  slug: string
  /** where the page is published, e.g. https://heyiris.io */
  origin: string
  /** binding names the page declares (json_content.bindings) */
  bindings: string[]
  /** the CLI's sign-in, read at run time — never stored by this module */
  token: () => Promise<string | null | undefined>
  /** folder for the last good document and data (offline) */
  cacheDir: string
  fetchImpl?: typeof fetch
}

// ── pure helpers (tested directly) ──────────────────────────────────────────────────────────────

/** Is this request for us, from this computer — not via a relay or a rebinding hostname? */
export function isLocalHost(hostHeader: string | undefined, port: number): boolean {
  const h = String(hostHeader ?? "").toLowerCase()
  return h === `localhost:${port}` || h === `127.0.0.1:${port}` || h === `[::1]:${port}`
}

/** Did the page itself make this request? */
export function fromThePage(headers: http.IncomingHttpHeaders, port: number): boolean {
  const site = String(headers["sec-fetch-site"] ?? "").toLowerCase()
  if (site) return site === "same-origin"
  const origin = String(headers.origin ?? "")
  if (!origin || origin === "null") return false
  try {
    const u = new URL(origin)
    return isLocalHost(u.host, port) && u.protocol === "http:"
  } catch {
    return false
  }
}

/** JSON that is safe inside a <script> element: no `</script>`, no `<!--`. */
export function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029")
}

/**
 * Put the owner's data into the page where the SDK reads it (`#iris-bindings`). Replaces the
 * block the anonymous render produced, or adds one at the top of <body>; the SDK reads it lazily,
 * at call time, so it only has to be in the document before the page's own script runs.
 */
export function injectBindings(html: string, data: Record<string, unknown>): string {
  const block = `<script type="application/json" id="iris-bindings">${scriptJson(data)}</script>`
  const existing = /<script[^>]*\bid=["']iris-bindings["'][^>]*>[\s\S]*?<\/script>/i
  if (existing.test(html)) return html.replace(existing, () => block)
  const body = /<body[^>]*>/i.exec(html)
  if (body) return html.slice(0, body.index + body[0].length) + block + html.slice(body.index + body[0].length)
  return block + html
}

/** Headers we never pass on, either way: hop-by-hop, the browser's cookies, IRIS's cookies. */
const DROP_REQ = new Set(["host", "cookie", "connection", "content-length", "origin", "referer", "authorization", "x-atlas-session", "accept-encoding"])
const DROP_RES = new Set(["set-cookie", "connection", "transfer-encoding", "content-encoding", "content-length", "strict-transport-security"])

export function forwardHeaders(h: http.IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(h)) {
    if (v === undefined || DROP_REQ.has(k.toLowerCase()) || k.toLowerCase().startsWith("sec-")) continue
    out[k] = Array.isArray(v) ? v.join(", ") : String(v)
  }
  return out
}

// ── the live session ────────────────────────────────────────────────────────────────────────────

export class LivePage {
  private session: string | null = null
  private fetch: typeof fetch
  constructor(private cfg: LiveConfig) {
    this.fetch = cfg.fetchImpl ?? fetch
    fs.mkdirSync(cfg.cacheDir, { recursive: true })
  }

  get base() {
    return this.cfg.origin.replace(/\/$/, "")
  }

  /** A page session for this page, minted with the CLI's sign-in. Null when not signed in or not allowed. */
  async ensureSession(force = false): Promise<string | null> {
    if (this.session && !force) return this.session
    this.session = null
    const token = await this.cfg.token()
    if (!token) return null
    const j = { "Content-Type": "application/json", Accept: "application/json" }
    const mint = await this.fetch(`${this.base}/api/v1/atlas/page-codes`, {
      method: "POST",
      headers: { ...j, Authorization: `Bearer ${token}` },
      body: JSON.stringify({ page_slug: this.cfg.slug }),
      signal: AbortSignal.timeout(8000),
    }).catch(() => null)
    const code = mint?.ok ? ((await mint.json().catch(() => null)) as any)?.code : null
    if (!code) return null
    const ex = await this.fetch(`${this.base}/api/v1/atlas/customer-auth/exchange-code`, {
      method: "POST",
      headers: j,
      body: JSON.stringify({ code, page_slug: this.cfg.slug }),
      signal: AbortSignal.timeout(8000),
    }).catch(() => null)
    const tok = ex?.ok ? ((await ex.json().catch(() => null)) as any)?.token : null
    this.session = typeof tok === "string" && tok ? tok : null
    return this.session
  }

  /** Forward one request to IRIS with the page session; one re-mint on a 401. */
  async forward(method: string, url: string, headers: Record<string, string>, body?: Buffer): Promise<Response | null> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const s = await this.ensureSession(attempt > 0)
      const res = await this.fetch(this.base + url, {
        method,
        headers: { ...headers, ...(s ? { "X-Atlas-Session": s } : {}) },
        body: body && body.length && method !== "GET" && method !== "HEAD" ? new Uint8Array(body) : undefined,
        redirect: "manual",
        signal: AbortSignal.timeout(30000),
      }).catch(() => null)
      if (!res) return null
      if (res.status !== 401 || attempt > 0) return res
    }
    return null
  }

  private cacheFile(name: string) {
    return path.join(this.cfg.cacheDir, name)
  }

  /** The owner's rows for every binding, fresh; the last good copy of any that cannot be fetched. */
  async bindings(): Promise<Record<string, unknown>> {
    let cached: Record<string, unknown> = {}
    try {
      cached = JSON.parse(fs.readFileSync(this.cacheFile("bindings.json"), "utf8"))
    } catch {}
    const out: Record<string, unknown> = {}
    await Promise.all(
      this.cfg.bindings.map(async (name) => {
        const res = await this.forward("GET", `/api/v1/public/pages/${encodeURIComponent(this.cfg.slug)}/data/${encodeURIComponent(name)}`, {
          Accept: "application/json",
        })
        const j = res?.ok ? ((await res.json().catch(() => null)) as any) : null
        if (j && Array.isArray(j.data)) out[name] = { data: j.data, meta: j.meta ?? null }
        else if (cached[name]) out[name] = cached[name]
      }),
    )
    if (Object.keys(out).length) fs.writeFileSync(this.cacheFile("bindings.json"), JSON.stringify(out))
    return out
  }

  /** The published document, fresh; else the last good copy; else null (the caller has the snapshot). */
  async document(): Promise<string | null> {
    const res = await this.fetch(`${this.base}/p/${encodeURIComponent(this.cfg.slug)}`, {
      headers: { Accept: "text/html" },
      signal: AbortSignal.timeout(6000),
    }).catch(() => null)
    if (res?.ok) {
      const html = await res.text()
      if (/<html|<body|<!doctype/i.test(html)) {
        fs.writeFileSync(this.cacheFile("document.html"), html)
        return html
      }
    }
    try {
      return fs.readFileSync(this.cacheFile("document.html"), "utf8")
    } catch {
      return null
    }
  }
}

/**
 * Hooks for startStaticServer. `intercept` answers /api/* (and assets the snapshot lacks); `html`
 * turns the page's document into the live one. Both refuse to do anything live for a request that
 * is not from this computer and this page.
 */
export function liveHooks(live: LivePage, slug: string, portOf: () => number, local?: LocalActions) {
  const readBody = (req: http.IncomingMessage) =>
    new Promise<Buffer>((resolve) => {
      const chunks: Buffer[] = []
      req.on("data", (c) => chunks.push(Buffer.from(c)))
      req.on("end", () => resolve(Buffer.concat(chunks)))
      req.on("error", () => resolve(Buffer.alloc(0)))
    })

  const relay = async (res: http.ServerResponse, up: Response) => {
    const headers: Record<string, string> = {}
    up.headers.forEach((v, k) => {
      if (!DROP_RES.has(k.toLowerCase())) headers[k] = v
    })
    const buf = Buffer.from(await up.arrayBuffer())
    res.writeHead(up.status, { ...headers, "Content-Length": String(buf.length) })
    res.end(buf)
  }

  return {
    async intercept(req: http.IncomingMessage, res: http.ServerResponse, urlPath: string): Promise<boolean> {
      // Local actions (#194354): the same two checks as /api/*, then the bridge's own rules.
      if (urlPath === "/__iris/local/status" || urlPath === "/__iris/local/run") {
        const port = portOf()
        const json = (code: number, body: unknown) => {
          res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" })
          res.end(JSON.stringify(body))
        }
        if (!local) return json(404, { ok: false, reason: "no_local_actions" }), true
        if (!isLocalHost(req.headers.host, port) || !fromThePage(req.headers, port))
          return json(403, { ok: false, reason: "not_local", error: "Only the app itself, on this computer." }), true
        if (urlPath === "/__iris/local/status") return json(200, await local.status()), true
        if (req.method !== "POST") return json(405, { ok: false, reason: "method" }), true
        let body: any = {}
        try {
          body = JSON.parse((await readBody(req)).toString("utf8") || "{}")
        } catch {}
        const r = await local.call(String(body.action ?? ""), body.args && typeof body.args === "object" ? body.args : {})
        return json(r.status, r.body), true
      }
      if (!urlPath.startsWith("/api/")) return false
      const port = portOf()
      if (!isLocalHost(req.headers.host, port) || !fromThePage(req.headers, port)) {
        res.writeHead(403, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: "This copy only answers the page it serves, on this computer.", reason: "not_local" }))
        return true
      }
      const up = await live.forward(req.method ?? "GET", req.url ?? urlPath, forwardHeaders(req.headers), await readBody(req))
      if (!up) {
        res.writeHead(503, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: "IRIS can't be reached right now — showing the last data this computer had.", reason: "offline" }))
        return true
      }
      await relay(res, up)
      return true
    },

    /** A missing asset after a publish: fetch it from IRIS rather than 404. GET only, no credential. */
    async missing(req: http.IncomingMessage, res: http.ServerResponse, urlPath: string): Promise<boolean> {
      if ((req.method ?? "GET") !== "GET" || !isLocalHost(req.headers.host, portOf())) return false
      const up = await fetch(live.base + (req.url ?? urlPath), { signal: AbortSignal.timeout(10000) }).catch(() => null)
      if (!up || !up.ok) return false
      await relay(res, up)
      return true
    },

    /** The page document: live when the request is local, the snapshot otherwise. */
    async html(req: http.IncomingMessage, urlPath: string, snapshot: string): Promise<string> {
      if (urlPath.replace(/\/$/, "") !== `/p/${slug}` && urlPath !== "/" && urlPath !== "/index.html") return snapshot
      if (!isLocalHost(req.headers.host, portOf())) return snapshot
      const [doc, data] = await Promise.all([live.document(), live.bindings()])
      return injectBindings(doc ?? snapshot, data)
    },
  }
}
