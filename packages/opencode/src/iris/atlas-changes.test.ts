import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fetchFingerprint, resetVersionSupport } from "./atlas-live"
import { readAtlasBoard } from "./atlas-board-read"
import { readBoardCopy, writeBoardCopy } from "./atlas-local-copy"
import * as platform from "./platform"

// #190231 phase 3: a refresh asks fl-api what changed since the copy's version, and downloads only
// the cards that moved. The fake below speaks fl-api's protocol (BoardVersionTest pins the real one).

type Card = { id: number; title: string; rev: string }
type List = { id: number; name: string; items: Card[] }

let lists: List[] = []
let versioned = true
let status = 200
let asked: string[] = []
let swapBetweenSkeletonAndIds: (() => void) | undefined
const versionOf = () => lists.map((l) => `${l.id}:${l.name}:${l.items.map((i) => `${i.id}.${i.rev}`).join(",")}`).join("|")
const card = (id: number, rev = "r1"): Card => ({ id, title: `t${id}`, rev })

function flApi(p: string): Response {
  const q = new URLSearchParams(p.split("?")[1] ?? "")
  asked.push(p.split("?")[1] ?? "")
  if (status !== 200) return new Response("no", { status })
  const head = versioned ? { version: versionOf() } : {}
  const full = (only?: Set<number>) => ({
    data: {
      ...head,
      contains_phi: false,
      lists: lists.map((l) => ({
        id: l.id,
        name: l.name,
        items: l.items.filter((i) => !only || only.has(i.id)).map((i) => ({ ...i, ...(versioned ? {} : { rev: undefined }), summary: { preview: "p", labels: [] } })),
      })),
    },
  })
  if (!versioned) return Response.json(full())
  if (q.get("ids")) {
    swapBetweenSkeletonAndIds?.()
    return Response.json(full(new Set(q.get("ids")!.split(",").map(Number))))
  }
  if (q.get("if_version") || q.get("skeleton")) {
    if (q.get("if_version") === versionOf()) return Response.json({ data: { ...head, unchanged: true } })
    return Response.json({ data: { ...head, lists: lists.map((l) => ({ id: l.id, name: l.name, items: l.items.map(({ id, rev }) => ({ id, rev })) })) } })
  }
  return Response.json(full())
}

const spies: { mockRestore(): void }[] = []
let home = ""
beforeEach(() => {
  lists = [
    { id: 1, name: "Todo", items: [card(1), card(2), card(3), card(4)] },
    { id: 2, name: "Done", items: [card(5), card(6)] },
  ]
  versioned = true
  status = 200
  asked = []
  swapBetweenSkeletonAndIds = undefined
  home = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-changes-"))
  process.env.IRIS_ATLAS_HOME = home
  platform.resetRecentBloqs()
  platform.resetPreviewSupport()
  resetVersionSupport()
  spies.push(spyOn(platform, "resolveUserId").mockResolvedValue(7))
  spies.push(
    spyOn(platform, "irisFetch").mockImplementation((async (p: string) =>
      p.includes("/bloqs?simplified=true") ? Response.json({ data: [{ id: 42, name: "b" }] }) : flApi(p)) as any),
  )
})
afterEach(() => {
  while (spies.length) spies.pop()!.mockRestore()
  delete process.env.IRIS_ATLAS_HOME
  fs.rmSync(home, { recursive: true, force: true })
})

/** What the panel would show, as [list name, [card ids + titles]]. */
const shape = (ls: platform.AtlasList[]) => ls.map((l) => [l.name, l.items.map((i) => `${i.id}:${i.title}`)])
const serverShape = () => lists.map((l) => [l.name, l.items.map((i) => `${i.id}:${i.title}`)])

async function held() {
  const r = await platform.fetchAtlas(42)
  asked = []
  return { version: r.data.version!, lists: r.data.lists }
}

describe("fetchAtlasChanges", () => {
  test("nothing changed: one request, answered `unchanged`, no board", async () => {
    const h = await held()
    expect(await platform.fetchAtlasChanges(42, h)).toEqual({ kind: "unchanged", version: h.version })
    expect(asked).toEqual([`if_version=${encodeURIComponent(h.version)}`])
  })

  test("one card edited: the skeleton, then ONLY that card — merged in place", async () => {
    const h = await held()
    lists[0].items[2] = { id: 3, title: "edited", rev: "r2" }
    const ch = await platform.fetchAtlasChanges(42, h)
    expect(ch.kind).toBe("merged")
    if (ch.kind !== "merged") return
    expect(ch.fetched).toBe(1)
    expect(asked[1]).toStartWith("ids=3&")
    expect(shape(ch.lists)).toEqual(serverShape())
  })

  test("a card moved, a list renamed, a card deleted and one added: the merge is the server's board", async () => {
    const h = await held()
    const moved = lists[0].items.splice(0, 1)[0]
    lists[1].items.unshift({ ...moved, rev: "r2" })
    lists[1].name = "Shipped"
    lists[0].items.pop()
    lists[0].items.push(card(9))
    const ch = await platform.fetchAtlasChanges(42, h)
    expect(ch.kind).toBe("merged")
    if (ch.kind !== "merged") return
    expect(ch.fetched).toBe(2) // the moved card (new rev) and the new one — not the renamed list's cards
    expect(shape(ch.lists)).toEqual(serverShape())
  })

  test("an fl-api without versions: `full`, so the caller does today's whole read", async () => {
    const h = await held()
    versioned = false
    expect((await platform.fetchAtlasChanges(42, h)).kind).toBe("full")
  })

  test("more than half the board changed: `full` — one read beats skeleton + ids", async () => {
    const h = await held()
    for (const l of lists) l.items = l.items.map((i) => ({ ...i, rev: "r9" }))
    expect((await platform.fetchAtlasChanges(42, h)).kind).toBe("full")
    expect(asked.some((q) => q.startsWith("ids="))).toBe(false)
  })

  test("a card changes again between the skeleton and the ids read: `full`, never a stale card", async () => {
    const h = await held()
    lists[0].items[0] = { id: 1, title: "first edit", rev: "r2" }
    swapBetweenSkeletonAndIds = () => (lists[0].items[0] = { id: 1, title: "second edit", rev: "r3" })
    expect((await platform.fetchAtlasChanges(42, h)).kind).toBe("full")
  })

  test("fl-api refuses: an error carrying the status, which the caller reads as a refusal", async () => {
    const h = await held()
    status = 404
    expect(await platform.fetchAtlasChanges(42, h)).toEqual({ kind: "error", reason: "fl-api 404" })
  })
})

describe("readAtlasBoard refreshes a versioned copy", () => {
  test("first open is a full read that saves the version with the copy", async () => {
    const r = await readAtlasBoard(42, { fresh: "1" })
    expect(r.sync).toBe("full")
    expect(readBoardCopy(7, 42)?.version).toBe(versionOf())
  })

  test("unchanged: no board is downloaded, and the copy is marked confirmed now", async () => {
    await readAtlasBoard(42, { fresh: "1" })
    const c = readBoardCopy(7, 42)!
    writeBoardCopy(7, 42, false, c.lists, c.version) // as it was
    const before = Date.parse(readBoardCopy(7, 42)!.copiedAt)
    asked = []
    await new Promise((r) => setTimeout(r, 5))
    const r = await readAtlasBoard(42, { fresh: "1" })
    expect(r.sync).toBe("unchanged")
    expect(asked).toHaveLength(1)
    expect(Date.parse(readBoardCopy(7, 42)!.copiedAt)).toBeGreaterThan(before)
  })

  test("one card edited: only that card is fetched, and the copy holds the new board and version", async () => {
    await readAtlasBoard(42, { fresh: "1" })
    lists[1].items[0] = { id: 5, title: "edited", rev: "r2" }
    asked = []
    const r = await readAtlasBoard(42, { fresh: "1" })
    expect(r.sync).toBe("delta")
    expect(shape(r.r.data.lists)).toEqual(serverShape())
    expect(asked.filter((q) => q.includes("light=1") && !q.startsWith("ids="))).toEqual([]) // no whole-board read
    const c = readBoardCopy<platform.AtlasList>(7, 42)!
    expect(c.version).toBe(versionOf())
    expect(shape(c.lists)).toEqual(serverShape())
  })

  test("fl-api unreachable on refresh: the copy, marked offline", async () => {
    await readAtlasBoard(42, { fresh: "1" })
    status = 503
    const r = await readAtlasBoard(42, { fresh: "1" })
    expect(r.source).toBe("copy")
    expect(r.offline).toBe(true)
  })

  test("fl-api refuses on refresh (access revoked): the copy is deleted, not shown", async () => {
    await readAtlasBoard(42, { fresh: "1" })
    status = 403
    const r = await readAtlasBoard(42, { fresh: "1" })
    expect(r.source).toBe("live")
    expect(r.r.measured).toBe(false)
    expect(readBoardCopy(7, 42)).toBeUndefined()
  })
})

describe("the live check asks for a version, not the board", () => {
  test("first check reads the skeleton; later checks send if_version and get a few bytes back", async () => {
    const a = await fetchFingerprint(42)
    expect(asked).toEqual(["skeleton=1"])
    asked = []
    const b = await fetchFingerprint(42, a!)
    expect(b).toBe(a)
    expect(asked).toEqual([`if_version=${encodeURIComponent(versionOf())}`])
    lists[0].items[0].rev = "r2"
    expect(await fetchFingerprint(42, b!)).not.toBe(b)
  })

  test("an fl-api without versions: the whole light board, as before", async () => {
    versioned = false
    const fp = await fetchFingerprint(42)
    expect(fp).not.toBeNull()
    expect(asked).toEqual(["skeleton=1", "light=1&summary=1"])
    asked = []
    await fetchFingerprint(42, fp!)
    expect(asked).toEqual(["light=1&summary=1"]) // not asked again for 10 minutes
  })
})
