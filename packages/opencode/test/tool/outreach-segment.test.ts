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
import { readDraft, resetDrafts, SegmentIO } from "@/iris/segments"
import {
  describeBreakdown,
  outreachShowCommand,
  OutreachShowTool,
  SegmentAddFilterTool,
  SegmentFindTool,
  SegmentPreviewTool,
  SegmentRemoveFilterTool,
  SegmentSaveTool,
} from "../../src/tool/outreach-segment"
import { MessageID } from "../../src/session/schema"
import type { Tool } from "@/tool/tool"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import preview from "../iris/fixtures/fl-api-segment-preview.json"

// #193534 — the agent opens Outreach › Audiences and builds the segment the person watches.

const real = { ...SegmentIO }
type Call = { path: string; method: string; body: any }
let calls: Call[] = []
function serve(answers: Record<string, (c: Call) => unknown>) {
  calls = []
  SegmentIO.fl = async (path, init) => {
    const c = { path, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined }
    calls.push(c)
    const a = answers[`${c.method} ${path}`]
    return a ? new Response(JSON.stringify(a(c))) : new Response(JSON.stringify({ message: "no" }), { status: 500 })
  }
}

afterEach(async () => {
  Object.assign(SegmentIO, real)
  resetDrafts()
  Panel.reset()
  await disposeAllInstances()
})

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([Agent.node, EventV2Bridge.node, Config.node, CrossSpawnSpawner.node, Session.node, SessionProjector.node, Truncate.node, Database.node, RuntimeFlags.node]),
  ),
)

const asks: any[] = []
const ctxFor = (sessionID: any): Tool.Context => ({
  sessionID,
  messageID: MessageID.ascending(),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: (req) => Effect.sync(() => void asks.push(req)),
})

const exec = Effect.fn("OutreachSegmentToolTest.exec")(function* (
  tool: typeof OutreachShowTool | typeof SegmentPreviewTool | typeof SegmentAddFilterTool | typeof SegmentRemoveFilterTool | typeof SegmentSaveTool | typeof SegmentFindTool,
  args: Record<string, unknown>,
  ctx: Tool.Context,
) {
  const info = yield* tool
  const t = yield* info.init()
  return (yield* t.execute(args as never, ctx)) as Tool.ExecuteResult<any>
})

const catalog: Panel.State["catalog"] = [
  { id: "outreach", label: "Outreach", subs: ["today", "campaigns", "scripts", "audiences"].map((id) => ({ id, label: id })) },
]

function fakeDesktop(session: string) {
  const seen: GlobalEvent[] = []
  const on = (e: GlobalEvent) => {
    if (e.payload?.type !== Panel.COMMAND_EVENT) return
    seen.push(e)
    const { id, command } = e.payload.properties
    queueMicrotask(() => Panel.report({ session, open: true, tab: "iris", catalog, ack: id, surface: command.surface, sub: command.sub }))
  }
  GlobalBus.on("event", on)
  return { seen, stop: () => GlobalBus.off("event", on) }
}

describe("outreach_show", () => {
  it.instance("asks the panel for Outreach › the view, through the show command", () =>
    Effect.gen(function* () {
      expect(outreachShowCommand("audiences")).toEqual({ action: "show", surface: "outreach", sub: "audiences" })
      const sessions = yield* Session.Service
      const parent = yield* sessions.create({ title: "desk" })
      const child = yield* sessions.create({ parentID: parent.id, title: "sub" })
      serve({ "GET /api/v1/segments/77": () => ({ data: { id: 77, bloq_id: 38, name: "Roadmap", filters: { source_post: "De9Uw8Ilhne" } } }) })
      const desk = fakeDesktop(String(parent.id))
      try {
        const r = yield* exec(OutreachShowTool, { view: "audiences", segment_id: 77 }, ctxFor(child.id))
        // The ROOT session's panel, the same payload side_panel's show sends.
        expect(desk.seen).toHaveLength(1)
        expect(desk.seen[0].payload.properties).toMatchObject({ session: String(parent.id), command: { action: "show", surface: "outreach", sub: "audiences" } })
        expect(r.metadata.answered).toBe(true)
        expect(r.output).toContain("Board #38 · \"Roadmap\" · segment #77")
        // The segment is in the draft the panel reads.
        expect((yield* Effect.promise(() => readDraft())).data).toMatchObject({ bloq: 38, segment_id: 77, by: "agent" })
      } finally {
        desk.stop()
      }
    }),
  )

  it.instance("with no desktop, says so and changes nothing else", () =>
    Effect.gen(function* () {
      Panel.timing.sendMs = 200
      Panel.timing.resendMs = 100
      try {
        const sessions = yield* Session.Service
        const s = yield* sessions.create({ title: "cli" })
        const r = yield* exec(OutreachShowTool, { view: "today" }, ctxFor(s.id))
        expect(r.metadata.answered).toBe(false)
        expect(r.output).toContain("No IRIS Desktop is connected")
      } finally {
        Panel.timing.sendMs = 12_000
        Panel.timing.resendMs = 3_000
      }
    }),
  )
})

describe("segment tools", () => {
  it.instance("add / remove edit the draft and answer with every filter's count", () =>
    Effect.gen(function* () {
      serve({ "POST /api/v1/bloqs/38/segments/preview": () => preview })
      const ctx = ctxFor("ses_x")
      const none = yield* exec(SegmentPreviewTool, {}, ctx)
      expect(none.output).toContain("pass bloq")
      yield* exec(SegmentAddFilterTool, { key: "source_post", value: "https://www.instagram.com/p/De9Uw8Ilhne/", bloq: 38 }, ctx)
      // No bloq: the draft on screen.
      const r = yield* exec(SegmentAddFilterTool, { key: "comment_contains", value: "roadmap" }, ctx)
      expect(r.output).toContain("1. source_post = De9Uw8Ilhne → 849 of 11,341")
      expect(r.output).toContain("2. comment_contains = roadmap → 788 of 849")
      expect(r.output).toContain("In the segment now: 788")
      expect(calls.at(-1)).toEqual({ path: "/api/v1/bloqs/38/segments/preview", method: "POST", body: { filters: { source_post: "De9Uw8Ilhne", comment_contains: "roadmap" }, page: 1 } })
      const gone = yield* exec(SegmentRemoveFilterTool, { key: "comment_contains" }, ctx)
      expect(gone.title).toContain("Removed comment_contains")
      expect(calls.at(-1)!.body.filters).toEqual({ source_post: "De9Uw8Ilhne" })
      const bad = yield* exec(SegmentAddFilterTool, { key: "followers_min", value: "lots" }, ctx)
      expect(bad.title).toBe("not added")
    }),
  )

  it.instance("save asks the person first, then writes the segment to fl-api", () =>
    Effect.gen(function* () {
      asks.length = 0
      serve({
        "POST /api/v1/bloqs/38/segments/preview": () => preview,
        "POST /api/v1/bloqs/38/segments": (c) => ({ data: { id: 91, bloq_id: 38, ...c.body } }),
      })
      const ctx = ctxFor("ses_x")
      yield* exec(SegmentAddFilterTool, { key: "source_post", value: "De9Uw8Ilhne", bloq: 38 }, ctx)
      const r = yield* exec(SegmentSaveTool, { name: "Roadmap commenters" }, ctx)
      expect(asks).toHaveLength(1)
      expect(asks[0]).toMatchObject({ permission: "segment_save", metadata: { bloq: 38, name: "Roadmap commenters" } })
      expect(calls.find((c) => c.method === "POST" && c.path === "/api/v1/bloqs/38/segments")!.body).toEqual({ name: "Roadmap commenters", filters: { source_post: "De9Uw8Ilhne" } })
      expect(r.title).toContain("Saved as segment #91")
    }),
  )

  it.instance("find asks first, runs the CLI's scrape --write, and puts the post on the draft", () =>
    Effect.gen(function* () {
      asks.length = 0
      serve({ "POST /api/v1/bloqs/38/segments/preview": () => preview })
      const ran: string[][] = []
      SegmentIO.cli = () => "/home/u/.iris/bin/iris"
      SegmentIO.exec = async (_f, args) => {
        ran.push(args)
        return { code: 0, stderr: "", stdout: JSON.stringify({ leads: [1, 2], outcome: { created: [{}], existing: [{}], failed: [] } }) }
      }
      const r = yield* exec(SegmentFindTool, { bloq: 38, post_url: "https://www.instagram.com/p/De9Uw8Ilhne/" }, ctxFor("ses_x"))
      expect(asks[0]).toMatchObject({ permission: "segment_find", metadata: { sends: "nothing" } })
      expect(ran).toEqual([["reachr", "scrape", "38", "--instagram", "https://www.instagram.com/p/De9Uw8Ilhne/", "--write", "--json"]])
      expect(r.output).toContain("Added 1 lead(s) to board #38")
      expect(r.output).toContain("Nothing was sent.")
      expect((yield* Effect.promise(() => readDraft(38))).data!.filters).toEqual([{ key: "source_post", value: "De9Uw8Ilhne" }])
    }),
  )
})

describe("breakdown text", () => {
  it.instance("a demographic filter says known and unknown, never a bare 0", () =>
    Effect.sync(() => {
      const text = describeBreakdown([{ key: "niche_in", value: ["Coach"] }], { total: 3, of: 6050, breakdown: [{ key: "niche_in", matched: 3, known: 4, of: 6050 }], members: { data: [], total: 0, page: 1, last_page: 1 } })
      expect(text).toBe("1. niche_in = Coach → 3 of 4 known · 6,046 unknown")
    }),
  )
})
