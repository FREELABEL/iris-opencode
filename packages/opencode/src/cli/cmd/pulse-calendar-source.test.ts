import { describe, expect, test } from "bun:test"
import { sweepCalendar, type SweepOptions } from "./pulse-check-sweep"
import type { FoundEvent, SearchResult, SearchSource } from "./calendar-search"

// #190968 — Pulse had no calendar stop: a topic you met about three times this week read the same
// as one nobody had touched. It reads through the same search `iris calendar search` uses.
const DAY = 864e5
const now = Date.now()
const ev = (title: string, at: number, cal = "alex@freelabel.net · Work"): FoundEvent => ({
  title,
  start: new Date(at).toISOString(),
  attendees: [],
  seenIn: [cal],
})
const ok = (name: string): SearchSource => ({ name, kind: "google", status: "ok", count: 0 })
const fake = (events: FoundEvent[], sources: SearchSource[]) => async (query: string, from: Date, to: Date) => {
  seen = { query, from, to }
  return { result: { query, window: { from: from.toISOString(), to: to.toISOString() }, events, sources, complete: true } as SearchResult }
}
let seen: { query: string; from: Date; to: Date } | null = null
const opts = (o: Partial<SweepOptions> = {}): SweepOptions =>
  ({ keyword: "hive sessions", repo: "/tmp", windowDays: 7, limit: 10, sources: ["calendar"], ...o }) as SweepOptions

describe("topic route — calendar stop", () => {
  test("counts meetings that happened this window and the one before, over both windows", async () => {
    const sw = await sweepCalendar(opts(), fake([ev("Hive sessions review", now - DAY), ev("Hive sessions kickoff", now - 9 * DAY)], [ok("alex@freelabel.net")]))
    expect(sw.searched).toBe(true)
    expect(sw.source).toBe("calendar")
    expect(sw.hits).toBe(1)
    expect(sw.hitsPrior).toBe(1)
    expect(sw.items[0].where).toContain("Hive sessions review")
    expect(seen!.query).toBe("hive sessions")
    expect(now - seen!.from.getTime()).toBeGreaterThanOrEqual(14 * DAY - 1000)
  })

  test("a meeting still to come is a plan, not recency — left out", async () => {
    const sw = await sweepCalendar(opts(), fake([ev("Hive sessions demo", now + 2 * DAY)], [ok("alex@freelabel.net")]))
    expect(sw.hits).toBe(0)
    expect(sw.lastHitEpoch).toBeUndefined()
  })

  test("no calendar readable is a SHUT stop with the reason, never 0 found", async () => {
    const sw = await sweepCalendar(opts(), fake([], [{ name: "alex@freelabel.net", kind: "google", status: "failed", count: 0, reason: "token expired" }]))
    expect(sw.searched).toBe(false)
    expect(sw.unavailableReason).toContain("token expired")
    const none = await sweepCalendar(opts(), fake([], []))
    expect(none.searched).toBe(false)
    expect(none.unavailableReason).toMatch(/no calendar/)
  })

  test("a partial search counts what it read and names what it could not", async () => {
    const sw = await sweepCalendar(
      opts(),
      fake([ev("Hive sessions sync", now - DAY)], [ok("alex@freelabel.net"), { name: "Apple Calendar", kind: "apple", status: "failed", count: 0, reason: "no access" }]),
    )
    expect(sw.searched).toBe(true)
    expect(sw.hits).toBe(1)
    expect(sw.unavailableReason).toContain("Apple Calendar")
  })

  test("a search that throws is a SHUT stop", async () => {
    const sw = await sweepCalendar(opts(), async () => {
      throw new Error("not signed in")
    })
    expect(sw.searched).toBe(false)
    expect(sw.unavailableReason).toContain("not signed in")
  })
})
