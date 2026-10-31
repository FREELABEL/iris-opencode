import { describe, expect, test } from "bun:test"
import { matchNote, searchRecords, splitAtlasResults } from "./platform-bloqs"

/**
 * #191251 (fl-api #202): "trading options portfolio" found 0 boards because every word had to
 * match. The server now relaxes to ANY word and says so (`match` on /atlas/search, `data.search`
 * on content-items). These pin that the CLI asks the server for boards (never filters them itself
 * when the server can answer), and that the server's note survives into human and --json output.
 */

const BOARD_300 = { type: "board", id: 300, title: "DELO Alert — AI Trading Agents", snippet: "", board_id: 300, board: "DELO Alert — AI Trading Agents", found_by: ["words"] }
const RELAXED = {
  mode: "any",
  words: ["trading", "options", "portfolio"],
  relaxed: true,
  relaxed_types: ["boards"],
  note: "No result contains all 3 words (trading, options, portfolio). Showing results that contain at least one, most words first — the best matched 1 of 3 words.",
}

function fake(opts: { atlas?: "relaxing" | "strict" | "missing"; boardsList?: any[]; contentSearch?: any } = {}) {
  const calls: string[] = []
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
  const fetcher = async (path: string) => {
    calls.push(path)
    if (path.startsWith("/api/v1/atlas/search?")) {
      if (opts.atlas === "missing") return json(404, { message: "Not Found" })
      if (opts.atlas === "strict") return json(200, { query: "x", count: 0, results: [], lanes: { words: "ran" }, failed_types: [] })
      return json(200, {
        query: "trading options portfolio",
        count: 1,
        results: [{ ...BOARD_300, matched_terms: 1, matched_words: "1 of 3 words" }],
        match: RELAXED,
        lanes: { words: "ran", meaning: "not built yet (S3 of #187964)" },
        failed_types: [],
      })
    }
    if (path === "/api/v1/user/7/bloqs") return json(200, { data: opts.boardsList ?? [] })
    if (path.startsWith("/api/v1/user/7/bloqs/content-items?") || path.startsWith("/api/v1/user/7/bloqs/550/items?")) {
      return json(200, { success: true, data: { items: [{ id: 1, title: "Options wheel notes", matched_words: "2 of 3 words", matched_terms: 2 }], ...(opts.contentSearch ? { search: opts.contentSearch } : {}) } })
    }
    return json(404, {})
  }
  return { fetcher, calls }
}

const base = { query: "trading options portfolio", limit: 20, userId: 7, wantItems: true, wantBoards: true }

describe("bloqs search — boards come from the server's word engine (#191251)", () => {
  test("default search: one /atlas/search call; the relaxed board and the server's match block come back", async () => {
    const f = fake()
    const r = await searchRecords({ ...base, types: ["items", "boards", "pages"] }, f.fetcher)
    expect(f.calls).toHaveLength(1)
    expect(f.calls[0]).toContain("/api/v1/atlas/search?")
    expect(r.boards).toEqual([{ id: 300, name: "DELO Alert — AI Trading Agents", found_by: ["words"], matched_words: "1 of 3 words", matched_terms: 1 }])
    expect(r.match).toEqual(RELAXED)
    expect(r.showBoards).toBe(true)
  })

  test("--bloq: boards still come from atlas/search?type=boards — not a client-side every-word filter", async () => {
    const f = fake({ boardsList: [{ id: 300, name: "DELO Alert — AI Trading Agents" }] })
    const r = await searchRecords({ ...base, types: ["items", "boards", "pages"], bloq: 550 }, f.fetcher)
    expect(f.calls.some((c) => c.startsWith("/api/v1/atlas/search?") && c.includes("type=boards"))).toBe(true)
    expect(f.calls).not.toContain("/api/v1/user/7/bloqs")
    expect(r.boards.map((b) => b.id)).toEqual([300])
    expect(r.items.map((i) => i.id)).toEqual([1])
    expect(f.calls.some((c) => c.startsWith("/api/v1/user/7/bloqs/550/items?"))).toBe(true)
  })

  test("a server without /atlas/search falls back to the old filter, and says nothing it was not told", async () => {
    const f = fake({ atlas: "missing", boardsList: [{ id: 300, name: "DELO Alert — AI Trading Agents" }, { id: 301, name: "Trading options portfolio desk" }] })
    const r = await searchRecords({ ...base, types: ["items", "boards", "pages"] }, f.fetcher)
    expect(r.usedAtlas).toBe(false)
    expect(r.boards.map((b) => b.id)).toEqual([301])
    expect(r.match).toBeNull()
  })

  test("content-items' data.search block is kept for --json", async () => {
    const search = { mode: "any", words: ["trading", "options", "portfolio"], relaxed: true, note: "No result contains all 3 words." }
    const f = fake({ atlas: "missing", contentSearch: search })
    const r = await searchRecords({ ...base, types: ["items", "boards", "pages"] }, f.fetcher)
    expect(r.search).toEqual(search)
    expect(r.items[0].matched_words).toBe("2 of 3 words")
  })
})

describe("matchNote", () => {
  test("prints the server's sentence when it relaxed", () => {
    expect(matchNote(RELAXED, null)).toBe(RELAXED.note)
  })
  test("no note when every word matched (strict, or an old server with no block)", () => {
    expect(matchNote({ mode: "all", words: ["a", "b"], relaxed: false }, null)).toBeNull()
    expect(matchNote(null, null)).toBeNull()
  })
  test("builds 'matched N of M words' itself when the server relaxed without a note", () => {
    expect(matchNote(null, { mode: "any", words: ["a", "b", "c"], relaxed: true }, [{ matched_terms: 2 }, { matched_terms: 1 }])).toBe(
      "No result contains all 3 words — showing the closest, best matched 2 of 3 words.",
    )
  })
  test("rows carry matched_words through splitAtlasResults", () => {
    const s = splitAtlasResults([{ type: "item", id: 9, title: "t", matched_words: "1 of 2 words", matched_terms: 1 }])
    expect(s.items[0]).toMatchObject({ id: 9, matched_words: "1 of 2 words", matched_terms: 1 })
  })
})
