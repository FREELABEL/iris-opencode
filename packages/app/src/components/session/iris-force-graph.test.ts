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
    // Empty since #185584 ported the interior onto ELON's own rules: `page` and `list` were
    // desktop-only and nothing emits them now. Adding one back should fail here until someone
    // decides it on purpose.
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

describe("edge strength is Elon's, not d3's", () => {
  test("an edge's own strength wins", () => {
    expect(edgeStrengthOf({ type: "parent", strength: 0.9 })).toBe(0.9)
  })

  test("a hierarchy holds tighter than an affiliation", () => {
    // If these were equal, cluster tightness would carry no meaning.
    expect(edgeStrengthOf({ type: "parent" })).toBeGreaterThan(edgeStrengthOf({ type: "affiliated" }))
  })

  test("an unknown type gets Elon's 0.3 fallback, NOT d3's 1/min(degree)", () => {
    // d3's default slackens hub links exactly where Elon's stay tight, which is why two
    // graphs built from identical data settled differently.
    expect(edgeStrengthOf({ type: "whatever" })).toBe(DEFAULT_EDGE_STRENGTH)
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
