import { NodeHttpServer } from "@effect/platform-node"
import { afterEach, beforeEach, describe, expect } from "bun:test"
import { Context, Effect, Layer, Option } from "effect"
import { HttpBody, HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { MoveSession } from "@opencode-ai/core/control-plane/move-session"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { Installation } from "../../src/installation"
import { trackDeps } from "../../src/iris/onboarding"
import { ServerAuth } from "../../src/server/auth"
import { RootHttpApi } from "../../src/server/routes/instance/httpapi/api"
import { controlHandlers } from "../../src/server/routes/instance/httpapi/handlers/control"
import { controlPlaneHandlers } from "../../src/server/routes/instance/httpapi/handlers/control-plane"
import { globalHandlers } from "../../src/server/routes/instance/httpapi/handlers/global"
import { irisHandlers } from "../../src/server/routes/instance/httpapi/handlers/iris"
import { authorizationLayer } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { schemaErrorLayer } from "../../src/server/routes/instance/httpapi/middleware/schema-error"
import { testEffect } from "../lib/effect"

// #191430 — the crash screen's report goes in through the onboarding pipe, with props.

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

const saved = { ...trackDeps }
let sent: Record<string, unknown>[] = []
beforeEach(() => {
  sent = []
  const home = mkdtempSync(path.join(tmpdir(), "iris-track-"))
  trackDeps.env = () => ({})
  trackDeps.home = () => home
  trackDeps.send = async (body) => {
    sent.push(body)
  }
})
afterEach(() => Object.assign(trackDeps, saved))

const post = (body: unknown) =>
  HttpClientRequest.post("/iris/onboarding/track").pipe(HttpClientRequest.setBody(HttpBody.jsonUnsafe(body)), HttpClient.execute)

describe("POST /iris/onboarding/track", () => {
  it.live("accepts a crash report with props and forwards exactly one scrubbed event", () =>
    Effect.gen(function* () {
      const response = yield* post({
        event: "app.crash_screen",
        props: {
          app_version: "1.18.152",
          os: "macos",
          message: "boom at /Users/alex/secret.txt",
          stack: ["when@tauri://localhost/assets/index.js:1:2"],
          prompt: "never forwarded",
        },
      })
      expect(response.status).toBe(200)
      expect(yield* response.json).toEqual({ ok: true })
      yield* Effect.promise(() => new Promise((r) => setTimeout(r, 50)))
      expect(sent.length).toBe(1)
      const props = sent[0].props as Record<string, unknown>
      expect(sent[0].event).toBe("app.crash_screen")
      expect(sent[0].variant).toBe("1.18.152")
      expect(props.message).toBe("boom at <path>")
      expect(props.stack).toEqual(["when@tauri://localhost/assets/index.js:1:2"])
      expect(props.prompt).toBeUndefined()
    }),
  )

  it.live("an onboarding step without props still works", () =>
    Effect.gen(function* () {
      const response = yield* post({ event: "onboarding.working" })
      expect(response.status).toBe(200)
    }),
  )
})
