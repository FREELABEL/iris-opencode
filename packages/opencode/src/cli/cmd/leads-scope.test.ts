import { describe, expect, test } from "bun:test"
import { describeListScope, type ListScope } from "./leads-scope"

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
})
