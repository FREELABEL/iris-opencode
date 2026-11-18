import { describe, expect, test } from "bun:test"
import { itemHintForMissingBloq } from "./platform-bloqs"

// #190209 — `iris bloqs get 190207` (an item id) answered only 404 "Bloq not found".
const ok = async () => new Response("{}", { status: 200 })
const missing = async () => new Response("{}", { status: 404 })

describe("itemHintForMissingBloq", () => {
  test("an item id gets the atlas use hint and the --json shape", async () => {
    const h = await itemHintForMissingBloq(190207, ok)
    expect(h?.message).toBe("#190207 is an Atlas item, not a board — read it with: iris atlas use 190207")
    expect(h?.json).toEqual({ success: false, error: "Bloq not found.", hint: "item", item_id: 190207 })
  })
  test("an id that is neither gets no hint", async () => {
    expect(await itemHintForMissingBloq("190207", missing)).toBeNull()
  })
  test("a name or a failing probe gets no hint", async () => {
    expect(await itemHintForMissingBloq("my board", ok)).toBeNull()
    expect(await itemHintForMissingBloq(5, async () => { throw new Error("net") })).toBeNull()
  })
})
