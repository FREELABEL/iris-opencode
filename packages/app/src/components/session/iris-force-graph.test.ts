import { describe, expect, test } from "bun:test"
import {
  DEFAULT_EDGE_STRENGTH,
  DEFAULT_TYPE,
  edgeStrengthOf,
  isDragGesture,
  NODE_TYPES,
  nodeStyle,
  presentTypesOf,
  typeCountsOf,
  visibleGraphOf,
} from "./iris-force-graph"

/**
 * The graph folds Elon's 14-type vocabulary in beside the board-to-board view it already had.
 * These cover the parts where being wrong is SILENT — a graph that renders beautifully while
 * every node is the wrong colour, or whose nodes cannot be clicked, looks fine in a screenshot.
 */

describe("the vocabulary is Elon's, not a parallel one", () => {
  test("bloq is #6366f1 — the colour this graph already hardcoded for every node", () => {
    // This is the whole reason the two graphs fold together rather than being reconciled:
    // NODE_COLOR was already Elon's bloq colour, so the old view was this table's bloq layer.
    expect(NODE_TYPES.bloq.color).toBe("#6366f1")
  })

  const ELON_14 = ["atlas", "artist", "person", "venue", "event", "brand", "deal", "bloq", "agent", "workflow", "program", "leadcluster", "memory", "playbook"]

  test("all 14 of Elon's types are present", () => {
    for (const t of ELON_14) expect(NODE_TYPES[t], t).toBeDefined()
  })

  test("additions are DECLARED, not accidental", () => {
    // Asserting an exact count of 14 would fail the moment this product grows a type Elon
    // does not have, and the fix would be to bump a number — which is how a vocabulary drifts
    // without anyone deciding to. Naming the extras makes each one a decision on the record.
    const extras = Object.keys(NODE_TYPES).filter((t) => !ELON_14.includes(t))
    // EMPTY: the interior is now built by ELON's rules (#185584), which emit only ELON's 14. The
    // desktop-only `page` and `list` types existed for the old assembler; `list` was added
    // without being declared here, and this test caught it — it was already failing on PR #65.
    expect(extras).toEqual([])
  })

  test("every type has an inline icon path, never a font glyph name", () => {
    for (const [name, t] of Object.entries(NODE_TYPES)) {
      // A FontAwesome class here would render nothing: there is no icon font, and the CSP
      // blocks webfont CDNs so it would fail silently rather than loudly.
      expect(t.icon, name).not.toContain("fa-")
      expect(t.icon, name).toMatch(/^[Mm]/)
    }
  })
})

describe("an untyped payload still renders exactly as it did before", () => {
  test("a node with no type is a bloq", () => {
    expect(nodeStyle(undefined).color).toBe(NODE_TYPES[DEFAULT_TYPE].color)
  })

  test("an UNKNOWN type falls back rather than rendering undefined", () => {
    // Reading .color off undefined throws inside a d3 tick, where the stack says nothing.
    expect(nodeStyle("not-a-real-type").color).toBe(NODE_TYPES[DEFAULT_TYPE].color)
  })

  test("a board-only graph offers no legend, because one chip is not a choice", () => {
    const boards = [{ type: undefined }, { type: undefined }, { type: "bloq" }]
    expect(presentTypesOf(boards)).toEqual(["bloq"])
  })
})

describe("the legend describes the data, not the vocabulary", () => {
  const mixed = [{ type: "bloq" }, { type: "agent" }, { type: "agent" }, { type: undefined }]

  test("only types PRESENT get a chip", () => {
    // A fixed list of 14 would advertise Venues on a graph that has none, which reads as
    // "you have no venues" when the truth is "this view never shows them".
    expect(presentTypesOf(mixed)).toEqual(["bloq", "agent"])
  })

  test("chips keep the vocabulary's order so the legend does not reshuffle", () => {
    const reordered = [{ type: "playbook" }, { type: "atlas" }, { type: "bloq" }]
    expect(presentTypesOf(reordered)).toEqual(["atlas", "bloq", "playbook"])
  })

  test("counts fold untyped nodes into bloq", () => {
    expect(typeCountsOf(mixed)).toEqual({ bloq: 2, agent: 2 })
  })
})

describe("edge strength is ELON's: `e.strength || 0.3`, and ELON never sets one", () => {
  test("an edge's own strength wins", () => {
    expect(edgeStrengthOf({ strength: 0.9 })).toBe(0.9)
  })

  test("every other edge is 0.3 — hierarchy and affiliation alike", () => {
    // This test used to assert a parent edge pulls harder than an affiliated one. That was a
    // per-type table labelled as ELON's; RelationshipGraph.vue gives EVERY edge 0.3, so the
    // assertion encoded exactly the drift #185584 reports.
    expect(edgeStrengthOf({})).toBe(DEFAULT_EDGE_STRENGTH)
    expect(DEFAULT_EDGE_STRENGTH).toBe(0.3)
  })

  test("a strength of 0 falls back to 0.3, as ELON's `||` does — not d3's 1/min(degree)", () => {
    expect(edgeStrengthOf({ strength: 0 })).toBe(0.3)
  })
})

describe("filtering is ELON's: select to SHOW, not to hide", () => {
  const nodes = [
    { id: "a", type: "agent" },
    { id: "b", type: "bloq" },
    { id: "c", type: "memory" },
    { id: 7 }, // untyped = bloq
  ]
  const edges = [
    { source: "a", target: "b" },
    { source: "b", target: "c" },
    { source: "c", target: "missing" },
  ]

  test("nothing selected shows everything, minus edges with a missing end", () => {
    const v = visibleGraphOf(nodes, edges, new Set())
    expect(v.nodes.length).toBe(4)
    expect(v.edges.length).toBe(2) // the dangling edge is not drawn, and not counted
  })

  test("selecting a type shows ONLY that type — the old behaviour hid it instead", () => {
    const v = visibleGraphOf(nodes, edges, new Set(["bloq"]))
    expect(v.nodes.map((n) => n.id)).toEqual(["b", 7])
    expect(v.edges.length).toBe(0) // both ends must survive the filter
  })

  test("selecting several unions them, and edges between survivors remain", () => {
    const v = visibleGraphOf(nodes, edges, new Set(["agent", "bloq"]))
    expect(v.nodes.map((n) => n.id)).toEqual(["a", "b", 7])
    expect(v.edges).toEqual([{ source: "a", target: "b" }])
  })
})

describe("clickDistance — the bug you could feel", () => {
  test("a dead-still tap is a click", () => {
    expect(isDragGesture({ x: 100, y: 100 }, { x: 100, y: 100 })).toBe(false)
  })

  test("a 1px wobble is STILL a click", () => {
    // This is the actual reported symptom: aiming carefully made selection less reliable,
    // because holding steady enough to move one pixel still armed a drag and ate the click.
    expect(isDragGesture({ x: 100, y: 100 }, { x: 101, y: 100 })).toBe(false)
  })

  test("5px is within tolerance, 7px is a drag", () => {
    expect(isDragGesture({ x: 0, y: 0 }, { x: 5, y: 0 })).toBe(false)
    expect(isDragGesture({ x: 0, y: 0 }, { x: 7, y: 0 })).toBe(true)
  })

  test("distance is diagonal, not per-axis", () => {
    // 5,5 is 7.07 away. A per-axis check would call this a click on both axes and never drag.
    expect(isDragGesture({ x: 0, y: 0 }, { x: 5, y: 5 })).toBe(true)
  })

  test("no pointer recorded is not a drag", () => {
    expect(isDragGesture(null, { x: 9, y: 9 })).toBe(false)
    expect(isDragGesture({ x: 0, y: 0 }, null)).toBe(false)
  })
})
