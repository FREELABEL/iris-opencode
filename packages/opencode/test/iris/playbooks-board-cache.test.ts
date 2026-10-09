import { beforeEach, describe, expect, test } from "bun:test"
import { boardPlaybooksCached, clearBoardPlaybooks } from "../../src/iris/platform"

// One upstream load per board, shared by every view, served stale while it refreshes (2026-10-09:
// the board call took 10–14 s and each tab paid it again, every minute).
const ok = (names: string[]) => ({
  measured: true as const,
  data: { everything: names.map((name) => ({ name }) as any) },
})
const failed = { measured: false as const, reason: "fl-api 503", data: { everything: [] as any[] } }

function loader(results: any[]) {
  let calls = 0
  const fn = async () => results[Math.min(calls++, results.length - 1)]
  return { fn, calls: () => calls }
}
const flush = () => new Promise((r) => setTimeout(r, 0))

describe("board playbook load", () => {
  beforeEach(() => clearBoardPlaybooks())

  test("fresh: a second view of the same board does not load again", async () => {
    const l = loader([ok(["a"])])
    await boardPlaybooksCached(571, 1, 0, l.fn)
    const again = await boardPlaybooksCached(571, 1, 30_000, l.fn)
    expect(l.calls()).toBe(1)
    expect(again.data.everything.map((p: any) => p.name)).toEqual(["a"])
  })

  test("stale: answered at once with the old list, refreshed in the background", async () => {
    const l = loader([ok(["old"]), ok(["new"])])
    await boardPlaybooksCached(571, 1, 0, l.fn)
    const stale = await boardPlaybooksCached(571, 1, 120_000, l.fn)
    expect(stale.data.everything.map((p: any) => p.name)).toEqual(["old"])
    await flush()
    expect(l.calls()).toBe(2)
    const after = await boardPlaybooksCached(571, 1, 121_000, l.fn)
    expect(after.data.everything.map((p: any) => p.name)).toEqual(["new"])
  })

  test("a failed refresh never replaces a good list", async () => {
    const l = loader([ok(["good"]), failed])
    await boardPlaybooksCached(571, 1, 0, l.fn)
    await boardPlaybooksCached(571, 1, 120_000, l.fn) // stale → background refresh fails
    await flush()
    const now = await boardPlaybooksCached(571, 1, 121_000, l.fn)
    expect(now.measured).toBe(true)
    expect(now.data.everything.map((p: any) => p.name)).toEqual(["good"])
  })

  test("expired: older than ten minutes is waited for, not served", async () => {
    const l = loader([ok(["old"]), ok(["new"])])
    await boardPlaybooksCached(571, 1, 0, l.fn)
    const r = await boardPlaybooksCached(571, 1, 11 * 60_000, l.fn)
    expect(r.data.everything.map((p: any) => p.name)).toEqual(["new"])
  })

  test("concurrent callers share one load", async () => {
    const l = loader([ok(["a"])])
    await Promise.all([
      boardPlaybooksCached(571, 1, 0, l.fn),
      boardPlaybooksCached(571, 1, 0, l.fn),
      boardPlaybooksCached(571, 1, 0, l.fn),
    ])
    expect(l.calls()).toBe(1)
  })

  test("boards and accounts do not share a list", async () => {
    const l = loader([ok(["a"]), ok(["b"]), ok(["c"])])
    await boardPlaybooksCached(571, 1, 0, l.fn)
    await boardPlaybooksCached(652, 1, 0, l.fn)
    await boardPlaybooksCached(571, 2, 0, l.fn)
    expect(l.calls()).toBe(3)
  })

  test("a failed first load is not cached as an answer", async () => {
    const l = loader([failed, ok(["a"])])
    expect((await boardPlaybooksCached(571, 1, 0, l.fn)).measured).toBe(false)
    expect((await boardPlaybooksCached(571, 1, 1_000, l.fn)).data.everything.length).toBe(1)
  })
})
