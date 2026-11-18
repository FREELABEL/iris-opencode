import { NodeHttpServer } from "@effect/platform-node"
import { afterEach, describe, expect } from "bun:test"
import { Context, Effect, Layer, Option } from "effect"
import { HttpBody, HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { MoveSession } from "@opencode-ai/core/control-plane/move-session"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { Installation } from "../../src/installation"
import { pagePinDeps } from "../../src/iris/page-pin"
import { ServerAuth } from "../../src/server/auth"
import { RootHttpApi } from "../../src/server/routes/instance/httpapi/api"
import { controlHandlers } from "../../src/server/routes/instance/httpapi/handlers/control"
import { controlPlaneHandlers } from "../../src/server/routes/instance/httpapi/handlers/control-plane"
import { globalHandlers } from "../../src/server/routes/instance/httpapi/handlers/global"
import { irisHandlers } from "../../src/server/routes/instance/httpapi/handlers/iris"
import { authorizationLayer } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { schemaErrorLayer } from "../../src/server/routes/instance/httpapi/middleware/schema-error"
import { testEffect } from "../lib/effect"

// #192624 — may this account pin a page as a Marketing sub-tab, through the real route. Effect Schema
// strips undeclared fields silently (PR #459), so every field the panel reads is asserted to arrive.
// The account's page list is mocked: it is fl-api's Page::scopeVisibleTo, which is what decides.

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

type Page = { id: number; title: string; slug?: string; status: string; visibility?: string; requiresAuth?: boolean }
let asked: string[] = []
const real = pagePinDeps.pages
afterEach(() => {
  pagePinDeps.pages = real
  asked = []
})
/** The account's own pages, as the platform scopes them — or a list that could not be read. */
function account(pages: Page[] | { measured: false; reason: string }) {
  pagePinDeps.pages = async (q) => {
    asked.push(q)
    return Array.isArray(pages) ? { measured: true, data: { pages } } : { ...pages, data: { pages: [] } }
  }
}
const postJson = (url: string, body: unknown) =>
  HttpClientRequest.post(url).pipe(HttpClientRequest.setBody(HttpBody.jsonUnsafe(body)), HttpClient.execute)
const pin = (slug: string) =>
  Effect.gen(function* () {
    const res = yield* postJson("/iris/page-pin", { slug })
    expect(res.status).toBe(200)
    return (yield* res.json) as any
  })

describe("/iris/page-pin (#192624)", () => {
  it.live("allows a page the account owns, with every field the panel reads", () =>
    Effect.gen(function* () {
      account([{ id: 7, title: "Our ads review", slug: "acme-ads-review", status: "published", visibility: "public", requiresAuth: true }])
      expect(yield* pin("Acme-Ads-Review")).toEqual({
        measured: true,
        allowed: true,
        page: { slug: "acme-ads-review", title: "Our ads review", status: "published", visibility: "public", requiresAuth: true, signIn: true },
      })
      expect(asked).toEqual(["acme-ads-review"])
    }),
  )

  it.live("refuses a page that is not in the account's own pages — FREELABEL's, for a customer", () =>
    Effect.gen(function* () {
      // A search hit that merely CONTAINS the slug is not the page.
      account([{ id: 9, title: "My review", slug: "freelabel-ads-review-copy", status: "published" }])
      const body = yield* pin("freelabel-ads-review")
      expect(body.measured).toBe(true)
      expect(body.allowed).toBe(false)
      expect(body.page).toBeUndefined()
      expect(body.reason).toMatch(/not one of your pages/)
    }),
  )

  it.live("fails closed when the account's pages cannot be read", () =>
    Effect.gen(function* () {
      account({ measured: false, reason: "not signed in (token: none)" })
      expect(yield* pin("acme-ads-review")).toEqual({ measured: false, allowed: false, reason: "not signed in (token: none)" })
    }),
  )

  it.live("a malformed slug is refused before any request", () =>
    Effect.gen(function* () {
      account([])
      expect(yield* pin("../etc/passwd")).toMatchObject({ allowed: false, reason: "not a page address" })
      expect(asked.length).toBe(0)
    }),
  )

  it.live("a private page is pinned to open signed in", () =>
    Effect.gen(function* () {
      account([{ id: 3, title: "Board only", slug: "board-only", status: "published", visibility: "private" }])
      expect((yield* pin("board-only")).page).toMatchObject({ signIn: true, visibility: "private" })
    }),
  )
})
