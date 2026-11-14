import { NodeHttpServer } from "@effect/platform-node"
import { afterEach, describe, expect } from "bun:test"
import { Context, Effect, Layer, Option } from "effect"
import { HttpBody, HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { MoveSession } from "@opencode-ai/core/control-plane/move-session"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { Installation } from "../../src/installation"
import { pageSignInDeps } from "../../src/iris/page-signin"
import { ServerAuth } from "../../src/server/auth"
import { RootHttpApi } from "../../src/server/routes/instance/httpapi/api"
import { controlHandlers } from "../../src/server/routes/instance/httpapi/handlers/control"
import { controlPlaneHandlers } from "../../src/server/routes/instance/httpapi/handlers/control-plane"
import { globalHandlers } from "../../src/server/routes/instance/httpapi/handlers/global"
import { irisHandlers } from "../../src/server/routes/instance/httpapi/handlers/iris"
import { authorizationLayer } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { schemaErrorLayer } from "../../src/server/routes/instance/httpapi/middleware/schema-error"
import { testEffect } from "../lib/effect"

// #192482 — a pinned page opened signed in, through the real route. Effect Schema strips undeclared
// fields silently (PR #459), so every field the panel reads is asserted to arrive. iris-api is mocked:
// a real call would mint a real one-time code for whoever runs the test.

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

const CODE = "A".repeat(20) + "b_-" + "C".repeat(20)

type Seen = { path: string; init?: RequestInit }
let seen: Seen[] = []
const real = pageSignInDeps.fetch
afterEach(() => {
  pageSignInDeps.fetch = real
  seen = []
})
function irisApi(status: number, body: unknown) {
  pageSignInDeps.fetch = async (path, init) => {
    seen.push({ path, init })
    return new Response(JSON.stringify(body), { status })
  }
}
const postJson = (url: string, body: unknown) =>
  HttpClientRequest.post(url).pipe(HttpClientRequest.setBody(HttpBody.jsonUnsafe(body)), HttpClient.execute)

describe("/iris/page-signin (#192482)", () => {
  it.live("returns the page address with the code in its fragment, every field intact", () =>
    Effect.gen(function* () {
      irisApi(200, { success: true, code: CODE, expires_in: 90, path: "/p/evil#atlas_code=" + CODE })
      const res = yield* postJson("/iris/page-signin", { slug: "lexicon-console" })
      expect(res.status).toBe(200)
      const body = (yield* res.json) as any
      expect(body).toEqual({ measured: true, url: `https://heyiris.io/p/lexicon-console#atlas_code=${CODE}`, expiresIn: 90 })
      expect(seen[0].path).toBe("/api/v1/atlas/page-codes")
      expect(seen[0].init?.method).toBe("POST")
      expect(JSON.parse(String(seen[0].init?.body))).toEqual({ page_slug: "lexicon-console" })
    }),
  )

  it.live("mints again on every call — a framed address is never reused", () =>
    Effect.gen(function* () {
      irisApi(200, { success: true, code: CODE, expires_in: 90 })
      yield* postJson("/iris/page-signin", { slug: "lexicon-console" })
      yield* postJson("/iris/page-signin", { slug: "lexicon-console" })
      expect(seen.length).toBe(2)
    }),
  )

  it.live("not signed in is measured: false with a reason, and no address", () =>
    Effect.gen(function* () {
      irisApi(401, { error: "Authentication required" })
      const body = (yield* (yield* postJson("/iris/page-signin", { slug: "lexicon-console" })).json) as any
      expect(body).toEqual({ measured: false, reason: "not signed in to IRIS", url: null, expiresIn: null })
    }),
  )

  it.live("a malformed slug or code never becomes an address", () =>
    Effect.gen(function* () {
      irisApi(200, { success: true, code: "../../x", expires_in: 90 })
      const bad = (yield* (yield* postJson("/iris/page-signin", { slug: "../etc/passwd" })).json) as any
      expect(bad).toMatchObject({ measured: false, url: null })
      expect(seen.length).toBe(0)
      const noCode = (yield* (yield* postJson("/iris/page-signin", { slug: "lexicon-console" })).json) as any
      expect(noCode).toMatchObject({ measured: false, url: null })
    }),
  )
})
