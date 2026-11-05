import { describe, expect, test } from "bun:test"
import {
  agoOf,
  createSwrCache,
  failedPart,
  fetchHomeDashboard,
  keepGoodParts,
  sliceOf,
  verbOf,
  type HomeDashboardData,
} from "./home-dashboard-data"

const clock = () => {
  let t = 0
  return { now: () => t, advance: (ms: number) => (t += ms) }
}
const settle = () => new Promise((r) => setTimeout(r, 0))
const counter = <T>(value: (n: number) => T) => {
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
    return {
      saved,
      load: (k: string) => saved.get(k),
      save: (k: string, e: { value: number; at: number }) => void saved.set(k, e),
    }
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
    beats: beatsFailed
      ? failedPart({ measured: false, heartbeats: [] }, "engine 502")
      : { measured: true, heartbeats: [] },
    accounts: { accounts: [{ id: n, active: true }] },
    recent: { measured: true, items: [] },
    at: n,
  })

  test("a part that failed keeps the last good one; the rest move on", () => {
    const merged = keepGoodParts(data(1), data(2, true))
    expect(merged.beats.measured).toBe(true)
    expect(merged.inbox.unread).toBe(2)
    expect(merged.at).toBe(2)
  })
})

describe("Home tab helpers", () => {
  test("sliceOf pages five at a time and clamps the page", () => {
    const all = Array.from({ length: 12 }, (_, i) => i + 1)
    expect(sliceOf(all, 1)).toMatchObject({ items: [1, 2, 3, 4, 5], page: 1, pages: 3, from: 1, to: 5, total: 12 })
    expect(sliceOf(all, 3)).toMatchObject({ items: [11, 12], from: 11, to: 12 })
    expect(sliceOf(all, 9).page).toBe(3)
    expect(sliceOf([], 1)).toMatchObject({ items: [], pages: 1, from: 0, to: 0 })
  })
  test("agoOf speaks in the table's short form", () => {
    const now = Date.parse("2026-11-05T12:00:00Z")
    expect(agoOf("2026-11-05T11:59:40Z", now)).toBe("now")
    expect(agoOf("2026-11-05T11:55:00Z", now)).toBe("5m")
    expect(agoOf("2026-11-05T09:00:00Z", now)).toBe("3h")
    expect(agoOf("2026-11-03T12:00:00Z", now)).toBe("2d")
    expect(agoOf(undefined, now)).toBe("—")
  })
  test("verbOf: created unless touched more than two minutes later", () => {
    expect(verbOf({ createdAt: "2026-11-05T01:00:00Z", updatedAt: "2026-11-05T01:01:00Z" })).toBe("created")
    expect(verbOf({ createdAt: "2026-11-05T01:00:00Z", updatedAt: "2026-11-05T03:00:00Z" })).toBe("edited")
  })
})

describe("progressive Home (#192535)", () => {
  test("each part is reported as it lands — the slowest read no longer holds the rest back", async () => {
    let release!: () => void
    const slow = new Promise<void>((resolve) => (release = resolve))
    const fetch = (async (url: string | URL | Request) => {
      if (String(url).includes("/iris/heartbeats")) await slow
      const body = {
        measured: true,
        nodes: [],
        agents: [],
        heartbeats: [],
        bloqs: [],
        accounts: [],
        items: [],
        unread: 0,
      }
      return new Response(JSON.stringify(body))
    }) as unknown as typeof globalThis.fetch
    const beatsSeen: boolean[] = []
    const done = fetchHomeDashboard("http://engine", fetch, (partial) => beatsSeen.push(partial.beats.measured))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(beatsSeen).toEqual([false, false, false, false, false, false])
    release()
    const final = await done
    expect(final.beats.measured).toBe(true)
    expect(beatsSeen.length).toBe(7)
  })

  test("a part not back yet keeps the last good copy instead of blanking it", async () => {
    const fetch = (async () => new Response("{}", { status: 500 })) as unknown as typeof globalThis.fetch
    const partials: HomeDashboardData[] = []
    await fetchHomeDashboard("http://engine", fetch, (p) => partials.push(p))
    const good = { ...partials[0], beats: { measured: true, heartbeats: [] } }
    expect(keepGoodParts(good, partials[0]).beats.measured).toBe(true)
  })

  test("the cache passes progress to listeners merged over the last copy, and keeps only the final value", async () => {
    const cache = createSwrCache<number>({
      freshMs: 60_000,
      staleMs: 600_000,
      merge: (prev, next) => (next < 0 ? prev : next),
    })
    const heard: number[] = []
    cache.subscribe((_, value) => heard.push(value))
    await cache.load("k", async () => 5)
    await cache.load("k", async (progress) => {
      progress(-1)
      progress(7)
      return 9
    })
    expect(heard).toEqual([5, 5, 7, 9])
    expect(cache.read("k", async () => 0)).toBe(9)
  })
})
