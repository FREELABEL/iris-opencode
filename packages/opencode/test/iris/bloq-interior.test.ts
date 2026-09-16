import { describe, expect, test } from "bun:test"
import { assembleInterior, interiorClusterSize } from "../../src/iris/platform"

/**
 * A board's interior, folded in beside the board-to-board graph. These cover the structural
 * rules that fail SILENTLY — a dangling edge anchors at the origin and draws a real-looking
 * relation to nothing, and an id collision merges two unrelated things into one node.
 */

const cat = (key: string, label: string, type: string, n: number) => ({
  key,
  label,
  type,
  items: Array.from({ length: n }, (_, i) => ({ id: `item-${key}-${i}`, name: `${label} ${i}` })),
})

describe("an empty category gets no hub", () => {
  test("a board with nothing in it is just its Atlas centre", () => {
    const { nodes, edges } = assembleInterior(12, [cat("agents", "Agents", "agent", 0)])
    expect(nodes).toHaveLength(1)
    expect(nodes[0].id).toBe("bloq-12")
    expect(edges).toHaveLength(0)
  })

  test("an empty category cannot be told from a failed fetch, so it is not drawn", () => {
    // The five fetches behind this fail independently. Drawing an empty "Leads" hub would
    // assert the board has no leads, which is precisely what a failed fetch does not know.
    const { nodes } = assembleInterior(12, [cat("agents", "Agents", "agent", 2), cat("leads", "Leads", "leadcluster", 0)])
    expect(nodes.some((n) => n.id === "hub-leads-12")).toBe(false)
    expect(nodes.some((n) => n.id === "hub-agents-12")).toBe(true)
  })
})

describe("every edge resolves to a node that exists", () => {
  test("no dangling endpoints across a full interior", () => {
    const { nodes, edges } = assembleInterior(7, [
      cat("agents", "Agents", "agent", 3),
      cat("pages", "Pages", "page", 2),
      cat("lists", "Lists", "atlas", 1),
    ])
    const ids = new Set(nodes.map((n) => n.id))
    for (const e of edges) {
      expect(ids.has(e.source), `source ${e.source}`).toBe(true)
      expect(ids.has(e.target), `target ${e.target}`).toBe(true)
    }
  })

  test("items hang off their hub, never straight off the centre", () => {
    // 200 leads wired into Atlas directly buries the other categories in a hairball.
    const { edges } = assembleInterior(7, [cat("leads", "Leads", "leadcluster", 4)])
    const fromCentre = edges.filter((e) => e.source === "bloq-7")
    expect(fromCentre).toHaveLength(1)
    expect(fromCentre[0].target).toBe("hub-leads-7")
  })
})

describe("ids are namespaced, because an item id can equal a board id", () => {
  test("nothing collides with a bare number", () => {
    const { nodes } = assembleInterior(1, [cat("agents", "Agents", "agent", 2)])
    for (const n of nodes) {
      expect(typeof n.id).toBe("string")
      expect(n.id).not.toMatch(/^\d+$/)
    }
  })

  test("two boards' hubs and centres do not share an id", () => {
    const a = assembleInterior(1, [cat("agents", "Agents", "agent", 1)])
    const b = assembleInterior(2, [cat("agents", "Agents", "agent", 1)])
    const aIds = new Set(a.nodes.map((n) => n.id))
    expect(aIds.has("hub-agents-2")).toBe(false)
    expect(aIds.has("bloq-2")).toBe(false)
    expect(b.nodes.some((n) => n.id === "bloq-2")).toBe(true)
  })
})

describe("cluster size is Elon's log scale", () => {
  test("5 and 50,000 both fit", () => {
    expect(interiorClusterSize(5)).toBeLessThan(30)
    expect(interiorClusterSize(50000)).toBeLessThanOrEqual(30)
  })

  test("more members is bigger, but not linearly", () => {
    const small = interiorClusterSize(10)
    const big = interiorClusterSize(1000)
    expect(big).toBeGreaterThan(small)
    // Linear would make 1000 a hundred times 10 and swallow the canvas.
    expect(big).toBeLessThan(small * 3)
  })

  test("zero members does not produce NaN or a negative radius", () => {
    // Math.log2(0) is -Infinity; the +1 is what stops a category of nothing drawing inside out.
    expect(interiorClusterSize(0)).toBeGreaterThan(0)
    expect(Number.isFinite(interiorClusterSize(0))).toBe(true)
  })
})
