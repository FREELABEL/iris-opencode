import { afterEach, describe, expect } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Exit } from "effect"
import { Agent } from "../../src/agent/agent"
import { Config } from "@/config/config"
import { Truncate } from "@/tool/truncate"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { AtlasArtifactTool } from "../../src/tool/atlas-artifact"
import { MessageID, SessionID } from "../../src/session/schema"
import type { Tool } from "@/tool/tool"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// #187717 — Atlas › Artifacts. The tool SHOWS a published note; it refuses anything else.

const realFetch = globalThis.fetch
afterEach(async () => {
  globalThis.fetch = realFetch
  await disposeAllInstances()
})

const it = testEffect(
  LayerNode.compile(LayerNode.group([Agent.node, Config.node, Truncate.node, Database.node, RuntimeFlags.node])),
)

const UUID = "17ac82c8-ade9-4384-9311-9d48a0930f2f"
const ctx: Tool.Context = {
  sessionID: SessionID.make("ses_atlas_test"),
  messageID: MessageID.ascending(),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const serve = (status: number, html = "") => {
  const seen: string[] = []
  globalThis.fetch = (async (input: any) => {
    seen.push(String(input))
    return new Response(html, { status })
  }) as typeof fetch
  return seen
}

const run = (args: Tool.InferParameters<typeof AtlasArtifactTool>) =>
  Effect.gen(function* () {
    const tool = yield* (yield* AtlasArtifactTool).init()
    return yield* tool.execute(args, ctx)
  })

describe("atlas_artifact", () => {
  it.instance("is named atlas_artifact and says it does not publish", () =>
    Effect.gen(function* () {
      const info = yield* AtlasArtifactTool
      expect(info.id).toBe("atlas_artifact")
      const tool = yield* info.init()
      expect(tool.description).toContain("does NOT publish")
      expect(tool.description).toContain("heyiris.io/n/<uuid>")
    }),
  )

  it.instance("a live note returns the canonical url and the note's own title for the card", () =>
    Effect.gen(function* () {
      const seen = serve(200, `<title inertia>EPIC — Atlas › Artifacts</title>`)
      const r = yield* run({ url: `https://heyiris.io/n/${UUID.toUpperCase()}?ref=x`, summary: " the plan " })
      expect(seen).toEqual([`https://heyiris.io/n/${UUID}`])
      expect(r.metadata).toMatchObject({ url: `https://heyiris.io/n/${UUID}`, title: "EPIC — Atlas › Artifacts", summary: "the plan" })
    }),
  )

  it.instance("the note's own title wins over one the model supplies", () =>
    Effect.gen(function* () {
      serve(200, `<title>The note</title>`)
      const r = yield* run({ url: `https://heyiris.io/n/${UUID}`, title: "Epic for this Feature" })
      expect(r.metadata.title).toBe("The note")
    }),
  )

  it.instance("the model's title is used only when the page has none", () =>
    Effect.gen(function* () {
      serve(200, `<html><body>no title</body></html>`)
      const r = yield* run({ url: `https://heyiris.io/n/${UUID}`, title: "Mine" })
      expect(r.metadata.title).toBe("Mine")
    }),
  )

  it.instance("a note that 404s is refused, not drawn as a card", () =>
    Effect.gen(function* () {
      serve(404)
      const exit = yield* Effect.exit(run({ url: `https://heyiris.io/n/${UUID}` }))
      expect(Exit.isFailure(exit)).toBe(true)
      expect(String(Exit.isFailure(exit) ? exit.cause : "")).toContain("HTTP 404")
    }),
  )

  it.instance("a non-note URL is refused before anything is fetched", () =>
    Effect.gen(function* () {
      const seen = serve(200)
      const exit = yield* Effect.exit(run({ url: `https://evil.example/n/${UUID}` }))
      expect(Exit.isFailure(exit)).toBe(true)
      expect(seen).toEqual([])
    }),
  )
})
