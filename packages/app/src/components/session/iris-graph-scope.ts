/**
 * WHICH boards the Atlas graph draws — decided as pure data, so it can be tested without a
 * browser, a signed-in account, or a board that happens to have the right shape.
 *
 * ## The bug this exists to kill
 *
 * The graph endpoint is account-wide (`/user/{id}/bloqs/graph`). Every other pane in the panel
 * is scoped to the board in the picker; this one silently was not, so switching project redrew
 * the identical picture and made the picker look broken on this pane alone.
 *
 * ## Why a lens and not an endpoint
 *
 * NAVIGATION-TEMPLATE rule 1 says a narrower view is a different endpoint, never a filter over
 * rows already on screen — because filtering a PAGE leaves the footer describing the unfiltered
 * set. That rationale does not reach here: the graph pane requests 500 and the account has 40
 * connected boards, so the payload is complete, not a page. The obligation the rule is really
 * protecting survives, and the caller honours it: the count printed under the drawing is
 * computed from the narrowed set, never from the server's account-wide summary.
 */

export type GraphScope = "project" | "connected" | "full"

export interface ScopableRow {
  id: number
  links?: { id: number }[]
}

/**
 * @param rows   every CONNECTED board (the payload already excludes degree-0 boards)
 * @param active the board in the picker, or undefined when none is chosen yet
 *
 * Returns the rows to draw. An empty array is a real answer — it means the active board has no
 * relations — and is deliberately NOT the same as falling back to every board, which would look
 * like the scope control does nothing.
 */
export function scopeGraphRows<T extends ScopableRow>(rows: T[], active: number | undefined, scope: GraphScope): T[] {
  if (scope === "full") return rows
  if (!active) return rows
  const byId = new Map(rows.map((r) => [r.id, r]))
  if (!byId.has(active)) return []

  if (scope === "project") {
    const keep = new Set<number>([active, ...(byId.get(active)!.links ?? []).map((l) => l.id)])
    return rows.filter((r) => keep.has(r.id))
  }

  // `connected` walks the whole component: the honest answer to "what is this project part of"
  // when the link that matters is two hops away.
  const seen = new Set<number>([active])
  const queue: number[] = [active]
  while (queue.length) {
    const cur = byId.get(queue.shift()!)
    for (const l of cur?.links ?? []) {
      if (seen.has(l.id)) continue
      seen.add(l.id)
      queue.push(l.id)
    }
  }
  return rows.filter((r) => seen.has(r.id))
}

/** True when the active board is not in the connected set at all — three boards in four here. */
export function graphBoardIsIsolated(rows: ScopableRow[], active: number | undefined, scope: GraphScope): boolean {
  if (scope === "full" || !active) return false
  return !rows.some((r) => r.id === active)
}

type MergeNode = { id: number | string; [k: string]: any }
type MergeEdge = { source: number | string; target: number | string; type?: string; label?: string; [k: string]: any }

/**
 * Fold expanded boards' interiors into the account-wide graph.
 *
 * Each interior is ELON's `relationshipGraphData` for one board (#185584), and ELON names a
 * RELATED board `bloq-<id>` — the same id it gives a board's own centre. ELON never collides
 * because it draws one board at a time. This graph can have several open at once, so:
 *
 *   - expand boards 682 and 368, where 682 relates to 368: 682's interior has a related-board
 *     node `bloq-368`, and 368's interior has its centre `bloq-368`. Two nodes, one id. d3 keys
 *     links by id, so edges bind to whichever it finds first and the other node floats free.
 *
 * A related board that is ALREADY on screen as a board node is therefore drawn as that board
 * node, not a second copy — and its relation edge is dropped, because the board-to-board layer
 * already draws that relation. A related board NOT on screen keeps ELON's node, once.
 *
 * Pure so the collision cases are provable without mounting a panel.
 */
export function mergeInteriors(
  boardIds: Set<number>,
  expanded: number[],
  interiors: Record<number, { nodes: MergeNode[]; edges: MergeEdge[] } | undefined>,
): { nodes: MergeNode[]; edges: MergeEdge[] } {
  const nodes: MergeNode[] = []
  const edges: MergeEdge[] = []
  const seen = new Set<string>()
  const key = (id: number | string) => `${typeof id}:${id}`

  for (const id of expanded) {
    if (!boardIds.has(id)) continue
    const interior = interiors[id]
    if (!interior) continue

    const remap = new Map<string, number>()
    for (const n of interior.nodes) {
      const m = typeof n.id === "string" ? /^bloq-(\d+)$/.exec(n.id) : null
      const rid = m ? Number(m[1]) : null
      if (rid !== null && rid !== id && boardIds.has(rid)) {
        remap.set(n.id as string, rid)
        continue
      }
      if (seen.has(key(n.id))) continue
      seen.add(key(n.id))
      nodes.push(n)
    }

    for (const e of interior.edges) {
      const s = remap.get(e.source as string)
      const t = remap.get(e.target as string)
      // A relation to an on-screen board: the board layer already draws it.
      if (s !== undefined || t !== undefined) continue
      edges.push(e)
    }
    // The seam from the board node to its own centre, so an opened board reads as one picture.
    edges.push({ source: id, target: `bloq-${id}`, type: "parent", label: "contains" })
  }
  return { nodes, edges }
}
