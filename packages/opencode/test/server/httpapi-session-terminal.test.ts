import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { afterEach, describe, expect } from "bun:test"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { Cause, Config, Effect, Exit, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse, HttpRouter, HttpServer } from "effect/unstable/http"
import { layerWebSocketConstructorGlobal } from "effect/unstable/socket/Socket"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { registerAdapter } from "../../src/control-plane/adapters"
import type { WorkspaceAdapter } from "../../src/control-plane/types"
import { Workspace } from "../../src/control-plane/workspace"

import { InstanceBootstrap as InstanceBootstrapService } from "../../src/project/bootstrap-service"
import { InstanceStore } from "../../src/project/instance-store"
import { Project } from "../../src/project/project"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import * as HttpSessionError from "../../src/server/routes/instance/httpapi/handlers/session-errors"
import { ExperimentalPaths } from "../../src/server/routes/instance/httpapi/groups/experimental"
import { SessionPaths } from "../../src/server/routes/instance/httpapi/groups/session"
import { Session } from "@/session/session"
import { MessageID, PartID, SessionID, type SessionID as SessionIDType } from "../../src/session/schema"
import { Database } from "@opencode-ai/core/database/database"
import { SessionInputTable, SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import * as DateTime from "effect/DateTime"
import { eq } from "drizzle-orm"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, provideInstanceEffect, TestInstance, tmpdirScoped } from "../fixture/fixture"
import { TestLLMServer } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"
import { pollWithTimeout, testEffect } from "../lib/effect"

const originalWorkspaces = Flag.OPENCODE_EXPERIMENTAL_WORKSPACES
const noopBootstrapLayer = Layer.succeed(
  InstanceBootstrapService.Service,
  InstanceBootstrapService.Service.of({ run: Effect.void }),
)
const appLayer = AppNodeBuilder.build(
  LayerNode.group([InstanceStore.node, Project.node, Session.node, Workspace.node, Database.node, Ripgrep.node]),
  [[InstanceStore.bootstrapNode, noopBootstrapLayer]],
)
const servedRoutes: Layer.Layer<never, Config.ConfigError, HttpServer.HttpServer> = HttpRouter.serve(
  HttpApiApp.routes,
  {
    disableListenLog: true,
    disableLogger: true,
  },
)
const httpApiLayer = servedRoutes.pipe(
  Layer.provide(layerWebSocketConstructorGlobal),
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(NodeServices.layer),
)
const it = testEffect(Layer.mergeAll(appLayer, httpApiLayer))

function pathFor(path: string, params: Record<string, string>) {
  return Object.entries(params).reduce((result, [key, value]) => result.replace(`:${key}`, value), path)
}

function createSession(input?: Session.CreateInput) {
  return Session.use.create(input)
}

function request(path: string, init?: RequestInit) {
  const url = new URL(path, "http://localhost")
  return HttpClientRequest.fromWeb(new Request(url, init)).pipe(
    HttpClientRequest.setUrl(url.pathname),
    HttpClient.execute,
  )
}

function json<T>(response: HttpClientResponse.HttpClientResponse) {
  if (response.status !== 200) return response.text.pipe(Effect.flatMap((text) => Effect.die(new Error(text))))
  return response.json.pipe(Effect.map((value) => value as T))
}

function responseJson(response: HttpClientResponse.HttpClientResponse) {
  return response.json
}

function requestJson<T>(path: string, init?: RequestInit) {
  return request(path, init).pipe(Effect.flatMap(json<T>))
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

type Read = { status: string; output: string; next: number; exitCode: number | null; truncated: boolean }

const readUntilDone = (sessionID: string, runID: string, headers: Record<string, string>) =>
  Effect.gen(function* () {
    let output = ""
    let from = 0
    const final = yield* pollWithTimeout(
      Effect.gen(function* () {
        const read = yield* requestJson<Read>(
          `${pathFor(SessionPaths.terminalRead, { sessionID, runID })}?from=${from}`,
          { headers },
        )
        output += read.output
        from = read.next
        return read.status === "running" ? undefined : read
      }),
      "terminal run did not finish",
      "20 seconds",
    )
    return { ...final, output }
  })

describe("session terminal mode (#190530)", () => {
  it.instance(
    "runs a command in the session directory, keeps the exit code, and writes nothing to the session",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory, "content-type": "application/json" }
        const session = yield* createSession({ title: "terminal" })

        const started = yield* requestJson<{ id: string }>(pathFor(SessionPaths.terminalStart, { sessionID: session.id }), {
          method: "POST",
          headers,
          body: JSON.stringify({ command: "pwd; echo out; echo err 1>&2; exit 3" }),
        })
        const done = yield* readUntilDone(session.id, started.id, headers)
        expect(done.status).toBe("exited")
        expect(done.exitCode).toBe(3)
        expect(done.output).toContain("out")
        expect(done.output).toContain("err")
        expect(done.output).toContain(test.directory)

        const messages = yield* requestJson<unknown[]>(pathFor(SessionPaths.messages, { sessionID: session.id }), { headers })
        expect(messages).toEqual([])
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "cancel stops a running command and the run says so",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory, "content-type": "application/json" }
        const session = yield* createSession({ title: "terminal cancel" })
        const started = yield* requestJson<{ id: string }>(pathFor(SessionPaths.terminalStart, { sessionID: session.id }), {
          method: "POST",
          headers,
          body: JSON.stringify({ command: "echo begin; sleep 30; echo never" }),
        })
        yield* pollWithTimeout(
          requestJson<Read>(pathFor(SessionPaths.terminalRead, { sessionID: session.id, runID: started.id }), { headers }).pipe(
            Effect.map((r) => (r.output.includes("begin") ? r : undefined)),
          ),
          "command never started",
          "10 seconds",
        )
        const cancel = yield* requestJson<{ cancelled: boolean }>(
          pathFor(SessionPaths.terminalCancel, { sessionID: session.id, runID: started.id }),
          { method: "POST", headers },
        )
        expect(cancel.cancelled).toBe(true)
        const done = yield* readUntilDone(session.id, started.id, headers)
        expect(done.status).toBe("cancelled")
        expect(done.output).not.toContain("never")
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "an unknown run is a 404, and another session cannot read a run",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory, "content-type": "application/json" }
        const a = yield* createSession({ title: "a" })
        const b = yield* createSession({ title: "b" })
        const started = yield* requestJson<{ id: string }>(pathFor(SessionPaths.terminalStart, { sessionID: a.id }), {
          method: "POST",
          headers,
          body: JSON.stringify({ command: "true" }),
        })
        const missing = yield* request(pathFor(SessionPaths.terminalRead, { sessionID: a.id, runID: "nope" }), { headers })
        expect(missing.status).toBe(404)
        const other = yield* request(pathFor(SessionPaths.terminalRead, { sessionID: b.id, runID: started.id }), { headers })
        expect(other.status).toBe(404)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )
})
