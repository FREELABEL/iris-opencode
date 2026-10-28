import { createMemo, createResource, createSignal, For, onCleanup, Show } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { useServer } from "@/context/server"
import { usePlatform } from "@/context/platform"
import { sessionHref } from "@/utils/session-route"
import "@/components/session/iris-hive-scripts.css"
import "./sessions/sessions-page.css"
import {
  applyFilters,
  mergeRows,
  optionsOf,
  sourceCounts,
  type CloudCopy,
  type Filters,
  type FleetNode,
  type IndexedSession,
  type SessionRow,
  type SortKey,
  type Source,
} from "./sessions/sessions-model"

/**
 * Sessions (#191497, epic #191485) — every chat you have, in one list: on this machine, on your
 * other machines, and the copies you saved to the cloud. Filter by where it lives, which machine,
 * which app, its status; sort; search. The Hive side panel stays for a glance while you work.
 */

type Transcript = { measured: boolean; reason?: string; messages: { role: string; type: string; text: string | null; tool: string | null }[] }

const SOURCES: { id: Source; label: string }[] = [
  { id: "all", label: "All" },
  { id: "this", label: "This machine" },
  { id: "other", label: "Other machines" },
  { id: "cloud", label: "Cloud copies" },
]

export default function SessionsPage() {
  const server = useServer()
  const platform = usePlatform()
  const navigate = useNavigate()
  const base = createMemo(() => server.current?.http?.url?.replace(/\/$/, ""))
  const getJson = async <T,>(path: string, fallback: T): Promise<T> => {
    try {
      const res = await (platform.fetch ?? globalThis.fetch)(`${base()}${path}`)
      return (await res.json()) as T
    } catch (e) {
      return { ...fallback, reason: e instanceof Error ? e.message : String(e) }
    }
  }

  const [fleet, { refetch: refetchFleet }] = createResource(() =>
    getJson<{ measured: boolean; reason?: string; nodes: FleetNode[] }>("/iris/hive/sessions", { measured: false, nodes: [] }),
  )
  const [cloud, { refetch: refetchCloud }] = createResource(() =>
    getJson<{ measured: boolean; reason?: string; copies: CloudCopy[] }>("/iris/hive/shares", { measured: false, copies: [] }),
  )
  const [history, { refetch: refetchHistory }] = createResource(() =>
    getJson<{ measured: boolean; reason?: string; sessions: IndexedSession[] }>("/iris/hive/session-index", { measured: false, sessions: [] }),
  )
  const refresh = () => {
    void refetchFleet()
    void refetchCloud()
    void refetchHistory()
  }
  const timer = setInterval(refresh, 60_000)
  onCleanup(() => clearInterval(timer))

  const [filters, setFilters] = createSignal<Filters>({ source: "all", machine: "", app: "", status: "", query: "", sort: "recent" })
  const set = (patch: Partial<Filters>) => setFilters({ ...filters(), ...patch })

  const rows = createMemo(() => mergeRows(fleet()?.nodes ?? [], cloud()?.copies ?? [], history()?.sessions ?? []))
  const shown = createMemo(() => applyFilters(rows(), filters()))
  const counts = createMemo(() => sourceCounts(rows(), filters()))
  const options = createMemo(() => optionsOf(rows()))

  const [open, setOpen] = createSignal<string | null>(null)

  return (
    <main class="ssv" aria-labelledby="ssv-title">
      <header class="ssv-head">
        <div>
          <h1 id="ssv-title">Sessions</h1>
          <p class="ssv-sub">
            Every chat you have — on this machine, on your other machines, and the copies you saved to the cloud.
          </p>
        </div>
        <button
          type="button"
          class="ssv-btn"
          onClick={refresh}
        >
          Refresh
        </button>
      </header>

      <div class="ssv-chips" role="tablist" aria-label="Where the chat lives">
        <For each={SOURCES}>
          {(s) => (
            <button
              type="button"
              role="tab"
              class="ssv-chip"
              aria-selected={filters().source === s.id}
              onClick={() => set({ source: s.id })}
            >
              {s.label} <span class="ssv-num">{counts()[s.id]}</span>
            </button>
          )}
        </For>
      </div>

      <div class="ssv-filters">
        <input
          id="ssv-search"
          class="ssv-search"
          type="search"
          placeholder="Search by title, machine or branch"
          value={filters().query}
          onInput={(e) => set({ query: e.currentTarget.value })}
        />
        <Select id="ssv-machine" label="Machine" value={filters().machine} options={options().machines} onChange={(v) => set({ machine: v })} />
        <Select id="ssv-app" label="App" value={filters().app} options={options().apps} onChange={(v) => set({ app: v })} />
        <Select id="ssv-status" label="Status" value={filters().status} options={options().statuses} onChange={(v) => set({ status: v })} />
        <label class="ssv-sort">
          Sort
          <select id="ssv-sort" value={filters().sort} onChange={(e) => set({ sort: e.currentTarget.value as SortKey })}>
            <option value="recent">Last active</option>
            <option value="title">Title</option>
            <option value="machine">Machine</option>
          </select>
        </label>
      </div>

      <Show when={fleet() && !fleet()!.measured}>
        <p class="ssv-warn">Could not read your machines' chats{fleet()!.reason ? ` — ${fleet()!.reason}` : ""}.</p>
      </Show>
      <Show when={history() && !history()!.measured}>
        <p class="ssv-warn">Showing recent chats only — could not read older ones{history()!.reason ? ` (${history()!.reason})` : ""}.</p>
      </Show>
      <Show when={cloud() && !cloud()!.measured}>
        <p class="ssv-warn">Could not read your cloud copies{cloud()!.reason ? ` — ${cloud()!.reason}` : ""}.</p>
      </Show>

      <Show
        when={shown().length}
        fallback={
          <p class="ssv-empty">
            {fleet.loading || cloud.loading || history.loading ? "Reading your chats…" : "No chats match. Clear a filter or try other words."}
          </p>
        }
      >
        <ul class="ssv-list">
          <For each={shown()}>
            {(r) => (
              <li class="ssv-row" data-open={open() === r.key ? "" : undefined}>
                <div class="ssv-main">
                  <button type="button" class="ssv-title" title={r.title} onClick={() => setOpen(open() === r.key ? null : r.key)}>
                    {r.title}
                  </button>
                  <div class="ssv-where">
                    <Show when={r.machine}>
                      <span class="ssv-tag" data-kind={r.machine!.self ? "this" : "other"}>
                        {r.machine!.self ? "This machine" : r.machine!.name}
                      </span>
                    </Show>
                    <Show when={r.copy}>
                      <span class="ssv-tag" data-kind="cloud" title={r.copy!.machine ? `Saved from ${r.copy!.machine}` : undefined}>
                        Cloud copy{!r.machine && r.copy!.machine ? ` · from ${r.copy!.machine}` : ""}
                      </span>
                    </Show>
                    <span class="ssv-meta">{r.app}</span>
                    <Show when={r.branch}>
                      <span class="ssv-meta">{r.branch}</span>
                    </Show>
                  </div>
                </div>
                <span class="ssv-status" data-status={r.status}>
                  {r.status === "copy" ? "saved" : r.status.replace("_", " ")}
                </span>
                <span class="ssv-age ssv-num">{age(r.updatedAt)}</span>
                <div class="ssv-actions">
                  <Show when={r.machine?.self && r.app === "IRIS" && server.key}>
                    <button type="button" class="ssv-btn" onClick={() => navigate(sessionHref(server.key!, r.sessionId))}>
                      Open
                    </button>
                  </Show>
                  <button type="button" class="ssv-btn ssv-quiet" onClick={() => setOpen(open() === r.key ? null : r.key)}>
                    {open() === r.key ? "Close" : "Read"}
                  </button>
                </div>
                <Show when={open() === r.key}>
                  <Peek row={r} getJson={getJson} />
                </Show>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </main>
  )
}

function Select(props: { id: string; label: string; value: string; options: string[]; onChange: (v: string) => void }) {
  return (
    <label class="ssv-sort">
      {props.label}
      <select id={props.id} value={props.value} onChange={(e) => props.onChange(e.currentTarget.value)}>
        <option value="">Any</option>
        <For each={props.options}>{(o) => <option value={o}>{o.replace("_", " ")}</option>}</For>
      </select>
    </label>
  )
}

/** The latest of a chat, read from the machine that has it. A copy-only chat says where the copy is. */
function Peek(props: { row: SessionRow; getJson: <T>(path: string, fallback: T) => Promise<T> }) {
  const [t] = createResource(() => {
    const r = props.row
    if (!r.machine) return Promise.resolve<Transcript>({ measured: false, reason: "only the cloud copy is left", messages: [] })
    const q = new URLSearchParams({ machine: r.machine.name, provider: r.provider, limit: "12" })
    return props.getJson<Transcript>(`/iris/hive/sessions/${encodeURIComponent(r.sessionId)}/transcript?${q}`, { measured: false, messages: [] })
  })
  return (
    <div class="ssv-peek">
      <Show when={!t.loading} fallback={<p class="ssv-meta">Reading it from {props.row.machine?.name ?? "the cloud copy"}…</p>}>
        <Show
          when={t()?.measured && t()!.messages.length}
          fallback={
            <p class="ssv-meta">
              {props.row.copy
                ? `Cloud copy: ${props.row.copy.messages} messages, saved ${age(props.row.copy.updatedAt)} ago${props.row.copy.machine ? ` from ${props.row.copy.machine}` : ""}.`
                : `Could not read it — ${t()?.reason ?? "the machine did not answer"}.`}
            </p>
          }
        >
          <ol class="ssv-lines">
            <For each={t()!.messages.filter((m) => (m.text ?? "").trim() || m.tool)}>
              {(m) => (
                <li>
                  <span class="ssv-who">{m.type === "tool_use" || m.tool ? m.tool ?? "tool" : m.role}</span>
                  <span>{(m.text ?? "").replace(/\s+/g, " ").slice(0, 240)}</span>
                </li>
              )}
            </For>
          </ol>
        </Show>
      </Show>
      <p class="ssv-meta">To keep going with it here, open it from Hive › Sessions in a project and choose Continue here.</p>
    </div>
  )
}

function age(iso: string | null): string {
  const t = iso ? Date.parse(iso) : NaN
  if (Number.isNaN(t)) return "—"
  const m = Math.max(0, Math.round((Date.now() - t) / 60000))
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`
}
