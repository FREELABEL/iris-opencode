import { describe, expect, test } from "bun:test"
import { createSwrCache, failedPart, keepGoodParts, type HomeDashboardData } from "./home-dashboard-data"

const clock = () => {
  let t = 0
  return { now: () => t, advance: (ms: number) => (t += ms) }
}
const settle = () => new Promise((r) => setTimeout(r, 0))
const counter = <T,>(value: (n: number) => T) => {
  let calls = 0
  return { fetch: async () => value(++calls), calls: () => calls }
}

describe("createSwrCache", () => {
  test("a fresh copy is served without a fetch", async () => {
    const c = clock()
    const cache = createSwrCache<number>({ freshMs: 60, staleMs: 600, now: c.now })
    const src = counter((n) => n)
    await cache.load("k", src.fetch)
    c.advance(30)
    expect(cache.read("k", src.fetch)).toBe(1)
    expect(src.calls()).toBe(1)
  })

  test("a stale copy is served at once and refreshed behind it", async () => {
    const c = clock()
    const cache = createSwrCache<number>({ freshMs: 60, staleMs: 600, now: c.now })
    const src = counter((n) => n)
    await cache.load("k", src.fetch)
    c.advance(120)
    const seen: number[] = []
    cache.subscribe((_, v) => seen.push(v))
    expect(cache.read("k", src.fetch)).toBe(1)
    await settle()
    expect(src.calls()).toBe(2)
    expect(seen).toEqual([2])
  })

  test("an expired copy is not shown", async () => {
    const c = clock()
    const cache = createSwrCache<number>({ freshMs: 60, staleMs: 600, now: c.now })
    const src = counter((n) => n)
    await cache.load("k", src.fetch)
    c.advance(601)
    expect(cache.read("k", src.fetch)).toBeUndefined()
  })

  test("callers share one read in flight", async () => {
    const cache = createSwrCache<number>({ freshMs: 60, staleMs: 600 })
    const src = counter((n) => n)
    await Promise.all([cache.load("k", src.fetch), cache.load("k", src.fetch), cache.load("k", src.fetch)])
    expect(src.calls()).toBe(1)
  })

  test("a failed read keeps the good copy", async () => {
    const cache = createSwrCache<number>({ freshMs: 60, staleMs: 600 })
    await cache.load("k", async () => 1)
    await cache.load("k", async () => Promise.reject(new Error("down"))).catch(() => {})
    expect(cache.read("k", async () => 3)).toBe(1)
  })

  test("warm reads only when there is no copy younger than maxAge", async () => {
    const c = clock()
    const cache = createSwrCache<number>({ freshMs: 60, staleMs: 600, now: c.now })
    const src = counter((n) => n)
    cache.warm("k", src.fetch, 300)
    await settle()
    c.advance(200)
    cache.warm("k", src.fetch, 300)
    expect(src.calls()).toBe(1)
    c.advance(200)
    cache.warm("k", src.fetch, 300)
    expect(src.calls()).toBe(2)
  })
})

describe("createSwrCache storage", () => {
  const memory = () => {
    const saved = new Map<string, { value: number; at: number }>()
    return { saved, load: (k: string) => saved.get(k), save: (k: string, e: { value: number; at: number }) => void saved.set(k, e) }
  }

  test("a stored copy is served after a reload, without a fetch while it is fresh", () => {
    const store = memory()
    store.saved.set("k", { value: 7, at: 0 })
    const cache = createSwrCache<number>({ freshMs: 60, staleMs: 600, now: () => 30, storage: store })
    const src = counter((n) => n)
    expect(cache.read("k", src.fetch)).toBe(7)
    expect(src.calls()).toBe(0)
  })

  test("a stored copy past fresh is served and refreshed, and the refresh is stored", async () => {
    const store = memory()
    store.saved.set("k", { value: 7, at: 0 })
    const cache = createSwrCache<number>({ freshMs: 60, staleMs: 600, now: () => 120, storage: store })
    expect(cache.read("k", async () => 8)).toBe(7)
    await settle()
    expect(store.saved.get("k")?.value).toBe(8)
  })

  test("an expired stored copy is not shown", () => {
    const store = memory()
    store.saved.set("k", { value: 7, at: 0 })
    const cache = createSwrCache<number>({ freshMs: 60, staleMs: 600, now: () => 601, storage: store })
    expect(cache.read("k", async () => 8)).toBeUndefined()
  })
})

describe("keepGoodParts", () => {
  const data = (n: number, beatsFailed = false): HomeDashboardData => ({
    hive: { measured: true, nodes: [] },
    agents: { measured: true, agents: [] },
    inbox: { measured: true, unread: n },
    bloqs: { measured: true, total: n, bloqs: [] },
    beats: beatsFailed ? failedPart({ measured: false, heartbeats: [] }, "engine 502") : { measured: true, heartbeats: [] },
    accounts: { accounts: [{ id: n, active: true }] },
    at: n,
  })

  test("a part that failed keeps the last good one; the rest move on", () => {
    const merged = keepGoodParts(data(1), data(2, true))
    expect(merged.beats.measured).toBe(true)
    expect(merged.inbox.unread).toBe(2)
    expect(merged.at).toBe(2)
  })
})
