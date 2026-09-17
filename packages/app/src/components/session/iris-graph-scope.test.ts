import { describe, expect, test } from "bun:test"
import { graphBoardIsIsolated, scopeGraphRows, type ScopableRow } from "./iris-graph-scope"

/*
 * A, B, C are one component: A—B, B—C. So C is TWO hops from A, which is the whole difference
 * between "project" and "connected" and the only reason both exist.
 * D—E are a second, separate component. F is in no component at all.
 */
const rows: ScopableRow[] = [
  { id: 1, links: [{ id: 2 }] }, // A
  { id: 2, links: [{ id: 1 }, { id: 3 }] }, // B
  { id: 3, links: [{ id: 2 }] }, // C
  { id: 4, links: [{ id: 5 }] }, // D
  { id: 5, links: [{ id: 4 }] }, // E
]
const ids = (r: ScopableRow[]) => r.map((x) => x.id).sort((a, b) => a - b)

describe("scopeGraphRows", () => {
  test("project is radius 1 — the board and what it links to, and NOT two hops out", () => {
    // If this ever returns 3 as well, "project" has silently become "connected" and the
    // control has two settings that do the same thing.
    expect(ids(scopeGraphRows(rows, 1, "project"))).toEqual([1, 2])
  })

  test("connected walks the whole component, so the two-hop board is included", () => {
    expect(ids(scopeGraphRows(rows, 1, "connected"))).toEqual([1, 2, 3])
  })

  test("connected stops at the component edge — a separate cluster is not reachable", () => {
    expect(ids(scopeGraphRows(rows, 1, "connected"))).not.toContain(4)
    expect(ids(scopeGraphRows(rows, 4, "connected"))).toEqual([4, 5])
  })

  test("full ignores the active board entirely", () => {
    expect(ids(scopeGraphRows(rows, 1, "full"))).toEqual([1, 2, 3, 4, 5])
    expect(ids(scopeGraphRows(rows, 999, "full"))).toEqual([1, 2, 3, 4, 5])
  })

  test("a board with no relations returns NOTHING, not everything", () => {
    // The tempting fallback is `rows`, and it is wrong: the user asked for one board's graph
    // and would be shown all 40, which looks like the control is broken rather than like an
    // answer. Empty is the finding.
    expect(scopeGraphRows(rows, 6, "project")).toEqual([])
    expect(scopeGraphRows(rows, 6, "connected")).toEqual([])
  })

  test("no board selected yet shows the whole atlas rather than nothing", () => {
    expect(ids(scopeGraphRows(rows, undefined, "project"))).toEqual([1, 2, 3, 4, 5])
  })

  test("a cycle terminates", () => {
    const cyclic: ScopableRow[] = [
      { id: 1, links: [{ id: 2 }] },
      { id: 2, links: [{ id: 1 }] },
    ]
    expect(ids(scopeGraphRows(cyclic, 1, "connected"))).toEqual([1, 2])
  })

  test("a row with no links field at all does not throw", () => {
    expect(ids(scopeGraphRows([{ id: 1 }], 1, "connected"))).toEqual([1])
    expect(ids(scopeGraphRows([{ id: 1 }], 1, "project"))).toEqual([1])
  })
})

describe("graphBoardIsIsolated", () => {
  test("true only when the board is absent from the connected set", () => {
    expect(graphBoardIsIsolated(rows, 6, "project")).toBe(true)
    expect(graphBoardIsIsolated(rows, 1, "project")).toBe(false)
  })

  test("never true on the full atlas — nothing is being scoped, so nothing is excluded", () => {
    expect(graphBoardIsIsolated(rows, 6, "full")).toBe(false)
  })

  test("never true before a board is chosen", () => {
    expect(graphBoardIsIsolated(rows, undefined, "project")).toBe(false)
  })
})

import { mergeInteriors } from "./iris-graph-scope"

describe("mergeInteriors — ELON interiors, several open at once", () => {
  // Two boards that relate to each other, and both to board 900 which is NOT on screen.
  const i682 = {
    nodes: [
      { id: "bloq-682", type: "atlas" },
      { id: "memory-hub", type: "memory" },
      { id: "bloq-368", type: "bloq" },
      { id: "bloq-900", type: "bloq" },
    ],
    edges: [
      { source: "bloq-682", target: "memory-hub", label: "memory" },
      { source: "bloq-682", target: "bloq-368", type: "sibling", label: "sibling" },
      { source: "bloq-682", target: "bloq-900", type: "parent", label: "parent" },
    ],
  }
  const i368 = {
    nodes: [
      { id: "bloq-368", type: "atlas" },
      { id: "bloq-682", type: "bloq" },
      { id: "bloq-900", type: "bloq" },
    ],
    edges: [
      { source: "bloq-682", target: "bloq-368", type: "sibling", label: "sibling" },
      { source: "bloq-368", target: "bloq-900", type: "parent", label: "parent" },
    ],
  }
  const on = new Set([682, 368])
  const both = mergeInteriors(on, [682, 368], { 682: i682, 368: i368 })

  test("no two nodes share an id — the collision this exists for", () => {
    const ids = both.nodes.map((n) => `${typeof n.id}:${n.id}`)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test("each board's OWN centre survives; a related on-screen board is not duplicated", () => {
    const atlas = both.nodes.filter((n) => n.type === "atlas").map((n) => n.id)
    expect(atlas).toEqual(["bloq-682", "bloq-368"])
    expect(both.nodes.filter((n) => n.type === "bloq").map((n) => n.id)).toEqual(["bloq-900"])
  })

  test("a related board off screen is kept once, even when two interiors name it", () => {
    expect(both.nodes.filter((n) => n.id === "bloq-900").length).toBe(1)
  })

  test("relations to on-screen boards are dropped — the board layer already draws them", () => {
    expect(both.edges.some((e) => e.type === "sibling")).toBe(false)
    expect(both.edges.filter((e) => e.target === "bloq-900").length).toBe(2)
  })

  test("every edge endpoint resolves to a node or a board", () => {
    const ids = new Set<string | number>([...both.nodes.map((n) => n.id), ...on])
    for (const e of both.edges) {
      expect(ids.has(e.source)).toBe(true)
      expect(ids.has(e.target)).toBe(true)
    }
  })

  test("one open board, nothing related on screen: ELON's interior passes through untouched", () => {
    const solo = mergeInteriors(new Set([682]), [682], { 682: i682 })
    expect(solo.nodes.map((n) => n.id)).toEqual(["bloq-682", "memory-hub", "bloq-368", "bloq-900"])
    expect(solo.edges.length).toBe(i682.edges.length + 1)
  })

  test("an expansion whose board left the scope contributes nothing", () => {
    expect(mergeInteriors(new Set([368]), [682], { 682: i682 }).nodes).toEqual([])
  })
})
