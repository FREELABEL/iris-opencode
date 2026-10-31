import { describe, expect, test } from "bun:test"
import { describeTagResult, parseTagArgs, tagPath } from "./leads-tag"

describe("leads tag/untag (#191744)", () => {
  test("ids become numbers, names stay names, commas split", () => {
    expect(parseTagArgs(["3595", "3596,3597", "craft soda", " ", 3598])).toEqual([3595, 3596, 3597, "craft soda", 3598])
  })

  test("a name that starts with a digit is still a name", () => {
    expect(parseTagArgs(["7up"])).toEqual(["7up"])
  })

  test("untag calls the per-lead remove route, never the tag delete route", () => {
    expect(tagPath(30324, "untag")).toBe("/api/v1/leads/30324/tags/remove")
    expect(tagPath(30324, "tag")).toBe("/api/v1/leads/30324/tags")
  })

  test("a tag that was not on the lead is reported, not counted as removed", () => {
    const lines = describeTagResult("untag", { removed: [], not_on_lead: ["coffee"], tags: [{ id: 1, name: "soda" }] })
    expect(lines).toEqual(["not on the lead: coffee", "tags now: soda"])
  })

  test("tag reports what was added and what was already there", () => {
    const lines = describeTagResult("tag", { added: ["espresso"], already_present: ["coffee"], tags: [] })
    expect(lines).toEqual(["added: espresso", "already on the lead: coffee", "tags now: (none)"])
  })
})
