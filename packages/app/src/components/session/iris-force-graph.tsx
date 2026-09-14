import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js"
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
  id: number
  name: string
  degree: number
  /** Radius. Elon sizes by meaning; here degree is the only signal we have. */
  size: number
}

export interface ForceEdge extends SimulationLinkDatum<ForceNode> {
  /** d3 REPLACES these ids with the node objects on the first tick, hence the union. */
  source: number | ForceNode
  target: number | ForceNode
  type: string
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

/** Elon's `bloq` node colour. Every node here is a board, so there is one. */
const NODE_COLOR = "#6366f1"

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
    nodes: { id: number; name: string; degree: number; size: number; x: number; y: number }[]
    edges: { x1: number; y1: number; x2: number; y2: number; type: string }[]
  }>({ nodes: [], edges: [] })
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
    const nodes = props.nodes.map((n) => ({ ...n }))
    const byId = new Map(nodes.map((n) => [n.id, n]))
    // Edges are rebuilt against THESE node objects: d3 mutates the datum in place, and linking
    // to a stale copy leaves every edge anchored at 0,0 while the nodes move away.
    const edges = props.edges
      .filter((e) => byId.has(e.source as number) && byId.has(e.target as number))
      .map((e) => ({ ...e }))

    // Nothing to lay out until the element has a width. Running anyway is what produced the
    // corner-cluster: the simulation settles around a centre of 0 and then has no energy left
    // to move when the real width arrives.
    const w = width()
    if (!w) return

    sim?.stop()

    sim = forceSimulation<ForceNode, ForceEdge>(nodes)
      .force(
        "link",
        forceLink<ForceNode, ForceEdge>(edges)
          .id((d) => d.id)
          .distance(120),
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
          x: n.x ?? 0,
          y: n.y ?? 0,
        })),
        edges: edges.map((e) => {
          const a = e.source as ForceNode
          const b = e.target as ForceNode
          return { x1: a?.x ?? 0, y1: a?.y ?? 0, x2: b?.x ?? 0, y2: b?.y ?? 0, type: e.type }
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

  function onPointerDown(e: PointerEvent, n?: ForceNode) {
    ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
    touched = true
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
    if (dragging) {
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

  return (
    <div class="iris-graph">
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
                  fill={NODE_COLOR}
                  fill-opacity="0.15"
                  stroke={NODE_COLOR}
                  stroke-width={hover()?.id === n.id ? "3" : "2"}
                />
                {/* Elon draws a FontAwesome glyph here. There is no icon font in this app, and
                    the degree is more use than a repeated sitemap icon on 39 identical nodes. */}
                <text
                  text-anchor="middle"
                  dominant-baseline="central"
                  font-size={String(Math.max(9, n.size * 0.7))}
                  fill={NODE_COLOR}
                  style={{ "pointer-events": "none" }}
                >
                  {n.degree}
                </text>
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
      <Show when={hover()}>
        {(n) => (
          <div class="iris-graph__tip">
            {n().name} · {n().degree} {n().degree === 1 ? "link" : "links"}
          </div>
        )}
      </Show>
    </div>
  )
}
