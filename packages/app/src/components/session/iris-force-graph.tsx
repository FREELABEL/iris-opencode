import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force"

/**
 * The relationship graph, ported from Elon's RelationshipGraph.vue.
 *
 * SAME PHYSICS, DIFFERENT RENDERER. The force constants are Elon's exactly — link distance 120,
 * charge -300, collide radius 35 — because the layout IS the thing being ported and changing a
 * constant changes what the picture says about how tightly a cluster holds together.
 *
 * What is deliberately NOT ported is d3-selection/zoom/drag. Elon imperatively builds its SVG
 * because Vue's template cannot express a force layout that mutates positions 60 times a second.
 * Solid can: positions are a signal, the SVG is ordinary JSX, and the tick just writes the
 * signal. Bringing d3-selection along would mean two things owning the same DOM, which is the
 * bug that costs a day.
 *
 * Pan, zoom and drag are ~40 lines of pointer handlers below rather than three more packages.
 */

export interface ForceNode extends SimulationNodeDatum {
  /**
   * `number` is a board id. A STRING is a namespaced interior node (`hub-agents-12`,
   * `item-8841`), which is why this is not just a number: a board's contents and the boards
   * themselves share one graph, and an item id could collide with a board id.
   */
  id: number | string
  name: string
  degree: number
  /** Radius. A board sizes by degree; interior nodes size by role, the way Elon does. */
  size: number
  /**
   * One of NODE_TYPES. Absent means `bloq`, which is what every node was when this graph only
   * drew boards — so an untyped payload renders exactly as it did before.
   */
  type?: string
  /** Elon's second tooltip line. A board has none; a hub says what it collects. */
  subtitle?: string
  /** Elon's third tooltip line — a count, a status, whatever the type makes true. */
  meta?: string
  /*
   * d3 WRITES THESE, and they are redeclared here on purpose.
   *
   * They come from SimulationNodeDatum, so this block is redundant — right up until
   * @types/d3-force is missing, at which point `extends SimulationNodeDatum` silently resolves
   * to nothing and every `n.x` becomes "Property 'x' does not exist". That is exactly how this
   * file broke a release build: the types were installed by hand into node_modules and never
   * declared in package.json, so the local typecheck passed against an artifact CI did not have.
   *
   * Declaring them here means the file describes its own contract instead of borrowing one.
   */
  x?: number
  y?: number
  vx?: number
  vy?: number
  /** Non-null pins the node; null hands it back to the simulation. */
  fx?: number | null
  fy?: number | null
}

export interface ForceEdge extends SimulationLinkDatum<ForceNode> {
  /** d3 REPLACES these ids with the node objects on the first tick, hence the union. */
  source: number | string | ForceNode
  target: number | string | ForceNode
  type: string
  /** Drawn at the midpoint. Elon labels its edges; without it a dashed line is unreadable. */
  label?: string
  /**
   * Link force strength. Elon reads this per edge and falls back to 0.3; this graph used d3's
   * default, which is 1/min(degree) — so a hub's links went slack exactly where Elon's stay
   * tight, and the two layouts settled differently from identical data. That was the one
   * "same physics" claim in the header that was not true.
   */
  strength?: number
}

/**
 * Elon's edge palette, kept verbatim so the two graphs read the same.
 * `sibling` and `mirrors` are dashed there; a dash is how a non-hierarchical link is told from
 * a hierarchical one at a glance.
 */
const EDGE_STYLE: Record<string, { color: string; dash?: string }> = {
  parent: { color: "#6366f1" },
  sibling: { color: "#8b5cf6", dash: "4,2" },
  affiliated: { color: "#0ea5e9" },
  partner: { color: "#14b8a6" },
  feeds_into: { color: "#f97316" },
  mirrors: { color: "#ec4899", dash: "2,2" },
}
const edgeStyle = (t: string) => EDGE_STYLE[t] ?? { color: "#374151" }

/**
 * ELON'S 14-TYPE VOCABULARY, colours verbatim.
 *
 * This graph already spoke it without knowing: NODE_COLOR was "#6366f1", which is exactly
 * Elon's `bloq` colour. Every node here was a board, so the graph was the `bloq` layer of this
 * table rendered alone — not a different model that needed reconciling with Elon's.
 *
 * `icon` is an inline SVG path on a 24x24 grid, NOT a font glyph. Elon uses FontAwesome; this
 * app has no icon font, and a webfont CDN is blocked by CSP and falls back silently. A path
 * ships in the bundle and cannot fail to load.
 */
export const NODE_TYPES: Record<string, { label: string; color: string; icon: string }> = {
  atlas: { label: "Atlas", color: "#34d399", icon: "M12 3 L20 18 H4 Z" },
  artist: { label: "Artists", color: "#f43f5e", icon: "M9 18V6l10-2v12M9 18a2 2 0 1 1-4 0 2 2 0 0 1 4 0zm10-2a2 2 0 1 1-4 0 2 2 0 0 1 4 0z" },
  person: { label: "People", color: "#3b82f6", icon: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm-8 8a8 8 0 0 1 16 0z" },
  venue: { label: "Venues", color: "#a855f7", icon: "M4 20V8l8-4 8 4v12H4zm6 0v-6h4v6" },
  event: { label: "Events", color: "#f59e0b", icon: "M4 6h16v14H4zM4 10h16M8 3v4M16 3v4" },
  brand: { label: "Brands", color: "#10b981", icon: "M4 12 12 4h8v8l-8 8zM16 8h.01" },
  deal: { label: "Deals", color: "#06b6d4", icon: "M4 12h4l3 6 4-12 3 6h4" },
  bloq: { label: "Bloqs", color: "#6366f1", icon: "M12 3v6M6 21v-6M18 21v-6M6 15h12v-6H6zM4 21h4M16 21h4" },
  agent: { label: "Agents", color: "#38bdf8", icon: "M7 9h10v8H7zM9 13h.01M15 13h.01M12 5v4M10 21h4" },
  workflow: { label: "Workflows", color: "#2dd4bf", icon: "M5 6h6v4H5zM13 14h6v4h-6zM8 10v6h5" },
  program: { label: "Programs", color: "#fb923c", icon: "M3 9l9-4 9 4-9 4zM7 12v5c0 1 2 2 5 2s5-1 5-2v-5" },
  leadcluster: { label: "Lead Groups", color: "#f472b6", icon: "M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm8 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM3 20a6 6 0 0 1 12 0M15 20a6 6 0 0 1 6-6" },
  memory: { label: "Memory", color: "#a3a3a3", icon: "M4 7c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zm0 0v10c0 1.7 3.6 3 8 3s8-1.3 8-3V7" },
  playbook: { label: "Playbooks", color: "#facc15", icon: "M4 5h7v15H4zM13 5h7v15h-7zM11 5v15" },
}
/*
 * EXACTLY ELON'S 14 — `page` and `list` were removed, not forgotten.
 *
 * Both were desktop-only types added while /iris/graph/:id drew its own Lists/Pages hubs. Once
 * that endpoint was ported onto ELON's relationshipGraphData (#185584), nothing emits either:
 * lists hang under ELON's Memory hub typed by inferType, which only ever returns ELON types, and
 * Genesis pages are not part of ELON's graph at all. A type nothing emits is a legend chip that
 * can never appear and an icon nobody will see drift out of date.
 */
export const DEFAULT_TYPE = "bloq"
export const nodeStyle = (t?: string) => NODE_TYPES[t ?? DEFAULT_TYPE] ?? NODE_TYPES[DEFAULT_TYPE]

/**
 * ELON'S PER-EDGE STRENGTHS. A hierarchy should hold tighter than an affiliation, and reading
 * cluster tightness as meaning only works if the strengths differ on purpose.
 */
export const EDGE_STRENGTH: Record<string, number> = {
  parent: 0.7,
  sibling: 0.5,
  feeds_into: 0.4,
  mirrors: 0.35,
  affiliated: 0.3,
  partner: 0.3,
}
/** Elon's fallback when a payload carries no strength. */
export const DEFAULT_EDGE_STRENGTH = 0.3

/**
 * Types actually present, in the vocabulary's order.
 *
 * Pure and exported for the same reason `scopeGraphRows` is: the interesting behaviour is
 * "which chips appear", and that is decidable from a node list with no simulation, no DOM and
 * no animation frame.
 */
export function presentTypesOf(nodes: { type?: string }[]): string[] {
  const seen = new Set(nodes.map((n) => n.type ?? DEFAULT_TYPE))
  return Object.keys(NODE_TYPES).filter((t) => seen.has(t))
}

export function typeCountsOf(nodes: { type?: string }[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const n of nodes) {
    const t = n.type ?? DEFAULT_TYPE
    out[t] = (out[t] ?? 0) + 1
  }
  return out
}

/** Elon's edge strength resolution: the edge's own, else the type's, else 0.3. */
export function edgeStrengthOf(e: { type: string; strength?: number }): number {
  return e.strength ?? EDGE_STRENGTH[e.type] ?? DEFAULT_EDGE_STRENGTH
}

/**
 * d3's clickDistance predicate. Under the tolerance a pointer sequence is a CLICK, not a drag.
 * Exported because this is the bug users actually felt and a regression here is silent — a
 * graph whose nodes cannot be selected still renders perfectly.
 */
export function isDragGesture(
  down: { x: number; y: number } | null,
  last: { x: number; y: number } | null,
  tolerance = 6,
): boolean {
  if (!down || !last) return false
  return Math.hypot(last.x - down.x, last.y - down.y) > tolerance
}

export function IrisForceGraph(props: {
  nodes: ForceNode[]
  edges: ForceEdge[]
  height?: number
  onNodeClick?: (n: ForceNode) => void
}) {
  /**
   * A SNAPSHOT per frame, not a counter.
   *
   * The first version bumped a `tick` signal from the simulation and rendered straight from the
   * mutated d3 data. Nothing read the counter, and Solid does not react to a property mutated
   * in place — so the DOM kept d3's initial phyllotaxis placement forever and the graph looked
   * like a tight little cluster. It even passed a test asserting the positions were distinct,
   * because phyllotaxis positions ARE distinct. They just are not a layout.
   *
   * Rendering from a plain snapshot makes the reactive dependency explicit and impossible to
   * lose: the JSX reads `frame()`, and `frame()` is written once per animation frame.
   */
  const [frame, setFrame] = createSignal<{
    nodes: {
      id: number | string
      name: string
      degree: number
      size: number
      type?: string
      subtitle?: string
      meta?: string
      x: number
      y: number
    }[]
    edges: { x1: number; y1: number; x2: number; y2: number; type: string; label?: string }[]
  }>({ nodes: [], edges: [] })
  /** Types the viewer has switched off. Empty = show everything, which is the default. */
  const [hiddenTypes, setHiddenTypes] = createSignal<Set<string>>(new Set())
  const [view, setView] = createSignal({ x: 0, y: 0, k: 1 })
  const [hover, setHover] = createSignal<ForceNode | null>(null)
  let svgEl: SVGSVGElement | undefined
  let sim: Simulation<ForceNode, ForceEdge> | undefined
  let raf = 0

  /**
   * Height is MEASURED, not assumed.
   *
   * A fixed height makes the graph a slab sitting in a scroller; filling the pane makes it the
   * pane. `props.height` stays as an override for anywhere that genuinely wants a fixed box.
   */
  const [height, setHeight] = createSignal(0)
  const H = () => props.height ?? height() ?? 420

  /**
   * The measured width, as a signal.
   *
   * `svgEl.clientWidth` is 0 when the effect first runs — the ref is assigned before layout —
   * so centring on it put every node at x≈0 and the whole graph in the top-left corner. It
   * looked like a layout bug; it was a measurement taken before there was anything to measure.
   *
   * A ResizeObserver rather than a one-shot read, because this panel is resizable and a graph
   * centred for yesterday's width is the same bug arriving later.
   */
  const [width, setWidth] = createSignal(0)
  onMount(() => {
    if (!svgEl) return
    const ro = new ResizeObserver(([entry]) => {
      const w = Math.round(entry.contentRect.width)
      const h = Math.round(entry.contentRect.height)
      if (w > 0) setWidth(w)
      if (h > 0) setHeight(h)
    })
    // The WRAPPER is measured, not the svg: the svg is sized from this measurement, so
    // observing it would be a loop that settles at whatever it happened to start on.
    ro.observe(svgEl.parentElement ?? svgEl)
    onCleanup(() => ro.disconnect())
  })

  createEffect(() => {
    // Filtering happens HERE, before the simulation, not at draw time: a hidden node that is
    // still in the layout keeps pushing its neighbours apart, leaving a hole where it was.
    const hidden = hiddenTypes()
    const nodes = props.nodes.filter((n) => !hidden.has(n.type ?? DEFAULT_TYPE)).map((n) => ({ ...n }))
    const byId = new Map(nodes.map((n) => [n.id, n]))
    // Edges are rebuilt against THESE node objects: d3 mutates the datum in place, and linking
    // to a stale copy leaves every edge anchored at 0,0 while the nodes move away.
    const edges = props.edges
      .filter((e) => byId.has(e.source as number | string) && byId.has(e.target as number | string))
      .map((e) => ({ ...e }))

    // Nothing to lay out until the element has a width. Running anyway is what produced the
    // corner-cluster: the simulation settles around a centre of 0 and then has no energy left
    // to move when the real width arrives.
    const w = width()
    if (!w) return

    sim?.stop()

    // Elon's constants, verbatim, for EVERY graph including expanded interiors:
    // distance 120, charge -300, collide 35. Scaling these per-node-count was tried and was
    // worse — the jam is a matter of how nodes render and how much canvas they get, not of
    // physics, and the physics were verified matching as part of the parity contract.
    sim = forceSimulation<ForceNode, ForceEdge>(nodes)
      .force(
        "link",
        forceLink<ForceNode, ForceEdge>(edges)
          .id((d: ForceNode) => d.id)
          .distance(120)
          // Elon's: the edge's own strength, else 0.3. d3's default is 1/min(degree), which
          // slackens exactly the hub links Elon holds tight.
          .strength((e: ForceEdge) => edgeStrengthOf(e)),
      )
      .force("charge", forceManyBody().strength(-300))
      .force("center", forceCenter(w / 2, H() / 2))
      .force("collision", forceCollide().radius(35))

    // One repaint per animation frame, not one per tick. A tick can fire several times a frame
    // and each would be a wasted render of the same positions.
    const snapshot = () =>
      setFrame({
        nodes: nodes.map((n) => ({
          id: n.id,
          name: n.name,
          degree: n.degree,
          size: n.size,
          type: n.type,
          subtitle: n.subtitle,
          meta: n.meta,
          x: n.x ?? 0,
          y: n.y ?? 0,
        })),
        edges: edges.map((e) => {
          const a = e.source as ForceNode
          const b = e.target as ForceNode
          return { x1: a?.x ?? 0, y1: a?.y ?? 0, x2: b?.x ?? 0, y2: b?.y ?? 0, type: e.type, label: e.label }
        }),
      })

    sim.on("tick", () => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        snapshot()
      })
    })

    /*
     * FIT ONCE THE LAYOUT SETTLES.
     *
     * A force layout spreads to whatever the forces dictate, not to the box it is drawn in:
     * measured 945x1419 of content in an 800x388 canvas, which puts a third of the boards past
     * the bottom edge where you would only find them by panning at random.
     *
     * On `end` rather than on a timer, because `end` is the simulation telling us it has
     * stopped moving — a timer would either fit too early, on a layout still expanding, or sit
     * there after it settled.
     *
     * Only if the view is untouched: re-framing someone who has already panned or zoomed is
     * the graph taking the wheel back.
     */
    sim.on("end", () => {
      if (touched) return
      const pad = 28
      const xs = nodes.map((n) => n.x ?? 0)
      const ys = nodes.map((n) => n.y ?? 0)
      if (!xs.length) return
      const minX = Math.min(...xs) - pad
      const maxX = Math.max(...xs) + pad
      const minY = Math.min(...ys) - pad
      const maxY = Math.max(...ys) + pad
      const w = width()
      const h = H()
      if (!w || !h) return
      /*
       * CLAMPED BOTH WAYS, and the lower bound is the interesting one.
       *
       * A true fit of this account's graph lands at k≈0.27 — everything on screen and every
       * label too small to read, which is a different way of not being able to see it. 0.5 is
       * where an 11px label is still legible. Above that we fit; below it we stop shrinking and
       * let the remainder be reached by panning, because a graph you can read and pan beats one
       * you can see all of and cannot read.
       *
       * Never zoom IN past 1 either: a three-node graph blown up to fill the pane looks broken.
       */
      const k = Math.min(1, Math.max(0.5, Math.min(w / (maxX - minX), h / (maxY - minY))))
      setView({ k, x: w / 2 - ((minX + maxX) / 2) * k, y: h / 2 - ((minY + maxY) / 2) * k })
    })

    live = { nodes, edges }
    snapshot()
  })

  /** The live d3 data, for dragging. Not reactive — the frame snapshot is what renders. */
  let live: { nodes: ForceNode[]; edges: ForceEdge[] } = { nodes: [], edges: [] }

  onCleanup(() => {
    sim?.stop()
    if (raf) cancelAnimationFrame(raf)
  })

  /** Screen -> graph space, so a drag follows the cursor at any zoom. */
  const toGraph = (e: PointerEvent) => {
    const r = svgEl!.getBoundingClientRect()
    const v = view()
    return { x: (e.clientX - r.left - v.x) / v.k, y: (e.clientY - r.top - v.y) / v.k }
  }

  /** Set the moment anyone pans, zooms or drags — after which the graph stops re-framing. */
  let touched = false

  let dragging: ForceNode | null = null
  let panning: { x: number; y: number; vx: number; vy: number } | null = null

  /**
   * ELON'S `clickDistance(6)`, which this did not have.
   *
   * Without it every pointerdown on a node starts a drag, and a drag that moves one pixel
   * still ends with fx/fy set and the click swallowed — so selecting a board was a coin flip
   * that got worse the more precisely you aimed. d3 solves it with a tolerance: movement under
   * 6px is a click, not a drag. Recorded here rather than inferred from the event, because by
   * the time `click` fires the pointer has already moved.
   */
  const CLICK_DISTANCE = 6
  let downAt: { x: number; y: number } | null = null
  const movedFarEnoughToBeADrag = () => isDragGesture(downAt, lastPointer, CLICK_DISTANCE)
  let lastPointer: { x: number; y: number } | null = null

  function onPointerDown(e: PointerEvent, n?: ForceNode) {
    ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
    touched = true
    downAt = { x: e.clientX, y: e.clientY }
    lastPointer = { x: e.clientX, y: e.clientY }
    if (n) {
      dragging = n
      // alphaTarget keeps the simulation warm while you hold a node, which is what makes the
      // rest of the graph get out of the way instead of staying frozen.
      sim?.alphaTarget(0.3).restart()
      const p = toGraph(e)
      n.fx = p.x
      n.fy = p.y
    } else {
      const v = view()
      panning = { x: e.clientX, y: e.clientY, vx: v.x, vy: v.y }
    }
  }

  function onPointerMove(e: PointerEvent) {
    lastPointer = { x: e.clientX, y: e.clientY }
    if (dragging) {
      // Below the tolerance this is still a click in progress — pinning now would jitter the
      // node out from under the cursor before the viewer has committed to a drag.
      if (!movedFarEnoughToBeADrag()) return
      const p = toGraph(e)
      dragging.fx = p.x
      dragging.fy = p.y
      return
    }
    if (panning) {
      setView((v) => ({ ...v, x: panning!.vx + (e.clientX - panning!.x), y: panning!.vy + (e.clientY - panning!.y) }))
    }
  }

  function onPointerUp() {
    if (dragging) {
      sim?.alphaTarget(0)
      // Released, not pinned: clearing fx/fy hands the node back to the simulation.
      dragging.fx = null
      dragging.fy = null
      dragging = null
    }
    panning = null
  }

  /** Re-centre and re-warm when the panel is resized, rather than leaving a stale centre. */
  createEffect(() => {
    const w = width()
    if (!w || !sim) return
    sim.force("center", forceCenter(w / 2, H() / 2))
    sim.alpha(0.5).restart()
  })

  function onWheel(e: WheelEvent) {
    e.preventDefault()
    touched = true
    const r = svgEl!.getBoundingClientRect()
    const mx = e.clientX - r.left
    const my = e.clientY - r.top
    setView((v) => {
      // Elon's scaleExtent.
      const k = Math.min(4, Math.max(0.3, v.k * (e.deltaY < 0 ? 1.1 : 1 / 1.1)))
      // Zoom about the cursor, so the thing under it stays under it.
      return { k, x: mx - ((mx - v.x) / v.k) * k, y: my - ((my - v.y) / v.k) * k }
    })
  }

  /** Types actually present, in the vocabulary's order so the legend does not reshuffle. */
  const presentTypes = createMemo(() => presentTypesOf(props.nodes))
  const typeCounts = createMemo(() => typeCountsOf(props.nodes))

  const toggleType = (t: string) =>
    setHiddenTypes((prev) => {
      const next = new Set(prev)
      // A Set mutated in place is the same object, and Solid would not see the change.
      if (next.has(t)) next.delete(t)
      else next.add(t)
      return next
    })

  const viewIsMoved = () => {
    const v = view()
    return v.k !== 1 || v.x !== 0 || v.y !== 0
  }

  /**
   * Reset hands the graph back to the auto-fit it does on `end`, rather than snapping to
   * identity — identity is not "fitted", it is the top-left corner at 1x, which is where
   * nothing is.
   */
  const resetView = () => {
    touched = false
    sim?.alpha(0.3).restart()
  }

  return (
    <div class="iris-graph">
      {/*
        LEGEND UNDER THE TABS, NOT AN OVERLAY. One strip above the canvas: one chip per type
        PRESENT, click toggles that type in/out of the layout (seen counts typeCounts()).
        Inside the flow so it reads as part of the tab UI, and never covers nodes or tooltips.
      */}
      <div class="iris-graph__legend">
        <For each={presentTypes()}>
          {(t) => (
            <button
              type="button"
              class="iris-graph__chip"
              title={hiddenTypes().has(t) ? `Show ${nodeStyle(t).label}` : `Hide ${nodeStyle(t).label}`}
              onClick={() => toggleType(t)}
              style={{ opacity: hiddenTypes().has(t) ? "0.35" : "1" }}
            >
              <span class="iris-graph__swatch" style={{ background: nodeStyle(t).color }} />
              {nodeStyle(t).label}
              <span class="font-mono tabular-nums opacity-60">{typeCounts()[t]}</span>
            </button>
          )}
        </For>
      </div>
      <div class="iris-graph__canvas">
      <svg
        ref={svgEl}
        class="iris-graph__svg"
        height={props.height ? String(props.height) : "100%"}
        onPointerDown={(e) => onPointerDown(e)}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
        onWheel={onWheel}
      >
        <defs>
          <marker id="iris-arrow" viewBox="-0 -5 10 10" refX="28" refY="0" orient="auto" markerWidth="6" markerHeight="6">
            <path d="M 0,-5 L 10,0 L 0,5" fill="#4b5563" />
          </marker>
        </defs>
        <g transform={`translate(${view().x},${view().y}) scale(${view().k})`}>
          <For each={frame().edges}>
            {(e) => {
              return (
                <line
                  x1={e.x1}
                  y1={e.y1}
                  x2={e.x2}
                  y2={e.y2}
                  stroke={edgeStyle(e.type).color}
                  stroke-width="1.5"
                  stroke-opacity="0.6"
                  stroke-dasharray={edgeStyle(e.type).dash}
                  marker-end="url(#iris-arrow)"
                />
              )
            }}
          </For>
          {/* Elon labels its edges at the midpoint. `type` was already in this payload and on
              ForceEdge — it reached the stroke colour and stopped there, so six relation kinds
              rendered as six shades of line with nothing saying which was which. */}
          <For each={frame().edges}>
            {(e) => (
              <Show when={view().k > 0.7}>
                <text
                  x={(e.x1 + e.x2) / 2}
                  y={(e.y1 + e.y2) / 2 - 3}
                  text-anchor="middle"
                  font-size="9"
                  /* Elon's gray (#6b7280) — the edge colour itself is loud next to a tinted
                     line and competes with the nodes; Elon's label is a caption, not a signal. */
                  fill="#6b7280"
                  style={{ "pointer-events": "none" }}
                >
                  {e.label ?? e.type.replace(/_/g, " ")}
                </text>
              </Show>
            )}
          </For>
          <For each={frame().nodes}>
            {(n) => (
              <g
                transform={`translate(${n.x},${n.y})`}
                style={{ cursor: "pointer" }}
                onPointerDown={(e) => {
                  e.stopPropagation()
                  // Drag the LIVE datum, not the snapshot — the snapshot is a copy and moving
                  // it would animate nothing.
                  const target = live.nodes.find((x) => x.id === n.id)
                  if (target) onPointerDown(e, target)
                }}
                onClick={() => props.onNodeClick?.(live.nodes.find((x) => x.id === n.id) ?? (n as any))}
                onMouseEnter={() => setHover(n as any)}
                onMouseLeave={() => setHover(null)}
              >
                <circle
                  r={hover()?.id === n.id ? n.size + 4 : n.size}
                  fill={nodeStyle(n.type).color}
                  fill-opacity="0.15"
                  stroke={nodeStyle(n.type).color}
                  stroke-width={hover()?.id === n.id ? "3" : "2"}
                />
                {/*
                  A GLYPH ON EVERY NODE — Elon draws getIconForType(d.type) unconditionally, and
                  the old degree-in-circle ("a repeated sitemap glyph on 39 identical boards
                  carries nothing") was a deliberate deviation recorded as pending in the parity
                  ticket. Exact parity wins: bloq nodes carry the sitemap glyph too.
                */}
                <g
                  transform={`translate(${-n.size * 0.45},${-n.size * 0.45}) scale(${(n.size * 0.9) / 24})`}
                  style={{ "pointer-events": "none" }}
                >
                  <path
                    d={nodeStyle(n.type).icon}
                    fill="none"
                    stroke={nodeStyle(n.type).color}
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                </g>
                <text
                  dy={n.size + 14}
                  text-anchor="middle"
                  font-size="11"
                  font-weight="600"
                  /* A token, not #e5e7eb. The panel is light or dark depending on the viewer,
                     and a hardcoded near-white label is invisible on half of them. */
                  fill="var(--text-base)"
                  style={{ "pointer-events": "none" }}
                >
                  {n.name.length > 18 ? n.name.slice(0, 16) + "…" : n.name}
                </text>
              </g>
            )}
          </For>
        </g>
      </svg>
      </div>
      {/* Reset is only offered once the view has actually been moved — an always-on control
          that does nothing on first sight is one more thing to wonder about. */}
      <Show when={viewIsMoved()}>
        <button type="button" class="iris-graph__reset" onClick={resetView} title="Reset zoom and position">
          Reset view
        </button>
      </Show>

      <Show when={hover()}>
        {(n) => (
          <div class="iris-graph__tip">
            <div>{n().name}</div>
            {/* Elon's second and third lines. A board still shows its degree, so nothing that
                used to be here was taken away. */}
            <Show when={n().subtitle}>
              <div class="opacity-70">{n().subtitle}</div>
            </Show>
            <div class="opacity-70">
              {n().meta ?? `${n().degree} ${n().degree === 1 ? "link" : "links"}`}
            </div>
          </div>
        )}
      </Show>
    </div>
  )
}
