import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import * as copy from "./atlas-local-copy"
import * as platform from "./platform"
import { isRefusal, readAtlasBoard } from "./atlas-board-read"

// #190231 phase 1: each board's last read is kept on this machine and served first.
// Alex, 2026-10-21: boards with patient data follow the default (NOT kept) but must be overrideable.

let home = ""
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-copy-"))
  process.env.IRIS_ATLAS_HOME = home
})
afterEach(() => {
  delete process.env.IRIS_ATLAS_HOME
  fs.rmSync(home, { recursive: true, force: true })
})

const lists = (n = 1) => [{ id: 1, name: "L", items: Array.from({ length: n }, (_, i) => ({ id: i, title: `t${i}` })) }]

describe("the local copy", () => {
  test("defaults: on, patient-data boards NOT kept, 20 boards, 200 MB", () => {
    expect(copy.readLocalCopySettings()).toEqual({ enabled: true, includePhi: false, maxBoards: 20, maxMB: 200 })
  })

  test("a board is kept and read back, owner-only on disk", () => {
    expect(copy.writeBoardCopy(7, 503, false, lists())).toBe(true)
    const c = copy.readBoardCopy(7, 503)!
    expect(c.lists).toEqual(lists())
    const f = path.join(home, "cache", "7", "503.json")
    expect(fs.statSync(f).mode & 0o777).toBe(0o600)
    expect(fs.statSync(path.dirname(f)).mode & 0o777).toBe(0o700)
  })

  test("a contains_phi board is not kept by default — and an old copy of it is deleted", () => {
    copy.writeLocalCopySettings({ includePhi: true })
    copy.writeBoardCopy(7, 174, true, lists())
    copy.writeLocalCopySettings({ includePhi: false })
    expect(fs.existsSync(path.join(home, "cache", "7", "174.json"))).toBe(false)
    expect(copy.writeBoardCopy(7, 174, true, lists())).toBe(false)
    expect(copy.readBoardCopy(7, 174)).toBeUndefined()
  })

  test("…and IS kept once the override is on", () => {
    copy.writeLocalCopySettings({ includePhi: true })
    expect(copy.writeBoardCopy(7, 174, true, lists())).toBe(true)
    expect(copy.readBoardCopy(7, 174)?.containsPhi).toBe(true)
  })

  test("turning it off deletes every copy, not just hides them", () => {
    copy.writeBoardCopy(7, 503, false, lists())
    copy.writeLocalCopySettings({ enabled: false })
    expect(fs.existsSync(path.join(home, "cache"))).toBe(false)
    expect(copy.writeBoardCopy(7, 503, false, lists())).toBe(false)
  })

  test("copies are per account", () => {
    copy.writeBoardCopy(7, 503, false, lists())
    expect(copy.readBoardCopy(8, 503)).toBeUndefined()
  })

  test("keeps the most recently opened boards within maxBoards", () => {
    copy.writeLocalCopySettings({ maxBoards: 2 })
    copy.writeBoardCopy(7, 1, false, lists())
    copy.writeBoardCopy(7, 2, false, lists())
    const old = new Date(Date.now() - 60_000)
    fs.utimesSync(path.join(home, "cache", "7", "1.json"), old, old)
    copy.writeBoardCopy(7, 3, false, lists())
    expect(copy.readBoardCopy(7, 1)).toBeUndefined()
    expect(copy.readBoardCopy(7, 2)).toBeDefined()
    expect(copy.readBoardCopy(7, 3)).toBeDefined()
  })

  test("a partial settings change leaves the other settings alone", () => {
    copy.writeLocalCopySettings({ maxBoards: 5 })
    const s = copy.writeLocalCopySettings({ includePhi: undefined, maxMB: 50 })
    expect(s).toEqual({ enabled: true, includePhi: false, maxBoards: 5, maxMB: 50 })
  })

  test("a malformed settings file falls back per field, never to 'off'", () => {
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(path.join(home, "local-copy.json"), '{"enabled":"yes","maxBoards":-3}')
    expect(copy.readLocalCopySettings()).toEqual(copy.DEFAULT_LOCAL_COPY)
  })
})

describe("readAtlasBoard — copy first, then fresh", () => {
  const spies: { mockRestore(): void }[] = []
  let live: Awaited<ReturnType<typeof platform.fetchAtlas>>
  let calls: { bodies?: boolean }[] = []
  beforeEach(() => {
    calls = []
    live = { measured: true, data: { lists: lists(2) as any, containsPhi: false } }
    spies.push(spyOn(platform, "resolveUserId").mockResolvedValue(7))
    spies.push(spyOn(platform, "fetchAtlas").mockImplementation(async (_b: number, o: any = {}) => (calls.push(o), live)))
  })
  afterEach(() => {
    while (spies.length) spies.pop()!.mockRestore()
  })

  test("no copy yet: reads fl-api and keeps what came back", async () => {
    const r = await readAtlasBoard(503)
    expect(r.source).toBe("live")
    expect(copy.readBoardCopy(7, 503)?.lists.length).toBe(1)
  })

  test("with a copy: answers from it WITHOUT asking fl-api", async () => {
    copy.writeBoardCopy(7, 503, false, lists(3))
    const r = await readAtlasBoard(503)
    expect(r.source).toBe("copy")
    expect(r.copiedAt).toBeTruthy()
    expect(calls.length).toBe(0)
  })

  test("fresh: asks fl-api even with a copy, and replaces the copy", async () => {
    copy.writeBoardCopy(7, 503, false, [])
    const r = await readAtlasBoard(503, { fresh: "1" })
    expect(r.source).toBe("live")
    expect(copy.readBoardCopy(7, 503)?.lists.length).toBe(1)
  })

  test("fl-api unreachable: the copy, marked offline, with the reason", async () => {
    copy.writeBoardCopy(7, 503, false, lists())
    live = { measured: false, reason: "fetch failed", data: { lists: [] } }
    const r = await readAtlasBoard(503, { fresh: "1" })
    expect(r).toMatchObject({ source: "copy", offline: true })
    expect(r.r.reason).toBe("fetch failed")
    expect(r.r.data.lists.length).toBe(1)
  })

  test("fl-api REFUSES (access revoked): the copy is deleted, never shown", async () => {
    copy.writeBoardCopy(7, 503, false, lists())
    live = { measured: false, reason: "unknown bloq 503", data: { lists: [] } }
    const r = await readAtlasBoard(503, { fresh: "1" })
    expect(r.source).toBe("live")
    expect(r.r.measured).toBe(false)
    expect(copy.readBoardCopy(7, 503)).toBeUndefined()
  })

  test("a search never uses the copy (it has no bodies) and reads bodies", async () => {
    copy.writeBoardCopy(7, 503, false, lists())
    const r = await readAtlasBoard(503, { q: "gate" })
    expect(r.source).toBe("live")
    expect(calls).toEqual([{ bodies: true }])
  })

  test("a contains_phi board read live is not written to disk", async () => {
    live = { measured: true, data: { lists: lists() as any, containsPhi: true } }
    await readAtlasBoard(174)
    expect(copy.readBoardCopy(7, 174)).toBeUndefined()
  })

  test("what counts as a refusal", () => {
    for (const r of ["unknown bloq 5", "not signed in (token: none)", "fl-api 403", "fl-api 404", "fl-api 401"]) expect(isRefusal(r)).toBe(true)
    for (const r of ["fetch failed", "fl-api 502", "fl-api 500", undefined]) expect(isRefusal(r)).toBe(false)
  })
})

// Offline, the panel could not draw any board without the board LIST: it showed "Could not reach
// IRIS" and stopped (found on a preview build with fl-api unreachable).
import { readBoardList } from "./atlas-board-read"
describe("the board list is kept too", () => {
  const spies: { mockRestore(): void }[] = []
  let list: Awaited<ReturnType<typeof platform.fetchBloqs>>
  beforeEach(() => {
    list = { measured: true, data: { bloqs: [{ id: 503, name: "Features" }] } }
    spies.push(spyOn(platform, "resolveUserId").mockResolvedValue(7))
    spies.push(spyOn(platform, "fetchBloqs").mockImplementation(async () => list))
  })
  afterEach(() => {
    while (spies.length) spies.pop()!.mockRestore()
  })

  test("read once online, then shown from the copy — marked offline — when fl-api is unreachable", async () => {
    await readBoardList()
    list = { measured: false, reason: "Unable to connect", data: { bloqs: [] } }
    const r = await readBoardList()
    expect(r.offline).toBe(true)
    expect(r.r.data.bloqs).toEqual([{ id: 503, name: "Features" }])
    expect(r.r.reason).toBe("Unable to connect")
  })

  test("a refusal (signed out) never falls back to the copy", async () => {
    await readBoardList()
    list = { measured: false, reason: "not signed in (token: none)", data: { bloqs: [] } }
    const r = await readBoardList()
    expect(r.offline).toBeUndefined()
    expect(r.r.measured).toBe(false)
  })

  test("the board list is not a board: eviction never removes it", async () => {
    await readBoardList()
    copy.writeLocalCopySettings({ maxBoards: 0 })
    copy.evict(7)
    expect(copy.readBoardListCopy(7)?.bloqs.length).toBe(1)
  })

  test("off means no board list either", async () => {
    copy.writeLocalCopySettings({ enabled: false })
    await readBoardList()
    expect(copy.readBoardListCopy(7)).toBeUndefined()
  })
})
