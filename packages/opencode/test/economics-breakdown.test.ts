import { describe, expect, it } from "bun:test"
import { parseBreakdown } from "../src/cli/cmd/platform-atlas-datasets"

/**
 * `--breakdown` is the one place the economics CLI does real parsing, and a
 * misparse is silent: the server accepts a well-formed spec pointing at the wrong
 * field, and the dashboard groups everything under "Unassigned" without erroring.
 */
describe("parseBreakdown", () => {
  it("treats a bare name as a single-value field", () => {
    expect(parseBreakdown("law_firm")).toEqual([{ type: "field", field: "law_firm" }])
  })

  it("keeps the order given — it is a fallback chain, not a set", () => {
    expect(parseBreakdown("law_firm,list:service_providers")).toEqual([
      { type: "field", field: "law_firm" },
      { type: "list", field: "service_providers" },
    ])
  })

  it("parses age buckets into numbers", () => {
    expect(parseBreakdown("age:referral_date:30/90/180")).toEqual([
      { type: "age", field: "referral_date", buckets: [30, 90, 180] },
    ])
  })

  it("omits buckets entirely when none are usable, so the server default applies", () => {
    expect(parseBreakdown("age:referral_date")).toEqual([{ type: "age", field: "referral_date" }])
    expect(parseBreakdown("age:referral_date:abc/-5")).toEqual([{ type: "age", field: "referral_date" }])
  })

  it("accepts an explicit field: prefix", () => {
    expect(parseBreakdown("field:law_firm")).toEqual([{ type: "field", field: "law_firm" }])
  })

  it("drops empty segments and stray whitespace rather than emitting a blank field", () => {
    // A blank field would validate server-side as a string but group every row
    // under the empty label.
    expect(parseBreakdown(" law_firm , , list: , ")).toEqual([{ type: "field", field: "law_firm" }])
  })

  it("returns nothing for undefined or empty input", () => {
    expect(parseBreakdown(undefined)).toEqual([])
    expect(parseBreakdown("")).toEqual([])
  })
})
