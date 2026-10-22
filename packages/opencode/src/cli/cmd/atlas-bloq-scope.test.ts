import { describe, expect, test } from "bun:test"
import { buildDatasetQuery, buildSummaryQuery, sameSlugBloqs } from "./platform-atlas-datasets"

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

describe("an ambiguous slug is visible before it is aggregated or exported", () => {
  test("the same slug on two boards reports both board ids", () => {
    const rows = [
      { slug: "shared", bloq_id: 766 },
      { slug: "shared", bloq_id: 754 },
      { slug: "other", bloq_id: 1 },
    ]
    expect(sameSlugBloqs(rows, "shared")).toEqual([754, 766])
  })

  test("a slug on one board is not ambiguous", () => {
    expect(sameSlugBloqs([{ slug: "solo", bloq_id: 38 }], "solo")).toEqual([38])
  })

  test("an account-global schema reports no board", () => {
    expect(sameSlugBloqs([{ slug: "global", bloq_id: null }], "global")).toEqual([])
  })

  test("a schema that is not there reports no boards", () => {
    expect(sameSlugBloqs([{ slug: "other", bloq_id: 1 }], "missing")).toEqual([])
  })
})
