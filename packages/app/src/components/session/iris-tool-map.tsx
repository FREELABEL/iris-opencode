import { createMemo, createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import "./iris-tool-map.css"
import { agentConfig, effectLabel, readCatalog, type Catalog, type Effect } from "./iris-agent-editor-model"
import { fmtDuration, verdict, type LiveRun } from "./iris-agent-live-model"
import { GEO, headerLine, layout, modelLabel, nodeBadge, nodeLine, providerOf, runPill, toolMap, type MapNode } from "./iris-tool-map-model"

/**
 * Agents › Live › Tool access (#192619): one agent's tools as a map — what this run has called
 * (left), what it may use and has not (right, solid), and the nearest tools it has no access to
 * (right, dashed). Layout and wording are in iris-tool-map-model.ts; this file only draws them.
 *
 * Reads the catalogue and the agent's tool list through the same sidecar routes the agent editor
 * uses; the run comes from the Live pane's own poll, so the map and the call list never disagree.
 */

type Fetch = (path: string, init?: RequestInit) => Promise<Response>
export type MapAgent = { id: number; name: string; model?: string }

async function proxied(doFetch: Fetch, path: string): Promise<any> {
  try {
    const j = (await (await doFetch(path)).json()) as { ok?: boolean; data?: any } | null
    return j?.ok ? j.data : undefined
  } catch {
    return undefined
  }
}

/** One glyph per effect, so a node says what the tool does to the world at a glance. */
const EFFECT_PATH: Record<Effect, string> = {
  read: "M2 8s2.2-4 6-4 6 4 6 4-2.2 4-6 4-6-4-6-4Zm6 2a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z",
  own_write: "M10.5 3.5l2 2L6 12H4v-2l6.5-6.5Z",
  unclassified: "M8 10.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z",
  shared_write: "M8 3.5v9M3.5 8h9",
  shared_overwrite: "M3 5.5h8.5L9.5 3.5M13 10.5H4.5l2 2",
  egress: "M3 8.2 13 3.5 10 13l-2.2-3.8L3 8.2Z",
  payment: "M2.5 4.5h11v7h-11zM2.5 7h11",
}

function Glyph(props: { effect: Effect; title: string }) {
  return (
    <span class="itm-icon" data-effect={props.effect} title={props.title}>
      <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
        <path d={EFFECT_PATH[props.effect]} fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round" />
      </svg>
    </span>
  )
}

function AgentIcon(props: { model?: string }) {
  const p = () => providerOf(props.model)
  return (
    <Show when={p()} fallback={<span class="itm-agent-dot" aria-hidden="true" />}>
      {(id) => <ProviderIcon id={id() as any} class="itm-provider" width={12} height={12} />}
    </Show>
  )
}

function Node(props: { node: MapNode; x: number; y: number; catalog: Catalog }) {
  const badge = () => nodeBadge(props.node)
  return (
    <div
      class="itm-node"
      data-kind={props.node.kind}
      data-tool={props.node.id}
      style={{ left: `${props.x}px`, top: `${props.y}px`, width: `${GEO.nodeW}px`, height: `${GEO.nodeH}px` }}
    >
      <div class="itm-node__top">
        <Glyph effect={props.node.effect} title={effectLabel(props.catalog, props.node.effect)} />
        <span class="itm-node__name">{props.node.name}</span>
        <Show when={props.node.kind === "used"}>
          <span class="itm-node__count">{props.node.calls}×</span>
        </Show>
      </div>
      <Show when={badge()} fallback={<div class="itm-node__line">{nodeLine(props.node, fmtDuration)}</div>}>
        {(b) => (
          <div class="itm-node__line">
            <span class="itm-badge" data-tone={b().tone}>
              {b().text}
            </span>
          </div>
        )}
      </Show>
    </div>
  )
}

export function IrisToolMap(props: {
  doFetch: Fetch
  agents: MapAgent[]
  agentId: number | undefined
  onPick: (id: number) => void
  run: LiveRun | null
}) {
  const [catalogRes] = createResource(async () => readCatalog(await proxied(props.doFetch, "/iris/agent-editor/tool-catalog")))
  const [agentRes] = createResource(
    () => props.agentId,
    (id) => proxied(props.doFetch, `/iris/agent-editor/agent/${id}`),
  )
  const catalog = () => catalogRes.latest ?? readCatalog(undefined)
  const agent = () => props.agents.find((a) => a.id === props.agentId)
  const model = () => {
    const c = agentConfig(agentRes.latest)
    return (typeof c.model === "string" && c.model) || agent()?.model || ""
  }
  // A tool list that was never set means "may get every tool": nothing can be called no access.
  const allowed = () => {
    const tools = agentConfig(agentRes.latest).tools
    return Array.isArray(tools) ? tools.filter((t: unknown): t is string => typeof t === "string") : null
  }

  const map = createMemo(() => toolMap(catalog(), allowed(), props.run))
  const [width, setWidth] = createSignal(720)
  let box: HTMLDivElement | undefined
  onMount(() => {
    if (!box || typeof ResizeObserver === "undefined") return
    const ro = new ResizeObserver((e) => setWidth(Math.floor(e[0]!.contentRect.width)))
    ro.observe(box)
    onCleanup(() => ro.disconnect())
  })
  const geo = createMemo(() => layout(map().left.length, map().right.length, width()))
  const pill = () => runPill(props.run)

  return (
    <section class="itm" data-component="iris-tool-map" aria-label="Tool access">
      <header class="itm-head">
        <span class="itm-head__title">
          <svg class="itm-head__mark" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <path d="M1 8h4M11 8h4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
            <circle cx="8" cy="8" r="2.6" fill="currentColor" />
          </svg>
          Tool access
        </span>
        <span class="itm-head__count">{headerLine(map())}</span>
      </header>

      <div class="itm-chips" role="tablist" aria-label="Agent">
        <For each={props.agents}>
          {(a) => (
            <button
              type="button"
              role="tab"
              class="itm-chip"
              aria-selected={a.id === props.agentId}
              onClick={() => props.onPick(a.id)}
            >
              <AgentIcon model={a.model} />
              {a.name}
            </button>
          )}
        </For>
      </div>

      <div class="itm-stage" ref={box}>
        <div class="itm-canvas" style={{ width: `${geo().width}px`, height: `${geo().height}px` }}>
          <svg class="itm-edges" width={geo().width} height={geo().height} aria-hidden="true">
            <For each={geo().edgesLeft}>{(d) => <path d={d} class="itm-edge" data-kind="used" />}</For>
            {/* Dashed first, so the trunk a solid edge shares with them reads solid. */}
            <For each={geo().edgesRight}>{(d, i) => <Show when={map().right[i()]?.kind === "none"}><path d={d} class="itm-edge" data-kind="none" /></Show>}</For>
            <For each={geo().edgesRight}>{(d, i) => <Show when={map().right[i()]?.kind !== "none"}><path d={d} class="itm-edge" data-kind={map().right[i()]?.kind} /></Show>}</For>
            <Show when={map().left.length}>
              <path class="itm-port" d={`M${geo().ports.left.x - 5},${geo().ports.left.y - 4} l4,4 l-4,4`} />
            </Show>
            <Show when={map().right.length}>
              <path class="itm-port" d={`M${geo().ports.right.x + 1},${geo().ports.right.y - 4} l4,4 l-4,4`} />
            </Show>
          </svg>

          <For each={map().left}>{(n, i) => <Node node={n} x={geo().left[i()]!.x} y={geo().left[i()]!.y} catalog={catalog()} />}</For>
          <For each={map().right}>{(n, i) => <Node node={n} x={geo().right[i()]!.x} y={geo().right[i()]!.y} catalog={catalog()} />}</For>

          <div
            class="itm-card"
            style={{ left: `${geo().card.x}px`, top: `${geo().card.y}px`, width: `${GEO.cardW}px`, "min-height": `${GEO.cardH}px` }}
          >
            <div class="itm-card__head">
              <span class="itm-card__icon">
                <AgentIcon model={model()} />
              </span>
              <span class="itm-card__who">
                <span class="itm-card__name">{agent()?.name ?? "Agent"}</span>
                <Show when={modelLabel(model())}>
                  <span class="itm-card__model">{modelLabel(model())}</span>
                </Show>
              </span>
              <span class="itm-pill" data-tone={pill().tone}>
                <Show when={pill().tone === "run"}>
                  <span class="itm-spin" aria-hidden="true" />
                </Show>
                {pill().text}
              </span>
            </div>
            <p class="itm-card__task" data-tone={verdict(props.run).tone}>
              {verdict(props.run).text}
            </p>
          </div>
        </div>
      </div>

      <Show when={map().moreLeft || map().moreRight}>
        <div class="itm-more">
          <Show when={map().moreLeft}>
            <span>+{map().moreLeft} more used</span>
          </Show>
          <Show when={map().moreRight}>
            <span>+{map().moreRight} more on the right</span>
          </Show>
        </div>
      </Show>
    </section>
  )
}
