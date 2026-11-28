import { NodeHttpServer } from "@effect/platform-node"
import { afterEach, beforeEach, describe, expect } from "bun:test"
import { Context, Effect, Layer, Option } from "effect"
import { HttpBody, HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { MoveSession } from "@opencode-ai/core/control-plane/move-session"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { Installation } from "../../src/installation"
import { runDeps } from "../../src/iris/cli-run"
import { ServerAuth } from "../../src/server/auth"
import { RootHttpApi } from "../../src/server/routes/instance/httpapi/api"
import { controlHandlers } from "../../src/server/routes/instance/httpapi/handlers/control"
import { controlPlaneHandlers } from "../../src/server/routes/instance/httpapi/handlers/control-plane"
import { globalHandlers } from "../../src/server/routes/instance/httpapi/handlers/global"
import { irisHandlers } from "../../src/server/routes/instance/httpapi/handlers/iris"
import { authorizationLayer } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { schemaErrorLayer } from "../../src/server/routes/instance/httpapi/middleware/schema-error"
import { testEffect } from "../lib/effect"

// #194581 — POST /iris/run: a pane's button runs the command. Nothing real runs here: exec is stubbed.

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

const saved = { ...runDeps }
let calls: { file: string; args: string[] }[] = []
beforeEach(() => {
  calls = []
  runDeps.cli = () => "/stub/.iris/bin/iris"
  runDeps.exec = async (file, args) => {
    calls.push({ file, args })
    return { code: 0, stdout: "2 drives\n", stderr: "", truncated: false, timedOut: false }
  }
})
afterEach(() => Object.assign(runDeps, saved))

const post = (body: unknown) =>
  HttpClientRequest.post("/iris/run").pipe(HttpClientRequest.setBody(HttpBody.jsonUnsafe(body)), HttpClient.execute)

describe("POST /iris/run", () => {
  it.live("a read runs at once, as argv", () =>
    Effect.gen(function* () {
      const response = yield* post({ argv: ["drives", "list"] })
      expect(response.status).toBe(200)
      expect(yield* response.json).toMatchObject({ ran: true, kind: "read", code: 0, stdout: "2 drives\n" })
      expect(calls).toEqual([{ file: "/stub/.iris/bin/iris", args: ["drives", "list"] }])
    }),
  )

  it.live("an unconfirmed write does not run", () =>
    Effect.gen(function* () {
      const response = yield* post({ argv: ["hive", "connect"] })
      expect(yield* response.json).toEqual({ ran: false, kind: "write", needsConfirm: true })
      expect(calls).toHaveLength(0)
    }),
  )

  it.live("a confirmed write runs", () =>
    Effect.gen(function* () {
      const response = yield* post({ argv: ["drives", "scan", "/Volumes/A B"], confirmed: true })
      expect(yield* response.json).toMatchObject({ ran: true, kind: "write" })
      expect(calls[0]?.args).toEqual(["drives", "scan", "/Volumes/A B"])
    }),
  )

  it.live("a server command is refused, confirmed or not", () =>
    Effect.gen(function* () {
      const response = yield* post({ argv: ["serve"], confirmed: true })
      const body = (yield* response.json) as { ran: boolean; refused?: string }
      expect(body.ran).toBe(false)
      expect(body.refused).toContain("serve")
      expect(calls).toHaveLength(0)
    }),
  )

  it.live("argv must be an array of strings", () =>
    Effect.gen(function* () {
      const response = yield* post({ argv: "drives list; rm -rf ~" })
      expect(response.status).toBe(400)
      expect(calls).toHaveLength(0)
    }),
  )
})
