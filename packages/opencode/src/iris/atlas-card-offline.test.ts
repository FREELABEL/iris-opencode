import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import * as copy from "./atlas-local-copy"
import * as outbox from "./atlas-outbox"
import { readCard } from "./atlas-board-read"
import type { AtlasList } from "./platform"

// #191003: offline, a card could only be edited if its editor was already open — opening one said
// "Could not load this card — fl-api 503". A card opened online is now kept whole beside its board,
// and offline the editor gets it back (or, never opened, its face with the body marked not here).

process.env.IRIS_USER_ID = "7"
const U = 7
const B = 503

type Card = { id: number; title: string; content: string; status: string; bloq_list_id: number }

let home = ""
let st: { down: false | "throw" | 503 | 404; cards: Map<number, Card> }

function fakeFlApi() {
  const s = { down: false as false | "throw" | 503 | 404, cards: new Map<number, Card>() }
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
  spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
    const url = new URL(String(input))
    if (s.down === "throw") throw new TypeError("fetch failed")
    if (s.down === 503) return json(503, { message: "Service Unavailable" })
    if (s.down === 404) return json(404, { message: "not found" })
    let m = url.pathname.match(/^\/api\/v1\/user\/bloqs\/list\/item\/(\d+)\/tasks$/)
    if (m) return json(200, { data: { tasks: [] } })
    m = url.pathname.match(/^\/api\/v1\/user\/bloqs\/list\/item\/(\d+)$/)
    if (m) {
      const c = s.cards.get(Number(m[1]))
      return c ? json(200, { data: c }) : json(404, { message: "not found" })
    }
    return json(500, { message: `fake: no route ${url.pathname}` })
  }) as typeof fetch)
  return s
}

function keepBoard(containsPhi = false) {
  const lists: AtlasList[] = [
    { id: 1, name: "Todo", items: [] },
    { id: 2, name: "Completed", items: [] },
  ]
  for (const c of st.cards.values()) {
    lists.find((l) => l.id === c.bloq_list_id)!.items.push({ id: c.id, title: c.title, status: c.status, preview: c.content.slice(0, 400) })
  }
  copy.writeBoardCopy(U, B, containsPhi, lists, "v1")
  return lists
}

const cardsDir = () => path.join(home, "cache", String(U), "cards", String(B))

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-card-offline-"))
  process.env.IRIS_ATLAS_HOME = home
  st = fakeFlApi()
  st.cards.set(201, { id: 201, title: "Site notes — gate access", content: "Use the east gate.", status: "todo", bloq_list_id: 1 })
  st.cards.set(202, { id: 202, title: "Pack the field kit", content: "Batteries, props, the Jackery.", status: "todo", bloq_list_id: 1 })
})
afterEach(() => {
  outbox.stopPumps()
  delete process.env.IRIS_ATLAS_HOME
  fs.rmSync(home, { recursive: true, force: true })
})

describe("a card opened online opens offline", () => {
  test("opened online it is kept, owner-only; offline it opens with its notes and says it is the kept copy", async () => {
    keepBoard()
    const online = await readCard(201)
    expect(online.measured).toBe(true)
    expect(online.offline).toBeUndefined()
    const f = path.join(cardsDir(), "201.json")
    expect(fs.statSync(f).mode & 0o777).toBe(0o600)

    for (const down of ["throw", 503] as const) {
      st.down = down
      const r = await readCard(201)
      expect(r.measured).toBe(true)
      expect(r.data.content).toBe("Use the east gate.")
      expect(r.data.listName).toBe("Todo")
      expect(r.offline).toMatchObject({ body: true })
      expect(typeof r.offline!.copiedAt).toBe("string")
    }
  })

  test("an edit saved offline is on the card when it is opened again, offline", async () => {
    keepBoard()
    await readCard(201)
    st.down = "throw"
    expect(outbox.enqueueSave(U, 201, { content: "East gate. Park by the barn.", title: "Site notes" }, { content: "Use the east gate." }).queued).toBe(true)
    expect(outbox.enqueueMove(U, 201, 2, 0).queued).toBe(true)
    const r = await readCard(201)
    expect(r.data).toMatchObject({ title: "Site notes", content: "East gate. Park by the barn.", listId: 2 })
  })

  test("the board's face is newer than the kept card: the face's title and status win, the body stays", async () => {
    keepBoard()
    await readCard(201)
    st.cards.get(201)!.title = "Gate access (east)"
    st.cards.get(201)!.status = "in_progress"
    keepBoard() // the board was read again, the card was not opened
    st.down = 503
    const r = await readCard(201)
    expect(r.data).toMatchObject({ title: "Gate access (east)", status: "in_progress", content: "Use the east gate." })
  })
})

describe("a card never opened here", () => {
  test("opens from its face: title and list, the body marked NOT HERE (not empty), the board's preview beside it", async () => {
    keepBoard()
    st.down = "throw"
    const r = await readCard(202)
    expect(r.measured).toBe(true)
    expect(r.data).toMatchObject({ title: "Pack the field kit", content: "", listId: 1, listName: "Todo" })
    expect(r.offline).toMatchObject({ body: false, preview: "Batteries, props, the Jackery." })
  })

  test("…and a card not on any kept board still says it could not be loaded, with the reason", async () => {
    st.down = 503
    const r = await readCard(202)
    expect(r.measured).toBe(false)
    expect(r.reason).toBe("fl-api 503")
  })
})

describe("the rules the board copy keeps, the card copy keeps", () => {
  test("a patient-data board is not kept, so neither are its cards — offline they do not open", async () => {
    keepBoard(true)
    const online = await readCard(201)
    expect(online.measured).toBe(true)
    expect(fs.existsSync(cardsDir())).toBe(false)
    st.down = "throw"
    expect((await readCard(201)).measured).toBe(false)
  })

  test("switching includePhi off removes the cards of a patient-data board with it", async () => {
    copy.writeLocalCopySettings({ includePhi: true })
    keepBoard(true)
    await readCard(201)
    expect(fs.existsSync(path.join(cardsDir(), "201.json"))).toBe(true)
    copy.writeLocalCopySettings({ includePhi: false })
    expect(fs.existsSync(cardsDir())).toBe(false)
  })

  test("turning the copy off removes every kept card", async () => {
    keepBoard()
    await readCard(201)
    copy.writeLocalCopySettings({ enabled: false })
    expect(fs.existsSync(path.join(home, "cache"))).toBe(false)
  })

  test("a board evicted from the copy takes its cards with it", async () => {
    keepBoard()
    await readCard(201)
    copy.writeLocalCopySettings({ maxBoards: 1 })
    copy.writeBoardCopy(U, 999, false, [{ id: 9, name: "x", items: [] }])
    expect(fs.existsSync(path.join(home, "cache", String(U), `${B}.json`))).toBe(false)
    expect(fs.existsSync(cardsDir())).toBe(false)
  })

  test("a card fl-api says is gone is removed, and is not served offline afterwards from its kept copy", async () => {
    keepBoard()
    await readCard(201)
    st.down = 404
    const gone = await readCard(201)
    expect(gone.measured).toBe(false)
    expect(fs.existsSync(path.join(cardsDir(), "201.json"))).toBe(false)
    st.down = "throw"
    expect((await readCard(201)).offline).toMatchObject({ body: false })
  })
})
