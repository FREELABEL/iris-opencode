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
import { HiveSim } from "../../src/iris/hive-sim"
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
  HiveSim.reset()
  await disposeAllInstances()
  await resetDatabase()
})

type StepRead = { id: string; status: string; output: string; next: number; reason: string | null }
type Read = {
  id: string
  status: string
  reason: string | null
  steps: StepRead[]
  feed: { progress?: { done: number; total: number }; inputs?: unknown; tables: { title: string; rows: string[][] }[]; flips: { text: string }[]; ignored: number }
  header: string[]
}

const FIXTURES = path.join(import.meta.dir, "..", "iris", "fixtures", "hive-sim")

// #194084 — the playbook's steps through the real route, against the fixture engines.
const readUntil = (sessionID: string, runID: string, headers: Record<string, string>, done: (r: Read) => boolean) =>
  Effect.gen(function* () {
    const outputs: Record<string, string> = {}
    let from = ""
    return yield* pollWithTimeout(
      Effect.gen(function* () {
        const read = yield* requestJson<Read>(
          `${pathFor(SessionPaths.hiveSimRead, { sessionID, runID })}${from ? `?from=${from}` : ""}`,
          { headers },
        )
        for (const s of read.steps) outputs[s.id] = (outputs[s.id] ?? "") + s.output
        from = read.steps.map((s) => s.next).join(",")
        return done(read) ? { ...read, outputs } : undefined
      }),
      "simulation did not reach the expected state",
      "30 seconds",
    )
  })

describe("session hive simulations (#194084)", () => {
  const saved = { ...process.env }
  afterEach(() => {
    for (const k of ["HIVE_SIM_DEMO_SECONDS", "HIVE_SIM_DEMO_BAD", "HIVE_SIM_DEMO_NOISE"]) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  it.instance(
    "runs an engine that writes the feed: steps pass, the feed lands, bad feed lines are ignored",
    () =>
      Effect.gen(function* () {
        process.env.HIVE_SIM_DEMO_SECONDS = "0.4"
        process.env.HIVE_SIM_DEMO_NOISE = "1"
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory, "content-type": "application/json" }
        const session = yield* createSession({ title: "sim" })
        const started = yield* requestJson<{ id: string }>(pathFor(SessionPaths.hiveSimStart, { sessionID: session.id }), {
          method: "POST",
          headers,
          body: JSON.stringify({ engine: path.join(FIXTURES, "demo-engine.py"), worlds: 200, cohort: 50, days: 14 }),
        })
        const done = yield* readUntil(session.id, started.id, headers, (r) => r.status !== "running")
        expect(done.status).toBe("passed")
        expect(done.steps.map((s) => s.status)).toEqual(["passed", "passed", "passed", "passed", "passed"])
        expect(done.outputs.engine).toContain("sha256: ")
        expect(done.outputs["tie-out"]).toContain("TIE-OUT PASSED")
        expect(done.outputs.simulate).toContain("simulated 200 / 200 worlds")
        expect(done.feed.progress).toEqual({ done: 200, total: 200 })
        expect(done.feed.inputs).toBeDefined()
        expect(done.feed.tables.map((t) => t.title)).toEqual(["Free cap ranking (median world)"])
        expect(done.feed.tables[0].rows[0][1]).not.toBe("…")
        expect(done.feed.flips).toHaveLength(1)
        expect(done.feed.ignored).toBe(3)

        const list = yield* requestJson<{ runs: { id: string; status: string }[] }>(
          pathFor(SessionPaths.hiveSimList, { sessionID: session.id }),
          { headers },
        )
        expect(list.runs.map((r) => r.id)).toEqual([started.id])
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "an engine with no feed still runs: header MEASURED/DRAWN from its text, the flip from its output",
    () =>
      Effect.gen(function* () {
        process.env.HIVE_SIM_DEMO_SECONDS = "0.2"
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory, "content-type": "application/json" }
        const session = yield* createSession({ title: "sim plain" })
        const started = yield* requestJson<{ id: string }>(pathFor(SessionPaths.hiveSimStart, { sessionID: session.id }), {
          method: "POST",
          headers,
          body: JSON.stringify({ engine: path.join(FIXTURES, "plain-engine.py"), refresh: false }),
        })
        const done = yield* readUntil(session.id, started.id, headers, (r) => r.status !== "running")
        expect(done.status).toBe("passed")
        expect(done.header).toEqual(["MEASURED: weekly orders per store | DRAWN: price elasticity"])
        expect(done.feed).toMatchObject({ tables: [], flips: [], ignored: 0 })
        expect(done.feed.progress).toBeUndefined()
        expect(done.outputs.pull).toContain("using the dataset already on disk")
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "bad data stops the run at the tie-out, with the engine's reason",
    () =>
      Effect.gen(function* () {
        process.env.HIVE_SIM_DEMO_BAD = "1"
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory, "content-type": "application/json" }
        const session = yield* createSession({ title: "sim bad" })
        const started = yield* requestJson<{ id: string }>(pathFor(SessionPaths.hiveSimStart, { sessionID: session.id }), {
          method: "POST",
          headers,
          body: JSON.stringify({ engine: path.join(FIXTURES, "demo-engine.py") }),
        })
        const done = yield* readUntil(session.id, started.id, headers, (r) => r.status !== "running")
        expect(done.status).toBe("failed")
        expect(done.steps.map((s) => s.status)).toEqual(["passed", "passed", "failed", "waiting", "waiting"])
        expect(done.steps[2].reason).toContain("user 193: median $4.1930")
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "cancel stops the simulate step and the engine process",
    () =>
      Effect.gen(function* () {
        process.env.HIVE_SIM_DEMO_SECONDS = "30"
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory, "content-type": "application/json" }
        const session = yield* createSession({ title: "sim cancel" })
        const started = yield* requestJson<{ id: string }>(pathFor(SessionPaths.hiveSimStart, { sessionID: session.id }), {
          method: "POST",
          headers,
          body: JSON.stringify({ engine: path.join(FIXTURES, "demo-engine.py"), worlds: 400 }),
        })
        yield* readUntil(session.id, started.id, headers, (r) => !!r.feed.progress)
        const cancel = yield* requestJson<{ cancelled: boolean }>(
          pathFor(SessionPaths.hiveSimCancel, { sessionID: session.id, runID: started.id }),
          { method: "POST", headers },
        )
        expect(cancel.cancelled).toBe(true)
        const done = yield* readUntil(session.id, started.id, headers, (r) => r.status !== "running")
        expect(done.status).toBe("cancelled")
        expect(done.steps.map((s) => s.status)).toEqual(["passed", "passed", "passed", "failed", "waiting"])
        const other = yield* createSession({ title: "other" })
        const missing = yield* request(pathFor(SessionPaths.hiveSimRead, { sessionID: other.id, runID: started.id }), { headers })
        expect(missing.status).toBe(404)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )
})
