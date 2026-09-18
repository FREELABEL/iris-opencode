/**
 * IRIS Edge — the rules that must hold in the CLI itself, not only in the reference scripts.
 *
 * Every test here is a failure that shipped once. They assert on STATE — what is on disk, what a
 * symlink points at — never on what a function said about itself, because the recurring failure in
 * this feature is a step that reports success while doing nothing.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test"
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, readlinkSync, existsSync, readdirSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { isOurs } from "./hosts"
import { assetGraph, buildEntryOf } from "./export"
import { exportCollections, isGatedPage } from "./export-data"
import { Remote, assertSafe } from "./deploy"
import { startStaticServer } from "./serve"

describe("hosts — one predicate for harvest AND verify", () => {
  test("apiv2 counts as ours over https — harvest used to miss it while verify flagged it", () => {
    expect(isOurs("https://apiv2.heyiris.io/api/v1/x")).toBe(true)
  })
  test("http counts too — harvest's copy required https", () => {
    expect(isOurs("http://freelabel.net/img/logo.png")).toBe(true)
  })
  test("a harvested copy under /_ext/<ourhost>/ is NOT a call home — host match, not substring", () => {
    expect(isOurs("http://localhost:8080/_ext/freelabel.net/img/logo.png")).toBe(false)
  })
  test("look-alike hosts and junk are not ours", () => {
    expect(isOurs("https://freelabel.net.evil.com/x")).toBe(false)
    expect(isOurs("https://notheyiris.io/x")).toBe(false)
    expect(isOurs("data:image/png;base64,AAAA")).toBe(false)
    expect(isOurs("not a url")).toBe(false)
  })
})

describe("export — the asset graph", () => {
  test("a hand-written page with no Vue entry has build entry '' — a real page, not an error", () => {
    // The shell version died silently on exactly this, twice: `$(… | grep …)` under pipefail.
    expect(buildEntryOf("<html><body><h1>hi</h1></body></html>")).toBe("")
    expect(buildEntryOf('<script src="/build/assets/app-AbC_1.js">')).toBe("app-AbC_1.js")
  })
  test("lazy chunks come from the manifest, not the HTML", () => {
    const g = assetGraph({ a: { file: "assets/app-X.js", css: ["assets/app-X.css"] }, b: { file: "assets/lazy-Y.js" } }, "")
    expect(g.required).toContain("/build/assets/lazy-Y.js")
    expect(g.required).toContain("/build/assets/app-X.css")
  })
  test("site chrome is OPTIONAL — a missing favicon must never fail an export", () => {
    const g = assetGraph({}, "")
    expect(g.required).not.toContain("/favicon.svg")
    expect(g.optional).toContain("/favicon.svg")
  })
  test("a chrome path the page names explicitly becomes required, not optional", () => {
    const g = assetGraph({}, '<link rel="icon" href="/favicon.svg">')
    expect(g.required).toContain("/favicon.svg")
    expect(g.optional).not.toContain("/favicon.svg")
  })
  test("a gate is detected through HTML-entity encoding, which is how it actually arrives", () => {
    expect(isGatedPage(`<div data-page='{&quot;requireOtp&quot;:true}'>`)).toBe(true)
    expect(isGatedPage(`<div data-page='{&quot;props&quot;:{}}'>`)).toBe(false)
  })
})

describe("export-data — the manifest keeps every refusal", () => {
  let server: ReturnType<typeof Bun.serve>
  let site: string
  beforeAll(() => {
    site = mkdtempSync(join(tmpdir(), "edge-manifest-"))
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const p = new URL(req.url).pathname
        // Same collection NAME under two data slugs: one PHI-flagged (refused), one safe (exported).
        if (p === "/api/v1/app-data/alpha/cases") return Response.json({ data: [{ id: 1 }], phi: true })
        if (p === "/api/v1/app-data/beta/cases") return Response.json({ data: [{ id: 2 }] })
        return new Response("nope", { status: 404 })
      },
    })
  })
  afterAll(() => {
    server.stop(true)
    rmSync(site, { recursive: true, force: true })
  })

  test("an export under one slug does not erase a refusal of the same name under another", async () => {
    const origin = `http://localhost:${server.port}`
    await exportCollections({ origin, slug: "alpha", site, collections: ["cases"] })
    await exportCollections({ origin, slug: "beta", site, collections: ["cases"] })

    const m = JSON.parse(readFileSync(join(site, "api/v1/app-data/_edge.json"), "utf8"))
    const alpha = m.collections.find((c: any) => c.slug === "alpha" && c.collection === "cases")
    const beta = m.collections.find((c: any) => c.slug === "beta" && c.collection === "cases")

    expect(alpha?.refused).toBe(true)
    expect(beta?.refused).toBe(false)
    expect(m.slugs).toEqual(["alpha", "beta"])
    // And the refused one never reached disk.
    expect(existsSync(join(site, "api/v1/app-data/alpha/cases"))).toBe(false)
    expect(existsSync(join(site, "api/v1/app-data/beta/cases"))).toBe(true)
  })
})

describe("serve — the one hosting rule", () => {
  let dir: string
  let srv: Awaited<ReturnType<typeof startStaticServer>>
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "edge-serve-"))
    writeFileSync(join(dir, "index.html"), "<html>root</html>")
    srv = await startStaticServer(dir)
  })
  afterAll(async () => {
    await srv.stop()
    rmSync(dir, { recursive: true, force: true })
  })
  test("an app route falls back to index.html, or refresh breaks", async () => {
    expect((await fetch(`${srv.url}/p/anything`)).status).toBe(200)
  })
  test("a missing ASSET 404s honestly — never HTML to the JS parser", async () => {
    expect((await fetch(`${srv.url}/build/assets/gone-X.js`)).status).toBe(404)
  })
  test("a traversal written on the wire is refused (fetch() would normalise it away)", async () => {
    const res = await new Promise<string>((resolve, reject) => {
      const net = require("net") as typeof import("net")
      const s = net.connect(srv.port, "127.0.0.1", () =>
        s.write(`GET /../../../../etc/passwd HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`),
      )
      let buf = ""
      s.on("data", (d) => (buf += d))
      s.on("end", () => resolve(buf))
      s.on("error", reject)
    })
    expect(res.split(" ")[1]).toBe("403")
    expect(res).not.toContain("root:")
  })
})

describe("deploy — the swap, read back from the target", () => {
  let root: string
  const release = (n: string) => {
    mkdirSync(join(root, "releases", n), { recursive: true })
    writeFileSync(join(root, "releases", n, "marker.txt"), n)
  }
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "edge-deploy-"))
  })
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  test("a SECOND swap actually moves current — ln/mv follow a dir symlink and exit 0 otherwise", async () => {
    const r = new Remote({ type: "local", path: root })
    release("20260101-000001")
    release("20260101-000002")
    await r.pointAt("20260101-000001")
    await r.pointAt("20260101-000002")

    expect(readlinkSync(join(root, "current"))).toBe("releases/20260101-000002")
    expect(readFileSync(join(root, "current", "marker.txt"), "utf8")).toBe("20260101-000002")
    // Nothing written INSIDE the previous release — which is where `mv -f tmp current` put it.
    expect(readdirSync(join(root, "releases", "20260101-000001"))).toEqual(["marker.txt"])
  })

  test("prune keeps N and never the live release", async () => {
    const r = new Remote({ type: "local", path: root, keep: 2 })
    release("20260101-000003")
    release("20260101-000004")
    await r.pointAt("20260101-000002") // live is NOT the newest
    await r.prune("20260101-000002")
    const left = await r.releases()
    expect(left).toContain("20260101-000002")
    expect(left.length).toBe(2)
  })

  test("nothing with shell syntax reaches a remote shell", () => {
    expect(() => assertSafe("slug", "my-page_2.v1")).not.toThrow()
    for (const bad of ["a;rm -rf /", "$(id)", "a b", "`x`", "a|b", "../x"]) {
      expect(() => assertSafe("slug", bad)).toThrow()
    }
    expect(() => new Remote({ type: "local", path: "/srv/site; rm -rf /" })).toThrow()
    expect(() => new Remote({ type: "local", path: "relative/path" })).toThrow()
    expect(() => new Remote({ type: "ssh", path: "/srv/site" })).toThrow()
  })
})
