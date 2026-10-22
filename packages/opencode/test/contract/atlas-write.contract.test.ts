/**
 * CONTRACT: a write based on a stale card is refused, never silently applied (#190537 D1).
 *
 * Runs against a DEPLOYED fl-api, on a scratch board that holds no real data:
 *
 *   IRIS_CONTRACT=1 IRIS_CONTRACT_BLOQ=811 IRIS_CONTRACT_LIST=2953 bun test test/contract/atlas-write.contract.test.ts
 *
 * The shape it pins is the one every client has today — the web UI, Desktop, agents,
 * `bloqs update-item`: read a card, change one thing, save the whole card back. Two clients that
 * read the same card both save; the second save silently puts back what the first one changed.
 *
 * The contract (W1): every write carries `base_rev`, the card rev it was read at (from
 * `?ids=` / `?version=1`, BoardVersionService). A write whose base is no longer the card's rev
 * gets 409 with the current card, so the client can merge instead of overwrite.
 *
 * Expected to FAIL until fl-api W1 is deployed — that failure is the point of writing it first.
 * No fake anywhere: every request goes to the real server.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { irisFetch, resolveUserId } from "../../src/cli/cmd/iris-api"

const ON = process.env.IRIS_CONTRACT === "1"
const BLOQ = Number(process.env.IRIS_CONTRACT_BLOQ ?? 0)
const LIST = Number(process.env.IRIS_CONTRACT_LIST ?? 0)
const made: number[] = []

async function json(res: Response): Promise<any> {
  const t = await res.text()
  try {
    const j = JSON.parse(t)
    return j?.data ?? j
  } catch {
    return { raw: t.slice(0, 300) }
  }
}

async function createCard(title: string): Promise<number> {
  const userId = await resolveUserId()
  const res = await irisFetch(`/api/v1/user/${userId}/bloqs/${BLOQ}/lists/${LIST}/items`, {
    method: "POST",
    body: JSON.stringify({ title, content: "original body", type: "default", status: "todo" }),
  })
  expect(res.ok).toBe(true)
  const id = Number((await json(res))?.id)
  made.push(id)
  return id
}

/** The card as a client holds it after reading: its fields and its rev. */
async function readCard(id: number): Promise<{ title: string; content: string; status: string; rev: string } | null> {
  const userId = await resolveUserId()
  const res = await irisFetch(`/api/v1/user/${userId}/bloqs/${BLOQ}?ids=${id}`)
  const board = await json(res)
  for (const l of board?.lists ?? []) for (const i of l.items ?? []) if (i.id === id) return i
  return null
}

function save(id: number, body: Record<string, unknown>) {
  return irisFetch(`/api/v1/user/bloqs/list/item/${id}`, { method: "PUT", body: JSON.stringify(body) })
}

describe.skipIf(!ON || !BLOQ || !LIST)("contract: stale writes are refused (#190537 D1)", () => {
  afterAll(async () => {
    for (const id of made) await irisFetch(`/api/v1/user/bloqs/list/item/${id}`, { method: "DELETE" }).catch(() => {})
  })

  test("two clients save the same card: the second, stale save gets 409 and the first edit survives", async () => {
    const id = await createCard(`w0 race ${Date.now()}`)
    const a = (await readCard(id))!
    const b = { ...a } // client B read the same card at the same moment
    expect(typeof a.rev).toBe("string")

    const first = await save(id, { title: "edited by A", content: a.content, status: a.status, base_rev: a.rev })
    expect(first.status).toBe(200)

    // B changes only the status, and saves the whole card as it read it — what every client does.
    const second = await save(id, { title: b.title, content: b.content, status: "done", base_rev: b.rev })
    const after = (await readCard(id))!
    console.log(`  second save → HTTP ${second.status}; title after both saves: ${JSON.stringify(after.title)}`)

    expect(after.title).toBe("edited by A") // A's edit must not be silently undone
    expect(second.status).toBe(409)
    const body = await json(second)
    expect(body?.current?.rev).toBe(after.rev) // the refusal hands back what to merge with
  })

  test("a save based on the current rev still succeeds (the guard does not block normal edits)", async () => {
    const id = await createCard(`w0 fresh ${Date.now()}`)
    const a = (await readCard(id))!
    const res = await save(id, { title: a.title, content: a.content, status: "done", base_rev: a.rev })
    expect(res.status).toBe(200)
    expect((await readCard(id))!.status).toBe("done")
  })

  test("deleting a card someone changed since you read it is refused", async () => {
    const id = await createCard(`w0 delete ${Date.now()}`)
    const stale = (await readCard(id))!
    expect((await save(id, { title: "edited after the read", base_rev: stale.rev })).status).toBe(200)

    const del = await irisFetch(`/api/v1/user/bloqs/list/item/${id}?base_rev=${stale.rev}`, { method: "DELETE" })
    const still = await readCard(id)
    console.log(`  stale delete → HTTP ${del.status}; card still there: ${still !== null}`)

    expect(still).not.toBeNull()
    expect(del.status).toBe(409)
  })
})
