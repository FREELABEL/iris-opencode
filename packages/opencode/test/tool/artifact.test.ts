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
import { ArtifactTool, ARTIFACT_EVENT } from "../../src/tool/artifact"
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
