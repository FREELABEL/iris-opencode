import { createMemo, createResource, createSignal, For, Show } from "solid-js"
import "./iris-agent-gallery.css"
import { Select } from "@opencode-ai/ui/select"
import { IrisAgentLive } from "./iris-agent-live"
import {
  capabilities,
  chatUrl,
  description,
  galleryAgents,
  iconTooltip,
  integrationChips,
  lastActivity,
  markOpened,
  MAX_VISIBLE_CONFIG,
  model,
  modelName,
  readLastOpened,
  SORTS,
  typeLabel,
  WORKSPACES,
  type GalleryAgent,
  type KindFilter,
  type SortKey,
  type WorkspaceFilter,
} from "./iris-agent-gallery-model"

/**
 * Agents › Agents (#192619): ELON's agents gallery in Desktop — AITeamPanel's toolbar (search,
 * All · People · Agents, workspace, sort, New Agent) over a grid of BaseAgentCard, dense. Rules
 * and wording live in iris-agent-gallery-model.ts.
 *
 * Desktop differences, each because Desktop has no such thing: Chat opens ELON's chat page for
 * the agent (the card's "open public chat"), Train opens the editor at Memory & files, and a Live
 * button opens the agent's run and tool access map — the Live tab this view replaced.
 */

const PATHS: Record<string, string> = {
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm10 2-4.35-4.35",
  user: "M20 21a8 8 0 0 0-16 0M12 13a5 5 0 1 0 0-10 5 5 0 0 0 0 10Z",
  robot: "M12 8V4H8M4 12h16v8H4zM2 14v4M22 14v4M9 16v.01M15 16v.01M8 8h8a2 2 0 0 1 2 2v2H6v-2a2 2 0 0 1 2-2Z",
  pen: "M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z",
  share: "M18 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM6 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm12 7a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM8.6 13.5l6.8 4M15.4 6.5l-6.8 4",
  brain: "M9.5 2a3 3 0 0 0-3 3v.2A3 3 0 0 0 4 8.5v.3A3.5 3.5 0 0 0 4.5 15 3 3 0 0 0 9.5 19V2Zm5 0a3 3 0 0 1 3 3v.2A3 3 0 0 1 20 8.5v.3A3.5 3.5 0 0 1 19.5 15a3 3 0 0 1-5 4V2Z",
  headset: "M3 14v-2a9 9 0 0 1 18 0v2M21 15a2 2 0 0 1-2 2h-1v-5h1a2 2 0 0 1 2 2ZM3 15a2 2 0 0 0 2 2h1v-5H5a2 2 0 0 0-2 2Z",
  comment: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z",
  cog: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-2.7-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 3.6 15H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.1-2.7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 2.7-1.1V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1.3Z",
  chip: "M6 6h12v12H6zM9 9h6v6H9zM9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4",
  clock: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Zm0-14v4l3 2",
  file: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8ZM14 2v6h6M8 13h8M8 17h5",
  external: "M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6",
  plus: "M12 5v14M5 12h14",
  empty: "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM2 2l20 20",
  pulse: "M22 12h-4l-3 9L9 3l-3 9H2",
  check: "M20 6 9 17l-5-5",
  down: "m6 9 6 6 6-6",
  up: "m18 15-6-6-6 6",
  plug: "M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0ZM12 18v4",
  globe: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20ZM2 12h20M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20Z",
  book: "M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5ZM4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5",
  tasks: "M9 11l3 3 8-8M20 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11",
  code: "m16 18 6-6-6-6M8 6l-6 6 6 6",
  chart: "M3 3v18h18M7 14l4-4 3 3 5-6",
}

function I(props: { n: string; class?: string; title?: string }) {
  return (
    <svg class={`iag-i ${props.class ?? ""}`} viewBox="0 0 24 24" aria-hidden={props.title ? undefined : "true"} role={props.title ? "img" : undefined}>
      <Show when={props.title}>
        <title>{props.title}</title>
      </Show>
      <path d={PATHS[props.n] ?? ""} />
    </svg>
  )
}

/** The editor's mark (iris-agent-editor.tsx): initials on a hue drawn from the name, so an agent looks the same in both. */
const hue = (name: string) => [...(name || "?")].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7)
const initials = (name: string) =>
  (name || "?")
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("") || "?"

function Card(props: {
  agent: GalleryAgent
  onChat: () => void
  onPage: () => void
  onTrain: () => void
  onLive: () => void
  onConfigure: () => void
}) {
  const a = () => props.agent
  const [all, setAll] = createSignal(false)
  const chips = createMemo(() => integrationChips(a()))
  // ELON lists an integration twice (capabilities AND integrations); once is enough.
  const caps = createMemo(() => capabilities(a()).filter((c) => !chips().some((x) => x.name === c)))
  const human = () => a().isHuman === true
  return (
    <div class="iag-card" data-agent-id={a().id} data-testid="iris-agent-card">
      <div class="iag-card__head">
        <span class="iag-mark" style={{ "--iag-hue": String(hue(a().name)) }} title={iconTooltip(a())} aria-hidden="true">
          {initials(a().name)}
        </span>
        <div class="iag-card__who">
          <div class="iag-card__name">{a().name || "Unnamed Agent"}</div>
          <div class="iag-card__sub">
            <span class="iag-kind" data-kind={human() ? "human" : "ai"}>
              {typeLabel(a())}
            </span>
            <Show
              when={human() && a().email}
              fallback={
                <Show when={!human() && model(a())}>
                  <span title={`AI Model: ${model(a())}`}>{modelName(a())}</span>
                </Show>
              }
            >
              <span class="iag-card__email" title={`Email: ${a().email}`}>
                {a().email}
              </span>
            </Show>
          </div>
        </div>
        <button type="button" class="iag-ghost" title="Open public chat in new tab" onClick={props.onPage}>
          <I n="external" />
        </button>
      </div>

      <p class="iag-card__desc">{description(a())}</p>

      <Show when={caps().length}>
        <div class="iag-chips" aria-label="Capabilities">
          <For each={all() ? caps() : caps().slice(0, MAX_VISIBLE_CONFIG)}>{(c) => <span class="iag-chip">{c}</span>}</For>
          <Show when={caps().length > MAX_VISIBLE_CONFIG}>
            <button type="button" class="iag-chip iag-chip--more" onClick={() => setAll(!all())}>
              {all() ? "Less" : `+${caps().length - MAX_VISIBLE_CONFIG}`}
            </button>
          </Show>
        </div>
      </Show>

      <Show when={chips().length}>
        <div class="iag-chips" aria-label="Integrations">
          <For each={chips()}>
            {(c) => (
              <span class="iag-chip iag-chip--on" title="Connected">
                <I n={c.icon} />
                {c.name}
              </span>
            )}
          </For>
        </div>
      </Show>

      <div class="iag-card__foot">
        <span class="iag-card__seen iag-num" title={a().lastUsedAt ? new Date(a().lastUsedAt!).toLocaleString() : "This agent has not been used yet"}>
          {lastActivity(a().lastUsedAt)}
          <Show when={(a().files ?? 0) > 0}>
            {` · ${a().files} file${a().files !== 1 ? "s" : ""}`}
          </Show>
        </span>
        <button type="button" class="iag-btn" title="Talk to this agent in the chat box below" onClick={props.onChat}>
          <I n="comment" />
          Chat
        </button>
        <Show when={!a().isVirtual}>
          <button type="button" class="iag-ghost" title="Train Agent" onClick={props.onTrain}>
            <I n="brain" />
          </button>
          <button type="button" class="iag-ghost iag-ghost--live" title="Live — what it is doing now, and its tool access" onClick={props.onLive}>
            <I n="pulse" />
          </button>
          <button type="button" class="iag-ghost" title="Configure Agent" onClick={props.onConfigure}>
            <I n="cog" />
          </button>
        </Show>
      </div>
    </div>
  )
}

type Fetch = (path: string, init?: RequestInit) => Promise<Response>
type AgentsPage = { measured?: boolean; reason?: string; agents?: GalleryAgent[]; total?: number | null; hasMore?: boolean }

/** Every agent in scope: ELON filters and sorts the whole roster, so the page has to hold it. */
async function loadAll(doFetch: Fetch, bloqId: number, scope: "project" | "all"): Promise<AgentsPage> {
  const PER = 200 // the engine's page cap (iris/pagination.ts)
  const url = (page: number) => `/iris/agents/${bloqId}?perPage=${PER}&page=${page}${scope === "all" ? "&scope=all" : ""}`
  const get = async (page: number): Promise<AgentsPage> => (await (await doFetch(url(page))).json()) as AgentsPage
  const first = await get(1)
  if (!first.measured || !first.hasMore || !first.total) return first
  const rest = await Promise.all(Array.from({ length: Math.ceil(first.total / PER) - 1 }, (_, i) => get(i + 2)))
  return { ...first, agents: [...(first.agents ?? []), ...rest.flatMap((r) => r.agents ?? [])] }
}

export function IrisAgentGallery(props: {
  doFetch: Fetch
  bloqId?: number
  /** Bumped by the panel after the editor saves, so the roster reloads. */
  reload: number
  onNew: () => void
  onConfigure: (a: GalleryAgent) => void
  onTrain: (a: GalleryAgent) => void
  openExternal: (url: string) => void
  /** Make this agent the composer's agent (#192931). Resolves to a sentence for the person, if any. */
  onChat: (a: GalleryAgent) => Promise<string | undefined>
}) {
  const [note, setNote] = createSignal<string | null>(null)
  const [scope, setScope] = createSignal<"project" | "all">("project")
  const [roster] = createResource(
    () => (props.bloqId ? ([props.bloqId, scope(), props.reload] as const) : undefined),
    ([b, s]): Promise<AgentsPage> =>
      loadAll(props.doFetch, b, s).catch((e) => ({ measured: false, reason: e instanceof Error ? e.message : String(e) })),
  )
  const agents = () => roster.latest?.agents ?? []
  const [live, setLive] = createSignal<GalleryAgent | null>(null)
  const [query, setQuery] = createSignal("")
  const [kind, setKind] = createSignal<KindFilter>("all")
  const [workspace, setWorkspace] = createSignal<WorkspaceFilter>("all")
  const [sort, setSort] = createSignal<SortKey>("last_opened_desc")
  const [opened, setOpened] = createSignal(readLastOpened())
  const open = (a: GalleryAgent) => setOpened(markOpened(a.id))
  const shown = createMemo(() =>
    galleryAgents(agents(), { query: query(), kind: kind(), workspace: workspace(), sort: sort(), lastOpened: opened() }),
  )

  return (
    <Show
      when={!live()}
      fallback={
        <IrisAgentLive
          doFetch={props.doFetch}
          bloqId={props.bloqId}
          agent={{ id: live()!.id, name: live()!.name, model: live()!.model }}
          onBack={() => setLive(null)}
        />
      }
    >
    <div class="iag" data-component="iris-agent-gallery">
      <div class="iag-bar">
        <label class="iag-find">
          <I n="search" />
          <input type="search" placeholder="Search agents…" value={query()} onInput={(e) => setQuery(e.currentTarget.value)} />
        </label>
        <div class="iag-seg" role="tablist" aria-label="Kind">
          <For each={[["all", "All"], ["human", "People"], ["ai", "Agents"]] as const}>
            {([value, label]) => (
              <button type="button" role="tab" aria-selected={kind() === value} onClick={() => setKind(value)}>
                {label}
              </button>
            )}
          </For>
        </div>
        {/* The app's own dropdown (Settings, the composer), not the OS one (#192931). */}
        <Select
          data-action="agents-workspace"
          options={WORKSPACES}
          current={WORKSPACES.find((o) => o.value === workspace())}
          value={(o) => o.value}
          label={(o) => o.label}
          onSelect={(o) => o && setWorkspace(o.value)}
          variant="ghost"
          size="small"
          valueClass="text-12-regular"
        />
        <Select
          data-action="agents-sort"
          options={SORTS}
          current={SORTS.find((o) => o.value === sort())}
          value={(o) => o.value}
          label={(o) => o.label}
          onSelect={(o) => o && setSort(o.value)}
          variant="ghost"
          size="small"
          valueClass="text-12-regular"
        />
        {/* Not in ELON, where the switch existed and nothing could reach it: this project, or the account. */}
        <div class="iag-seg" role="tablist" aria-label="Which agents">
          <For each={[["all", "All"], ["project", "This project"]] as const}>
            {([value, label]) => (
              <button type="button" role="tab" aria-selected={scope() === value} onClick={() => setScope(value)}>
                {label}
              </button>
            )}
          </For>
        </div>
        <span class="iag-end">
        <Show when={roster.latest?.measured}>
          <span class="iag-count iag-num">
            {shown().length === agents().length ? agents().length : `${shown().length} of ${agents().length}`}
          </span>
        </Show>
        <button type="button" class="iag-new" data-testid="iris-agent-new" disabled={!props.bloqId} onClick={props.onNew}>
          + New agent
        </button>
        </span>
      </div>

      <Show when={note()}>
        <p class="iag-note iag-note--chat" role="status">
          {note()}
        </p>
      </Show>
      <Show when={roster.latest?.measured === false}>
        <p class="iag-note iag-note--err">Could not load agents — {roster.latest?.reason}</p>
      </Show>
      <Show
        when={!roster.loading || agents().length}
        fallback={<p class="iag-note">Loading your team…</p>}
      >
        <div class="iag-grid-wrap">
          <Show
            when={shown().length}
            fallback={
              <div class="iag-empty">
                <p>No agents found.</p>
                <p class="iag-note">Create AI assistants or add human team members to build powerful workflows.</p>
                <button type="button" class="iag-new" disabled={!props.bloqId} onClick={props.onNew}>
                  + New agent
                </button>
              </div>
            }
          >
            <div class="iag-grid">
              <For each={shown()}>
                {(a) => (
                  <Card
                    agent={a}
                    onChat={() => {
                      open(a)
                      setNote(`Selecting ${a.name}…`)
                      void props.onChat(a).then((n) => setNote(n ?? null))
                    }}
                    onPage={() => {
                      open(a)
                      props.openExternal(chatUrl(a.id))
                    }}
                    onTrain={() => {
                      open(a)
                      props.onTrain(a)
                    }}
                    onLive={() => {
                      open(a)
                      setLive(a)
                    }}
                    onConfigure={() => {
                      open(a)
                      props.onConfigure(a)
                    }}
                  />
                )}
              </For>
            </div>
          </Show>
        </div>
      </Show>
    </div>
    </Show>
  )
}
