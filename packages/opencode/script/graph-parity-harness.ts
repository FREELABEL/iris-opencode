/**
 * DIFFERENTIAL PARITY HARNESS — runs ELON's ACTUAL code next to the port.
 *
 * Not committed as a test (it reads fl-elon-web-ui from the monorepo, which CI does not have).
 * Its job is to produce the golden expectations the committed test pins, and to run the
 * equal-counts check #185584 asks for against live boards.
 */
import { readFileSync, writeFileSync } from "fs"
import { buildRelationshipGraph, renderedGraph, type GraphInputs } from "../src/iris/relationship-graph"

// The monorepo's Elon checkout. Overridable because this path is one machine's layout.
const ELON =
  process.env.ELON_DASHBOARD_DIR ??
  "/Users/mayoalexander/sites/freelabel/fl-docker-dev/fl-elon-web-ui/components/Dashboard"
const board = readFileSync(`${ELON}/Bloq/Board.vue`, "utf8")
const container = readFileSync(`${ELON}/BloqContentContainer.vue`, "utf8")

/** Body of `name (args) {` … matching `}`, with brace matching that skips strings/templates. */
function extract(src: string, signature: string): { args: string; body: string } {
  const at = src.indexOf(signature)
  if (at < 0) throw new Error(`not found in ELON source: ${signature}`)
  const open = src.indexOf("{", at + signature.length - 1)
  const args = signature.slice(signature.indexOf("(") + 1, signature.lastIndexOf(")"))
  let depth = 0
  let q: string | null = null
  for (let i = open; i < src.length; i++) {
    const c = src[i]
    if (q) {
      if (c === "\\") { i++; continue }
      if (c === q) q = null
      continue
    }
    if (c === "'" || c === '"' || c === "`") { q = c; continue }
    if (c === "/" && src[i + 1] === "/") { i = src.indexOf("\n", i); continue }
    if (c === "{") depth++
    else if (c === "}") { depth--; if (depth === 0) return { args, body: src.slice(open + 1, i) } }
  }
  throw new Error(`unbalanced: ${signature}`)
}

const mk = (sig: { args: string; body: string }) => new Function(sig.args, sig.body)
const elonGraph = mk(extract(board, "relationshipGraphData () {"))
const elonWorkflowJobs = mk(extract(board, "scheduledWorkflowJobs () {"))
const elonAssigned = mk(extract(board, "getCardAssignedAgents (card) {"))
const elonProcessLists = mk(extract(container, "processListsFromBoardData (boardData) {"))

/** Run ELON's real pipeline over raw inputs, then its renderer's dangling-edge filter. */
export function runElon(inp: GraphInputs) {
  const listsHost: any = { lists: [] }
  const quiet = console.log
  console.log = () => {}
  try { elonProcessLists.call(listsHost, { lists: inp.lists }) } finally { console.log = quiet }
  const getters: Record<string, any> = {
    "leads/getLeadsByBloq": () => inp.leads,
    "bloqs/getPlaybooksByBloq": () => inp.playbooks,
    "bloqs/getRelationsByBloq": () => inp.relations,
    "bloqs/getScheduledJobs": inp.scheduledJobs,
    "bloqs/getDeployedAgents": inp.agents,
  }
  const self: any = {
    localBoardId: inp.bloqId,
    boardId: String(inp.bloqId),
    boardTitle: inp.boardTitle,
    agentsWithTasks: inp.agents,
    lists: listsHost.lists,
    $store: { getters },
  }
  self.scheduledWorkflowJobs = elonWorkflowJobs.call(self)
  self.getCardAssignedAgents = (card: any) => elonAssigned.call(self, card)
  const g = elonGraph.call(self)
  const ids = new Set(g.nodes.map((n: any) => n.id))
  return { nodes: g.nodes, edges: g.edges.filter((e: any) => ids.has(e.source) && ids.has(e.target)) }
}

/** Canonical, order-sensitive comparison of everything the renderer consumes. */
const norm = (g: { nodes: any[]; edges: any[] }) => ({
  nodes: g.nodes.map((n) => [n.id, n.name, n.type, n.subtitle ?? null, Math.round(n.size * 1e6) / 1e6]),
  edges: g.edges.map((e) => [e.source, e.target, e.type ?? null, e.label ?? null]),
})

export function compare(label: string, inp: GraphInputs) {
  const a = norm(runElon(inp))
  const b = norm(renderedGraph(buildRelationshipGraph(inp)))
  const sa = JSON.stringify(a)
  const sb = JSON.stringify(b)
  const ok = sa === sb
  console.log(`${ok ? "✓" : "✗"} ${label}: ELON ${a.nodes.length} nodes/${a.edges.length} edges · port ${b.nodes.length}/${b.edges.length}`)
  if (!ok) {
    for (let i = 0; i < Math.max(a.nodes.length, b.nodes.length); i++)
      if (JSON.stringify(a.nodes[i]) !== JSON.stringify(b.nodes[i])) { console.log("  first node diff", i, a.nodes[i], b.nodes[i]); break }
    for (let i = 0; i < Math.max(a.edges.length, b.edges.length); i++)
      if (JSON.stringify(a.edges[i]) !== JSON.stringify(b.edges[i])) { console.log("  first edge diff", i, a.edges[i], b.edges[i]); break }
  }
  return { ok, elon: runElon(inp), inputs: inp }
}

// ── Synthetic fixture: every rule and every edge case in one board ──
export const RICH: GraphInputs = {
  bloqId: 42,
  boardTitle: "Song Wars HQ",
  leads: [
    { status: "hot", enrolled_programs: [{ id: 7, name: "Mentorship" }, { program_id: 9, name: "Bootcamp" }] },
    { status: "hot", enrolled_programs: [{ id: 7, name: "Mentorship" }] },
    { status: " Cold ", enrolled_programs: [] },
    { status: null },
    { status: "" },
    { status: "Needs Follow-Up!" },
  ],
  agents: [
    { id: 11, name: "Scout", model: "gpt-4.1-nano", scheduled_jobs: [{ workflow_id: 501 }, { workflow_id: 501 }, { workflow_id: null }] },
    { id: 12, name: null, model: null, scheduled_jobs: [{ workflow_id: 999 }] },
  ],
  scheduledJobs: [
    { id: 1, bloq_id: 42, workflow_id: 501, task_name: "Daily digest", status: "active" },
    { id: 2, bloq_id: "42", workflow_id: 502, workflow: { name: "Fallback name" }, frequency: "weekly" },
    { id: 3, bloq_id: 42, workflow_id: null, task_name: "agent job, not a workflow" },
    { id: 4, bloq_id: 77, workflow_id: 503, task_name: "other board" },
  ],
  playbooks: [
    { name: "Lead Outreach", attached_at: "2026-09-01" },
    { name: null, slug: "health-check" },
    { name: null, slug: null },
  ],
  lists: [
    {
      id: 900,
      name: "Venue Scouting",
      items: [
        { id: 1, title: "Studio A booking", content: '{"assignedAgents":[11,999]}' },
        { id: 2, title: null, content: '{"title":"Artist roster from content"}' },
        { id: 3, title: "A very long item title that is well over thirty characters", content: "not json" },
        { id: 4, title: null, name: "has a name but ELON ignores it", content: null },
      ],
    },
    { id: 901, name: null, items: [] },
    { id: 902, name: "Team Contacts", items: [{ id: 5, title: "Plain thing", content: { assignedAgents: [12] } }] },
  ],
  relations: [
    { direction: "from", relation_type: "feeds_into", related_bloq: { id: 7, name: "Label Ops" } },
    { direction: "to", relation_type: "parent", related_bloq: { id: 8, name: null } },
    { direction: "from", relation_type: "feeds_into", related_bloq: { id: 7, name: "Label Ops" } },
    { direction: "from", relation_type: "sibling", related_bloq: null },
  ],
}

export const EMPTY: GraphInputs = { bloqId: 5, boardTitle: null, leads: [], agents: [], scheduledJobs: [], playbooks: [], lists: [], relations: [] }

if (import.meta.main) {
  const results = [compare("synthetic RICH", RICH), compare("synthetic EMPTY", EMPTY)]
  writeFileSync(
    "test/iris/relationship-graph.golden.json",
    JSON.stringify({ RICH: { inputs: RICH, expected: results[0].elon }, EMPTY: { inputs: EMPTY, expected: results[1].elon } }, null, 1) + "\n",
  )
  console.log(results.every((r) => r.ok) ? "\nall synthetic fixtures match ELON" : "\nMISMATCH")
}
