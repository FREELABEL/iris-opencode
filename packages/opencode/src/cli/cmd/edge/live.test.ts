import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "fs"
import http from "http"
import os from "os"
import path from "path"
import { fromThePage, injectBindings, isLocalHost, LivePage, liveHooks, scriptJson } from "./live"
import { startStaticServer, type StaticServer } from "./serve"
import { serveArgv } from "./served"

/**
 * #194353 — a page served on this computer with live data. The owner's session lives in this
 * process; these pin that it reaches IRIS for the page and for nobody else.
 */

describe("who may use the live copy", () => {
  test("only this computer, on our port — not a relay host or a rebinding name", () => {
    expect(isLocalHost("localhost:7401", 7401)).toBe(true)
    expect(isLocalHost("127.0.0.1:7401", 7401)).toBe(true)
    expect(isLocalHost("my-page.t.heyiris.io", 7401)).toBe(false)
    expect(isLocalHost("evil.example:7401", 7401)).toBe(false)
    expect(isLocalHost("localhost:7402", 7401)).toBe(false)
    expect(isLocalHost(undefined, 7401)).toBe(false)
  })

  test("only the page itself — another site in the same browser cannot drive it", () => {
    expect(fromThePage({ "sec-fetch-site": "same-origin" }, 7401)).toBe(true)
    expect(fromThePage({ "sec-fetch-site": "cross-site" }, 7401)).toBe(false)
    expect(fromThePage({ "sec-fetch-site": "same-site" }, 7401)).toBe(false)
    expect(fromThePage({ origin: "http://localhost:7401" }, 7401)).toBe(true)
    expect(fromThePage({ origin: "https://evil.example" }, 7401)).toBe(false)
    expect(fromThePage({ origin: "null" }, 7401)).toBe(false)
    expect(fromThePage({}, 7401)).toBe(false)
  })

  test("a public copy is never live", () => {
    const argv = serveArgv(["iris"], "/s", 7401, "my-page", "my-page")
    expect(argv).toContain("--public-name")
    expect(argv).not.toContain("--live")
    expect(serveArgv(["iris"], "/s", 7401, undefined, "my-page")).toContain("--live")
  })
})

describe("putting the data into the page", () => {
  test("replaces the anonymous block, or adds one at the top of body", () => {
    const a = injectBindings('<html><body><script type="application/json" id="iris-bindings">{}</script><p>x</p></body></html>', { agents: { data: [1] } })
    expect(a).toContain('{"agents":{"data":[1]}}')
    expect(a.match(/iris-bindings/g)!.length).toBe(1)
    const b = injectBindings('<html><body class="x"><p>x</p></body></html>', { a: { data: [] } })
    expect(b).toContain('<body class="x"><script type="application/json" id="iris-bindings">')
  })

  test("a row that contains </script> cannot break out of the block", () => {
    const out = scriptJson({ name: "</script><script>alert(1)</script>" })
    expect(out).not.toContain("</script>")
    expect(JSON.parse(out).name).toBe("</script><script>alert(1)</script>")
  })
})

// ── end to end: a fake IRIS, the real server, real requests ─────────────────────────────────────

let iris: http.Server, base: string, srv: StaticServer, dir: string
const seen: { method: string; url: string; session: string; auth: string; cookie: string }[] = []
let online = true
let docVersion = "v1"

beforeAll(async () => {
  iris = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on("data", (c) => chunks.push(c))
    req.on("end", () => {
      seen.push({ method: req.method!, url: req.url!, session: String(req.headers["x-atlas-session"] ?? ""), auth: String(req.headers.authorization ?? ""), cookie: String(req.headers.cookie ?? "") })
      if (!online) {
        req.socket.destroy()
        return
      }
      const j = (code: number, body: unknown) => {
        res.writeHead(code, { "Content-Type": "application/json", "Set-Cookie": "iris=secret" })
        res.end(JSON.stringify(body))
      }
      if (req.url === "/api/v1/atlas/page-codes") return j(200, { code: "c".repeat(43) })
      if (req.url === "/api/v1/atlas/customer-auth/exchange-code") return j(200, { token: "SESSION-1" })
      if (req.url!.startsWith("/api/v1/public/pages/my-app/data/agents"))
        return req.headers["x-atlas-session"] === "SESSION-1" ? j(200, { data: [{ id: 7, name: "Scout" }], meta: { total: 1 } }) : j(401, {})
      if (req.url!.startsWith("/api/v1/public/pages/my-app/actions/page/status")) return j(200, { ok: true, got: JSON.parse(Buffer.concat(chunks).toString() || "{}") })
      if (req.url === "/p/my-app") {
        res.writeHead(200, { "Content-Type": "text/html" })
        return res.end(`<!doctype html><html><body><h1>${docVersion}</h1><script src="/js/new.js"></script></body></html>`)
      }
      if (req.url === "/js/new.js") {
        res.writeHead(200, { "Content-Type": "text/javascript" })
        return res.end("window.x=1")
      }
      j(404, {})
    })
  })
  await new Promise<void>((r) => iris.listen(0, "127.0.0.1", r))
  base = `http://127.0.0.1:${(iris.address() as any).port}`

  dir = fs.mkdtempSync(path.join(os.tmpdir(), "live-"))
  fs.mkdirSync(path.join(dir, "site"))
  fs.writeFileSync(path.join(dir, "site", "index.html"), "<!doctype html><html><body><h1>snapshot</h1></body></html>")
  const live = new LivePage({ slug: "my-app", origin: base, bindings: ["agents"], token: async () => "CLI-TOKEN", cacheDir: path.join(dir, "live") })
  let port = 0
  srv = await startStaticServer(path.join(dir, "site"), 0, liveHooks(live, "my-app", () => port))
  port = srv.port
})

afterAll(async () => {
  await srv?.stop()
  iris?.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

const local = (p: string, init: RequestInit & { headers?: Record<string, string> } = {}) =>
  fetch(`http://localhost:${srv.port}${p}`, init)

describe("a live page on this computer", () => {
  test("opens the published page with the owner's rows in it, fetched with a page session", async () => {
    const html = await (await local("/p/my-app")).text()
    expect(html).toContain("<h1>v1</h1>")
    expect(html).toContain('"agents":{"data":[{"id":7,"name":"Scout"}]')
    // The CLI token went to the code endpoint only; data went with the page session.
    expect(seen.find((s) => s.url === "/api/v1/atlas/page-codes")!.auth).toBe("Bearer CLI-TOKEN")
    expect(seen.filter((s) => s.url.includes("/data/agents")).every((s) => s.session === "SESSION-1" && s.auth === "")).toBe(true)
    expect(html).not.toContain("SESSION-1")
    expect(html).not.toContain("CLI-TOKEN")
  })

  test("a publish shows on the next load, and a new asset is fetched instead of 404ing", async () => {
    docVersion = "v2"
    expect(await (await local("/p/my-app")).text()).toContain("<h1>v2</h1>")
    expect(await (await local("/js/new.js")).text()).toBe("window.x=1")
  })

  test("the page's own actions are forwarded with the session, and IRIS's cookies are not passed back", async () => {
    const r = await local("/api/v1/public/pages/my-app/actions/page/status", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin", Cookie: "browser=1" },
      body: JSON.stringify({ payload: { agentId: 7, values: { status: "paused" } } }),
    })
    expect(r.status).toBe(200)
    expect((await r.json()).got.payload.values.status).toBe("paused")
    expect(r.headers.get("set-cookie")).toBeNull()
    const sent = seen.filter((s) => s.url.includes("/actions/page/status")).at(-1)!
    expect(sent.session).toBe("SESSION-1")
    expect(sent.cookie).toBe("")
  })

  test("another website cannot use it", async () => {
    const r = await local("/api/v1/public/pages/my-app/actions/page/status", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "cross-site" },
      body: "{}",
    })
    expect(r.status).toBe(403)
  })

  test("a request arriving under another host name gets the snapshot and no forwarding", async () => {
    const res = await new Promise<{ status: number; body: string }>((resolve) => {
      const req = http.request({ host: "127.0.0.1", port: srv.port, path: "/p/my-app", headers: { Host: "my-app.t.heyiris.io" } }, (r) => {
        let b = ""
        r.on("data", (c) => (b += c))
        r.on("end", () => resolve({ status: r.statusCode!, body: b }))
      })
      req.end()
    })
    expect(res.body).toContain("snapshot")
    expect(res.body).not.toContain("Scout")
  })

  test("with no network it opens with the last data it had", async () => {
    online = false
    try {
      const html = await (await local("/p/my-app")).text()
      expect(html).toContain("<h1>v2</h1>")
      expect(html).toContain("Scout")
    } finally {
      online = true
    }
  })
})
