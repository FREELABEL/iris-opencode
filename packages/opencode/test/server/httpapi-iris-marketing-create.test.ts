import { NodeHttpServer } from "@effect/platform-node"
import { afterEach, describe, expect } from "bun:test"
import { Context, Effect, Layer, Option } from "effect"
import { HttpBody, HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { MoveSession } from "@opencode-ai/core/control-plane/move-session"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { Installation } from "../../src/installation"
import { marketingCreateDeps, slugify } from "../../src/iris/marketing-create"
import { ServerAuth } from "../../src/server/auth"
import { RootHttpApi } from "../../src/server/routes/instance/httpapi/api"
import { controlHandlers } from "../../src/server/routes/instance/httpapi/handlers/control"
import { controlPlaneHandlers } from "../../src/server/routes/instance/httpapi/handlers/control-plane"
import { globalHandlers } from "../../src/server/routes/instance/httpapi/handlers/global"
import { irisHandlers } from "../../src/server/routes/instance/httpapi/handlers/iris"
import { authorizationLayer } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { schemaErrorLayer } from "../../src/server/routes/instance/httpapi/middleware/schema-error"
import { testEffect } from "../lib/effect"

// #193233 — Desktop › Marketing › + makes a brand kit or a landing page, through the real routes.

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
// Effect Schema strips undeclared fields silently (PR #459), so every field the panel reads is asserted.

const real = { ...marketingCreateDeps }
afterEach(() => Object.assign(marketingCreateDeps, real))
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
const post = (url: string, body: unknown) =>
  Effect.gen(function* () {
    const res = yield* HttpClientRequest.post(url).pipe(HttpClientRequest.setBody(HttpBody.jsonUnsafe(body)), HttpClient.execute)
    expect(res.status).toBe(200)
    return (yield* res.json) as any
  })

describe("slugify (#193233)", () => {
  it.live("makes an address from a name", () =>
    Effect.sync(() => {
      expect(slugify("Acme Shoes — Spring!")).toBe("acme-shoes-spring")
      expect(slugify("Café Été")).toBe("cafe-ete")
      expect(slugify("!!!")).toBe("")
    }),
  )
})

describe("/iris/marketing/landing-page (#193233)", () => {
  it.live("makes a draft page owned by the board and returns where it is", () =>
    Effect.gen(function* () {
      const sent: any[] = []
      marketingCreateDeps.page = async (b) => {
        sent.push(b)
        return json(201, { data: { id: 7, slug: b.slug, title: b.title } })
      }
      expect(yield* post("/iris/marketing/landing-page", { bloq_id: 912, name: "Spring Launch" })).toEqual({
        ok: true,
        id: 7,
        slug: "spring-launch",
        name: "Spring Launch",
      })
      expect(sent[0]).toMatchObject({ owner_type: "bloq", owner_id: 912, status: "draft", slug: "spring-launch" })
      expect(sent[0].json_content.components.map((c: any) => c.type)).toEqual(["Hero", "SiteFooter"])
    }),
  )
  it.live("a taken address is retried once with a suffix", () =>
    Effect.gen(function* () {
      const slugs: string[] = []
      marketingCreateDeps.suffix = () => "x7k2"
      marketingCreateDeps.page = async (b) => {
        slugs.push(String(b.slug))
        return slugs.length === 1
          ? json(422, { message: "The slug has already been taken." })
          : json(201, { data: { id: 8, slug: b.slug, title: b.title } })
      }
      const r = yield* post("/iris/marketing/landing-page", { bloq_id: 912, name: "Spring Launch" })
      expect(slugs).toEqual(["spring-launch", "spring-launch-x7k2"])
      expect(r.slug).toBe("spring-launch-x7k2")
    }),
  )
  it.live("no name, or a refusal, says why in plain words and sends nothing it shouldn't", () =>
    Effect.gen(function* () {
      let calls = 0
      marketingCreateDeps.page = async () => (calls++, json(403, {}))
      expect((yield* post("/iris/marketing/landing-page", { bloq_id: 912, name: "  " })).error.kind).toBe("invalid")
      expect(calls).toBe(0)
      const r = yield* post("/iris/marketing/landing-page", { bloq_id: 912, name: "Spring" })
      expect(r.error.kind).toBe("not_allowed")
      expect(r.error.message).not.toMatch(/\d{3}/)
    }),
  )
})

describe("/iris/marketing/brand (#193233)", () => {
  it.live("makes a brand on the board, as the signed-in user", () =>
    Effect.gen(function* () {
      const sent: any[] = []
      marketingCreateDeps.userId = async () => 31
      marketingCreateDeps.brand = async (b) => {
        sent.push(b)
        return json(201, { data: { id: 51, slug: b.slug, name: b.name } })
      }
      expect(yield* post("/iris/marketing/brand", { bloq_id: 912, name: "Acme Shoes" })).toEqual({
        ok: true,
        id: 51,
        slug: "acme-shoes",
        name: "Acme Shoes",
      })
      expect(sent[0]).toEqual({ user_id: 31, name: "Acme Shoes", slug: "acme-shoes", entity_type: "brand", bloq_id: 912 })
    }),
  )
  it.live("signed out makes nothing", () =>
    Effect.gen(function* () {
      let calls = 0
      marketingCreateDeps.userId = async () => null
      marketingCreateDeps.brand = async () => (calls++, json(201, {}))
      expect((yield* post("/iris/marketing/brand", { bloq_id: 912, name: "Acme" })).error.kind).toBe("signed_out")
      expect(calls).toBe(0)
    }),
  )
})
