import { NodeHttpServer } from "@effect/platform-node"
import { afterEach, describe, expect } from "bun:test"
import { Context, Effect, Layer, Option } from "effect"
import { HttpBody, HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { MoveSession } from "@opencode-ai/core/control-plane/move-session"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { Installation } from "../../src/installation"
import { ServerAuth } from "../../src/server/auth"
import { RootHttpApi } from "../../src/server/routes/instance/httpapi/api"
import { controlHandlers } from "../../src/server/routes/instance/httpapi/handlers/control"
import { controlPlaneHandlers } from "../../src/server/routes/instance/httpapi/handlers/control-plane"
import { globalHandlers } from "../../src/server/routes/instance/httpapi/handlers/global"
import { irisHandlers } from "../../src/server/routes/instance/httpapi/handlers/iris"
import { authorizationLayer } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { schemaErrorLayer } from "../../src/server/routes/instance/httpapi/middleware/schema-error"
import { testEffect } from "../lib/effect"

// #194575 — POST /iris/invite/claim through the real route. Effect Schema strips undeclared fields
// silently (PR #459), so ok/outcome/message are asserted to arrive. fl-api is the mocked part:
// only its claim URL is answered here; everything else goes to the real fetch.

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

const realFetch = globalThis.fetch
let sent: unknown[] = []
afterEach(() => {
  globalThis.fetch = realFetch
  sent = []
})
/** fl-api's claim endpoint answers `status` with `body`, or the network drops (`"offline"`). */
function flApi(status: number | "offline", body: unknown = {}) {
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    if (!url.includes("/api/v1/usage/invite/claim")) return realFetch(input, init)
    sent.push(JSON.parse(String(init?.body ?? "null")))
    if (status === "offline") throw new Error("getaddrinfo ENOTFOUND")
    return new Response(JSON.stringify(body), { status })
  }) as typeof fetch
}
const claim = (code: string) =>
  Effect.gen(function* () {
    const res = yield* HttpClientRequest.post("/iris/invite/claim").pipe(
      HttpClientRequest.setBody(HttpBody.jsonUnsafe({ code })),
      HttpClient.execute,
    )
    expect(res.status).toBe(200)
    return (yield* res.json) as any
  })

describe("POST /iris/invite/claim (#194575)", () => {
  it.live("attributed: ok, with the reward sentence; the code is sent normalised", () =>
    Effect.gen(function* () {
      flApi(200, { ok: true, outcome: "attributed" })
      expect(yield* claim("  FRIEND42 ")).toEqual({
        ok: true,
        outcome: "attributed",
        message: "You're in — you'll both get +25M tokens after your first agent run.",
      })
      expect(sent).toEqual([{ code: "friend42" }])
    }),
  )

  it.live("each refusal is an outcome and its sentence", () =>
    Effect.gen(function* () {
      const cases: [number, unknown, string, string][] = [
        [200, { ok: false, outcome: "self_invite" }, "self_invite", "That's your own code."],
        [200, { ok: false, outcome: "already_attributed" }, "already_attributed", "This account already used an invite."],
        [200, { ok: false, outcome: "too_old" }, "too_old", "Invite codes work in your first 14 days."],
        [422, { ok: false, outcome: "invalid_code" }, "invalid_code", "We couldn't find that code."],
      ]
      for (const [status, body, outcome, message] of cases) {
        flApi(status, body)
        expect(yield* claim("friend42")).toEqual({ ok: false, outcome, message })
      }
    }),
  )

  it.live("a dropped network, an expired sign-in and a server error are sentences too", () =>
    Effect.gen(function* () {
      flApi("offline")
      expect(yield* claim("friend42")).toEqual({
        ok: false,
        outcome: "unreachable",
        message: "Couldn't reach IRIS to check that code. Try again in a moment.",
      })
      flApi(401, { message: "Unauthenticated." })
      expect((yield* claim("friend42")).outcome).toBe("signed_out")
      flApi(500, { message: "Server Error" })
      expect(yield* claim("friend42")).toEqual({
        ok: false,
        outcome: "error",
        message: "That code couldn't be checked right now. Try again later.",
      })
    }),
  )

  it.live("a code that can't be one never reaches fl-api", () =>
    Effect.gen(function* () {
      flApi(200, { ok: true, outcome: "attributed" })
      expect(yield* claim("no!")).toEqual({ ok: false, outcome: "invalid_code", message: "We couldn't find that code." })
      expect(sent).toEqual([])
    }),
  )
})
