import { NodeHttpServer } from "@effect/platform-node"
import { afterEach, describe, expect } from "bun:test"
import { Context, Effect, Layer, Option } from "effect"
import { HttpBody, HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { MoveSession } from "@opencode-ai/core/control-plane/move-session"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { Installation } from "../../src/installation"
import { pageAddressDeps } from "../../src/iris/page-address"
import { ServerAuth } from "../../src/server/auth"
import { RootHttpApi } from "../../src/server/routes/instance/httpapi/api"
import { controlHandlers } from "../../src/server/routes/instance/httpapi/handlers/control"
import { controlPlaneHandlers } from "../../src/server/routes/instance/httpapi/handlers/control-plane"
import { globalHandlers } from "../../src/server/routes/instance/httpapi/handlers/global"
import { irisHandlers } from "../../src/server/routes/instance/httpapi/handlers/iris"
import { authorizationLayer } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { schemaErrorLayer } from "../../src/server/routes/instance/httpapi/middleware/schema-error"
import { testEffect } from "../lib/effect"

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

// Marketing tab, 2026-11-20 — the address a MEMBER opens for one of their own pages, through the real
// route. FL-007 (published + unlisted) showed "This page isn't published" in the tab because the tab
// framed /p/<slug>, which 404s for an unlisted page by design. The account's page list and fl-api's
// page detail are mocked; every field the panel reads is asserted to arrive (Effect Schema strips
// undeclared fields silently, PR #459).

type Page = { id: number; title: string; slug?: string; status: string; visibility?: string }
let fetched: string[] = []
const realPages = pageAddressDeps.pages
const realFetch = pageAddressDeps.fetch
afterEach(() => {
  pageAddressDeps.pages = realPages
  pageAddressDeps.fetch = realFetch
  fetched = []
})
function account(pages: Page[] | { measured: false; reason: string }, detail: Record<number, unknown> = {}) {
  pageAddressDeps.pages = async () =>
    Array.isArray(pages) ? { measured: true, data: { pages } } : { ...pages, data: { pages: [] } }
  pageAddressDeps.fetch = async (path: string) => {
    fetched.push(path)
    const id = Number(path.split("/").pop())
    return id in detail
      ? new Response(JSON.stringify({ success: true, data: detail[id] }), { status: 200 })
      : new Response(JSON.stringify({ success: false }), { status: 404 })
  }
}
const address = (slug: string) =>
  Effect.gen(function* () {
    const res = yield* HttpClient.get(`/iris/page-address?slug=${encodeURIComponent(slug)}`)
    expect(res.status).toBe(200)
    return (yield* res.json) as any
  })

const UUID = "ef0faee2-d239-451a-a74d-80fdd129b014"

describe("/iris/page-address (Marketing shows a member's own page whatever its status)", () => {
  it.live("a published public page is the plain slug, in one request", () =>
    Effect.gen(function* () {
      account([{ id: 1, title: "Feed", slug: "freelabel-feed-preview", status: "published", visibility: "public" }])
      expect(yield* address("freelabel-feed-preview")).toEqual({
        measured: true,
        url: "https://heyiris.io/p/freelabel-feed-preview",
        kind: "public",
        status: "published",
        visibility: "public",
      })
      expect(fetched).toEqual([])
    }),
  )

  it.live("a published UNLISTED page opens at /p/<public_id> — the slug 404s for it by design", () =>
    Effect.gen(function* () {
      account([{ id: 1166, title: "Grid plan", slug: "freelabel-grid-plan", status: "published", visibility: "unlisted" }], {
        1166: { status: "published", visibility: "unlisted", public_id: UUID, preview_url: "https://www.genesis-ui.com/p/freelabel-grid-plan?preview=true&token=abcDEF123_-xyz" },
      })
      const body = yield* address("freelabel-grid-plan")
      expect(body).toEqual({ measured: true, url: `https://heyiris.io/p/${UUID}`, kind: "unlisted", status: "published", visibility: "unlisted" })
      expect(fetched).toEqual(["/api/v1/pages/1166"])
    }),
  )

  it.live("a DRAFT opens at the owner's preview link, rebuilt on heyiris.io whatever host fl-api named", () =>
    Effect.gen(function* () {
      account([{ id: 1165, title: "Cover preview", slug: "freelabel-cover-preview", status: "draft", visibility: "unlisted" }], {
        1165: { status: "draft", visibility: "unlisted", public_id: UUID, preview_url: "https://www.genesis-ui.com/p/freelabel-cover-preview?preview=true&token=MTE2NTpwYWdl" },
      })
      const body = yield* address("freelabel-cover-preview")
      expect(body.kind).toBe("preview")
      expect(body.url).toBe("https://heyiris.io/p/freelabel-cover-preview?preview=true&token=MTE2NTpwYWdl")
    }),
  )

  it.live("a draft whose detail carries no preview link (not the owner) falls back to the plain address and says why", () =>
    Effect.gen(function* () {
      account([{ id: 5, title: "Theirs", slug: "a-draft", status: "draft" }], { 5: { status: "draft", visibility: "public" } })
      const body = yield* address("a-draft")
      expect(body.measured).toBe(false)
      expect(body.url).toBe("https://heyiris.io/p/a-draft")
      expect(body.reason).toMatch(/no preview link/)
    }),
  )

  it.live("not one of the account's pages: only the plain address, never another account's preview", () =>
    Effect.gen(function* () {
      account([{ id: 9, title: "Mine", slug: "freelabel-grid-plan-copy", status: "draft" }], { 9: { preview_url: "https://heyiris.io/p/x?preview=true&token=SECRET1234" } })
      const body = yield* address("freelabel-grid-plan")
      expect(body).toEqual({ measured: false, reason: "not one of your pages", url: "https://heyiris.io/p/freelabel-grid-plan", kind: "public" })
      expect(fetched).toEqual([])
    }),
  )

  it.live("a page list that cannot be read leaves the tab exactly where it was: the plain address", () =>
    Effect.gen(function* () {
      account({ measured: false, reason: "not signed in (token: none)" })
      const body = yield* address("freelabel-grid-plan")
      expect(body.measured).toBe(false)
      expect(body.url).toBe("https://heyiris.io/p/freelabel-grid-plan")
    }),
  )

  it.live("a malformed slug is refused before any request", () =>
    Effect.gen(function* () {
      account([])
      const body = yield* address("../../etc")
      expect(body.measured).toBe(false)
      expect(body.reason).toBe("not a page address")
      expect(fetched).toEqual([])
    }),
  )
})
