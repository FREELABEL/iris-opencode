import { describe, expect, test } from "bun:test"
import { buildDatasetQuery, buildSchemaDeleteQuery, buildSummaryQuery, resolutionHint } from "./platform-atlas-datasets"

/**
 * A dataset slug is unique per (user, bloq) — not per account. So the same slug can exist
 * on two boards, and every read that does not pin a board spans both of them. Measured
 * 2026-10-22 (#190579): one record on board 766 and one on 754, `records summary` reported
 * "Total Records: 2" and `export` wrote both rows — a client-scoped dataset reading another
 * board's data. `list` could already be pinned with --bloq; `search`, `summary`, `export`
 * and `records delete` could not.
 *
 * These tests are about the query the CLI BUILDS. If bloq_id is absent here, no amount of
 * server-side support can scope the request.
 */

describe("dataset reads carry the board pin", () => {
  test("a record query sends bloq_id when --bloq is given", () => {
    const q = buildDatasetQuery({ limit: 25, bloq: 766 })
    expect(q.get("bloq_id")).toBe("766")
  })

  test("omitting --bloq sends no bloq_id — the default is unchanged", () => {
    expect(buildDatasetQuery({ limit: 25 }).get("bloq_id")).toBeNull()
  })

  test("search and filters survive alongside the board pin", () => {
    const q = buildDatasetQuery({ limit: 25, bloq: 754, search: "ON_BOARD", filters: ["status=open"] })
    expect(q.get("bloq_id")).toBe("754")
    expect(q.get("search")).toBe("ON_BOARD")
    expect(q.get("filter[status]")).toBe("open")
  })

  test("a filter value may contain '=' without being split", () => {
    const q = buildDatasetQuery({ limit: 25, filters: ["name=a=b"] })
    expect(q.get("filter[name]")).toBe("a=b")
  })

  test("summary sends bloq_id when --bloq is given", () => {
    expect(buildSummaryQuery({ bloq: 766, groupBy: "status" }).get("bloq_id")).toBe("766")
  })

  test("summary without --bloq sends none", () => {
    expect(buildSummaryQuery({ groupBy: "status" }).get("bloq_id")).toBeNull()
  })
})

describe("an unpinned read says which schema answered", () => {
  /**
   * `/api/v1/atlas/schemas` returns only the latest version of each slug, so the CLI cannot
   * count the boards a slug lives on. It can still do the honest thing `list` already does:
   * say which schema resolved and how to pin the next read. A summary that silently spans
   * two boards is the dangerous half of #190579.
   */
  test("an unpinned read names the schema it resolved", () => {
    const hint = resolutionHint("shared", 323, undefined)
    expect(hint).toContain("#323")
    expect(hint).toContain("--bloq")
  })

  test("a pinned read has nothing to explain", () => {
    expect(resolutionHint("shared", 323, 766)).toBeNull()
  })

  test("an unknown schema id produces no hint", () => {
    expect(resolutionHint("shared", undefined, undefined)).toBeNull()
  })
})

describe("a schema delete can name one board or every board", () => {
  test("a pinned delete carries bloq_id next to cascade", () => {
    expect(buildSchemaDeleteQuery({ cascade: true, bloq: 766 })).toBe("?cascade=true&bloq_id=766")
  })

  test("all_boards is an explicit choice, not the default", () => {
    expect(buildSchemaDeleteQuery({ cascade: true, allBoards: true })).toBe("?cascade=true&all_boards=true")
  })

  test("no scope flags leaves the old single-board call unchanged", () => {
    expect(buildSchemaDeleteQuery({ cascade: true })).toBe("?cascade=true")
    expect(buildSchemaDeleteQuery({})).toBe("")
  })
})
