import { describe, expect, test } from "bun:test"
import {
  DEFAULT_EDGE_STRENGTH,
  edgeCaption,
  edgeLabelBox,
  labelScale,
  nodeLabelBox,
  placeLabelPositions,
  RING_MIN_GAP,
  RING_STEP,
  radialTreeTargets,
  ringRadii,
  placeLabels,
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

describe("edge strength is ELON's exactly: e.strength || 0.3", () => {
  test("an edge's own strength wins", () => {
    expect(edgeStrengthOf({ type: "parent", strength: 0.9 })).toBe(0.9)
  })

  test("TYPE PLAYS NO PART — a parent edge pulls exactly like any other", () => {
    // A per-type table (parent 0.7…) once lived here labelled as ELON's. ELON has none: it
    // is `strength: e.strength || 0.3` for every edge. The invented 0.7 crushed a project's
    // related boards onto ATLAS and made the Project graph stop looking like ELON's.
    expect(edgeStrengthOf({ type: "parent" })).toBe(DEFAULT_EDGE_STRENGTH)
    expect(edgeStrengthOf({ type: "sibling" })).toBe(edgeStrengthOf({ type: "affiliated" }))
  })

  test("the fallback is 0.3, not d3's 1/min(degree)", () => {
    expect(DEFAULT_EDGE_STRENGTH).toBe(0.3)
    expect(edgeStrengthOf({ type: "whatever" })).toBe(0.3)
  })

  test("a strength of 0 falls back, because ELON uses || not ??", () => {
    expect(edgeStrengthOf({ strength: 0 })).toBe(0.3)
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

describe("label placement — decided, not all drawn", () => {
  const box = (id: string, x: number, priority: number, owner?: string) => ({ id, x, y: 0, w: 50, h: 10, priority, owner })

  test("two overlapping labels: the more important one wins", () => {
    const v = placeLabels([box("small", 0, 12), box("hub", 10, 20)], [])
    expect([...v]).toEqual(["hub"])
  })

  test("labels that do not touch are both drawn", () => {
    const v = placeLabels([box("a", 0, 12), box("b", 100, 12)], [])
    expect(v.has("a") && v.has("b")).toBe(true)
  })

  test("the hovered label is drawn even when it loses on priority", () => {
    // Hovering a node and still not being able to read its name is worse than clutter.
    const v = placeLabels([box("small", 0, 12), box("hub", 10, 20)], [], new Set(["small"]))
    expect(v.has("small")).toBe(true)
  })

  test("the hovered label is drawn even when it sits on ANOTHER node's circle", () => {
    // Priority sorting alone cannot guarantee this: an obstacle is not a placed label, so
    // going first does not clear it. The pin has to override the obstacle check itself.
    const otherCircle = { x: 0, y: 0, w: 50, h: 10, owner: "n:9" }
    expect(placeLabels([box("n:1", 0, 12, "n:1")], [otherCircle], new Set(["n:1"])).has("n:1")).toBe(true)
  })

  test("a node's OWN circle does not hide its label; another node's does", () => {
    const circle = { x: 0, y: 0, w: 50, h: 10, owner: "n:1" }
    expect(placeLabels([box("n:1", 0, 12, "n:1")], [circle]).has("n:1")).toBe(true)
    expect(placeLabels([box("n:2", 0, 12, "n:2")], [circle]).has("n:2")).toBe(false)
  })

  test("equal priorities resolve the same way every call — no per-frame flicker", () => {
    const run = () => [...placeLabels([box("b", 0, 12), box("a", 10, 12)], [])]
    expect(run()).toEqual(run())
    expect(run()).toEqual(["a"])
  })

  test("ZOOMING IN gives crowded labels their primary spot back", () => {
    // Screen-constant labels shrink in graph units as you zoom, so labels pushed to a fallback
    // spot (or off entirely) at 1x return to their natural place below the node when zoomed.
    const a = { id: 1, name: "Package Index v0.1", size: 12, x: 0, y: 0 }
    const b = { id: 2, name: "Dataset + Page SERVED", size: 12, x: 60, y: 0 }
    const at = (k: number) => placeLabelPositions([nodeLabelBox(a, k), nodeLabelBox(b, k)], [])
    expect([...at(1).values()].filter((p) => p === 0).length).toBe(1)
    expect([...at(3).values()].every((p) => p === 0)).toBe(true)
  })

  test("labels stay screen-constant: 1x is unchanged, zoom is clamped", () => {
    expect(labelScale(1)).toBe(1)
    expect(labelScale(2)).toBe(0.5)
    expect(labelScale(100)).toBe(labelScale(4))
    expect(labelScale(0.01)).toBe(labelScale(0.3))
  })

  test("a label already on screen keeps the primary spot against a near-equal rival (hysteresis)", () => {
    const hub = { id: 1, name: "Agents", size: 14, x: 0, y: 0 }
    const item = { id: 2, name: "Agents", size: 12, x: 5, y: 0 }
    // Without hysteresis the bigger node takes the spot below...
    expect(placeLabelPositions([nodeLabelBox(hub, 1), nodeLabelBox(item, 1)], []).get("n:1")).toBe(0)
    // ...but a label already showing is not displaced by a 2px size difference.
    expect(placeLabelPositions([nodeLabelBox(hub, 1), nodeLabelBox(item, 1, true)], []).get("n:2")).toBe(0)
  })

  test("a list WITH cards takes the primary spot over a bigger leaf board", () => {
    // Board 682: 31 related boards at size 18 took the space and "📦 Package Index" (16)
    // lost its label while its own cards kept theirs.
    const list = { id: "list-1", name: "📦 Package Index", size: 16, x: 0, y: 0 }
    const board = { id: "bloq-9", name: "Genesis UI SDK", size: 18, x: 4, y: 0 }
    expect(placeLabelPositions([nodeLabelBox(list, 1, false, 5), nodeLabelBox(board, 1)], []).get("n:list-1")).toBe(0)
  })

  test("an EMPTY list does not jump the queue", () => {
    const list = { id: "list-2", name: "Ideas", size: 16, x: 0, y: 0 }
    const board = { id: "bloq-9", name: "Genesis UI SDK", size: 18, x: 4, y: 0 }
    expect(placeLabelPositions([nodeLabelBox(list, 1, false, 0), nodeLabelBox(board, 1)], []).get("n:bloq-9")).toBe(0)
  })

  test("a label BLOCKED below moves to another spot instead of vanishing", () => {
    // The case that hid "📦 Package Index": its own cards cluster right under it. One card's
    // circle directly below must not cost the list its name.
    const list = { id: "list-1", name: "📦 Package Index", size: 16, x: 0, y: 0 }
    const box = nodeLabelBox(list, 1, false, 5)
    const cardBelow = { x: box.x, y: box.y, w: box.w, h: box.h, owner: "n:item-7" }
    const pos = placeLabelPositions([box], [cardBelow]).get("n:list-1")
    expect(pos).toBeDefined()
    expect(pos).not.toBe(0)
  })

  test("a label keeps last frame's fallback spot rather than hopping back and forth", () => {
    const list = { id: "list-1", name: "📦 Package Index", size: 16, x: 0, y: 0 }
    // Nothing blocks it now, but it held "right" (2) last frame — it should stay there.
    expect(placeLabelPositions([nodeLabelBox(list, 1, true, 5, 2)], []).get("n:list-1")).toBe(2)
  })

  test("an edge caption never beats a node name", () => {
    const node = nodeLabelBox({ id: 1, name: "Memory", size: 12, x: 0, y: 0 }, 1)
    const edge = edgeLabelBox({ x1: -20, y1: node.y + 20, x2: 20, y2: node.y + 20, text: "parent" }, 0, 1, true)
    const v = placeLabels([edge, node], [])
    expect(v.has("n:1")).toBe(true)
  })
})

describe("untyped edges — the crash an expanded board caused", () => {
  // Live on board 682: 20 of 52 edges carry no `type`, 19 carry neither type nor label. The
  // renderer called e.type.replace on them and the error boundary took the whole app down.
  test("an edge with neither label nor type has NO caption, and does not throw", () => {
    expect(() => edgeCaption({})).not.toThrow()
    expect(edgeCaption({})).toBeNull()
  })

  test("ELON's labelled hub edge uses its label", () => {
    expect(edgeCaption({ label: "memory" })).toBe("memory")
  })

  test("a board relation with only a type is still captioned by it", () => {
    expect(edgeCaption({ type: "feeds_into" })).toBe("feeds into")
  })

  test("an untyped edge gets ELON's default strength, not undefined", () => {
    expect(edgeStrengthOf({})).toBe(DEFAULT_EDGE_STRENGTH)
  })
})

describe("rings by depth — the Project graph reads PROJECT -> hubs -> lists -> cards", () => {
  // Board 682's shape: ATLAS -> Memory -> lists -> cards, plus related boards off ATLAS.
  const nodes = [
    { id: "bloq-682", type: "atlas" },
    { id: "memory-hub", type: "memory" },
    { id: "list-1", type: "brand" },
    { id: "item-1", type: "brand" },
    { id: "bloq-9", type: "bloq" },
    { id: "bloq-10", type: "bloq" },
  ]
  const edges = [
    { source: "bloq-682", target: "memory-hub" },
    { source: "memory-hub", target: "list-1" },
    { source: "list-1", target: "item-1" },
    { source: "bloq-682", target: "bloq-9" },
    { source: "bloq-682", target: "bloq-10" },
  ]
  const r = ringRadii(nodes, edges, "bloq-682", ["bloq"])

  test("each level of the hierarchy sits further out than the last", () => {
    expect(r.get("bloq-682")).toBe(0)
    expect(r.get("memory-hub")!).toBeGreaterThan(0)
    expect(r.get("list-1")!).toBeGreaterThan(r.get("memory-hub")!)
    expect(r.get("item-1")!).toBeGreaterThan(r.get("list-1")!)
  })

  test("related projects go on the OUTER ring, not beside Memory", () => {
    // They are depth 1 (linked straight to ATLAS). On ring 1 they tangled into the project's
    // own structure — the glob. They are other projects; they belong outside it.
    expect(r.get("bloq-9")!).toBeGreaterThan(r.get("item-1")!)
    expect(r.get("bloq-9")).toBe(r.get("bloq-10"))
  })

  test("a crowded ring grows so its nodes are not piled on each other", () => {
    const many = [{ id: "root", type: "atlas" }, ...Array.from({ length: 40 }, (_, i) => ({ id: `n${i}`, type: "brand" }))]
    const e = many.slice(1).map((n) => ({ source: "root", target: n.id }))
    const radius = ringRadii(many, e, "root").get("n0")!
    expect(radius).toBeGreaterThan(RING_STEP)
    // Circumference leaves at least the minimum gap per node.
    expect((2 * Math.PI * radius) / 40).toBeGreaterThanOrEqual(RING_MIN_GAP - 0.001)
  })

  test("no root on the canvas means no rings — the plain web is untouched", () => {
    expect(ringRadii(nodes, edges, "bloq-999").size).toBe(0)
  })

  test("d3's mutated edges (source/target as objects) still resolve", () => {
    const mutated = edges.map((x) => ({ source: { id: x.source }, target: { id: x.target } }))
    expect(ringRadii(nodes, mutated, "bloq-682", ["bloq"]).get("item-1")).toBe(r.get("item-1"))
  })
})

describe("radial tree — a card sits beside its own list", () => {
  // Board 682's real shape: ATLAS -> Memory -> 4 lists with 5/3/1/1 cards, + related boards.
  const lists = [["list-pkg", 5], ["list-spec", 3], ["list-org", 1], ["list-diary", 1]] as const
  const nodes: { id: string; type: string }[] = [{ id: "bloq-682", type: "atlas" }, { id: "memory-hub", type: "memory" }]
  const edges: { source: string; target: string }[] = [{ source: "bloq-682", target: "memory-hub" }]
  for (const [l, n] of lists) {
    nodes.push({ id: l, type: "brand" })
    edges.push({ source: "memory-hub", target: l })
    for (let i = 0; i < n; i++) {
      nodes.push({ id: `item-${l}-${i}`, type: "brand" })
      edges.push({ source: l, target: `item-${l}-${i}` })
    }
  }
  for (let i = 0; i < 31; i++) {
    nodes.push({ id: `bloq-${i}`, type: "bloq" })
    edges.push({ source: "bloq-682", target: `bloq-${i}` })
  }
  const t = radialTreeTargets(nodes, edges, "bloq-682", ["bloq"])
  const angle = (id: string) => Math.atan2(t.get(id)!.y, t.get(id)!.x)
  const gap = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)))

  test("each list's cards form ONE unbroken run round the ring — no interleaving, no crossing", () => {
    // The glob: a card settled on the far side from its list and its edge crossed the graph.
    // (Angular nearness to its own list is the wrong test — a list holding half the cards owns
    // half the circle, so its end cards are legitimately near a neighbour.)
    const cards = nodes.filter((n) => n.id.startsWith("item-")).map((n) => ({ list: n.id.replace(/-\d+$/, "").slice(5), a: angle(n.id) }))
    cards.sort((x, y) => x.a - y.a)
    let runs = 1
    for (let i = 1; i < cards.length; i++) if (cards[i].list !== cards[i - 1].list) runs++
    // Circular: the last and first may belong to the same list and are one run.
    if (cards[0].list === cards[cards.length - 1].list) runs--
    expect(runs).toBe(lists.length)
  })

  test("every card falls inside its OWN list's wedge", () => {
    // Contiguity and even spacing both survive rotating every card 180deg away from its list.
    // This does not: a list owns (its cards / all cards) of the circle, centred on the list.
    const total = lists.reduce((sum, [, n]) => sum + n, 0)
    for (const [l, n] of lists) {
      const halfWedge = (Math.PI * n) / total
      for (let i = 0; i < n; i++) expect(gap(angle(`item-${l}-${i}`), angle(l)), `${l} card ${i}`).toBeLessThanOrEqual(halfWedge + 0.001)
    }
  })

  test("the root is the centre", () => {
    expect(t.get("bloq-682")).toEqual({ x: 0, y: 0 })
  })

  test("wedges are sized by card count, so cards are evenly spaced and none are crammed", () => {
    // Equal wedges per list would put Package Index's 5 cards in the same arc as Organ-System's
    // one, cramming them. Proportional wedges space every card the same.
    const as = nodes.filter((n) => n.id.startsWith("item-")).map((n) => angle(n.id)).sort((a, b) => a - b)
    const gaps = as.map((a, i) => gap(a, as[(i + 1) % as.length]))
    expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThan(0.001)
  })

  test("related projects all sit on the one outer ring, outside the structure", () => {
    const r = (id: string) => Math.hypot(t.get(id)!.x, t.get(id)!.y)
    const outer = Array.from({ length: 31 }, (_, i) => r(`bloq-${i}`))
    expect(Math.max(...outer) - Math.min(...outer)).toBeLessThan(0.001)
    expect(outer[0]).toBeGreaterThan(r("item-list-pkg-0"))
  })

  test("every node gets a position", () => {
    expect(t.size).toBe(nodes.length)
  })
})
