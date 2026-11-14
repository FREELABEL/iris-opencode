import { test, expect, describe } from "bun:test"
import { readFileSync } from "fs"
import { join } from "path"
import {
  OWNER_BLOQ_REQUIRED_MESSAGE,
  bulkDeleteRefusal,
  filterByOwnership,
  ownershipQueryParams,
  resolveOwnerBloq,
} from "./agent-ownership"

describe("resolveOwnerBloq (#189966)", () => {
  test("missing owner project is an error with the exact guidance", () => {
    expect(resolveOwnerBloq(undefined)).toEqual({ error: OWNER_BLOQ_REQUIRED_MESSAGE })
    expect(OWNER_BLOQ_REQUIRED_MESSAGE).toBe(
      "Every agent needs an owner project. Pass --bloq <id> (see: iris atlas list)",
    )
  })
  test("zero, negative, NaN and blank are not an owner", () => {
    for (const v of [0, -3, NaN, "", "  ", "abc", 1.5]) expect("error" in resolveOwnerBloq(v)).toBe(true)
  })
  test("a positive id is accepted (number or numeric string)", () => {
    expect(resolveOwnerBloq(571)).toEqual({ bloqId: 571 })
    expect(resolveOwnerBloq("38")).toEqual({ bloqId: 38 })
  })
  test("create handler checks the owner before it writes, and --bloq is an alias", () => {
    const src = readFileSync(join(import.meta.dir, "platform-agents.ts"), "utf8")
    const create = src.slice(src.indexOf("const AgentsCreateCommand"), src.indexOf("const AgentsChatCommand"))
    expect(create).toMatch(/alias: \["b", "bloq"\]/)
    const check = create.indexOf("resolveOwnerBloq(")
    const write = create.indexOf("irisFetch(")
    expect(check).toBeGreaterThan(-1)
    expect(write).toBeGreaterThan(check)
  })
})

describe("ownership filters (#189967)", () => {
  test("filters are sent to the server as query params", () => {
    expect(ownershipQueryParams({ orphaned: true, workspaceOrphaned: true })).toEqual({
      orphaned: "1",
      workspace_orphaned: "1",
    })
    expect(ownershipQueryParams({})).toEqual({})
  })

  test("a payload without bloq_id is reported unevaluable, not filtered to everything", () => {
    const today = [{ id: 1, name: "a" }, { id: 2, name: "b" }]
    const r = filterByOwnership(today, { orphaned: true })
    expect(r.unevaluable).toEqual(["bloq_id"])
  })

  test("with the fields present, orphaned means null/absent owner only", () => {
    const agents = [
      { id: 1, bloq_id: 571, workspace_id: 3 },
      { id: 2, bloq_id: null, workspace_id: null },
      { id: 3, bloq_id: 12, workspace_id: null },
    ]
    expect(filterByOwnership(agents, { orphaned: true }).agents.map((a) => a.id)).toEqual([2])
    expect(filterByOwnership(agents, { workspaceOrphaned: true }).agents.map((a) => a.id)).toEqual([2, 3])
    expect(filterByOwnership(agents, { orphaned: true }).unevaluable).toEqual([])
  })
})

describe("bulk-delete --orphaned refuses what it cannot evaluate (#189967)", () => {
  test("refuses when the payload has no bloq_id — it would have selected every agent", () => {
    const today = [{ id: 1, name: "a" }, { id: 2, name: "b" }]
    expect(bulkDeleteRefusal(today, { orphaned: true })).toMatch(/Refusing to bulk-delete/)
    expect(bulkDeleteRefusal(today, { bloq: 571 })).toMatch(/Refusing/)
  })
  test("proceeds when every record carries bloq_id (null counts as carried)", () => {
    expect(bulkDeleteRefusal([{ id: 1, bloq_id: null }], { orphaned: true })).toBeNull()
  })
  test("search-only bulk delete is unaffected", () => {
    expect(bulkDeleteRefusal([{ id: 1 }], {})).toBeNull()
  })
  test("the bulk-delete handler consults the refusal before filtering", () => {
    const src = readFileSync(join(import.meta.dir, "platform-agents.ts"), "utf8")
    const bulk = src.slice(src.indexOf("const AgentsBulkDeleteCommand"), src.indexOf("const AgentsAssignCommand"))
    expect(bulk).toContain("bulkDeleteRefusal(")
    expect(bulk).not.toContain("agents.filter((a: any) => !a.bloq_id)")
  })
})

describe("serverIgnoredOwnership — a filter applied to one page is not an answer", () => {
  const { serverIgnoredOwnership } = require("./agent-ownership")
  test("rows that fail the predicate mean the server ignored ?orphaned=1", () => {
    expect(serverIgnoredOwnership([{ id: 1, bloq_id: 5 }, { id: 2, bloq_id: null }], { orphaned: true })).toBe(true)
  })
  test("all rows orphaned means the server applied it", () => {
    expect(serverIgnoredOwnership([{ id: 1, bloq_id: null }, { id: 2, bloq_id: 0 }], { orphaned: true })).toBe(false)
  })
  test("an empty page proves nothing either way, so it is treated as applied", () => {
    expect(serverIgnoredOwnership([], { orphaned: true })).toBe(false)
  })
  test("no ownership filter requested", () => {
    expect(serverIgnoredOwnership([{ id: 1, bloq_id: 5 }], {})).toBe(false)
  })
  test("workspace filter is checked on workspace_id", () => {
    expect(serverIgnoredOwnership([{ id: 1, bloq_id: null, workspace_id: 9 }], { workspaceOrphaned: true })).toBe(true)
  })
})
