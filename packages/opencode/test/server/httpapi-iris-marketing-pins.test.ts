import { NodeHttpServer } from "@effect/platform-node"
import { afterEach, describe, expect } from "bun:test"
import { Context, Effect, Layer, Option } from "effect"
import { HttpBody, HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { MoveSession } from "@opencode-ai/core/control-plane/move-session"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { Installation } from "../../src/installation"
import { marketingPinsDeps } from "../../src/iris/marketing-pins"
import { ServerAuth } from "../../src/server/auth"
import { RootHttpApi } from "../../src/server/routes/instance/httpapi/api"
import { controlHandlers } from "../../src/server/routes/instance/httpapi/handlers/control"
import { controlPlaneHandlers } from "../../src/server/routes/instance/httpapi/handlers/control-plane"
import { globalHandlers } from "../../src/server/routes/instance/httpapi/handlers/global"
import { irisHandlers } from "../../src/server/routes/instance/httpapi/handlers/iris"
import { authorizationLayer } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { schemaErrorLayer } from "../../src/server/routes/instance/httpapi/middleware/schema-error"
import { testEffect } from "../lib/effect"

// #193357 — Desktop › Marketing's pins on the account, through the real routes. fl-api is a stand-in
// answering with the shapes of fl-api #298 (GET/PUT /api/v1/me/settings/marketing.pins).

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

const real = marketingPinsDeps.fetch
afterEach(() => (marketingPinsDeps.fetch = real))
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
const sent: any[] = []
function flApi(answer: (init?: RequestInit) => Response) {
  sent.length = 0
  marketingPinsDeps.fetch = async (init) => {
    sent.push(init?.body ? { method: init.method, body: JSON.parse(String(init.body)) } : { method: "GET" })
    return answer(init)
  }
}
const get = () =>
  Effect.gen(function* () {
    const res = yield* HttpClient.get("/iris/marketing/pins")
    expect(res.status).toBe(200)
    return (yield* res.json) as any
  })
const put = (body: unknown) =>
  Effect.gen(function* () {
    const res = yield* HttpClientRequest.put("/iris/marketing/pins").pipe(HttpClientRequest.setBody(HttpBody.jsonUnsafe(body)), HttpClient.execute)
    expect(res.status).toBe(200)
    return (yield* res.json) as any
  })
const pins = { pins: [{ slug: "spring", label: "Spring", signIn: true }], selected: "spring" }

describe("/iris/marketing/pins (#193357)", () => {
  it.live("every field the panel reads arrives", () =>
    Effect.gen(function* () {
      flApi(() => json(200, { success: true, data: { key: "marketing.pins", value: pins, version: 3 } }))
      expect(yield* get()).toEqual({ measured: true, available: true, value: pins, version: 3 })
    }),
  )
  it.live("before fl-api has the route: not available, so the panel keeps localStorage", () =>
    Effect.gen(function* () {
      flApi(() => json(404, { message: "Not Found" }))
      expect(yield* get()).toMatchObject({ measured: true, available: false })
    }),
  )
  it.live("a save passes the version through and returns the saved one", () =>
    Effect.gen(function* () {
      flApi((init) => json(200, { success: true, data: { value: JSON.parse(String(init?.body)).value, version: 4 } }))
      expect(yield* put({ value: pins, version: 3 })).toEqual({ ok: true, value: pins, version: 4 })
      expect(sent[0]).toEqual({ method: "PUT", body: { value: pins, version: 3 } })
    }),
  )
  it.live("a stale save comes back as a conflict carrying what is really saved", () =>
    Effect.gen(function* () {
      const theirs = { pins: [{ slug: "theirs", label: "Theirs" }] }
      flApi(() => json(409, { success: false, error: "changed", current: { key: "marketing.pins", value: theirs, version: 5 } }))
      expect(yield* put({ value: pins, version: 3 })).toMatchObject({ ok: false, conflict: true, value: theirs, version: 5 })
    }),
  )
})
