import { describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, utimesSync, writeFileSync, readFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { limitToStore, readAtlasDiary, storeEarliest, type SourceSweep } from "./pulse-check-sweep"

// #189233, measured 2026-10-13 on v1.3.342: a 30-day sweep's prior window is days 30–60, and the
// Claude Code / opencode stores on that box only reached back to Oct 3 — so every topic read
// "106 vs 0" momentum. With a 7-day window the same sweep said "46 vs 45".
const DAY = 864e5
const NOW = Date.parse("2026-10-13T01:00:00Z")
const sweep = (): SourceSweep => ({ source: "claude_code", searched: true, hits: 106, hitsPrior: 0, items: [], matchedVariants: ["x"] }) as any
const opts = (windowDays: number) => ({ keyword: "x", windowDays, limit: 5 }) as any

describe("a session store only testifies about what it still holds", () => {
  test("store younger than the prior window → no prior (not 0), and it says how far back it reaches", () => {
    const s = limitToStore(sweep(), Date.parse("2026-10-03T00:00:00Z"), opts(30), NOW)
    expect(s.hitsPrior).toBeUndefined()
    expect(s.unavailableReason).toContain("only go back to 2026-10-03")
    expect(s.unavailableReason).toContain("this window covers 10 of 30 days")
  })
  test("store that reaches past the prior window keeps its prior", () => {
    const s = limitToStore(sweep(), NOW - 20 * DAY, opts(7), NOW)
    expect(s.hitsPrior).toBe(0)
    expect(s.unavailableReason).toBeUndefined()
  })
  test("store covering the window but not the prior one → prior dropped, window whole", () => {
    const s = limitToStore(sweep(), NOW - 10 * DAY, opts(7), NOW)
    expect(s.hitsPrior).toBeUndefined()
    expect(s.unavailableReason).not.toContain("covers")
  })
  test("an existing note is kept, not overwritten", () => {
    const s = limitToStore({ ...sweep(), unavailableReason: "left out the session running this check (13 transcript files)" }, NOW - 3 * DAY, opts(30), NOW)
    expect(s.unavailableReason!.startsWith("left out the session running this check")).toBe(true)
  })
  test("storeEarliest finds the oldest file of that kind, nested, ignoring others", () => {
    const root = mkdtempSync(join(tmpdir(), "store-"))
    mkdirSync(join(root, "proj", "sub"), { recursive: true })
    const f = (p: string, ms: number) => {
      writeFileSync(join(root, p), "x")
      utimesSync(join(root, p), ms / 1000, ms / 1000)
    }
    f("proj/a.jsonl", NOW - 5 * DAY)
    f("proj/sub/b.jsonl", NOW - 9 * DAY)
    f("proj/old.txt", NOW - 90 * DAY)
    expect(Math.round(storeEarliest(root, ".jsonl")!)).toBe(Math.round(NOW - 9 * DAY))
    expect(storeEarliest(join(root, "missing"), ".jsonl")).toBeUndefined()
  })
})

describe("one Atlas diary reader for pulse check and pulse --admin", () => {
  const fetchOf = (routes: Record<string, any>) => async (path: string) => {
    const hit = Object.keys(routes).find((k) => path.includes(k))
    return new Response(JSON.stringify(hit ? routes[hit] : {}), { status: hit ? 200 : 404 })
  }
  const routes = {
    "bloqs?simplified": { data: [{ id: 9, name: "Daily Diary" }, { id: 10, name: "Sales" }] },
    "bloqs/9": {
      data: {
        lists: [
          {
            name: "Daily Diary",
            items: [
              { id: 1, title: "2026-10-12 — heartbeats truth", description: "## Summary\nShipped the week chart" },
              { id: 2, title: "2026-09-01", description: "old" },
            ],
          },
          { name: "Ideas", items: [{ id: 3, title: "2026-10-12", description: "not a diary list" }] },
        ],
      },
    },
  }
  test("reads only diary boards' diary lists, newest first, since the cutoff", async () => {
    const r = await readAtlasDiary(fetchOf(routes), 193, Date.parse("2026-10-11T00:00:00Z"))
    expect("error" in r).toBe(false)
    if ("error" in r) return
    expect(r.lists).toBe(1)
    expect(r.entries.map((e) => e.title)).toEqual(["2026-10-12 — heartbeats truth"])
    expect(r.entries[0].where).toBe("Atlas · Daily Diary #1")
  })
  test("signed out → says why, never an empty success", async () => {
    expect(await readAtlasDiary(fetchOf(routes), undefined, 0)).toEqual({ error: "not signed in to read the Atlas diary" })
  })
  test("pulse --admin's JSON diary is the diary, not the scorecard digest", () => {
    const src = readFileSync(join(import.meta.dir, "platform-leads.ts"), "utf8")
    expect(src).toContain("diary: diaryLines.slice(0, 5),")
    expect(src).not.toContain("diary: lines.slice(0, 5),")
    expect(src).toContain("readAtlasDiary((p: string) => irisFetch(p)")
  })
})
