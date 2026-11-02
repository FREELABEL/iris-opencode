import { For, Show, createMemo, createResource, createSignal, onCleanup, type JSX } from "solid-js"
import { useServerSDK } from "@/context/server-sdk"
import { usePlatform } from "@/context/platform"
import type { HeartbeatRow } from "@/components/session/iris-heartbeats-model"
import { todayOf, type AgentsPayload, type HivePayload, type InboxPayload } from "./home-today-model"
import {
  TABS,
  compact,
  greetingOf,
  overviewOf,
  pageOf,
  rowOf,
  tabCount,
  tabRows,
  type Indicator,
  type Tab,
} from "./home-dashboard-model"
import "./home-dashboard.css"

/**
 * Home (#192222): your operation at a glance — agents and their heartbeats, machines, inbox — above
 * projects and sessions. Status is shown by indicators (dot, spinner, icons) with the words in the
 * tooltip, so the screen carries numbers rather than sentences.
 */

type BeatsPayload = { measured: boolean; reason?: string | null; heartbeats: HeartbeatRow[] }
type BloqsPayload = { measured: boolean; total?: number; bloqs: unknown[] }

const PATHS: Record<string, string> = {
  clock: "M8 1.8a6.2 6.2 0 1 0 0 12.4A6.2 6.2 0 0 0 8 1.8zM8 4.6V8l2.3 1.5",
  stop: "M8 1.8a6.2 6.2 0 1 0 0 12.4A6.2 6.2 0 0 0 8 1.8z",
  warn: "M8 2.2 14.3 13.4H1.7zM8 6.4v3.2M8 11.4v.1",
  pause: "M8 1.8a6.2 6.2 0 1 0 0 12.4A6.2 6.2 0 0 0 8 1.8zM6.5 5.6v4.8M9.5 5.6v4.8",
  bolt: "M9 1.8 3.6 9h3.6L6.6 14.2 12.4 7H8.7z",
  chip: "M4.2 4.2h7.6v7.6H4.2zM6.4 2v2.2M9.6 2v2.2M6.4 11.8V14M9.6 11.8V14M2 6.4h2.2M2 9.6h2.2M11.8 6.4H14M11.8 9.6H14",
  slot: "M2.2 3h11.6v4H2.2zM2.2 9h11.6v4H2.2z",
  token: "M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2zM5.6 8h4.8M8 5.6v4.8",
  mail: "M2 3.6h12v8.8H2zM2.6 4.4 8 8.6l5.4-4.2",
  grid: "M2.5 2.5h4.5v4.5H2.5zM9 2.5h4.5v4.5H9zM2.5 9h4.5v4.5H2.5zM9 9h4.5v4.5H9z",
}

function Icon(props: { name: keyof typeof PATHS; color?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style={{ color: props.color }} aria-hidden="true">
      <path d={PATHS[props.name]} fill={props.name === "bolt" ? "currentColor" : "none"} />
      <Show when={props.name === "stop"}>
        <rect x="5.6" y="5.6" width="4.8" height="4.8" rx="1" fill="currentColor" stroke="none" />
      </Show>
    </svg>
  )
}

const RED = "var(--ihd-bad)"
const AMBER = "var(--ihd-am)"

function Indicate(props: { kind: Indicator }): JSX.Element {
  switch (props.kind) {
    case "ok":
      return <i class="ihd-live" />
    case "running":
      return <i class="ihd-spin" />
    case "stopped":
      return <Icon name="stop" color={RED} />
    case "late":
      return <Icon name="clock" color={RED} />
    case "failing":
      return <Icon name="warn" color={AMBER} />
    case "paused":
      return <Icon name="pause" color="var(--ihd-faint)" />
  }
}

function Mark(props: { a: string; b: string; shape?: "split" | "square" }) {
  const r = (i: number) => (props.shape === "square" && (i === 1 || i === 2) ? "3px" : "50%")
  return (
    <div class="ihd-mk" aria-hidden="true">
      <For each={[props.a, props.b, props.b, props.a]}>{(c, i) => <i style={{ background: c, "border-radius": r(i()) }} />}</For>
    </div>
  )
}

const TAB_LABEL: Record<Tab, string> = { attention: "Needs attention", active: "Most active", all: "All" }

export function HomeDashboard(props: { class?: string; onNewChat?: () => void; onSettings?: () => void }) {
  const serverSDK = useServerSDK()
  const platform = usePlatform()
  const get = async <T,>(path: string, fallback: T): Promise<T> => {
    try {
      const res = await (platform.fetch ?? globalThis.fetch)(`${serverSDK().url.replace(/\/$/, "")}${path}`, {
        headers: { Accept: "application/json" },
      })
      if (!res.ok) return { ...fallback, reason: `engine ${res.status}` }
      return (await res.json()) as T
    } catch (e) {
      return { ...fallback, reason: e instanceof Error ? e.message : String(e) }
    }
  }
  const [data, { refetch }] = createResource(async () => {
    const [hive, agents, inbox, bloqs, beats] = await Promise.all([
      get<HivePayload>("/iris/hive?perPage=200", { measured: false, nodes: [] }),
      get<AgentsPayload>("/iris/agents-mine", { measured: false, agents: [] }),
      get<InboxPayload>("/iris/inbox?perPage=1", { measured: false, unread: null }),
      get<BloqsPayload>("/iris/bloqs?perPage=1", { measured: false, bloqs: [] }),
      get<BeatsPayload>("/iris/heartbeats", { measured: false, heartbeats: [] }),
    ])
    return { hive, agents, inbox, bloqs, beats, at: Date.now() }
  })
  const [now, setNow] = createSignal(Date.now())
  const timer = setInterval(() => {
    setNow(Date.now())
    void refetch()
  }, 60_000)
  onCleanup(() => clearInterval(timer))

  const [tab, setTab] = createSignal<Tab>("attention")
  const [page, setPage] = createSignal(1)
  const pick = (t: Tab) => {
    setTab(t)
    setPage(1)
  }

  const beats = () => data.latest?.beats.heartbeats ?? []
  const tiles = createMemo(() => {
    const d = data.latest
    return d ? todayOf(d.hive, d.agents, d.inbox) : []
  })
  const tile = (k: string) => tiles().find((t) => t.key === k)
  const ov = createMemo(() => {
    const day = new Date(now())
    day.setHours(0, 0, 0, 0)
    return overviewOf(beats(), now(), day.getTime())
  })
  const rows = createMemo(() => pageOf(tabRows(beats(), tab(), now()), page()))
  const hive = () => data.latest?.hive
  const online = () => hive()?.nodes.filter((n) => n.online) ?? []
  const freeSlots = () => online().reduce((s, n) => s + Math.max(0, (n.maxConcurrent ?? 0) - (n.activeTasks ?? 0)), 0)
  const models = () => new Set(online().flatMap((n) => n.modelsServing ?? [])).size
  const projects = () => {
    const b = data.latest?.bloqs
    return b?.measured ? String(b.total ?? b.bloqs.length) : "—"
  }

  return (
    <Show when={data.latest && (data.latest!.beats.measured || tiles().some((t) => t.measured))}>
      <div class={`ihd ${props.class ?? ""}`}>
        <div class="ihd-hello">
          <div>
            <div class="ihd-label" style={{ color: "var(--ihd-em)" }}>
              ● Today
            </div>
            <h1 class="ihd-h1">
              {greetingOf(new Date(now()).getHours())},<br />
              <span class="ihd-grad">here's your operation.</span>
            </h1>
            <div class="ihd-status">
              <Show when={ov().stopped}>
                <span class="ihd-i" style={{ color: RED }} title="Agents that are scheduled but not running">
                  <Icon name="stop" color={RED} />
                  {ov().stopped} stopped
                </span>
              </Show>
              <Show when={hive()?.measured}>
                <span class="ihd-i" title="Machines online">
                  <i class="ihd-live" />
                  {online().length}/{hive()!.nodes.length} online
                </span>
              </Show>
              <Show when={data.latest?.inbox.measured && data.latest!.inbox.unread != null}>
                <span class="ihd-i" title="Unread in your Hive inbox">
                  <Icon name="mail" />
                  {data.latest!.inbox.unread}
                </span>
              </Show>
            </div>
          </div>
          <div class="ihd-actions">
            <Show when={props.onSettings}>
              <button type="button" class="ihd-chip" onClick={() => props.onSettings?.()}>
                Settings
              </button>
            </Show>
            <Show when={props.onNewChat}>
              <button type="button" class="ihd-go" onClick={() => props.onNewChat?.()}>
                New chat
              </button>
            </Show>
          </div>
        </div>

        <div class="ihd-stats">
          <div class="ihd-stat" title="Boards you own or share">
            <Mark a="var(--ihd-bl)" b="var(--ihd-in)" />
            <div class="ihd-n">{projects()}</div>
            <div class="ihd-label" style={{ color: "var(--ihd-in)" }}>
              Projects
            </div>
            <div class="ihd-meta">
              <span class="ihd-i">
                <Icon name="grid" />
                boards
              </span>
            </div>
          </div>
          <div class="ihd-stat" title={tile("agents")?.detail}>
            <Mark a="var(--ihd-fu)" b="var(--ihd-in)" />
            <div class="ihd-n">{tile("agents")?.value ?? "—"}</div>
            <div class="ihd-label" style={{ color: "var(--ihd-fu)" }}>
              Agents
            </div>
            <div class="ihd-meta">
              <span class="ihd-i" title="On a schedule">
                <Icon name="clock" />
                {ov().scheduled}
              </span>
              <span class="ihd-i" title="Healthy">
                <i class="ihd-live" style={{ width: "6px", height: "6px" }} />
                {ov().healthy}
              </span>
            </div>
          </div>
          <div class="ihd-stat" title="Scheduled agent heartbeats">
            <Show when={ov().stopped}>
              <span class="ihd-flag ihd-ov" data-tone="bad" title="Not running">
                <Icon name="stop" color={RED} />
                <b>{ov().stopped}</b>
              </span>
            </Show>
            <Mark a="var(--ihd-em)" b="var(--ihd-am)" shape="square" />
            <div class="ihd-n">{data.latest?.beats.measured ? beats().length : "—"}</div>
            <div class="ihd-label" style={{ color: "var(--ihd-em)" }}>
              Heartbeats
            </div>
            <div class="ihd-meta">
              <span class="ihd-i" title="Running today">
                <Icon name="bolt" color="var(--ihd-em)" />
                {ov().runsToday}
              </span>
              <span class="ihd-i" title="Paused">
                <Icon name="pause" />
                {ov().paused}
              </span>
            </div>
          </div>
          <div class="ihd-stat" title={tile("machines")?.detail}>
            <Mark a="var(--ihd-cy)" b="var(--ihd-bl)" shape="square" />
            <div class="ihd-n">{hive()?.measured ? `${online().length}/${hive()!.nodes.length}` : "—"}</div>
            <div class="ihd-label" style={{ color: "var(--ihd-cy)" }}>
              Machines
            </div>
            <div class="ihd-meta">
              <span class="ihd-i" title="Free task slots">
                <Icon name="slot" />
                {freeSlots()}
              </span>
              <span class="ihd-i" title="AI models serving">
                <Icon name="chip" />
                {models()}
              </span>
            </div>
          </div>
          <div class="ihd-stat" title={tile("inbox")?.detail}>
            <Mark a="var(--ihd-am)" b="var(--ihd-fu)" shape="square" />
            <div class="ihd-n">{data.latest?.inbox.measured && data.latest!.inbox.unread != null ? data.latest!.inbox.unread : "—"}</div>
            <div class="ihd-label" style={{ color: "var(--ihd-am)" }}>
              Hive inbox
            </div>
            <div class="ihd-meta">
              <span class="ihd-i">
                <Icon name="mail" />
                unread
              </span>
            </div>
          </div>
        </div>

        <Show when={data.latest?.beats.measured}>
          <section class="ihd-card" aria-label="Your agents">
            <div class="ihd-ah">
              <h2>Your agents</h2>
              <span class="ihd-ov" title="Scheduled">
                <Icon name="clock" />
                <b>{ov().scheduled}</b>
              </span>
              <span class="ihd-ov" title="Healthy">
                <i class="ihd-live" />
                <b>{ov().healthy}</b>
              </span>
              <Show when={ov().stopped}>
                <span class="ihd-ov" data-tone="bad" title="Not running">
                  <Icon name="stop" color={RED} />
                  <b>{ov().stopped}</b>
                </span>
              </Show>
              <Show when={ov().failing}>
                <span class="ihd-ov" data-tone="warn" title="Last run failed">
                  <Icon name="warn" color={AMBER} />
                  <b>{ov().failing}</b>
                </span>
              </Show>
              <span class="ihd-ov" title="Paused">
                <Icon name="pause" />
                <b>{ov().paused}</b>
              </span>
              <span class="ihd-ov" title="Runs today">
                <Icon name="bolt" color="var(--ihd-em)" />
                <b>{ov().runsToday}</b>
              </span>
              <span class="ihd-ov" title="Tokens today">
                <Icon name="token" />
                <b>{compact(ov().tokensToday)}</b>
              </span>
            </div>
            <Show when={ov().stopped}>
              <div class="ihd-alert" role="status">
                <Icon name="stop" />
                {ov().stopped} scheduled {ov().stopped === 1 ? "agent is" : "agents are"} not running. Hover a row to see why.
              </div>
            </Show>
            <div class="ihd-tabs" role="tablist">
              <For each={TABS}>
                {(t) => (
                  <button type="button" role="tab" class="ihd-tab" aria-selected={tab() === t} onClick={() => pick(t)}>
                    {TAB_LABEL[t]}
                    <span>{tabCount(beats(), t, now())}</span>
                  </button>
                )}
              </For>
            </div>
            <div class="ihd-th" aria-hidden="true">
              <span />
              <span>Agent</span>
              <span title="Schedule">
                <Icon name="clock" />
              </span>
              <span>Last 12 runs</span>
              <span>Last</span>
              <span title="Model">
                <Icon name="chip" />
              </span>
            </div>
            <Show when={rows().total} fallback={<div class="ihd-empty">Nothing here — every agent is beating.</div>}>
              <For each={rows().items}>
                {(r) => {
                  const a = () => rowOf(r, now())
                  return (
                    <div class="ihd-tr" data-indicator={a().indicator} title={a().why}>
                      <span class="ihd-st">
                        <Indicate kind={a().indicator} />
                      </span>
                      <span class="ihd-name">{a().name}</span>
                      <span class="ihd-mu">{a().every}</span>
                      <span class="ihd-hb" aria-label={`Last ${a().strip.length} runs`}>
                        <For each={Array.from({ length: Math.max(0, 12 - a().strip.length) })}>{() => <i />}</For>
                        <For each={a().strip}>{(k) => <i data-k={k} />}</For>
                      </span>
                      <span class="ihd-mu" data-bad={a().indicator === "stopped" || a().indicator === "late" ? "" : undefined}>
                        {a().last}
                      </span>
                      <span class="ihd-mu">{a().model ?? "—"}</span>
                    </div>
                  )
                }}
              </For>
            </Show>
            <div class="ihd-pager">
              <span class="ihd-range">
                {rows().from}–{rows().to} of {rows().total}
              </span>
              <button type="button" class="ihd-pg" aria-label="Previous page" disabled={rows().page <= 1} onClick={() => setPage(rows().page - 1)}>
                ‹
              </button>
              <For each={Array.from({ length: rows().pages }, (_, i) => i + 1)}>
                {(p) => (
                  <button type="button" class="ihd-pg" aria-current={p === rows().page ? "page" : undefined} onClick={() => setPage(p)}>
                    {p}
                  </button>
                )}
              </For>
              <button type="button" class="ihd-pg" aria-label="Next page" disabled={rows().page >= rows().pages} onClick={() => setPage(rows().page + 1)}>
                ›
              </button>
            </div>
            <div class="ihd-legend">
              <span>
                <i class="ihd-live" />
                healthy
              </span>
              <span>
                <i class="ihd-spin" style={{ width: "10px", height: "10px" }} />
                running
              </span>
              <span>
                <Icon name="stop" color={RED} />
                not running
              </span>
              <span>
                <Icon name="clock" color={RED} />
                late
              </span>
              <span>
                <Icon name="warn" color={AMBER} />
                failed
              </span>
              <span>
                <Icon name="pause" />
                paused
              </span>
            </div>
          </section>
        </Show>
      </div>
    </Show>
  )
}
