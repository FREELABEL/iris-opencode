/**
 * A board's relationship graph, built by ELON'S RULES — not by rules that resemble them.
 *
 * This is a port of `relationshipGraphData` in fl-elon-web-ui's Board.vue, plus the two
 * transforms that feed it (BloqContentContainer's list→card mapping and the scheduled-job
 * filter). #185584 asks for the EXACT structure, with equal node and edge counts as the check,
 * and the previous desktop assembler could not pass that check on any board with leads:
 *
 *   ELON     leads clustered by STATUS — one node per status, sized by head-count
 *   desktop  one node per LEAD
 *
 * so 200 leads in 3 statuses were 4 nodes in one graph and 51 in the other. It also had no
 * Programs or Workflows hubs, no agent→workflow `runs` or agent→item `assigned` edges, no
 * related boards, and a Lists/Pages vocabulary ELON does not have. The renderer was never the
 * gap; the assembly was.
 *
 * READ THIS BEFORE "IMPROVING" ANYTHING HERE. Every oddity below is ELON's and is deliberate in
 * the sense that matters: changing it makes the two graphs disagree again. That includes
 * inferring a list's type from its title, truncating item labels at 30, fixed hub sizes, and
 * hub edges carrying a label but no type. If one of those is wrong, fix it in ELON and here in
 * the same change — that is the one-component rule #183240 exists to enforce.
 *
 * Pure, so the rules are provable without a network: test/iris/relationship-graph.test.ts runs
 * fixtures whose expected output was produced by executing ELON's own function.
 */

export interface GraphNode {
  id: string
  name: string
  type: string
  subtitle?: string
  size: number
}

export interface GraphEdge {
  source: string
  target: string
  /** Only relation edges carry a type. ELON's hub and child edges have none. */
  type?: string
  label?: string
}

/** Raw API shapes, as fl-api returns them — the transforms ELON applies happen in here. */
export interface GraphInputs {
  bloqId: number
  /** The board's `name`. ELON's centre subtitle is `boardTitle || 'Project'`. */
  boardTitle?: string | null
  /** GET /api/v1/users/{uid}/leads?bloq_id=&per_page=50 — the same page size ELON loads. */
  leads: Array<{ status?: unknown; enrolled_programs?: Array<Record<string, any>> | null }>
  /** GET /api/v1/users/{uid}/bloqs/{bloqId}/agents/with-tasks */
  agents: Array<{ id: number; name?: string | null; model?: string | null; scheduled_jobs?: Array<{ workflow_id?: number | null }> | null }>
  /** GET /api/v1/users/{uid}/bloqs/scheduled-jobs — filtered here exactly as ELON filters it. */
  scheduledJobs: Array<Record<string, any>>
  /** GET /api/v1/bloqs/{bloqId}/playbooks */
  playbooks: Array<{ name?: string | null; slug?: string | null; attached_at?: string | null }>
  /** GET /api/v1/user/{uid}/bloqs/{bloqId} → `lists`, each with raw `items`. */
  lists: Array<{ id: number | string; name?: string | null; items?: Array<Record<string, any>> | null }>
  /** GET /api/v1/user/{uid}/bloqs/{bloqId}/relations */
  relations: Array<{ direction?: string; relation_type?: string; related_bloq?: { id: number; name?: string | null } | null }>
  /**
   * Agents an item's `content.assignedAgents` may resolve to. ELON resolves against its store's
   * deployed agents; passing the board's own agents gives the same RENDERED graph, because an
   * `assigned` edge to an agent with no node on this board is dropped as dangling either way.
   */
  deployedAgentIds?: Set<number>
}

/** ELON's log scale, so a cluster of 5 and one of 50,000 both fit. */
export const clusterSize = (count: number) => Math.min(30, 14 + Math.log2((count || 0) + 1) * 2)

/**
 * How many cards one list may draw before the rest collapse into a single "+N more".
 * Six keeps a list legible at the zoom the pane opens at; the cap is mirrored in ELON.
 */
const MAX_CARDS_PER_LIST = 6

/** ELON's title→type guess for lists and their items. Order matters: first match wins. */
export function inferType(text: unknown): string {
  const t = String(text || "").toLowerCase()
  if (t.includes("event") || t.includes("song wars") || t.includes("show") || t.includes("concert") || t.includes("festival")) return "event"
  if (t.includes("venue") || t.includes("studio") || t.includes("creators dont die") || t.includes("location")) return "venue"
  if (t.includes("swot") || t.includes("audit") || t.includes("action plan") || t.includes("deal") || t.includes("strategy")) return "deal"
  if (t.includes("artist") || t.includes("dj") || t.includes("producer") || t.includes("musician")) return "artist"
  if (t.includes("contact") || t.includes("person") || t.includes("team")) return "person"
  return "brand"
}

/** BloqContentContainer's card title: the item's own, else its parsed content's, else null. */
function toCard(item: Record<string, any>) {
  let content = item.content
  if (typeof content === "string") {
    try {
      content = JSON.parse(content)
    } catch {
      // ELON keeps the string as-is when it is not JSON.
    }
  }
  // No `name`: ELON's card carries id/title/description/content/type/status/sort_order only, so
  // the graph's `item.title || item.name || 'Item'` can never reach `name` there. Carrying it
  // here would label an untitled item by its name in one graph and "Item" in the other.
  return {
    id: item.id,
    title: item.title || (content && typeof content === "object" ? content.title : null) || null,
    content,
  }
}

export function buildRelationshipGraph(input: GraphInputs): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = []
  const edges: GraphEdge[] = []
  const nodeIds = new Set<string>()

  const addNode = (id: string, name: string, type: string, opts: { subtitle?: string; size: number }) => {
    if (nodeIds.has(id)) return
    nodeIds.add(id)
    nodes.push({ id, name, type, ...opts })
  }

  const bloqId = input.bloqId
  const bloqNodeId = "bloq-" + bloqId
  if (bloqId) {
    addNode(bloqNodeId, "ATLAS", "atlas", { subtitle: input.boardTitle || "Project", size: 28 })
  }

  const addHub = (hubId: string, label: string, type: string, subtitle: string) => {
    addNode(hubId, label, type, { subtitle: subtitle || "", size: 20 })
    if (bloqId) edges.push({ source: bloqNodeId, target: hubId, label: label.toLowerCase() })
    return hubId
  }
  const plural = (n: number, word: string) => `${n} ${word}${n !== 1 ? "s" : ""}`

  // ── Leads + Programs ──
  const leads = input.leads ?? []
  const progKey = (p: Record<string, any>) => "program-" + (p.id || p.program_id || p.enrollment_id || p.name)
  const programs: Record<string, { key: string; name: string; count: number }> = {}
  for (const lead of leads) {
    for (const p of lead.enrolled_programs || []) {
      const key = progKey(p)
      if (!programs[key]) programs[key] = { key, name: p.name || "Program", count: 0 }
      programs[key].count++
    }
  }
  const programList = Object.values(programs)
  if (programList.length > 0) {
    const programsHub = addHub("programs-hub", "Programs", "program", plural(programList.length, "program"))
    for (const prog of programList) {
      addNode(prog.key, prog.name, "program", { subtitle: plural(prog.count, "lead"), size: clusterSize(prog.count) })
      edges.push({ source: programsHub, target: prog.key })
    }
  }

  if (leads.length > 0) {
    const statusGroups: Record<string, number> = {}
    for (const lead of leads) {
      const status = String(lead.status || "No status").trim() || "No status"
      statusGroups[status] = (statusGroups[status] || 0) + 1
    }
    const leadsHub = addHub("leads-hub", "Leads", "leadcluster", plural(leads.length, "contact"))
    for (const status of Object.keys(statusGroups).sort()) {
      const count = statusGroups[status]
      const sid = "leadstatus-" + status.toLowerCase().replace(/[^a-z0-9]+/g, "-")
      addNode(sid, status, "leadcluster", { subtitle: plural(count, "contact"), size: clusterSize(count) })
      edges.push({ source: leadsHub, target: sid })
    }
  }

  // ── Agents (+ agent→workflow "runs") ──
  // NOT addHub: ELON builds this hub by hand, with the same size and a fixed "agents" label.
  const agents = input.agents ?? []
  const agentWorkflowSeen = new Set<string>()
  if (agents.length > 0) {
    const agentsHubId = "agents-hub"
    addNode(agentsHubId, "Agents", "agent", { subtitle: plural(agents.length, "agent"), size: 20 })
    if (bloqId) edges.push({ source: bloqNodeId, target: agentsHubId, label: "agents" })
    for (const agent of agents) {
      const aId = "agent-" + agent.id
      addNode(aId, agent.name || "Agent #" + agent.id, "agent", { subtitle: agent.model || "", size: 15 })
      edges.push({ source: agentsHubId, target: aId })
      for (const job of agent.scheduled_jobs || []) {
        if (job && job.workflow_id) {
          const wId = "workflow-" + job.workflow_id
          const seenKey = aId + "->" + wId
          if (!agentWorkflowSeen.has(seenKey)) {
            agentWorkflowSeen.add(seenKey)
            edges.push({ source: aId, target: wId, label: "runs" })
          }
        }
      }
    }
  }

  // ── Workflows: ELON's `scheduledWorkflowJobs` — this board's jobs that point at a workflow ──
  const workflowJobs = (input.scheduledJobs ?? []).filter(
    (job) => parseInt(String(job.bloq_id)) === bloqId && job.workflow_id != null,
  )
  if (workflowJobs.length > 0) {
    const workflowsHub = addHub("workflows-hub", "Workflows", "workflow", plural(workflowJobs.length, "workflow"))
    for (const job of workflowJobs) {
      const wId = "workflow-" + (job.workflow_id || job.id)
      addNode(wId, job.task_name || (job.workflow && job.workflow.name) || "Workflow", "workflow", {
        subtitle: job.status || job.frequency || "",
        size: 15,
      })
      edges.push({ source: workflowsHub, target: wId })
    }
  }

  // ── Playbooks ──
  const playbooks = input.playbooks ?? []
  if (playbooks.length > 0) {
    const playbooksHub = addHub("playbooks-hub", "Playbooks", "playbook", plural(playbooks.length, "playbook"))
    playbooks.forEach((pb, i) => {
      const name = pb.name || pb.slug || "Playbook " + (i + 1)
      const pid = "playbook-" + String(pb.name || pb.slug || i).toLowerCase().replace(/[^a-z0-9]+/g, "-")
      addNode(pid, name, "playbook", { subtitle: pb.attached_at ? "attached" : "", size: 14 })
      edges.push({ source: playbooksHub, target: pid })
    })
  }

  // ── Lists + their cards, under one Memory hub ──
  const lists = (input.lists ?? []).map((l) => ({
    id: l.id,
    title: l.name || "Untitled List",
    cards: (l.items || []).map(toCard),
  }))
  const memoryHub = lists.length > 0 ? addHub("memory-hub", "Memory", "memory", plural(lists.length, "list")) : null
  const deployed = input.deployedAgentIds ?? new Set(agents.map((a) => a.id))
  for (const list of lists) {
    const listType = inferType(list.title)
    addNode("list-" + list.id, list.title || "List", listType, { size: 16 })
    if (memoryHub) edges.push({ source: memoryHub, target: "list-" + list.id })
    /*
     * CARDS ARE CAPPED PER LIST — the one deliberate divergence from drawing every row.
     *
     * ELON drew one node per card, and on a small board that is right. On a real one it is not:
     * the Pathways SOP library renders 159 item nodes under a handful of lists, the labels
     * overlap into a ring, and the hubs the picture exists to show disappear inside it. Leads
     * and programs were already clustered for this exact reason; cards were the branch that
     * still drew everything.
     *
     * The remainder is never silently dropped: it becomes one "+N more" node, sized by how many
     * it stands for, so the drawing still says how much is behind it. The same cap now applies in
     * ELON's Board.vue, so the two surfaces still agree — which is what the golden pins.
     */
    const shownCards = list.cards.slice(0, MAX_CARDS_PER_LIST)
    const hiddenCards = list.cards.length - shownCards.length
    if (hiddenCards > 0) {
      addNode("list-" + list.id + "-more", "+" + hiddenCards + " more", listType, {
        subtitle: list.title || "",
        size: clusterSize(hiddenCards),
      })
      edges.push({ source: "list-" + list.id, target: "list-" + list.id + "-more" })
    }
    for (const item of shownCards) {
      const itemLabel = String(item.title || "Item")
      const type = inferType(itemLabel) !== "brand" ? inferType(itemLabel) : listType
      addNode("item-" + item.id, itemLabel.length > 30 ? itemLabel.slice(0, 28) + "..." : itemLabel, type, {
        subtitle: list.title || "",
        size: 12,
      })
      edges.push({ source: "list-" + list.id, target: "item-" + item.id })
      const assigned = item.content && typeof item.content === "object" ? item.content.assignedAgents : null
      for (const agentId of Array.isArray(assigned) ? assigned : []) {
        if (deployed.has(agentId)) edges.push({ source: "agent-" + agentId, target: "item-" + item.id, label: "assigned" })
      }
    }
  }

  // ── Related boards ──
  for (const relation of input.relations ?? []) {
    if (!relation.related_bloq) continue
    const relatedId = "bloq-" + relation.related_bloq.id
    addNode(relatedId, relation.related_bloq.name || "Bloq #" + relation.related_bloq.id, "bloq", { size: 18 })
    const source = relation.direction === "from" ? "bloq-" + bloqId : relatedId
    const target = relation.direction === "from" ? relatedId : "bloq-" + bloqId
    const alreadyExists = edges.some((e) => e.source === source && e.target === target && e.type === relation.relation_type)
    if (!alreadyExists) edges.push({ source, target, type: relation.relation_type, label: relation.relation_type })
  }

  return { nodes, edges }
}

/**
 * What RelationshipGraph.vue actually draws: edges whose ends both exist.
 *
 * ELON's builder emits `runs` and `assigned` edges optimistically and lets the renderer drop the
 * ones with a missing end. Counts compared BEFORE this step would compare two lists of edges
 * nobody sees — #185584's check is on what is drawn.
 */
export function renderedGraph<T extends { nodes: GraphNode[]; edges: GraphEdge[] }>(g: T) {
  const ids = new Set(g.nodes.map((n) => n.id))
  return { nodes: g.nodes, edges: g.edges.filter((e) => ids.has(e.source) && ids.has(e.target)) }
}
