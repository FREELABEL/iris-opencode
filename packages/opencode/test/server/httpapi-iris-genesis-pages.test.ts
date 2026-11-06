import { NodeHttpServer } from "@effect/platform-node"
import { afterEach, describe, expect } from "bun:test"
import { Context, Effect, Layer, Option } from "effect"
import { HttpBody, HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { MoveSession } from "@opencode-ai/core/control-plane/move-session"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { Installation } from "../../src/installation"
import { genesisDeps } from "../../src/iris/genesis-pages"
import { ServerAuth } from "../../src/server/auth"
import { RootHttpApi } from "../../src/server/routes/instance/httpapi/api"
import { controlHandlers } from "../../src/server/routes/instance/httpapi/handlers/control"
import { controlPlaneHandlers } from "../../src/server/routes/instance/httpapi/handlers/control-plane"
import { globalHandlers } from "../../src/server/routes/instance/httpapi/handlers/global"
import { irisHandlers } from "../../src/server/routes/instance/httpapi/handlers/iris"
import { authorizationLayer } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { schemaErrorLayer } from "../../src/server/routes/instance/httpapi/middleware/schema-error"
import { testEffect } from "../lib/effect"

// #192632 — Genesis › Pages through the real routes. Effect Schema strips undeclared fields silently,
// so every field the panel reads is asserted to arrive. The platform is replaced by the shapes it
// returned on 2026-11-05; the writes are asserted by the calls they make — nothing reaches a page.

const apiLayer = HttpRouter.serve(
  HttpApiBuilder.layer(RootHttpApi).pipe(
    Layer.provide([controlHandlers, controlPlaneHandlers, globalHandlers, irisHandlers]),
    Layer.provide([authorizationLayer, schemaErrorLayer]),
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
    HttpRouter.provideRequest(Layer.succeedContext(Context.empty() as Context.Context<unknown>)),
  ),
  { disableListenLog: true, disableLogger: true },
).pipe(
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provide(Layer.mock(Auth.Service)({})),
  Layer.provide(Layer.mock(Config.Service)({})),
  Layer.provide(Layer.mock(Installation.Service)({})),
  Layer.provide(Layer.mock(MoveSession.Service)({})),
  Layer.provide(ServerAuth.Config.configLayer({ password: Option.none(), username: "opencode" })),
)
const it = testEffect(apiLayer)

const ROW = {
  id: 783,
  slug: "cwc-preview-events",
  title: "Preview — Events &amp; Specials",
  status: "published",
  visibility: "unlisted",
  requires_auth: false,
  current_version: 32,
  thumbnail_url: "https://apiv2.heyiris.io/storage/thumbnails/cwc-preview-events.png",
  owner_type: "bloq",
  owner_id: 314,
  site_id: 14,
  public_url: "https://cottonwoodcreekbrewery.com/p/cwc-preview-events",
  updated_at: "2026-11-05T20:05:20.000000Z",
}
type Call = { path: string; method: string; body?: string }
let calls: Call[] = []
let page: Record<string, unknown> = { ...ROW }
const real = { ...genesisDeps }
afterEach(() => {
  Object.assign(genesisDeps, real)
  calls = []
  page = { ...ROW }
})
const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 })
/** A platform that answers like iris-api did, and applies writes to one in-memory page. */
function platform() {
  genesisDeps.userId = async () => 193
  genesisDeps.fetch = async (path, _base, init) => {
    const method = init?.method ?? "GET"
    calls.push({ path, method, body: typeof init?.body === "string" ? init.body : undefined })
    if (path.startsWith("/api/v1/pages?")) {
      const u = new URLSearchParams(path.split("?")[1])
      // The account has 1,038 pages; board 314 owns this one.
      const total = u.get("owner_id") ? 1 : u.get("status") === "draft" ? 167 : u.get("status") === "published" ? 857 : 1038
      return ok({ data: Number(u.get("per_page")) === 1 ? [] : [page], total, last_page: Math.ceil(total / Number(u.get("per_page"))), current_page: Number(u.get("page")) })
    }
    if (path === "/api/v1/pages/783" && method === "PUT") {
      page = { ...page, ...JSON.parse(String(init?.body)) }
      return ok(page)
    }
    if (path === "/api/v1/pages/783") return ok({ ...page, preview_url: "https://raichu.heyiris.io/p/x?preview=true&token=v2", json_content: { theme: { branding: { name: "Cottonwood Creek" } } }, owner: { name: "Cottonwood" }, creator: { id: 5083, full_name: "Emily Glynn" } })
    if (path.endsWith("/publish")) return (page = { ...page, status: "published" }), ok(page)
    if (path.endsWith("/unpublish")) return (page = { ...page, status: "draft" }), ok(page)
    if (path.startsWith("/api/v1/pages/783/rollback/")) return (page = { ...page, current_version: 33 }), ok(page)
    if (path.startsWith("/api/v1/pages/783/versions?")) return ok({ data: [{ version_number: "32", changed_by: "5083", created_at: "2026-11-05T20:05:20.000000Z", change_summary: "Updated" }], total: 1, last_page: 1 })
    if (path === "/api/v1/pages/783/versions/31") return ok({ version_number: "31", json_content: JSON.stringify({ render_mode: "html", html: "<main>v31</main>" }), changer: { id: 5083, full_name: "Emily Glynn" } })
    if (path === "/api/internal/cache/purge-page") return ok({})
    return new Response("{}", { status: 404 })
  }
}
const writes = () => calls.filter((c) => c.method !== "GET" && c.path !== "/api/internal/cache/purge-page")
const getJson = (url: string) =>
  Effect.gen(function* () {
    const res = yield* HttpClient.get(url)
    expect(res.status).toBe(200)
    return (yield* res.json) as any
  })
const postJson = (url: string, body: unknown) =>
  Effect.gen(function* () {
    const res = yield* HttpClientRequest.post(url).pipe(HttpClientRequest.setBody(HttpBody.jsonUnsafe(body)), HttpClient.execute)
    expect(res.status).toBe(200)
    return (yield* res.json) as any
  })

describe("/iris/pages (#192632)", () => {
  it.live("pages through the platform's own count, with every field a card reads and the filter counts", () =>
    Effect.gen(function* () {
      platform()
      const body = yield* getJson("/iris/pages/0?scope=all&filter=all&page=2&perPage=24")
      expect(body).toMatchObject({ measured: true, page: 2, perPage: 24, total: 1038, totalIsExact: true, hasMore: true })
      expect(body.counts).toEqual({ all: 1038, published: 857, draft: 167 })
      expect(body.pages[0]).toMatchObject({
        title: "Preview — Events & Specials",
        thumbnailUrl: ROW.thumbnail_url,
        ownerType: "bloq",
        ownerId: 314,
        siteId: 14,
        visibility: "unlisted",
        version: 32,
        url: ROW.public_url,
      })
      expect(calls.find((c) => c.path.includes("per_page=24"))!.path).toContain("page=2")
    }),
  )

  it.live("Drafts is filtered by the platform; Private is a scan that counts what it found", () =>
    Effect.gen(function* () {
      platform()
      expect((yield* getJson("/iris/pages/0?scope=all&filter=draft")).total).toBe(167)
      expect(calls[0].path).toContain("status=draft")
      expect((yield* getJson("/iris/pages/314?filter=all")).counts).toEqual({ all: 1, published: 1, draft: 1, private: 1 })
      expect(calls.at(-1)!.path).toContain("owner_id=314")
      const priv = yield* getJson("/iris/pages/314?filter=private")
      expect(priv.pages.map((p: any) => p.id)).toEqual([783])
      expect(priv.counts.private).toBe(1)
    }),
  )

  it.live("one page's facts carry the brand it names and its draft preview, never its document", () =>
    Effect.gen(function* () {
      platform()
      const i = yield* getJson("/iris/page/783/info")
      expect(i).toMatchObject({ measured: true, brandName: "Cottonwood Creek", ownerName: "Cottonwood", creator: { id: 5083, name: "Emily Glynn" }, previewUrl: "https://raichu.heyiris.io/p/x?preview=true&token=v2" })
      expect(i.page.thumbnailUrl).toBe(ROW.thumbnail_url)
      expect(JSON.stringify(i)).not.toContain("json_content")
    }),
  )

  it.live("versions list, and a past version drawn as its own document", () =>
    Effect.gen(function* () {
      platform()
      expect(yield* getJson("/iris/page/783/versions")).toMatchObject({ measured: true, total: 1, hasMore: false, versions: [{ version: 32, byId: 5083, summary: "Updated" }] })
      const v = yield* getJson("/iris/page/783/versions/31")
      expect(v).toMatchObject({ measured: true, version: 31, by: "Emily Glynn", renderMode: "html" })
      expect(v.html).toContain("<main>v31</main>")
      expect(writes()).toEqual([])
    }),
  )
})

describe("acting on a page (#192632): widening asks, narrowing doesn't", () => {
  it.live("publish without the person's yes is refused and calls nothing", () =>
    Effect.gen(function* () {
      platform()
      const r = yield* postJson("/iris/page/783/publish", { publish: true })
      expect(r.ok).toBe(false)
      expect(r.reason).toContain("confirmation")
      expect(calls).toEqual([])
    }),
  )

  it.live("publish with it calls the CLI's route and reads the page back; unpublish needs none", () =>
    Effect.gen(function* () {
      platform()
      page = { ...ROW, status: "draft" }
      const r = yield* postJson("/iris/page/783/publish", { publish: true, confirm: true })
      expect(r).toMatchObject({ ok: true, page: { status: "published", id: 783 } })
      expect(writes().map((c) => `${c.method} ${c.path}`)).toEqual(["POST /api/v1/pages/783/publish"])
      expect((yield* postJson("/iris/page/783/publish", { publish: false })).page.status).toBe("draft")
    }),
  )

  it.live("widening is judged on the platform's value: unlisted → public refused without confirm", () =>
    Effect.gen(function* () {
      platform()
      const r = yield* postJson("/iris/page/783/visibility", { mode: "public" })
      expect(r.ok).toBe(false)
      expect(writes()).toEqual([])
      const done = yield* postJson("/iris/page/783/visibility", { mode: "public", confirm: true })
      expect(done).toMatchObject({ ok: true, page: { visibility: "public" } })
      expect(writes()[0]).toMatchObject({ method: "PUT", path: "/api/v1/pages/783", body: JSON.stringify({ visibility: "public" }) })
    }),
  )

  it.live("narrowing goes through with no confirm, and a dropped field is not called success", () =>
    Effect.gen(function* () {
      platform()
      page = { ...ROW, visibility: "public" }
      expect(yield* postJson("/iris/page/783/visibility", { mode: "unlisted" })).toMatchObject({ ok: true, page: { visibility: "unlisted" } })
      // A platform build without the column accepts the PUT and keeps the old value.
      const put = genesisDeps.fetch
      genesisDeps.fetch = async (path, base, init) => (init?.method === "PUT" ? ok(page) : put(path, base, init))
      const r = yield* postJson("/iris/page/783/visibility", { mode: "private" })
      expect(r.ok).toBe(false)
      expect(r.reason).toContain("nothing changed")
    }),
  )

  it.live("rollback needs confirm, and then posts to the version's rollback route", () =>
    Effect.gen(function* () {
      platform()
      expect((yield* postJson("/iris/page/783/rollback", { version: 31 })).ok).toBe(false)
      expect(writes()).toEqual([])
      expect(yield* postJson("/iris/page/783/rollback", { version: 31, confirm: true })).toMatchObject({ ok: true, page: { version: 33 } })
      expect(writes().map((c) => c.path)).toEqual(["/api/v1/pages/783/rollback/31"])
    }),
  )
})
