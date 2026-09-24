import { describe, expect, test } from "bun:test"
import golden from "./relationship-graph.golden.json"
import {
  buildRelationshipGraph,
  inferType,
  parseExpandedListIds,
  renderedGraph,
  type GraphInputs,
} from "../../src/iris/relationship-graph"

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

/**
 * THE CAP, which is the one place the port and ELON deliberately agree to stop drawing.
 *
 * Measured 2026-09-22 on the Pathways SOP library: one board produced 159 item nodes, the labels
 * overlapped into an unreadable ring, and the owner could not use the pane. Leads and programs
 * were already clustered; cards were not. The remainder is not dropped — it is one node that
 * says how many it stands for, so the picture still reports its own size.
 */
describe("a long list collapses its tail instead of drawing every card", () => {
  const listOf = (n: number) => ({
    id: 9001,
    name: "SOP Library",
    items: Array.from({ length: n }, (_, i) => ({ id: 5000 + i, title: `SOP ${i + 1}` })),
  })
  const inputs = (n: number): GraphInputs => ({
    bloqId: 42,
    boardTitle: "Pathways",
    lists: [listOf(n)],
    relations: [],
    agents: [],
    scheduledJobs: [],
    playbooks: [],
    leads: [],
  })

  test("nine cards draw six, plus one node standing for the other three", () => {
    const g = renderedGraph(buildRelationshipGraph(inputs(9)))
    const items = g.nodes.filter((n) => n.id.startsWith("item-"))
    const more = g.nodes.filter((n) => n.id === "list-9001-more")
    expect(items).toHaveLength(6)
    expect(more).toHaveLength(1)
    expect(more[0].name).toBe("+3 more")
    // It hangs off the list it belongs to, not off the Memory hub or the centre.
    expect(g.edges.some((e) => e.source === "list-9001" && e.target === "list-9001-more")).toBe(true)
  })

  test("six or fewer is left exactly as it was — the cap never fires early", () => {
    const g = renderedGraph(buildRelationshipGraph(inputs(6)))
    expect(g.nodes.filter((n) => n.id.startsWith("item-"))).toHaveLength(6)
    expect(g.nodes.some((n) => n.id.endsWith("-more"))).toBe(false)
  })

  test("the collapsed node is sized by how many it stands for", () => {
    const small = renderedGraph(buildRelationshipGraph(inputs(8)))
    const big = renderedGraph(buildRelationshipGraph(inputs(200)))
    const sizeOf = (g: { nodes: any[] }) => g.nodes.find((n) => n.id === "list-9001-more")!.size
    expect(sizeOf(big)).toBeGreaterThan(sizeOf(small))
  })
})

/*
 * EXPANDING A LIST — the cap's escape hatch (the `expand` query on /iris/graph/:bloqID).
 *
 * The cap is what makes a real board readable, and it is also why a card can become
 * unreachable: a node is the only thing you can click to open a card, and a card behind a
 * "+N more" has none. Measured on board 517 with the cap and no way out: 66 cards clickable,
 * 101 not, out of 167.
 */
describe("a list can be expanded to draw every card in it", () => {
  const listOf = (n: number, id = 9001) => ({
    id,
    name: "List " + id,
    items: Array.from({ length: n }, (_, i) => ({ id: id * 100 + i + 1, title: "Card " + (i + 1) })),
  })
  const inputs = (lists: any[], expandedListIds?: ReadonlySet<number>): GraphInputs => ({
    bloqId: 42,
    boardTitle: "Pathways",
    lists,
    expandedListIds,
    relations: [],
    agents: [],
    scheduledJobs: [],
    playbooks: [],
    leads: [],
  })

  test("an expanded list draws all of its cards, and loses its +N more", () => {
    const g = renderedGraph(buildRelationshipGraph(inputs([listOf(20)], new Set([9001]))))
    expect(g.nodes.filter((n) => n.id.startsWith("item-"))).toHaveLength(20)
    // Nothing is standing in for anything any more, so the placeholder must be gone — leaving
    // it would claim there are cards beyond the twenty now drawn.
    expect(g.nodes.some((n) => n.id === "list-9001-more")).toBe(false)
  })

  test("every expanded card is a real node, which is the whole point — they can be opened", () => {
    const g = renderedGraph(buildRelationshipGraph(inputs([listOf(20)], new Set([9001]))))
    const ids = new Set(g.nodes.map((n) => n.id))
    for (let i = 1; i <= 20; i++) expect(ids.has("item-" + (900100 + i)), "card " + i).toBe(true)
    // And each hangs off its own list, not off the centre.
    expect(g.edges.filter((e) => e.source === "list-9001" && e.target.startsWith("item-"))).toHaveLength(20)
  })

  test("expanding ONE list leaves every other list capped", () => {
    const g = renderedGraph(buildRelationshipGraph(inputs([listOf(20, 9001), listOf(20, 9002)], new Set([9001]))))
    const under = (listId: number) =>
      g.edges.filter((e) => e.source === "list-" + listId && e.target.startsWith("item-")).length
    expect(under(9001)).toBe(20)
    expect(under(9002)).toBe(6)
    expect(g.nodes.some((n) => n.id === "list-9002-more")).toBe(true)
    expect(g.nodes.some((n) => n.id === "list-9001-more")).toBe(false)
  })

  test("an id nobody has expands nothing — it never widens another list", () => {
    const g = renderedGraph(buildRelationshipGraph(inputs([listOf(20)], new Set([424242]))))
    expect(g.nodes.filter((n) => n.id.startsWith("item-"))).toHaveLength(6)
    expect(g.nodes.some((n) => n.id === "list-9001-more")).toBe(true)
  })

  test("no expansion at all is byte-identical to the capped default", () => {
    // The golden pins the default; this pins that ADDING the parameter did not change it.
    const withUndefined = renderedGraph(buildRelationshipGraph(inputs([listOf(20)])))
    const withEmptySet = renderedGraph(buildRelationshipGraph(inputs([listOf(20)], new Set())))
    expect(withEmptySet).toEqual(withUndefined)
    expect(withUndefined.nodes.filter((n) => n.id.startsWith("item-"))).toHaveLength(6)
  })

  test("a list id that arrives as a numeric STRING still expands", () => {
    // fl-api returns ids as numbers here and strings there; comparing them raw silently
    // expanded nothing, which looks exactly like a click that did not register.
    const stringy = [{ ...listOf(20), id: "9001" as any }]
    const g = renderedGraph(buildRelationshipGraph(inputs(stringy, new Set([9001]))))
    expect(g.nodes.filter((n) => n.id.startsWith("item-"))).toHaveLength(20)
  })
})

/*
 * THE `expand` QUERY, parsed.
 *
 * It only ever widens what is drawn, so every rule here is "drop the bad id, keep the graph".
 * Rejecting the request instead would blank a board because one id had a stray character.
 */
describe("parseExpandedListIds", () => {
  test("a comma-separated list becomes the set of ids", () => {
    expect([...(parseExpandedListIds("1871,1902") ?? [])]).toEqual([1871, 1902])
  })

  test("spaces around the ids are tolerated — a hand-typed URL still works", () => {
    expect([...(parseExpandedListIds(" 1871 , 1902 ") ?? [])]).toEqual([1871, 1902])
  })

  test("nothing to expand is undefined, not an empty set", () => {
    // buildRelationshipGraph reads `expandedListIds?.has(...) ?? false`, so an empty set and
    // undefined behave the same — but undefined is what "the caller asked for nothing" means.
    expect(parseExpandedListIds(undefined)).toBeUndefined()
    expect(parseExpandedListIds("")).toBeUndefined()
    expect(parseExpandedListIds(",,")).toBeUndefined()
    expect(parseExpandedListIds(null)).toBeUndefined()
  })

  test("junk is dropped, and the ids beside it survive", () => {
    expect([...(parseExpandedListIds("1871,abc,,1902") ?? [])]).toEqual([1871, 1902])
  })

  test("zero, negatives and fractions are not list ids", () => {
    expect(parseExpandedListIds("0,-4,1.5")).toBeUndefined()
  })

  test("a repeated id is one id — the set is the point", () => {
    expect([...(parseExpandedListIds("1871,1871") ?? [])]).toEqual([1871])
  })
})
