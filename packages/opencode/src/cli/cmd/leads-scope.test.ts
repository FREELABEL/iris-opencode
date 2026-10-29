import { describe, expect, test } from "bun:test"
import {
  buildListRequest,
  buildSegmentFilters,
  describeListScope,
  emptyListMessage,
  leadDisplayName,
  LIST_SORTS,
  leadHasReplied,
  mergeResponders,
  parseListLimit,
  type ListScope,
} from "./leads-scope"

/**
 * #182078 — a partial answer must say so.
 *
 * `iris leads list` hides Prospected by default, caps by recency, and used to report
 * only the page size. Each behaviour is defensible alone; together, with no
 * population figure, they produced a confident partial answer indistinguishable from
 * a complete one. Six funnel KPIs were computed from it and published as measured
 * fact — over 56 rows out of 28,522.
 *
 * These lock the REPORTING, which is the part that failed. The filtering itself was
 * always correct.
 */
describe("describeListScope", () => {
  const full: ListScope = { shown: 20, total: 20, prospectedHidden: 0 }

  test("a complete answer says nothing extra — no false alarm", () => {
    const r = describeListScope(full)
    expect(r.truncated).toBe(false)
    expect(r.notes).toEqual([])
    expect(r.warnings).toEqual([])
  })

  test("truncation is named WITH the population, not just the page size", () => {
    const r = describeListScope({ shown: 20, total: 28522, prospectedHidden: 0 })
    expect(r.truncated).toBe(true)
    expect(r.notes.join(" ")).toContain("28522")
    // The page size alone is what the bug reported. Naming only `shown` is the defect.
    expect(r.notes.join(" ")).not.toBe("newest 20 of 20")
  })

  test("a hidden default filter is disclosed with the escape hatch", () => {
    const r = describeListScope({ shown: 20, total: 20, prospectedHidden: 62 })
    expect(r.notes.join(" ")).toContain("62")
    expect(r.notes.join(" ")).toContain("--all")
  })

  test("both conditions are reported together, not one or the other", () => {
    const r = describeListScope({ shown: 20, total: 28522, prospectedHidden: 62 })
    expect(r.notes).toHaveLength(2)
    expect(r.notes.join(" · ")).toContain("62")
    expect(r.notes.join(" · ")).toContain("28522")
  })

  test("machine-readable output carries a DO-NOT-COMPUTE warning", () => {
    // The KPIs were computed from --json, where the human-facing suffix never appears.
    // A silent truncation in JSON is the exact failure this guards.
    const r = describeListScope({ shown: 20, total: 28522, prospectedHidden: 62 })
    expect(r.warnings.some((w) => /TRUNCATED/.test(w))).toBe(true)
    expect(r.warnings.some((w) => /FILTERED/.test(w))).toBe(true)
    expect(r.warnings.join(" ")).toContain("not a population")
  })

  /**
   * #184945 — the window description must track the window.
   *
   * `leads list` sorted client-side over a server page ordered by created_at, so an
   * In Negotiation lead updated that same day sat past row 1000. Pushing the order to
   * the server fixes the window; these lock the half that silently rots afterwards —
   * the sentence describing it. "newest N of M" was hardcoded, and would have gone on
   * being printed under --sort name.
   */
  test("the ordering is quoted from the caller, not assumed", () => {
    const r = describeListScope({
      shown: 20,
      total: 28522,
      prospectedHidden: 0,
      ordering: "most recently active",
    })
    expect(r.notes.join(" ")).toContain("most recently active 20 of 28522")
    expect(r.warnings.join(" ")).toContain("most recently active 20 of 28522")
    // The old hardcoded wording must not survive a different ordering.
    expect(r.notes.join(" ")).not.toContain("newest")
    expect(r.warnings.join(" ")).not.toContain("by id")
  })

  test("a different ordering produces a different sentence", () => {
    const alpha = describeListScope({ shown: 20, total: 28522, prospectedHidden: 0, ordering: "first alphabetically" })
    const recent = describeListScope({ shown: 20, total: 28522, prospectedHidden: 0, ordering: "most recently active" })
    expect(alpha.notes.join(" ")).toContain("first alphabetically")
    expect(alpha.notes.join(" ")).not.toEqual(recent.notes.join(" "))
  })

  test("an absent or blank ordering degrades to a neutral word, never to a wrong one", () => {
    // Silence is fine. A confident "newest" that nobody verified is not.
    for (const ordering of [undefined, "", "   "]) {
      const r = describeListScope({ shown: 20, total: 28522, prospectedHidden: 0, ordering })
      expect(r.notes.join(" ")).toContain("first 20 of 28522")
      expect(r.notes.join(" ")).not.toContain("newest")
    }
  })

  test("ordering never fabricates truncation on a complete answer", () => {
    const r = describeListScope({ shown: 20, total: 20, prospectedHidden: 0, ordering: "most recently active" })
    expect(r.truncated).toBe(false)
    expect(r.notes).toEqual([])
    expect(r.warnings).toEqual([])
  })

  test("total below shown never invents a negative or a false truncation", () => {
    // Defensive: an API that omits `total` used to fall back to leads.length, which is
    // how truncation became undetectable by construction.
    const r = describeListScope({ shown: 20, total: 5, prospectedHidden: 0 })
    expect(r.truncated).toBe(false)
  })

  /**
   * #190003 — the hidden count describes the FETCHED WINDOW, not the book.
   *
   * The filter runs client-side over the rows the server returned (default fetch is
   * 100), then the list is trimmed to --limit. So the count is "how many Prospected
   * rows were among those 100", and it printed beside "20 of 28750". A reader sees
   * "73 Prospected hidden" and "20 of 28750" and cannot tell what either counts — the
   * two numbers look like they describe one population and do not.
   */
  test("the Prospected count names the window it was counted over", () => {
    const r = describeListScope({ shown: 20, total: 28750, prospectedHidden: 73, scanned: 100 })
    const line = r.notes.join(" · ")
    expect(line).toContain("73 Prospected hidden of 100 scanned")
    // Both figures still present, and now each is attributable.
    expect(line).toContain("28750")
    expect(r.warnings.join(" ")).toContain("of 100 scanned")
  })

  test("without a window the count stays unqualified rather than inventing one", () => {
    const r = describeListScope({ shown: 20, total: 20, prospectedHidden: 62 })
    expect(r.notes.join(" ")).toContain("62 Prospected hidden")
    expect(r.notes.join(" ")).not.toContain("scanned")
  })

  test("a window smaller than the page is not a window — no dangling 'of 3 scanned'", () => {
    // Defensive: `scanned` is a caller-supplied number. If it is nonsense, say less.
    const r = describeListScope({ shown: 20, total: 20, prospectedHidden: 2, scanned: 3 })
    expect(r.notes.join(" ")).not.toContain("scanned")
  })
})

describe("buildListRequest — #191690 filter in the query, not after the page", () => {
  test("the default list excludes Prospected ON THE SERVER, for every sort", () => {
    for (const sort of ["activity", "created", "name", "value"]) {
      const r = buildListRequest({ limit: 2, sort })
      expect(r.hidesProspected).toBe(true)
      expect(r.params.get("exclude_statuses")).toBe("Prospected")
    }
  })

  test("--sort created asks for exactly the page — no oversized window to filter after", () => {
    const r = buildListRequest({ limit: 2, sort: "created" })
    expect(r.params.get("per_page")).toBe("2")
    expect(r.params.get("sort_by")).toBe("created_at")
    expect(r.params.get("sort_direction")).toBe("desc")
  })

  test("--all, --status and --search do not exclude anything", () => {
    expect(buildListRequest({ limit: 5, all: true }).params.has("exclude_statuses")).toBe(false)
    const st = buildListRequest({ limit: 5, status: "Prospected" })
    expect(st.params.has("exclude_statuses")).toBe(false)
    expect(st.params.get("status")).toBe("Prospected")
    expect(buildListRequest({ limit: 5, search: "acme" }).params.has("exclude_statuses")).toBe(false)
  })

  test("the default activity view keeps its wider window, capped at the server max", () => {
    expect(buildListRequest({ limit: 20 }).params.get("per_page")).toBe("100")
    expect(buildListRequest({ limit: 900 }).params.get("per_page")).toBe("1000")
    expect(buildListRequest({ limit: 20, all: true }).params.get("per_page")).toBe("20")
  })

  test("bloq scope is passed through", () => {
    expect(buildListRequest({ limit: 5, bloqId: 40 }).params.get("bloq_id")).toBe("40")
  })
})

describe("buildListRequest — #191688/#191689 an explicit --sort is the order shown", () => {
  test("only the default activity view is reordered into status bands", () => {
    expect(buildListRequest({ limit: 5, sort: "activity" }).reorderByStatus).toBe(true)
    expect(buildListRequest({ limit: 5 }).reorderByStatus).toBe(true)
    for (const sort of ["created", "name", "value"]) {
      expect(buildListRequest({ limit: 5, sort }).reorderByStatus).toBe(false)
    }
  })

  test("value is the money (price_bid, highest first) and the footer says so", () => {
    const r = buildListRequest({ limit: 5, sort: "value" })
    expect(r.params.get("sort_by")).toBe("price_bid")
    expect(r.params.get("sort_direction")).toBe("desc")
    expect(r.orderingLabel).toContain("deal value")
  })

  test("name asks the server for its display-name order, A-Z", () => {
    const r = buildListRequest({ limit: 5, sort: "name" })
    expect(r.params.get("sort_by")).toBe("name")
    expect(r.params.get("sort_direction")).toBe("asc")
    expect(LIST_SORTS.name.orderingLabel).toContain("alphabetically")
  })
})

describe("leadDisplayName — #191688 name is null on most leads", () => {
  test("falls back to nickname, then first_name, then the id", () => {
    expect(leadDisplayName({ id: 1, name: "Robyn Baker", nickname: "x" })).toBe("Robyn Baker")
    expect(leadDisplayName({ id: 100, name: null, nickname: "Antonio Guevara" })).toBe("Antonio Guevara")
    expect(leadDisplayName({ id: 7, name: "  ", nickname: "", first_name: "Sam" })).toBe("Sam")
    expect(leadDisplayName({ id: 87, name: null, nickname: "" })).toBe("Lead #87")
  })
})

describe("parseListLimit — #191691", () => {
  test("accepts whole numbers 1..1000", () => {
    expect(parseListLimit("20")).toEqual({ ok: true, value: 20 })
    expect(parseListLimit(1)).toEqual({ ok: true, value: 1 })
    expect(parseListLimit("1000")).toEqual({ ok: true, value: 1000 })
  })

  test("rejects negative, zero, fractional, non-numeric and oversized limits with a clear message", () => {
    for (const bad of ["-1", -1, "0", 0, "abc", Number.NaN, "2.5", "1001", "", undefined]) {
      const r = parseListLimit(bad)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toContain("--limit must be a whole number from 1 to 1000")
    }
    const nan = parseListLimit(Number.NaN)
    if (!nan.ok) expect(nan.error).toContain('"NaN"')
  })
})

describe("emptyListMessage — #191693 a filtered empty result is not an empty book", () => {
  test("a filter that matched nothing says so, without the Create hint", () => {
    const m = emptyListMessage({ status: "Responded", bloqId: 40 })
    expect(m.warn).toBe('No leads match status "Responded", bloq 40')
    expect(m.hint).not.toContain("Create one")
  })
  test("an unfiltered empty book still offers to create one", () => {
    expect(emptyListMessage({}).hint).toContain("Create one")
  })
})

describe("buildSegmentFilters — #191692 the bloq scope is in the saved filters", () => {
  test("bloq_id is stored as an integer next to the other filters", () => {
    const f = buildSegmentFilters({ status: "Responded", bloqId: 40 })
    expect(f).toEqual({ status: "Responded", bloq_id: 40 })
    expect(typeof f.bloq_id).toBe("number")
  })
  test("a bloq scope alone is a filter", () => {
    expect(Object.keys(buildSegmentFilters({ bloqId: 40 }))).toEqual(["bloq_id"])
  })
  test("no bloq, no bloq_id key", () => {
    expect("bloq_id" in buildSegmentFilters({ status: "Won" })).toBe(false)
  })
})

describe("mergeResponders — #191702 replied means replied, not a status", () => {
  const a = { id: 10782, status: "Responded", has_replied: true, updated_at: "2026-10-20T00:00:00Z" }
  const b = { id: 10673, status: "Follow Up", has_replied: 1, updated_at: "2026-10-25T00:00:00Z" }
  const c = { id: 5671, status: "Qualified", has_replied: false, tags: [{ name: "DM Replied" }], updated_at: "2026-10-22T00:00:00Z" }
  const never = { id: 1, status: "Responded", has_replied: false, tags: [] }

  test("has_replied OR the DM Replied tag, any status, de-duplicated, newest first", () => {
    const out = mergeResponders([[a, b], [c, a]], 10)
    expect(out.map((l) => l.id)).toEqual([10673, 5671, 10782])
  })
  test("a status of Responded alone is not a reply, and a server that ignored the filter cannot leak every lead", () => {
    expect(mergeResponders([[never], [never]], 10)).toEqual([])
  })
  test("respects the limit", () => {
    expect(mergeResponders([[a, b, c]], 1).map((l) => l.id)).toEqual([10673])
  })
  test("leadHasReplied reads the flag or the tag", () => {
    expect(leadHasReplied({ has_replied: "1" })).toBe(true)
    expect(leadHasReplied({ tags: ["DM Replied"] })).toBe(true)
    expect(leadHasReplied({ has_replied: 0, tags: [{ name: "Other" }] })).toBe(false)
  })
})
