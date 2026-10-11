import { afterEach, describe, expect } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Effect } from "effect"
import { Agent } from "../../src/agent/agent"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Config } from "@/config/config"
import { Session } from "@/session/session"
import { Truncate } from "@/tool/truncate"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { Artifacts } from "@/iris/artifacts"
import { GenesisArtifactTool as ArtifactTool, ARTIFACT_EVENT } from "../../src/tool/genesis-artifact"
import { MessageID } from "../../src/session/schema"
import type { Tool } from "@/tool/tool"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// #186510 — the shared Artifacts pane. Two agents in one desktop session: the parent (build) and
// a subagent (researcher) in its own child session. Each must see the other's writes, attributed.

afterEach(async () => {
  await disposeAllInstances()
})

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Agent.node,
      EventV2Bridge.node,
      Config.node,
      CrossSpawnSpawner.node,
      Session.node,
      SessionProjector.node,
      Truncate.node,
      Database.node,
      RuntimeFlags.node,
    ]),
  ),
)

const ctxFor = (sessionID: any, agent: string): Tool.Context => ({
  sessionID,
  messageID: MessageID.ascending(),
  callID: "",
  agent,
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
})

const run = Effect.fn("ArtifactToolTest.run")(function* (
  args: Tool.InferParameters<typeof ArtifactTool>,
  ctx: Tool.Context,
) {
  const info = yield* ArtifactTool
  const tool = yield* info.init()
  return yield* tool.execute(args, ctx)
})

describe("tool.artifact — the shared pane", () => {
  it.instance("a subagent's artifact lands in the ROOT session, attributed, and the parent sees it", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const sessions = yield* Session.Service
      const parent = yield* sessions.create({ title: "desk" })
      const child = yield* sessions.create({ parentID: parent.id, title: "research" })

      const events: GlobalEvent[] = []
      const listen = (e: GlobalEvent) => e.payload?.type === ARTIFACT_EVENT && events.push(e)
      GlobalBus.on("event", listen)
      try {
        const made = yield* run(
          { action: "create", title: "Findings", kind: "markdown", content: "# found it" },
          ctxFor(child.id, "researcher"),
        )
        const id = made.metadata.id!

        // On disk under the PARENT's session, with the subagent as author.
        const where = Artifacts.rootFor(test.directory)
        const onDisk = Artifacts.list(where.dir, parent.id)
        expect(onDisk.map((m) => m.id)).toEqual([id])
        expect(onDisk[0].author).toEqual({ agent: "researcher", session: child.id })
        expect(Artifacts.list(where.dir, child.id)).toEqual([])

        // The parent agent sees it through the tool…
        const listed = yield* run({ action: "list" }, ctxFor(parent.id, "build"))
        expect(listed.output).toContain(id)
        expect(listed.output).toContain("by researcher")

        // …writes its own, which the SUBAGENT then sees.
        yield* run({ action: "create", title: "Plan", kind: "markdown", content: "# plan" }, ctxFor(parent.id, "build"))
        const fromChild = yield* run({ action: "list" }, ctxFor(child.id, "researcher"))
        expect(fromChild.output).toContain("by build")
        expect(fromChild.metadata.count).toBe(2)

        // Every write was announced, keyed to the root session — that is what the pane refetches on.
        expect(events).toHaveLength(2)
        expect(events.every((e) => e.payload.properties.session === parent.id && e.directory === test.directory)).toBe(
          true,
        )
      } finally {
        GlobalBus.off("event", listen)
      }
    }),
  )

  it.instance("an update against a stale revision is refused and says who wrote since", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const parent = yield* sessions.create({ title: "desk" })
      const child = yield* sessions.create({ parentID: parent.id, title: "research" })

      const made = yield* run(
        { action: "create", title: "Table", kind: "csv", content: "a\n1" },
        ctxFor(parent.id, "build"),
      )
      const id = made.metadata.id!
      yield* run({ action: "update", id, content: "a\n2", base_revision: 1 }, ctxFor(child.id, "researcher"))
      const stale = yield* run({ action: "update", id, content: "a\n3", base_revision: 1 }, ctxFor(parent.id, "build"))

      expect(stale.metadata.conflict).toBe(true)
      expect(stale.output).toContain("researcher")
      const now = yield* run({ action: "read", id }, ctxFor(parent.id, "build"))
      expect(now.output).toContain("a\n2")
      expect(now.output).toContain("revision: 2")
    }),
  )
})

describe("genesis_artifact — scoped, and the card has what it needs", () => {
  it.instance("is named genesis_artifact and says not to use it for tasks", () =>
    Effect.gen(function* () {
      const info = yield* ArtifactTool
      expect(info.id).toBe("genesis_artifact")
      const tool = yield* info.init()
      expect(tool.description).toContain("Do NOT use it to carry out a task")
      expect(tool.description).toContain("iris genesis publish-html")
    }),
  )

  it.instance("a create returns title, kind, session and created:true for the chat card", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const parent = yield* sessions.create({ title: "desk" })
      const r = yield* run(
        { action: "create", title: "All Hallows", kind: "html", content: "<h1>hi</h1>" },
        ctxFor(parent.id, "build"),
      )
      expect(r.metadata).toMatchObject({
        title: "All Hallows",
        kind: "html",
        session: parent.id,
        created: true,
        revision: 1,
      })
    }),
  )
})

// #188930 — data by reference: a page bound to an earlier tool call, drawn inside the chat.
describe("genesis_artifact — bindings and inline display", () => {
  /** A conversation whose assistant turn already ran a tool that returned three plans. */
  const withCall = (
    callID: string,
    status: "completed" | "running" = "completed",
    output = '{"data":[{"plan":"Starter","price":19},{"plan":"Team","price":29},{"plan":"Studio","price":49}]}',
  ) =>
    [
      {
        info: { id: "msg_a", role: "assistant" },
        parts: [
          {
            type: "tool",
            callID,
            tool: "atlas_datasets",
            state:
              status === "completed"
                ? { status, input: {}, output, title: "plans", metadata: {}, time: { start: 1, end: 2 } }
                : { status, input: {}, time: { start: 1 } },
          },
        ],
      },
    ] as any

  const page = `<html><head><title>Plans</title></head><body><ul id=l></ul><script>document.getElementById('l').innerHTML=iris.data.rows('plans').map(function(r){return '<li>'+r.plan+' '+r.price+'</li>'}).join('')</script></body></html>`

  it.instance("binds a finished tool call: the block is written into the artifact and handed to the card", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const sessions = yield* Session.Service
      const s = yield* sessions.create({ title: "desk" })
      const r = yield* run(
        {
          action: "create",
          title: "Plans",
          kind: "html",
          content: page,
          display: "inline",
          bindings: { plans: { call_id: "call_1" } },
        },
        { ...ctxFor(s.id, "build"), messages: withCall("call_1") },
      )
      expect(r.metadata.display).toBe("inline")
      expect(r.metadata.bindings?.plans.data).toHaveLength(3)
      expect(r.metadata.bindings?.plans.meta.source).toBe("call:atlas_datasets:call_1")
      expect(r.output).toContain("plans = 3 rows")
      expect(r.output).toContain("drawn live in the chat message")
      const onDisk = Artifacts.read(Artifacts.rootFor(test.directory).dir, s.id, r.metadata.id!)!
      expect(onDisk.content).toContain('id="iris-bindings"')
      expect(onDisk.content).toContain('"plan":"Studio"')
      // the block comes before the page's own script, which reads it synchronously
      expect(onDisk.content.indexOf("iris-bindings")).toBeLessThan(onDisk.content.indexOf("getElementById('l')"))
    }),
  )

  it.instance("an unknown call id FAILS the call — never an empty frame", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const s = yield* sessions.create({ title: "desk" })
      const exit = yield* Effect.exit(
        run(
          {
            action: "create",
            title: "Plans",
            kind: "html",
            content: page,
            bindings: { plans: { call_id: "call_missing" } },
          },
          { ...ctxFor(s.id, "build"), messages: withCall("call_1") },
        ),
      )
      expect(exit._tag).toBe("Failure")
      expect(String((exit as any).cause)).toContain("no tool call call_missing")
    }),
  )

  it.instance("a call that has not finished is refused, by name", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const s = yield* sessions.create({ title: "desk" })
      const exit = yield* Effect.exit(
        run(
          { action: "create", title: "Plans", kind: "html", content: page, bindings: { plans: { call_id: "call_1" } } },
          { ...ctxFor(s.id, "build"), messages: withCall("call_1", "running") },
        ),
      )
      expect(String((exit as any).cause)).toContain("is running, not completed")
    }),
  )

  it.instance("bindings are refused on a non-html artifact, and call_id + dataset together", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const s = yield* sessions.create({ title: "desk" })
      const md = yield* Effect.exit(
        run(
          { action: "create", title: "x", kind: "markdown", content: "# x", bindings: { a: { call_id: "call_1" } } },
          {
            ...ctxFor(s.id, "build"),
            messages: withCall("call_1"),
          },
        ),
      )
      expect(String((md as any).cause)).toContain("bindings are for html artifacts")
      const both = yield* Effect.exit(
        run(
          {
            action: "create",
            title: "x",
            kind: "html",
            content: page,
            bindings: { a: { call_id: "call_1", dataset: "d" } },
          },
          {
            ...ctxFor(s.id, "build"),
            messages: withCall("call_1"),
          },
        ),
      )
      expect(String((both as any).cause)).toContain("exactly one of call_id or dataset")
    }),
  )

  it.instance("a styling update that carries the read-back content keeps its data", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const sessions = yield* Session.Service
      const s = yield* sessions.create({ title: "desk" })
      const ctx = { ...ctxFor(s.id, "build"), messages: withCall("call_1") }
      const made = yield* run(
        { action: "create", title: "Plans", kind: "html", content: page, bindings: { plans: { call_id: "call_1" } } },
        ctx,
      )
      const where = Artifacts.rootFor(test.directory).dir
      const back = Artifacts.read(where, s.id, made.metadata.id!)!.content
      yield* run(
        {
          action: "update",
          id: made.metadata.id!,
          content: back.replace("<title>", "<style>li{color:red}</style><title>"),
          base_revision: 1,
        },
        ctx,
      )
      const now = Artifacts.read(where, s.id, made.metadata.id!)!.content
      expect(now).toContain("li{color:red}")
      expect(now.match(/id="iris-bindings"/g)).toHaveLength(1)
      expect(now).toContain('"plan":"Studio"')
    }),
  )

  it.instance("default display is card — existing callers are unchanged", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const s = yield* sessions.create({ title: "desk" })
      const r = yield* run({ action: "create", title: "x", kind: "html", content: "<h1>x</h1>" }, ctxFor(s.id, "build"))
      expect(r.metadata.display).toBe("card")
      expect(r.metadata.bindings).toBeUndefined()
    }),
  )
})

// #188930 gap #1 — the answer built from fixed parts, not hand-written markup.
describe("genesis_artifact — components", () => {
  const plansCall = [
    {
      info: { id: "msg_a", role: "assistant" },
      parts: [
        {
          type: "tool",
          callID: "call_p",
          tool: "atlas_datasets",
          state: {
            status: "completed",
            input: {},
            output: '[{"plan":"Starter","price":19},{"plan":"Team","price":29}]',
            title: "",
            metadata: {},
            time: { start: 1, end: 2 },
          },
        },
      ],
    },
  ] as any

  it.instance("a components answer is stored as an html page: the runtime, the spec and the bound data", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const sessions = yield* Session.Service
      const s = yield* sessions.create({ title: "desk" })
      const r = yield* run(
        {
          action: "create",
          title: "Plans",
          display: "inline",
          components: [
            { type: "Stat", props: { label: "Plans", value: { from: "plans", field: "price", agg: "count" } } },
            { type: "Table", props: { from: "plans", columns: ["plan", "price"] } },
          ],
          bindings: { plans: { call_id: "call_p" } },
        },
        { ...ctxFor(s.id, "build"), messages: plansCall },
      )
      expect(r.metadata.kind).toBe("html")
      const doc = Artifacts.read(Artifacts.rootFor(test.directory).dir, s.id, r.metadata.id!)!.content
      expect(doc).toContain("window.__IRIS_UI__=")
      expect(doc).toContain('id="iris-bindings"')
      expect(doc).toContain('"plan":"Team"')
      expect(doc.indexOf("iris-bindings")).toBeLessThan(doc.indexOf("window.__IRIS_UI__="))
    }),
  )

  it.instance("an invalid spec fails the call with what is allowed — nothing is written", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const sessions = yield* Session.Service
      const s = yield* sessions.create({ title: "desk" })
      const exit = yield* Effect.exit(
        run(
          {
            action: "create",
            title: "x",
            components: [{ type: "Table", props: { from: "nope" } }],
            bindings: { plans: { call_id: "call_p" } },
          },
          { ...ctxFor(s.id, "build"), messages: plansCall },
        ),
      )
      expect(String((exit as any).cause)).toContain(
        'components: components[0]: from "nope" is not a binding. Bound: plans',
      )
      expect(Artifacts.list(Artifacts.rootFor(test.directory).dir, s.id)).toEqual([])
    }),
  )

  it.instance("content and components together is refused", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const s = yield* sessions.create({ title: "desk" })
      const exit = yield* Effect.exit(
        run(
          {
            action: "create",
            title: "x",
            kind: "html",
            content: "<p>",
            components: [{ type: "Text", props: { text: "x" } }],
          },
          ctxFor(s.id, "build"),
        ),
      )
      expect(String((exit as any).cause)).toContain("content OR components")
    }),
  )

  it.instance("the description lists the catalog, so the model knows its parts", () =>
    Effect.gen(function* () {
      const info = yield* ArtifactTool
      const tool = yield* info.init()
      const schema = JSON.stringify(tool.parameters)
      for (const t of ["Stat", "Table", "BarChart", "Slider"]) expect(schema).toContain(t)
    }),
  )
})
