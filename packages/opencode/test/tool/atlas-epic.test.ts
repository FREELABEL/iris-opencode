import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect } from "effect"
import { Agent } from "../../src/agent/agent"
import { Config } from "@/config/config"
import { Truncate } from "@/tool/truncate"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { AtlasEpicTool } from "../../src/tool/atlas-epic"
import { MessageID, SessionID } from "../../src/session/schema"
import type { Tool } from "@/tool/tool"
import * as platform from "../../src/iris/platform"
import {
  EPIC_LIMITS,
  EPIC_MARKER,
  configuredBloqId,
  itemContent,
  normalizeEpic,
  saveEpic,
  type EpicInput,
} from "../../src/iris/atlas-epic"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const spies: { mockRestore(): void }[] = []
afterEach(async () => {
  while (spies.length) spies.pop()!.mockRestore()
  delete process.env.IRIS_BLOQ_ID
  await disposeAllInstances()
})

const it = testEffect(
  LayerNode.compile(LayerNode.group([Agent.node, Config.node, Truncate.node, Database.node, RuntimeFlags.node])),
)

const ctx: Tool.Context = {
  sessionID: SessionID.make("ses_atlas_epic_test"),
  messageID: MessageID.ascending(),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const PLAN: EpicInput = {
  title: "  Reply to people waiting on me ",
  summary: "2 things ready for you to review. Nothing was sent.",
  lists: [
    {
      title: "Draft replies to people waiting on you",
      source: "Gmail",
      status: "ready",
      label: "2 drafts to review",
      items: [
        {
          title: "Maria Lopez",
          subtitle: "Rescheduling Thursday's cleaning",
          body: "Hi Maria,\nThursday at 3 works.",
          kind: "draft",
          actions: ["send", "edit", "send"],
          ref: { type: "gmail_message", id: "1a11ee985e3dc9b1" },
        },
        { title: "Dev Patel", kind: "draft" },
      ],
    },
    { title: "Overdue invoices", source: "stripe", status: "needs", items: [{ title: "Acme", kind: "alert" }] },
  ],
}

/** A fake fl-api: records every call, answers by route. */
function fakePlatform(opts: { bloqs?: { id: number; name: string }[]; failItems?: boolean; failList?: boolean } = {}) {
  const calls: { path: string; method: string; body?: any }[] = []
  let nextId = 1000
  spies.push(spyOn(platform, "resolveUserId").mockResolvedValue(7))
  spies.push(
    spyOn(platform, "fetchBloqs").mockResolvedValue({ measured: true, data: { bloqs: opts.bloqs ?? [{ id: 42, name: "Plans" }] } }),
  )
  spies.push(
    spyOn(platform, "irisFetch").mockImplementation((async (p: string, _base: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET"
      calls.push({ path: p, method, body: init.body ? JSON.parse(String(init.body)) : undefined })
      const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 })
      if (method === "POST" && /\/bloqs\/\d+\/lists$/.test(p))
        return opts.failList ? new Response(JSON.stringify({ message: "nope" }), { status: 500 }) : ok({ id: 555 })
      if (method === "POST" && /\/lists\/\d+\/items$/.test(p))
        return opts.failItems
          ? new Response(JSON.stringify({ message: "The given data was invalid." }), { status: 422 })
          : ok({ id: nextId++ })
      // fl-api BloqController::store shape — the id is under `bloq`, not at the top.
      if (method === "POST" && /\/user\/7\/bloqs$/.test(p)) return ok({ bloq: { id: 77, name: "Plans" }, lists: [] })
      return ok({})
    }) as any),
  )
  return calls
}

const run = (args: Tool.InferParameters<typeof AtlasEpicTool>) =>
  Effect.gen(function* () {
    const tool = yield* (yield* AtlasEpicTool).init()
    return yield* tool.execute(args, ctx)
  })

describe("normalizeEpic", () => {
  test("trims, dedupes actions, lowercases source, drops unknown enum values", () => {
    const r = normalizeEpic(PLAN)
    if ("error" in r) throw new Error(r.error)
    expect(r.epic.title).toBe("Reply to people waiting on me")
    expect(r.epic.lists[0].source).toBe("gmail")
    expect(r.epic.lists[0].items[0].actions).toEqual(["send", "edit"])
    const odd = normalizeEpic({ title: "x", lists: [{ title: "l", status: "bogus", items: [{ title: "i", kind: "??", actions: ["fly"] }] }] })
    if ("error" in odd) throw new Error(odd.error)
    expect(odd.epic.lists[0].status).toBeUndefined()
    expect(odd.epic.lists[0].items[0].kind).toBeUndefined()
    expect(odd.epic.lists[0].items[0].actions).toBeUndefined()
  })

  test("refuses an empty title and an epic with no titled list", () => {
    expect(normalizeEpic({ title: "   ", lists: [{ title: "a", items: [] }] })).toHaveProperty("error")
    expect(normalizeEpic({ title: "t", lists: [] })).toHaveProperty("error")
    expect(normalizeEpic({ title: "t", lists: [{ title: " ", items: [] }] })).toHaveProperty("error")
  })

  test("caps lists and items and says what it dropped", () => {
    const items = Array.from({ length: 60 }, (_, i) => ({ title: `i${i}` }))
    const lists = Array.from({ length: 15 }, (_, i) => ({ title: `l${i}`, items }))
    const r = normalizeEpic({ title: "big", lists })
    if ("error" in r) throw new Error(r.error)
    expect(r.epic.lists).toHaveLength(EPIC_LIMITS.lists)
    expect(r.epic.lists[0].items).toHaveLength(EPIC_LIMITS.items)
    expect(r.dropped[0]).toContain("3 list(s)")
    expect(r.dropped.some((d) => d.includes("10 item(s)"))).toBe(true)
  })

  test("clips an item title to fl-api's 191-char limit", () => {
    const r = normalizeEpic({ title: "t", lists: [{ title: "l", items: [{ title: "x".repeat(400) }] }] })
    if ("error" in r) throw new Error(r.error)
    expect(r.epic.lists[0].items[0].title.length).toBe(EPIC_LIMITS.title)
  })
})

describe("itemContent", () => {
  test("quotes the draft and carries kind/actions/ref in an invisible marker", () => {
    const r = normalizeEpic(PLAN)
    if ("error" in r) throw new Error(r.error)
    const c = itemContent(r.epic.lists[0], r.epic.lists[0].items[0], 0)
    expect(c).toContain("**Draft replies to people waiting on you** · gmail")
    expect(c).toContain("> Hi Maria,\n> Thursday at 3 works.")
    const marker = c.match(new RegExp(`<!-- ${EPIC_MARKER} (.*) -->`))
    expect(marker).not.toBeNull()
    expect(JSON.parse(marker![1])).toMatchObject({ kind: "draft", ref: { type: "gmail_message", id: "1a11ee985e3dc9b1" } })
  })
})

describe("configuredBloqId", () => {
  test("env wins, then ~/.iris/config.json default_bloq_id", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "epic-cfg-"))
    const cfg = path.join(dir, "config.json")
    writeFileSync(cfg, JSON.stringify({ default_bloq_id: 12 }))
    expect(configuredBloqId(cfg)).toBe(12)
    process.env.IRIS_BLOQ_ID = "99"
    expect(configuredBloqId(cfg)).toBe(99)
    delete process.env.IRIS_BLOQ_ID
    expect(configuredBloqId(path.join(dir, "missing.json"))).toBeUndefined()
  })
})

describe("saveEpic", () => {
  const epicOf = () => {
    const r = normalizeEpic(PLAN)
    if ("error" in r) throw new Error(r.error)
    return r.epic
  }

  test("one list per epic on the Plans board, one item per epic item", async () => {
    const calls = fakePlatform()
    const r = await saveEpic(epicOf(), {})
    expect(r).toMatchObject({ saved: true, bloqId: 42, listIds: [555] })
    expect(r.itemIds?.map((l) => l.length)).toEqual([2, 1])
    const list = calls.find((c) => c.path.endsWith("/bloqs/42/lists"))!
    expect(list.body.name).toBe("Reply to people waiting on me")
    const items = calls.filter((c) => c.path === "/api/v1/user/7/bloqs/42/lists/555/items")
    expect(items).toHaveLength(3)
    expect(items.find((c) => c.body.title === "Maria Lopez")!.body).toMatchObject({
      description: "Rescheduling Thursday's cleaning",
      type: "task",
      status: "todo",
      content_format: "markdown",
    })
  })

  test("creates a Plans board when the user has none", async () => {
    const calls = fakePlatform({ bloqs: [{ id: 1, name: "Other" }] })
    const r = await saveEpic(epicOf(), {})
    expect(r.bloqId).toBe(77)
    expect(calls.some((c) => c.method === "POST" && c.path === "/api/v1/user/7/bloqs" && c.body.name === "Plans")).toBe(true)
  })

  test("refuses an explicit board that is not the user's", async () => {
    fakePlatform()
    const r = await saveEpic(epicOf(), { bloqId: 999 })
    expect(r.saved).toBe(false)
    expect(r.reason).toContain("999")
  })

  test("when no item lands, the empty list is removed and saved is false", async () => {
    const calls = fakePlatform({ failItems: true })
    const r = await saveEpic(epicOf(), {})
    expect(r.saved).toBe(false)
    expect(r.reason).toContain("invalid")
    expect(calls.some((c) => c.method === "DELETE" && c.path.endsWith("/bloqs/list/555"))).toBe(true)
  })

  test("signed out is a reason, not a throw", async () => {
    spies.push(spyOn(platform, "resolveUserId").mockResolvedValue(null))
    const r = await saveEpic(epicOf(), {})
    expect(r.saved).toBe(false)
    expect(r.reason).toContain("not signed in")
  })
})

describe("atlas_epic tool", () => {
  it.instance("is named atlas_epic and tells the model it never sends", () =>
    Effect.gen(function* () {
      const info = yield* AtlasEpicTool
      expect(info.id).toBe("atlas_epic")
      const tool = yield* info.init()
      expect(tool.description).toContain("NEVER sends")
    }),
  )

  it.instance("a saved epic returns the card's metadata with item ids", () =>
    Effect.gen(function* () {
      fakePlatform()
      const r = yield* run(PLAN as any)
      expect(r.metadata).toMatchObject({ title: "Reply to people waiting on me", saved: true, bloqId: 42, listIds: [555] })
      expect(r.metadata.lists[0].items[0]).toMatchObject({ title: "Maria Lopez", kind: "draft" })
      expect(typeof r.metadata.lists[0].items[0].id).toBe("number")
      expect(r.output).toContain("2 list(s), 3 item(s)")
      expect(r.output).toContain("Nothing was sent")
    }),
  )

  it.instance("a failed save still returns the whole plan, with a reason", () =>
    Effect.gen(function* () {
      fakePlatform({ failList: true })
      const r = yield* run(PLAN as any)
      expect(r.metadata.saved).toBe(false)
      expect(r.metadata.reason).toContain("could not create the list")
      expect(r.metadata.lists).toHaveLength(2)
      expect(r.metadata.lists[0].items[0].body).toContain("Thursday at 3")
      expect(r.output).toContain("Not saved to Atlas")
    }),
  )

  it.instance("save: false never touches the network", () =>
    Effect.gen(function* () {
      const calls = fakePlatform()
      const r = yield* run({ ...(PLAN as any), save: false })
      expect(r.metadata.saved).toBe(false)
      expect(calls).toHaveLength(0)
    }),
  )
})
