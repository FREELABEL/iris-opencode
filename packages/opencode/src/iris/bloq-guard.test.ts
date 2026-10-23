import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import * as platform from "./platform"
import { unknownBloqReason } from "./platform"

const listOf = (ids: number[]) => ({ measured: true, data: { bloqs: ids.map((id) => ({ id, name: `b${id}` })) } })

describe("unknownBloqReason", () => {
  test("rejects an id the account does not have", () => {
    // Why this guard exists: iris-api answers 200 with an EMPTY page list for a bloq that
    // cannot exist, so for /iris/pages the honest answer and the reassuring one were the same
    // JSON until something checked the id first.
    expect(unknownBloqReason(99999999, listOf([674, 571]))).toBe("unknown bloq 99999999")
  })

  test("allows an id the account does have", () => {
    expect(unknownBloqReason(571, listOf([674, 571]))).toBeNull()
  })

  test("FAILS OPEN when the bloq list could not be measured", () => {
    // The important one. Offline or 401, we cannot list bloqs — and a guard that cannot verify
    // must decline to judge rather than invent a verdict. Returning a reason here would make
    // every surface report "unknown bloq" during an outage, which is a confident wrong answer
    // dressed as a careful one.
    expect(unknownBloqReason(571, { measured: false, reason: "fl-api 401", data: { bloqs: [] } })).toBeNull()
  })

  test("an account with genuinely no bloqs still rejects", () => {
    // Measured and empty is a real answer: you have no bloqs, so this id is not one of yours.
    expect(unknownBloqReason(1, listOf([]))).toBe("unknown bloq 1")
  })
})

// #190231 phase 0b — the guard reuses the board list the picker just fetched.
describe("unknownBloq shares one board-list request", () => {
  const spies: { mockRestore(): void }[] = []
  let calls = 0
  let lists: (number[] | "fail")[] = []
  let user = 7

  beforeEach(() => {
    platform.resetRecentBloqs()
    calls = 0
    user = 7
    spies.push(spyOn(platform, "resolveUserId").mockImplementation(async () => user))
    spies.push(
      spyOn(platform, "irisFetch").mockImplementation((async (p: string) => {
        if (!p.includes("/bloqs?simplified=true")) throw new Error(`unexpected ${p}`)
        const next = lists[Math.min(calls, lists.length - 1)]
        calls++
        await new Promise((r) => setTimeout(r, 20)) // in flight long enough for the guard to join it
        if (next === "fail") return new Response("{}", { status: 500 })
        return Response.json({ data: next.map((id) => ({ id, name: `b${id}` })) })
      }) as any),
    )
  })
  afterEach(() => {
    while (spies.length) spies.pop()!.mockRestore()
  })

  test("the picker's request and the guard's are ONE upstream call", async () => {
    lists = [[42]]
    const [, verdict] = await Promise.all([platform.fetchBloqs(), platform.unknownBloq(42)])
    expect(verdict).toBeNull()
    expect(calls).toBe(1)
  })

  test("a board made a moment ago is asked about fresh, never refused from the reused list", async () => {
    lists = [[42], [42, 77]]
    await platform.fetchBloqs()
    expect(await platform.unknownBloq(77)).toBeNull()
    expect(calls).toBe(2)
  })

  test("an id that really is not yours is still refused", async () => {
    lists = [[42]]
    await platform.fetchBloqs()
    expect(await platform.unknownBloq(99999999)).toBe("unknown bloq 99999999")
  })

  test("a failed list is never reused: the guard asks again, and fails open if it still fails", async () => {
    lists = ["fail", "fail"]
    await platform.fetchBloqs()
    expect(await platform.unknownBloq(42)).toBeNull()
    expect(calls).toBe(2)
  })

  test("another account's list is not reused", async () => {
    lists = [[42], [55]]
    await platform.fetchBloqs()
    user = 8
    expect(await platform.unknownBloq(42)).toBe("unknown bloq 42")
    expect(calls).toBeGreaterThanOrEqual(2)
  })
})

describe("unknownBloq prefers a list already in hand", () => {
  const spies: { mockRestore(): void }[] = []
  let calls = 0
  afterEach(() => {
    while (spies.length) spies.pop()!.mockRestore()
  })

  test("a finished list from seconds ago answers at once, without waiting for the picker's newer request", async () => {
    platform.resetRecentBloqs()
    calls = 0
    spies.push(spyOn(platform, "resolveUserId").mockResolvedValue(7))
    spies.push(
      spyOn(platform, "irisFetch").mockImplementation((async () => {
        calls++
        await new Promise((r) => setTimeout(r, calls === 1 ? 5 : 300)) // the second request is slow
        return Response.json({ data: [{ id: 42, name: "b42" }] })
      }) as any),
    )
    await platform.fetchBloqs() // the list a moment ago
    void platform.fetchBloqs() // the picker asks again, slowly
    const t0 = Date.now()
    expect(await platform.unknownBloq(42)).toBeNull()
    expect(Date.now() - t0).toBeLessThan(100)
  })
})
