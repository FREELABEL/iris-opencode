import { describe, expect, test } from "bun:test"
import { describePath } from "./platform-atlas-graph"

describe("describePath", () => {
  test("names the side that did not resolve", () => {
    expect(describePath({ found: false, missing: ["to"], withheld: 0 })).toEqual(["Not in the graph: to"])
  })

  test("a definite absence reads as one", () => {
    expect(describePath({ found: true, path: null, complete: true, max_hops: 3, withheld: 0 })).toEqual([
      "No connection within 3 hops.",
    ])
  })

  test("withheld edges stop a null from reading as no connection", () => {
    expect(describePath({ found: true, path: null, complete: true, max_hops: 3, withheld: 2 })[0]).toContain("one may exist")
  })

  test("a search that ran out never reads as unconnected", () => {
    expect(describePath({ found: true, path: null, complete: false, max_hops: 3, withheld: 0 })[0]).toContain("does NOT mean")
  })

  test("every hop shows its source record", () => {
    const lines = describePath({
      found: true,
      from: { name: "Ann" },
      path: [{ predicate: "child_of", entity: { id: 2, name: "Ben" }, evidence: { schema_id: 1, record_id: 11, field: "name" } }],
      withheld: 0,
    })
    expect(lines).toEqual(["Ann", "  child_of -> Ben  (record 1/11)"])
  })
})
