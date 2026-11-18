import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import * as copy from "./atlas-local-copy"
import * as outbox from "./atlas-outbox"
import type { AtlasList } from "./platform"

// #190537 W3: edits made with fl-api unreachable wait on this machine and are sent when it answers.
// The fake fl-api below answers in the shapes RECORDED from production (fixtures/fl-api-card-write.json,
// scratch board 811, 2026-10-23): a 409 is fl-api's own body with only the card's values swapped in.

process.env.IRIS_USER_ID = "7"
const U = 7
const B = 503
const fixture = JSON.parse(fs.readFileSync(path.join(import.meta.dir, "../../test/iris/fixtures/fl-api-card-write.json"), "utf8"))

type Card = { id: number; title: string; content: string; status: string; priority: string | null; card_type: string | null; due_date: string | null; bloq_list_id: number; rev: string }

/** fl-api, as far as these writes go: W1's rev guard, and the recorded reply shapes. */
function fakeFlApi() {
  const cards = new Map<number, Card>()
  let n = 0
  let nextId = 9000
  const st = { offline: false, calls: [] as string[], cards, refuse: new Set<number>(), changedBy: { id: 9, name: "Sam", is_you: false } }
  const rev = () => `r${++n}`
  const add = (c: Omit<Card, "rev">) => {
    const card = { ...c, rev: rev() }
    cards.set(c.id, card)
    return card
  }
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } })

  spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = init?.method ?? "GET"
    st.calls.push(`${method} ${url.pathname}`)
    if (st.offline) throw new TypeError("fetch failed")
    const body = init?.body ? JSON.parse(String(init.body)) : {}

    let m = url.pathname.match(/^\/api\/v1\/user\/bloqs\/list\/item\/(\d+)$/)
    if (m && method === "PUT") {
      const card = cards.get(Number(m[1]))
      if (!card) return json(404, { message: "not found" })
      if (st.refuse.has(card.id)) return json(403, { message: "You can't edit cards on this board." })
      if (body.base_rev && body.base_rev !== card.rev) {
        const r = structuredClone(fixture.save409.body)
        r.data.current = { ...r.data.current, ...card }
        r.data.changed_by = st.changedBy
        r.data.retry = { base_rev: card.rev }
        r.data.your_base_rev = body.base_rev
        return json(409, r, { "x-card-rev": card.rev })
      }
      for (const k of ["title", "content", "status", "priority", "card_type", "due_date", "bloq_list_id"]) if (k in body) (card as any)[k] = body[k]
      card.rev = rev()
      return json(200, { success: true, message: "ok", card_rev: card.rev, data: card }, { "x-card-rev": card.rev })
    }
    m = url.pathname.match(/^\/api\/v1\/user\/\d+\/bloqs\/(\d+)\/items$/)
    if (m && method === "POST") {
      const id = nextId++
      add({ id, title: body.title, content: body.content, status: "todo", priority: null, card_type: null, due_date: null, bloq_list_id: body.list_id })
      return json(201, { data: { id } })
    }
    m = url.pathname.match(/^\/api\/v1\/user\/\d+\/bloqs\/list\/item\/(\d+)\/position$/)
    if (m && method === "PATCH") {
      const card = cards.get(Number(m[1]))!
      card.bloq_list_id = body.list_id
      card.rev = rev()
      return json(200, { success: true })
    }
    return json(500, { message: `fake: no route ${method} ${url.pathname}` })
  }) as typeof fetch)

  /** Someone else, online, changing a card. */
  const otherEdit = (id: number, change: Partial<Card>) => {
    Object.assign(cards.get(id)!, change)
    cards.get(id)!.rev = rev()
  }
  return { st, add, otherEdit }
}

let home = ""
let api: ReturnType<typeof fakeFlApi>

/** fl-api's cards, kept on this machine as a board copy (what the panel read). */
function keepBoard(containsPhi = false) {
  const lists: AtlasList[] = [
    { id: 1, name: "To do", items: [] },
    { id: 2, name: "Done", items: [] },
  ]
  for (const c of api.st.cards.values()) {
    lists.find((l) => l.id === c.bloq_list_id)!.items.push({ id: c.id, title: c.title, status: c.status, rev: c.rev, priority: c.priority ?? undefined })
  }
  copy.writeBoardCopy(U, B, containsPhi, lists, "v1")
  return lists
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-outbox-"))
  process.env.IRIS_ATLAS_HOME = home
  api = fakeFlApi()
  api.add({ id: 101, title: "Call the venue", content: "body", status: "todo", priority: null, card_type: null, due_date: null, bloq_list_id: 1 })
  api.add({ id: 102, title: "Book the van", content: "body", status: "todo", priority: null, card_type: null, due_date: null, bloq_list_id: 1 })
})
afterEach(() => {
  outbox.stopPumps()
  delete process.env.IRIS_ATLAS_HOME
  fs.rmSync(home, { recursive: true, force: true })
})

describe("D2: an offline round trip", () => {
  test("edit, move and create offline: 3 waiting, drawn on the board; back online all three land and the queue empties", async () => {
    const lists = keepBoard()
    expect(outbox.enqueueSave(U, 101, { title: "Call the venue (Fri)" }).queued).toBe(true)
    expect(outbox.enqueueMove(U, 102, 2, 0).queued).toBe(true)
    const made = outbox.enqueueCreate(U, B, 1, { title: "Print setlists" })
    expect(made).toMatchObject({ queued: true, id: -1 })
    expect(outbox.counts(U, B)).toEqual({ waiting: 3, held: 0 })

    const shown = outbox.overlay(U, B, lists)
    expect(shown[0].items.map((i) => [i.id, i.title, (i as any).pending])).toEqual([
      [101, "Call the venue (Fri)", "waiting"],
      [-1, "Print setlists", "waiting"],
    ])
    expect(shown[1].items.map((i) => i.id)).toEqual([102])
    expect(lists[0].items.map((i) => i.title)).toEqual(["Call the venue", "Book the van"]) // the copy is untouched

    api.st.offline = true
    expect(await outbox.replay(U)).toMatchObject({ sent: 0, offline: true, waiting: 3 })

    api.st.offline = false
    expect(await outbox.replay(U)).toEqual({ sent: 3, held: 0, waiting: 0, offline: false })
    expect(api.st.cards.get(101)!.title).toBe("Call the venue (Fri)")
    expect(api.st.cards.get(102)!.bloq_list_id).toBe(2)
    expect([...api.st.cards.values()].map((c) => c.title)).toContain("Print setlists")
    expect(fs.existsSync(copy.outboxFile(U))).toBe(false)
  })

  test("the queue is owner-only on disk", () => {
    keepBoard()
    outbox.enqueueSave(U, 101, { status: "done" })
    expect(fs.statSync(copy.outboxFile(U)).mode & 0o777).toBe(0o600)
    expect(fs.statSync(path.dirname(copy.outboxFile(U))).mode & 0o777).toBe(0o700)
  })

  test("two saves to one card offline are ONE save, compared against what you first saw", async () => {
    keepBoard()
    outbox.enqueueSave(U, 101, { title: "first" })
    outbox.enqueueSave(U, 101, { title: "second", status: "done" })
    const ops = outbox.readOutbox(U).ops
    expect(ops).toHaveLength(1)
    expect(ops[0]).toMatchObject({ kind: "save", base: { title: "Call the venue", status: "todo" }, patch: { title: "second", status: "done" } })
    await outbox.replay(U)
    expect(api.st.cards.get(101)).toMatchObject({ title: "second", status: "done" })
  })

  test("editing or moving a card created offline changes its create; later edits follow it to its real id", async () => {
    keepBoard()
    const { id } = outbox.enqueueCreate(U, B, 1, { title: "draft" }) as { id: number }
    outbox.enqueueSave(U, id, { title: "Print setlists", content: "4 copies" })
    outbox.enqueueMove(U, id, 2, 0)
    expect(outbox.readOutbox(U).ops).toHaveLength(1)
    await outbox.replay(U)
    const made = [...api.st.cards.values()].find((c) => c.title === "Print setlists")!
    expect(made).toMatchObject({ content: "4 copies", bloq_list_id: 2 })
  })

  test("a patient-data board that is not kept here cannot queue: the edit is refused with the reason, not lost quietly", () => {
    keepBoard(true) // includePhi is off by default, so this writes nothing
    const r = outbox.enqueueSave(U, 101, { title: "x" })
    expect(r.queued).toBe(false)
    expect((r as { reason: string }).reason).toContain("isn't kept on this computer")
    expect(outbox.enqueueCreate(U, B, 1, { title: "x" }).queued).toBe(false)
    expect(fs.existsSync(copy.outboxFile(U))).toBe(false)
  })

  test("a patient-data copy left on disk after includePhi was switched off by hand is still not queued onto", () => {
    copy.writeLocalCopySettings({ includePhi: true })
    keepBoard(true)
    // An admin edits the settings file directly: nothing deletes the copy, but nothing may use it.
    fs.writeFileSync(path.join(home, "local-copy.json"), JSON.stringify({ enabled: true, includePhi: false, maxBoards: 20, maxMB: 200 }))
    expect(outbox.enqueueSave(U, 101, { title: "x" }).queued).toBe(false)
    expect(outbox.enqueueMove(U, 101, 2, 0).queued).toBe(false)
  })

  test("…and with includePhi on, it queues like any other board", () => {
    copy.writeLocalCopySettings({ includePhi: true })
    keepBoard(true)
    expect(outbox.enqueueSave(U, 101, { title: "x" }).queued).toBe(true)
  })

  test("a refusal is held with fl-api's words, and later edits to that card wait behind it", async () => {
    keepBoard()
    api.st.refuse.add(101)
    outbox.enqueueSave(U, 101, { title: "x" })
    outbox.enqueueMove(U, 101, 2, 0)
    outbox.enqueueSave(U, 102, { status: "done" })
    expect(await outbox.replay(U)).toEqual({ sent: 1, held: 1, waiting: 1, offline: false })
    expect(outbox.heldOn(U, B)[0]).toMatchObject({ itemId: 101, kind: "refused", message: "You can't edit cards on this board." })
    expect(api.st.cards.get(101)!.bloq_list_id).toBe(1) // the move did not jump the held save
  })
})

describe("D3: a conflict is shown, not lost", () => {
  test("fields that don't overlap merge: your title and their status both survive", async () => {
    keepBoard()
    outbox.enqueueSave(U, 101, { title: "Call the venue (Fri)" })
    api.otherEdit(101, { status: "done" })
    expect(await outbox.replay(U)).toEqual({ sent: 1, held: 0, waiting: 0, offline: false })
    expect(api.st.cards.get(101)).toMatchObject({ title: "Call the venue (Fri)", status: "done" })
  })

  test("the same field changed both ways is HELD with both values; your other fields still land; fl-api keeps theirs until you choose", async () => {
    keepBoard()
    outbox.enqueueSave(U, 101, { title: "Mine", priority: "high" })
    api.otherEdit(101, { title: "Theirs" })
    expect(await outbox.replay(U)).toEqual({ sent: 0, held: 1, waiting: 0, offline: false })
    expect(api.st.cards.get(101)).toMatchObject({ title: "Theirs", priority: "high" })
    const [h] = outbox.heldOn(U, B)
    expect(h).toMatchObject({ itemId: 101, kind: "conflict", fields: [{ field: "title", base: "Call the venue", mine: "Mine", theirs: "Theirs" }] })
    expect(h.message).toBe("Sam changed the title on this card while you were offline. Choose which to keep.")
    expect(outbox.counts(U, B)).toEqual({ waiting: 0, held: 1 })
  })

  test("choosing 'keep mine' sends yours against the card you were shown", async () => {
    keepBoard()
    outbox.enqueueSave(U, 101, { title: "Mine" })
    api.otherEdit(101, { title: "Theirs" })
    await outbox.replay(U)
    const puts = api.st.calls.filter((c) => c.startsWith("PUT")).length
    const r = await outbox.resolve(U, outbox.heldOn(U, B)[0].opId, "mine")
    expect(r.ok).toBe(true)
    expect(api.st.cards.get(101)!.title).toBe("Mine")
    // One save, against the card you were shown — not a stale one that is refused first.
    expect(api.st.calls.filter((c) => c.startsWith("PUT")).length).toBe(puts + 1)
    expect(outbox.counts(U)).toEqual({ waiting: 0, held: 0 })
  })

  test("'keep mine' after the card changed AGAIN comes back held with the newest value, never overwriting it unseen", async () => {
    keepBoard()
    outbox.enqueueSave(U, 101, { title: "Mine" })
    api.otherEdit(101, { title: "Theirs" })
    await outbox.replay(U)
    api.otherEdit(101, { title: "Theirs, again" })
    await outbox.resolve(U, outbox.heldOn(U, B)[0].opId, "mine")
    expect(api.st.cards.get(101)!.title).toBe("Theirs, again")
    expect(outbox.heldOn(U, B)[0].fields[0]).toMatchObject({ mine: "Mine", theirs: "Theirs, again" })
  })

  test("choosing 'keep theirs' drops yours and sends nothing", async () => {
    keepBoard()
    outbox.enqueueSave(U, 101, { title: "Mine" })
    api.otherEdit(101, { title: "Theirs" })
    await outbox.replay(U)
    const puts = api.st.calls.filter((c) => c.startsWith("PUT")).length
    await outbox.resolve(U, outbox.heldOn(U, B)[0].opId, "theirs")
    expect(api.st.calls.filter((c) => c.startsWith("PUT")).length).toBe(puts)
    expect(api.st.cards.get(101)!.title).toBe("Theirs")
    expect(outbox.counts(U)).toEqual({ waiting: 0, held: 0 })
  })

  test("both sides made the SAME change: nothing to hold, nothing left to send", async () => {
    keepBoard()
    outbox.enqueueSave(U, 101, { status: "done" })
    api.otherEdit(101, { status: "done" })
    expect(await outbox.replay(U)).toMatchObject({ sent: 1, held: 0 })
  })

  test("a body edited without knowing what it was before is held when fl-api's differs — never guessed", async () => {
    keepBoard()
    outbox.enqueueSave(U, 101, { content: "my notes" }) // the copy has no body, and the editor sent none
    api.otherEdit(101, { status: "done" })
    await outbox.replay(U)
    expect(outbox.heldOn(U, B)[0].fields.map((f) => f.field)).toEqual(["content"])
  })

  test("someone CLEARED the body while you were offline: held, not overwritten with yours as if it had been empty all along", async () => {
    keepBoard()
    outbox.enqueueSave(U, 101, { content: "my notes" })
    api.otherEdit(101, { content: "" })
    await outbox.replay(U)
    expect(api.st.cards.get(101)!.content).toBe("")
    expect(outbox.heldOn(U, B)[0].fields.map((f) => f.field)).toEqual(["content"])
  })

  test("…but with the body the editor started from, an untouched body merges", async () => {
    keepBoard()
    outbox.enqueueSave(U, 101, { content: "my notes" }, { content: "body" })
    api.otherEdit(101, { status: "done" })
    expect(await outbox.replay(U)).toMatchObject({ sent: 1, held: 0 })
    expect(api.st.cards.get(101)).toMatchObject({ content: "my notes", status: "done" })
  })

  test("a date answered as a timestamp is the same date the editor sent", async () => {
    keepBoard()
    outbox.enqueueSave(U, 101, { due_date: "2026-11-01" })
    api.otherEdit(101, { due_date: "2026-11-01T00:00:00.000000Z", status: "done" })
    expect(await outbox.replay(U)).toMatchObject({ sent: 1, held: 0 })
  })

  test("the RECORDED production 409 merges: only the status changed there, so your title goes through", async () => {
    // fixture: card read at r0, someone set status=in_progress, then "mine offline" was saved stale.
    const rec = fixture.save409.body.data.current
    api.add({ id: rec.id, title: rec.title, content: rec.content, status: "todo", priority: null, card_type: null, due_date: null, bloq_list_id: 1 })
    keepBoard()
    outbox.enqueueSave(U, rec.id, { title: "mine offline" })
    api.otherEdit(rec.id, { status: rec.status })
    expect(await outbox.replay(U)).toMatchObject({ sent: 1, held: 0 })
    expect(api.st.cards.get(rec.id)).toMatchObject({ title: "mine offline", status: "in_progress" })
  })
})

describe("the copy is kept while it matters (S8)", () => {
  test("a board larger than the whole budget is kept when it is the one just written", () => {
    copy.writeLocalCopySettings({ maxMB: 0.0001 })
    const big = [{ id: 1, name: "L", items: Array.from({ length: 200 }, (_, i) => ({ id: i, title: `card ${i}`.repeat(4) })) }]
    expect(copy.writeBoardCopy(U, 900, false, big)).toBe(true)
    expect(copy.readBoardCopy(U, 900)).toBeDefined()
  })

  test("a board with edits waiting is never evicted, even past maxBoards", () => {
    keepBoard()
    outbox.enqueueSave(U, 101, { status: "done" })
    copy.writeLocalCopySettings({ maxBoards: 1 })
    copy.writeBoardCopy(U, 901, false, [{ id: 1, name: "L", items: [] }])
    copy.writeBoardCopy(U, 902, false, [{ id: 1, name: "L", items: [] }])
    expect(copy.readBoardCopy(U, B)).toBeDefined()
    expect(copy.readBoardCopy(U, 901)).toBeUndefined()
  })
})
