// Serve a production build same-origin with the engine, the way the desktop app does:
// files from the build, page routes to index.html, everything else proxied to the engine.
import http from "node:http"
import fs from "node:fs"
import path from "node:path"
// node serve.mjs <dist-dir> <port> [engine-url] [host]
const [DIR, PORT, ENGINE = "http://127.0.0.1:4096", HOST = "127.0.0.1"] = process.argv.slice(2)
const types = {
  ".js": "text/javascript",
  ".css": "text/css",
  ".html": "text/html",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
  ".webmanifest": "application/manifest+json",
}
const engine = new URL(ENGINE)
http
  .createServer((req, res) => {
    try {
      const url = new URL(req.url, "http://x")
      const file = path.join(DIR, decodeURIComponent(url.pathname))
      if (file.startsWith(DIR) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        res.writeHead(200, {
          "content-type": types[path.extname(file)] ?? "application/octet-stream",
          "cache-control": url.pathname.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
        })
        return fs
          .createReadStream(file)
          .on("error", () => res.end())
          .pipe(res)
      }
      if (req.method === "GET" && (req.headers.accept ?? "").includes("text/html")) {
        res.writeHead(200, { "content-type": "text/html", "cache-control": "no-cache" })
        return fs
          .createReadStream(path.join(DIR, "index.html"))
          .on("error", () => res.end())
          .pipe(res)
      }
      const up = http.request(
        {
          hostname: engine.hostname,
          port: engine.port,
          path: req.url,
          method: req.method,
          headers: { ...req.headers, host: engine.host },
        },
        (r) => {
          res.writeHead(r.statusCode ?? 502, r.headers)
          r.pipe(res)
        },
      )
      up.on("error", () => {
        res.writeHead(502)
        res.end()
      })
      req.pipe(up)
    } catch {
      res.writeHead(500)
      res.end()
    } // a build being replaced must not take the server down
  })
  .listen(Number(PORT), HOST, () => console.log(`serving ${DIR} on http://${HOST}:${PORT}`))
