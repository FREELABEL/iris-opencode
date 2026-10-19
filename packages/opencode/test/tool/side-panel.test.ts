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
import { Panel } from "@/iris/panel"
import { SidePanelTool } from "../../src/tool/side-panel"
import { MessageID } from "../../src/session/schema"
import type { Tool } from "@/tool/tool"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// #190093 — the agent sees and steers the desktop side panel.

afterEach(async () => {
  Panel.reset()
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

const ctxFor = (sessionID: any): Tool.Context => ({
  sessionID,
  messageID: MessageID.ascending(),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
})

const run = Effect.fn("SidePanelToolTest.run")(function* (args: Tool.InferParameters<typeof SidePanelTool>, ctx: Tool.Context) {
  const info = yield* SidePanelTool
  const tool = yield* info.init()
  return yield* tool.execute(args, ctx)
})

const catalog: Panel.State["catalog"] = [
  { id: "atlas", label: "Atlas", subs: [{ id: "lists", label: "Lists" }, { id: "schemas", label: "Schemas" }] },
  { id: "pages", label: "Genesis", subs: [{ id: "artifacts", label: "Artifacts" }] },
]

/** A pretend desktop: applies show/artifact by reporting where it landed, with the ack. */
function fakeDesktop(session: string) {
  const seen: GlobalEvent[] = []
  const on = (e: GlobalEvent) => {
    if (e.payload?.type !== Panel.COMMAND_EVENT) return
    seen.push(e)
    const { id, command } = e.payload.properties
    if (e.payload.properties.session !== session) return
    const s: Panel.State = { session, open: true, tab: "iris", catalog, ack: id }
    if (command.action === "show") Object.assign(s, { surface: command.surface, sub: command.sub })
    if (command.action === "artifact") Object.assign(s, { surface: "pages", sub: "artifacts", artifact: command.id })
    queueMicrotask(() => Panel.report(s))
  }
  GlobalBus.on("event", on)
  return { seen, stop: () => GlobalBus.off("event", on) }
}

describe("side_panel tool", () => {
  it.instance("is named side_panel", () =>
    Effect.gen(function* () {
      const info = yield* SidePanelTool
      expect(info.id).toBe("side_panel")
    }),
  )

  it.instance("state with no desktop says so plainly", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const s = yield* sessions.create({ title: "desk" })
      const r = yield* run({ action: "state" }, ctxFor(s.id))
      expect(r.metadata.answered).toBe(false)
      expect(r.output).toContain("No desktop panel has reported")
    }),
  )

  it.instance("a subagent steers the ROOT session's panel, and gets the desktop's answer back", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const parent = yield* sessions.create({ title: "desk" })
      const child = yield* sessions.create({ parentID: parent.id, title: "research" })
      Panel.report({ session: String(parent.id), open: false, catalog })
      const desk = fakeDesktop(String(parent.id))
      try {
        // A label, not an id — resolved through the catalog the desktop reported.
        const r = yield* run({ action: "show", surface: "Atlas", sub: "Schemas" }, ctxFor(child.id))
        expect(desk.seen).toHaveLength(1)
        expect(desk.seen[0].payload.properties).toMatchObject({
          session: String(parent.id),
          command: { action: "show", surface: "atlas", sub: "schemas" },
        })
        expect(r.metadata.answered).toBe(true)
        expect(r.output).toContain("product: Atlas › Schemas")

        const st = yield* run({ action: "state" }, ctxFor(child.id))
        expect(st.output).toContain("atlas (Atlas): lists, schemas")
      } finally {
        desk.stop()
      }
    }),
  )

  it.instance("an unknown view is refused before anything is sent", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const s = yield* sessions.create({ title: "desk" })
      Panel.report({ session: String(s.id), open: true, catalog })
      const desk = fakeDesktop(String(s.id))
      try {
        const r = yield* run({ action: "show", surface: "atlas", sub: "graph" }, ctxFor(s.id))
        expect(r.metadata.refused).toContain("lists, schemas")
        expect(desk.seen).toHaveLength(0)
      } finally {
        desk.stop()
      }
    }),
  )

  it.instance("artifact opens Genesis › Artifacts on it", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const s = yield* sessions.create({ title: "desk" })
      const desk = fakeDesktop(String(s.id))
      try {
        const r = yield* run({ action: "artifact", id: "a_123" }, ctxFor(s.id))
        expect(r.output).toContain("artifact selected: a_123")
        expect(r.output).toContain("product: Genesis › Artifacts")
      } finally {
        desk.stop()
      }
    }),
  )
})
