import { describe, expect, test } from "bun:test"
import { atlasTypesFor, splitAtlasResults } from "./platform-bloqs"

// #187964 S2: `iris atlas search` reads /api/v1/atlas/search, the one words engine.
describe("atlasTypesFor", () => {
  test("defaults to items, boards and pages — pages were the one record type search could not reach", () => {
    expect(atlasTypesFor({}).types).toEqual(["items", "boards", "pages"])
  })
  test("--type wins and unknown names are reported, not dropped", () => {
    expect(atlasTypesFor({ type: "Leads, files ,cards" })).toEqual({ types: ["leads", "files"], unknown: ["cards"] })
  })
  test("the legacy narrowing flags still narrow", () => {
    expect(atlasTypesFor({ "boards-only": true }).types).toEqual(["boards"])
    expect(atlasTypesFor({ "items-only": true }).types).toEqual(["items"])
  })
})

describe("splitAtlasResults", () => {
  test("items keep the legacy field names the printer and --json callers read", () => {
    const { items, boards, pages, other } = splitAtlasResults([
      { type: "item", id: 7, title: "Redis outage", board_id: 3, board: "Ops", list: "Incidents", snippet: "sigterm", found_by: ["words"] },
      { type: "board", id: 3, title: "Ops" },
      { type: "page", id: 9, title: "Plan", slug: "plan" },
      { type: "lead", id: 1, title: "Ana" },
    ])
    expect(items[0]).toMatchObject({ id: 7, bloq_id: 3, bloq_name: "Ops", list_name: "Incidents", content: "sigterm" })
    expect(boards[0]).toMatchObject({ id: 3, name: "Ops" })
    expect(pages[0].slug).toBe("plan")
    expect(other[0].type).toBe("lead")
  })
  test("a non-array body is empty, not a crash", () => {
    expect(splitAtlasResults(undefined as any)).toEqual({ items: [], boards: [], pages: [], other: [] })
  })
})
