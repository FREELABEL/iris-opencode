/**
 * CONTRACT: edits made offline land when the connection returns, and a conflict is shown, never
 * lost (#190537 D2, D3).
 *
 * Runs against a DEPLOYED fl-api, on a scratch board that holds no real data:
 *
 *   IRIS_CONTRACT=1 IRIS_CONTRACT_BLOQ=811 IRIS_CONTRACT_LIST=2953 bun test test/contract/atlas-offline.contract.test.ts
 *
 * "Offline" is the network failing — every fl-api call throws, as it does with no connection.
 * Everything else is the real server: the queue's saves meet W1's real rev guard and its real 409.
 * The other writer is a plain PUT with no base, which is what every client sent before W1.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const ON = process.env.IRIS_CONTRACT === "1"
const BLOQ = Number(process.env.IRIS_CONTRACT_BLOQ ?? 0)
const LIST = Number(process.env.IRIS_CONTRACT_LIST ?? 0)
setDefaultTimeout(60_000)

const home = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-offline-contract-"))
process.env.IRIS_ATLAS_HOME = home

const { readAtlasBoardWithEdits } = await import("../../src/iris/atlas-board-read")
const { createCard, moveCard, saveCard } = await import("../../src/iris/atlas-write")
const outbox = await import("../../src/iris/atlas-outbox")
const { fetchAtlas, irisFetch, resolveUserId } = await import("../../src/iris/platform")

const realFetch = globalThis.fetch
let offline = false
const made: number[] = []

async function card(title: string): Promise<number> {
  const userId = await resolveUserId()
  const res = await irisFetch(`/api/v1/user/${userId}/bloqs/${BLOQ}/items`, undefined, {
    method: "POST",
    body: JSON.stringify({ title, content: "original body", type: "default", list_id: LIST }),
  })
  const j = (await res.json()) as any
  const id = Number(j?.data?.id ?? j?.data?.data?.id ?? j?.id)
  made.push(id)
  return id
}
/** The card as fl-api has it now, read the way nothing on this machine can influence. */
async function live(id: number) {
  const r = await fetchAtlas(BLOQ)
  return r.data.lists.flatMap((l) => l.items.map((i) => ({ ...i, listId: l.id }))).find((i) => i.id === id)
}
/** Someone else, online, saving the whole field the way clients did before W1: no base. */
async function otherWriter(id: number, body: Record<string, unknown>) {
  const res = await irisFetch(`/api/v1/user/bloqs/list/item/${id}`, undefined, { method: "PUT", body: JSON.stringify(body) })
  expect(res.status).toBe(200)
}

describe.skipIf(!ON || BLOQ !== 811 || !LIST)("contract: offline edits (#190537 D2, D3)", () => {
  let userId = 0
  beforeAll(async () => {
    userId = (await resolveUserId())!
    spyOn(globalThis, "fetch").mockImplementation((async (input: any, init?: any) => {
      if (offline) throw new TypeError("fetch failed")
      return realFetch(input, init)
    }) as typeof fetch)
  })
  afterAll(async () => {
    offline = false
    outbox.stopPumps()
    for (const id of made) await irisFetch(`/api/v1/user/bloqs/list/item/${id}`, undefined, { method: "DELETE" }).catch(() => {})
    fs.rmSync(home, { recursive: true, force: true })
  })

  test("D2: edit, move and create offline → '3 waiting'; reconnect → all three land and a fresh read matches", async () => {
    const a = await card(`d2 edit ${Date.now()}`)
    const b = await card(`d2 move ${Date.now()}`)
    await readAtlasBoardWithEdits(BLOQ, { fresh: "1" }) // the board is opened: this machine keeps its copy

    offline = true
    const newTitle = `d2 created offline ${Date.now()}`
    expect(await saveCard(a, { title: "d2 edited offline" })).toMatchObject({ ok: true, queued: true })
    expect(await moveCard(b, LIST, 0)).toMatchObject({ ok: true, queued: true })
    const c = await createCard(BLOQ, LIST, { title: newTitle })
    expect(c).toMatchObject({ ok: true, queued: true })
    expect(c.id!).toBeLessThan(0)

    const shown = await readAtlasBoardWithEdits(BLOQ, { fresh: "1" })
    expect(shown).toMatchObject({ offline: true, outbox: { waiting: 3, held: 0 } })
    const items = shown.r.data.lists.flatMap((l) => l.items) as any[]
    expect(items.find((i) => i.id === a)).toMatchObject({ title: "d2 edited offline", pending: "waiting" })
    expect(items.find((i) => i.id === c.id)).toMatchObject({ title: newTitle, pending: "waiting" })

    offline = false
    const sent = await outbox.replay(userId)
    console.log(`  reconnect → ${JSON.stringify(sent)}`)
    expect(sent).toEqual({ sent: 3, held: 0, waiting: 0, offline: false })

    expect((await live(a))!.title).toBe("d2 edited offline")
    const list = (await fetchAtlas(BLOQ)).data.lists.find((l) => l.id === LIST)!
    expect(list.items[0].id).toBe(b)
    const created = list.items.find((i) => i.title === newTitle)
    expect(created).toBeDefined()
    made.push(created!.id)
    expect(outbox.counts(userId)).toEqual({ waiting: 0, held: 0 })
  })

  test("D3: fields that don't overlap merge — your title offline, their status online, both survive", async () => {
    const id = await card(`d3 merge ${Date.now()}`)
    await readAtlasBoardWithEdits(BLOQ, { fresh: "1" })
    offline = true
    expect(await saveCard(id, { title: "d3 my title" })).toMatchObject({ queued: true })
    offline = false
    await otherWriter(id, { status: "in_progress" })

    expect(await outbox.replay(userId)).toMatchObject({ sent: 1, held: 0 })
    expect(await live(id)).toMatchObject({ title: "d3 my title", status: "in_progress" })
  })

  test("D3: the same field changed both ways is held with both values — nothing dropped — and the person decides", async () => {
    const id = await card(`d3 clash ${Date.now()}`)
    await readAtlasBoardWithEdits(BLOQ, { fresh: "1" })
    offline = true
    expect(await saveCard(id, { title: "d3 mine", status: "done" })).toMatchObject({ queued: true })
    offline = false
    await otherWriter(id, { title: "d3 theirs" })

    expect(await outbox.replay(userId)).toMatchObject({ sent: 0, held: 1 })
    // Their title stands for now; your status, which they did not touch, already landed.
    expect(await live(id)).toMatchObject({ title: "d3 theirs", status: "done" })

    const shown = await readAtlasBoardWithEdits(BLOQ, { fresh: "1" })
    const held = shown.outbox!.heldItems[0]
    console.log(`  held: ${held.message} ${JSON.stringify(held.fields)}`)
    expect(held).toMatchObject({ itemId: id, kind: "conflict", fields: [{ field: "title", mine: "d3 mine", theirs: "d3 theirs" }] })
    expect((shown.r.data.lists.flatMap((l) => l.items) as any[]).find((i) => i.id === id).pending).toBe("held")

    expect((await outbox.resolve(userId, held.opId, "mine")).ok).toBe(true)
    expect((await live(id))!.title).toBe("d3 mine")
    expect(outbox.counts(userId)).toEqual({ waiting: 0, held: 0 })
  })
})
