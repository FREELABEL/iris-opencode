/**
 * Serve an exported Genesis page. Static files, with one rule that is not optional:
 *
 *   SPA FALLBACK — the app rewrites the URL to /p/<slug> after it boots. A host that 404s unknown
 *   paths serves the page fine on first load and breaks on refresh, which is the kind of bug a
 *   client finds and you don't.
 *
 * This is the reference host, used by verify/harvest/discover and by `iris genesis serve-edge`.
 * Any static host works (nginx, Caddy, S3+CloudFront, Netlify) as long as it does the same
 * fallback — `iris genesis export --host-config` prints those.
 */
import http from "http"
import fs from "fs"
import path from "path"

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8",
}

export interface StaticServer {
  port: number
  /**
   * `localhost`, not `127.0.0.1`, and it is load-bearing: harvest recognises a runtime 404 by
   * matching `http://localhost:<port>`. Change this and harvest silently stops chasing them.
   */
  url: string
  stop(): Promise<void>
}

/**
 * Start the reference host on `port` (0 picks a free one). In-process: the shell version spawned
 * this as a child, which meant every caller paid a process launch and a fixed sleep waiting for it
 * to be ready. Here `listen` tells us exactly when it is up.
 */
/**
 * Optional hooks (live mode, #194353). Without them this is exactly the static reference host.
 *   intercept  answer a request before the file lookup (live: /api/*)
 *   missing    answer a request the snapshot has no file for, before the 404 / SPA fallback
 *   html       transform a document before it is sent (live: the fresh page with the owner's data)
 */
export interface ServerHooks {
  intercept?(req: http.IncomingMessage, res: http.ServerResponse, urlPath: string): Promise<boolean>
  missing?(req: http.IncomingMessage, res: http.ServerResponse, urlPath: string): Promise<boolean>
  html?(req: http.IncomingMessage, urlPath: string, snapshot: string): Promise<string>
}

export function startStaticServer(dir: string, port = 0, hooks: ServerHooks = {}): Promise<StaticServer> {
  const root = path.resolve(dir)

  const send = (res: http.ServerResponse, code: number, body: Buffer, type: string) => {
    res.writeHead(code, { "Content-Type": type, "Content-Length": body.length })
    res.end(body)
  }

  const sendHtml = async (req: http.IncomingMessage, res: http.ServerResponse, urlPath: string, html: Buffer) => {
    if (!hooks.html) return send(res, 200, html, TYPES[".html"]!)
    const out = await hooks.html(req, urlPath, html.toString("utf8")).catch(() => html.toString("utf8"))
    // A live document is never cached by the browser: the next load must ask again.
    res.setHeader("Cache-Control", "no-store")
    send(res, 200, Buffer.from(out), TYPES[".html"]!)
  }

  const server = http.createServer(async (req, res) => {
    let urlPath: string
    try {
      urlPath = decodeURIComponent((req.url ?? "/").split("?")[0]!)
    } catch {
      return send(res, 400, Buffer.from("bad request"), "text/plain")
    }
    try {
      if (hooks.intercept && (await hooks.intercept(req, res, urlPath))) return
    } catch {
      if (!res.headersSent) return send(res, 502, Buffer.from("upstream error"), "text/plain")
      return
    }
    // Keep the response inside the served directory: a request for ../../etc/passwd resolves out.
    // This must handle a path written by hand on the wire — a URL parser normalises `..` (and
    // `%2e%2e`) away before it ever reaches here, so testing this with fetch() proves nothing.
    const target = path.resolve(root, "." + urlPath)
    if (target !== root && !target.startsWith(root + path.sep)) {
      return send(res, 403, Buffer.from("forbidden"), "text/plain")
    }

    const isFile = (() => {
      try {
        return fs.statSync(target).isFile()
      } catch {
        return false
      }
    })()
    if (isFile) {
      const data = fs.readFileSync(target)
      if (path.extname(target) === ".html") return sendHtml(req, res, urlPath, data)
      return send(res, 200, data, TYPES[path.extname(target)] ?? "application/octet-stream")
    }
    // SPA fallback, but NOT for asset-shaped requests. Falling back on those returns index.html
    // for a missing .js, and the parser reports "Unexpected token '<'" — which reads like a
    // corrupt bundle and is actually a 404 wearing a disguise. Assets must 404 honestly.
    const looksLikeAsset = path.extname(urlPath) !== "" || urlPath.startsWith("/build/")
    if (looksLikeAsset) {
      try {
        if (hooks.missing && (await hooks.missing(req, res, urlPath))) return
      } catch {}
      return send(res, 404, Buffer.from("not found"), "text/plain")
    }
    let index: Buffer
    try {
      index = fs.readFileSync(path.join(root, "index.html"))
    } catch {
      return send(res, 404, Buffer.from("not found"), "text/plain")
    }
    return sendHtml(req, res, urlPath, index)
  })

  return new Promise((resolve, reject) => {
    server.on("error", reject)
    server.listen(port, "127.0.0.1", () => {
      const actual = (server.address() as { port: number }).port
      resolve({
        port: actual,
        url: `http://localhost:${actual}`,
        stop: () =>
          new Promise<void>((r) => {
            server.closeAllConnections?.()
            server.close(() => r())
          }),
      })
    })
  })
}

/** What to tell whoever runs the client's web server. One rule, three shapes. */
export const HOST_CONFIG = `
The one rule: unknown paths fall back to index.html — EXCEPT asset paths, which must 404.

nginx
  location /        { try_files $uri $uri/ /index.html; }
  location /build/  { try_files $uri =404; }          # assets must 404, never fall back

Caddy
  handle /build/* { file_server }                     # 404s naturally
  handle          { try_files {path} /index.html
                    file_server }

S3 + CloudFront
  Error document: index.html  (403 and 404 -> /index.html, 200)
  BUT add a behaviour for /build/* with NO custom error response.

Point the web root at <deploy path>/current, never at a release directory.
`.trim()
