import { describe, expect, test } from "bun:test"
import { likelyDuplicates, searchTerms, titleSimilarity, titleTokens } from "../src/cli/cmd/bug-dedupe"

describe("bug dedupe (#189153)", () => {
  test("the real pair that was paid twice is caught", () => {
    // #178357: the same report filed as #177544 and #177555.
    const items = [
      { id: 177544, title: "iris pages verify reports PASS when the page 404s", status: "done" },
      { id: 160001, title: "Typesense reindex times out on large bloqs", status: "active" },
    ]
    const m = likelyDuplicates("pages verify reported PASS on a 404 page", items)
    expect(m.map((x) => x.id)).toEqual([177544])
  })

  test("one shared common word is not a duplicate", () => {
    const items = [{ id: 1, title: "Gmail inbox sync drops threads" }]
    expect(likelyDuplicates("Calendar sync shows wrong timezone", items)).toEqual([])
  })

  test("severity prefixes and ticket refs do not count as overlap", () => {
    expect(titleTokens("[CRITICAL] #188702 worktrees never removed")).toEqual(["worktree", "never", "remov"])
    expect(titleSimilarity("[HIGH] login loop", "[HIGH] invoice total wrong")).toBe(0)
  })

  test("an open match outranks a closed one at the same score, and the list is capped", () => {
    const items = [
      { id: 10, title: "hive tasks stuck pending forever", status: "done" },
      { id: 11, title: "hive tasks stuck pending forever", status: "active" },
      { id: 12, title: "hive tasks stuck pending forever again", status: "active" },
      { id: 13, title: "hive tasks stuck pending forever twice", status: "todo" },
    ]
    const m = likelyDuplicates("hive tasks stuck pending", items, { limit: 3 })
    expect(m).toHaveLength(3)
    expect(m.map((x) => x.id)).not.toContain(10)
  })

  test("duplicate ids from two searches are reported once", () => {
    const row = { id: 5, title: "proof video upload fails on windows" }
    expect(likelyDuplicates("proof video upload fails windows", [row, row])).toHaveLength(1)
  })

  test("search terms are the longest distinctive words", () => {
    expect(searchTerms("[LOW] the metering ratchet flags a metered lane")).toEqual(["ratchet", "meter"])
  })
})
