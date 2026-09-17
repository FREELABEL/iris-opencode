import { describe, expect, test } from "bun:test"
import golden from "./relationship-graph.golden.json"
import { buildRelationshipGraph, inferType, renderedGraph, type GraphInputs } from "../../src/iris/relationship-graph"

/**
 * #185584 PARITY, pinned.
 *
 * `expected` in the golden file was not written by hand: it is the output of ELON's own
 * `relationshipGraphData` (Board.vue) and `processListsFromBoardData` (BloqContentContainer.vue),
 * extracted from source and executed on these inputs by packages/opencode/parity-harness.ts. So
 * a failure here means the port and ELON now DISAGREE — not that someone's expectation changed.
 *
 * Deep equality, not counts. A port with one hub sized 21 instead of 20 keeps every count equal
 * and fails here; it was tried deliberately to prove it.
 */
const norm = (g: { nodes: any[]; edges: any[] }) => ({
  nodes: g.nodes.map((n) => [n.id, n.name, n.type, n.subtitle ?? null, Math.round(n.size * 1e6) / 1e6]),
  edges: g.edges.map((e) => [e.source, e.target, e.type ?? null, e.label ?? null]),
})

describe("relationship graph matches ELON's output exactly", () => {
  for (const [name, fixture] of Object.entries(golden as Record<string, { inputs: GraphInputs; expected: any }>)) {
    test(name, () => {
      const port = renderedGraph(buildRelationshipGraph(fixture.inputs))
      expect(norm(port)).toEqual(norm(fixture.expected))
    })
  }
})

describe("the rules the golden file exercises, named", () => {
  const RICH = (golden as any).RICH.inputs as GraphInputs
  const g = renderedGraph(buildRelationshipGraph(RICH))
  const ids = new Set(g.nodes.map((n) => n.id))

  test("leads cluster by status — one node per status, not per lead", () => {
    const clusters = g.nodes.filter((n) => n.id.startsWith("leadstatus-"))
    // 6 leads: hot×2, " Cold " (trimmed), null + "" (both "No status"), "Needs Follow-Up!".
    // Order is ELON's plain .sort() — code-unit order, so "Needs" < "No" and capitals before "hot".
    // (Hand-written as "No status" first on the first attempt; the golden test, which runs ELON's
    // code, was right and this was wrong.)
    expect(clusters.map((n) => n.name)).toEqual(["Cold", "Needs Follow-Up!", "No status", "hot"])
  })

  test("programs come from leads' enrolled_programs", () => {
    expect(g.nodes.filter((n) => n.type === "program" && n.id !== "programs-hub").map((n) => n.name)).toEqual(["Mentorship", "Bootcamp"])
  })

  test("only THIS board's workflow jobs make the Workflows hub", () => {
    expect(ids.has("workflow-501")).toBe(true)
    expect(ids.has("workflow-502")).toBe(true) // bloq_id "42" as a string still matches, as parseInt does in ELON
    expect(ids.has("workflow-503")).toBe(false) // another board
  })

  test("a `runs` edge to a workflow with no node is dropped, as ELON's renderer drops it", () => {
    expect(g.edges.some((e) => e.target === "workflow-999")).toBe(false)
    expect(g.edges.filter((e) => e.label === "runs").length).toBe(1) // 501 twice dedupes to one
  })

  test("assigned edges resolve only to agents on this board", () => {
    const assigned = g.edges.filter((e) => e.label === "assigned").map((e) => `${e.source}->${e.target}`)
    expect(assigned).toEqual(["agent-11->item-1", "agent-12->item-5"])
  })

  test("related boards join as bloq nodes, and a repeated relation adds one edge", () => {
    expect(g.nodes.find((n) => n.id === "bloq-7")?.type).toBe("bloq")
    expect(g.edges.filter((e) => e.type === "feeds_into").length).toBe(1)
  })

  test("an item with a name but no title is 'Item' — ELON's cards never carry name", () => {
    expect(g.nodes.find((n) => n.id === "item-4")?.name).toBe("Item")
  })

  test("inferType keeps ELON's first-match order", () => {
    expect(inferType("Venue for the show")).toBe("event") // "show" is checked before "venue"
    expect(inferType("")).toBe("brand")
  })
})
