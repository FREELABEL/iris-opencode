import { For, Match, Show, Switch, createMemo, createSignal, onCleanup, type JSX } from "solid-js"
import { useServerSDK } from "@/context/server-sdk"
import { usePlatform } from "@/context/platform"
import { openIrisPanel } from "@/components/session/iris-nav"
import type { HeartbeatRow } from "@/components/session/iris-heartbeats-model"
import { todayOf, type AgentsPayload, type HivePayload, type InboxPayload } from "./home-today-model"
import {
  TABS,
  compact,
  greetingOf,
  overviewOf,
  emptyText,
  listRows,
  type Indicator,
  type Tab,
} from "./home-dashboard-model"
import { sayingFor } from "./home-sayings"
import {
  agoOf,
  fetchHomeDashboard,
  fetchHomeRecap,
  type HomeRecap,
  homeDashboard,
  homeDashboardKey,
  sliceOf,
  verbOf,
  type RecentItem,
  type HomeDashboardData,
} from "./home-dashboard-data"
import { hivePillTarget } from "@/components/session/iris-hive-inbox-model"
import { focusHiveSession } from "@/components/session/iris-nav"
import { byTool, fleetOf, type FleetRow } from "./home-fleet-model"
import { AgentMark } from "@/components/session/agent-mark"
import { plural, recapOf } from "./home-recap-model"
import { Spinner } from "@opencode-ai/ui/spinner"
import "./home-dashboard.css"

/**
 * Home (#192222): your operation at a glance — agents and their heartbeats, machines, inbox — above
 * projects and sessions. Status is shown by indicators (dot, spinner, icons) with the words in the
 * tooltip, so the screen carries numbers rather than sentences.
 */

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
  moon: "M12.8 10.2A5.6 5.6 0 0 1 5.8 3.2a5.6 5.6 0 1 0 7 7z",
}

function Icon(props: { name: keyof typeof PATHS; color?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      style={{ color: props.color }}
      aria-hidden="true"
    >
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
      return <Spinner class="ihd-spin" />
    case "resting":
      return <Icon name="moon" color="var(--ihd-in)" />
    case "stopped":
      return <Icon name="stop" color={RED} />
    case "late":
      return <Icon name="clock" color={RED} />
    case "failing":
      return <Icon name="warn" color={AMBER} />
    case "paused":
      return <Icon name="pause" color="var(--ihd-faint)" />
    case "idle":
      return <i class="ihd-idle" />
  }
}

// A tile's mark (#194375): neutral dots, one in the accent. Colour is not what tells tiles apart.
function Mark(props: { shape?: "split" | "square" }) {
  const r = (i: number) => (props.shape === "square" && (i === 1 || i === 2) ? "3px" : "50%")
  return (
    <div class="ihd-mk" aria-hidden="true">
      <For each={[0, 1, 2, 3]}>{(i) => <i style={{ "border-radius": r(i) }} />}</For>
    </div>
  )
}

const TAB_LABEL: Record<Tab, string> = { attention: "Needs attention", active: "Most active", all: "All" }
// All first: what is failing is a filter you choose, not the first thing Home shows (2026-11-04).
const AGENT_TABS: Tab[] = ["all", "active", "attention"]

// #194315: no page numbers on Home. Five rows, then "Show all N" in place.
const FEW = 5
function More(props: { total: number; shown: number; open: boolean; onToggle: () => void }) {
  return (
    <Show when={props.total > FEW}>
      <div class="ihd-pager">
        <span class="ihd-range">
          {props.shown} of {props.total}
        </span>
        <button type="button" class="ihd-chip" aria-expanded={props.open} onClick={() => props.onToggle()}>
          {props.open ? "Show fewer" : `Show all ${props.total}`}
        </button>
      </div>
    </Show>
  )
}

export function HomeDashboard(props: { class?: string; onNewChat?: () => void; onSettings?: () => void }) {
  const serverSDK = useServerSDK()
  const platform = usePlatform()
  // Opens beside Home (#192535): no chat is chosen, and none is needed.
  const openHeartbeats = () => openIrisPanel({ surface: "agents", sub: "heartbeats" })
  const key = () => homeDashboardKey(serverSDK().url)
  const fetcher = (progress: (partial: HomeDashboardData) => void) =>
    fetchHomeDashboard(serverSDK().url, platform.fetch ?? globalThis.fetch, progress)
  // The last good copy first — it outlives this page — and the fresh read lands behind it.
  const [data, setData] = createSignal(homeDashboard.read(key(), fetcher))
  onCleanup(homeDashboard.subscribe((k, value) => k === key() && setData(() => value)))
  // #192608: the Machines tile opens Hive › Machines — the one Computers view — not a second copy here.
  // Beside Home, like Heartbeats (#192535): no chat is needed for the panel any more.
  const openComputers = () => openIrisPanel({ surface: "hive", sub: "machines" })
  const [now, setNow] = createSignal(Date.now())
  // The written "Today" paragraph (#194315): read on its own — it is a model call — and again every
  // 5 minutes; the engine caches it and writes a new one at most every 15.
  const [written, setWritten] = createSignal<HomeRecap | null>(null)
  const readWritten = () =>
    void fetchHomeRecap(serverSDK().url, platform.fetch ?? globalThis.fetch).then((r) => r && setWritten(r))
  readWritten()
  const writtenTimer = setInterval(readWritten, 5 * 60_000)
  onCleanup(() => clearInterval(writtenTimer))
  const timer = setInterval(() => {
    setNow(Date.now())
    void homeDashboard.load(key(), fetcher).catch(() => {})
  }, 60_000)
  onCleanup(() => clearInterval(timer))
  const user = createMemo(() => {
    const list = data()?.accounts.accounts ?? []
    return (list.find((a) => a.active) ?? list[0])?.id
  })

  const [tab, setTab] = createSignal<Tab>("all")
  // The card's three views (#192535). Activity first: what changed on your boards.
  const [view, setView] = createSignal<"activity" | "agents" | "inbox">("activity")
  const [open, setOpen] = createSignal<Record<string, boolean>>({})
  const toggle = (k: string) => setOpen((o) => ({ ...o, [k]: !o[k] }))
  const size = (k: string, n: number) => (open()[k] ? Math.max(n, FEW) : FEW)
  const recentItems = () => data()?.recent?.items ?? []
  const feed = createMemo(() => sliceOf(recentItems(), 1, size("feed", recentItems().length)))
  const mail = createMemo(() => sliceOf(data()?.inbox.items ?? [], 1, size("mail", data()?.inbox.items?.length ?? 0)))
  const openItem = (item: RecentItem) => openIrisPanel({ surface: "atlas", bloqId: item.bloqId, itemId: item.id })
  const openInbox = () => openIrisPanel(hivePillTarget("inbox"))
  // On your machines (#192626): one row per live session, any tool, any machine you have.
  const fleet = createMemo(() => fleetOf(data()?.sessions))
  const [tool, setTool] = createSignal<string | null>(null)
  const fleetAll = createMemo(() => byTool(fleet().rows, tool()))
  const fleetRows = createMemo(() => sliceOf(fleetAll(), 1, size("fleet", fleetAll().length)))
  const pickTool = (t: string | null) => setTool(t)
  const openSessions = () => openIrisPanel({ surface: "hive", sub: "sessions" })
  const openFleetRow = (r: FleetRow) => {
    focusHiveSession({ nodeId: r.nodeId, sessionId: r.sessionId })
    openSessions()
  }
  const pick = (t: Tab) => setTab(t)

  const beats = () => data()?.beats.heartbeats ?? []
  const tiles = createMemo(() => {
    const d = data()
    return d ? todayOf(d.hive, d.agents, d.inbox) : []
  })
  const tile = (k: string) => tiles().find((t) => t.key === k)
  const ov = createMemo(() => {
    const day = new Date(now())
    day.setHours(0, 0, 0, 0)
    return overviewOf(beats(), now(), day.getTime())
  })
  // #192647: every agent, not only the scheduled ones — the card counts all of them.
  const agentList = () => (data()?.agents.measured ? data()!.agents.agents : [])
  const agentTotal = () => data()?.agents.total ?? agentList().length
  const all = createMemo(() => listRows(beats(), agentList(), tab(), now()))
  const rows = createMemo(() => sliceOf(all(), 1, size("agents", all().length)))
  const openAgents = () => openIrisPanel({ surface: "agents" })
  const hive = () => data()?.hive
  const online = () => hive()?.nodes.filter((n) => n.online) ?? []
  const freeSlots = () => online().reduce((s, n) => s + Math.max(0, (n.maxConcurrent ?? 0) - (n.activeTasks ?? 0)), 0)
  const models = () => new Set(online().flatMap((n) => n.modelsServing ?? [])).size
  const recap = createMemo(() => {
    const day = new Date(now())
    day.setHours(0, 0, 0, 0)
    return recapOf(recentItems(), day.getTime())
  })
  const needsYou = () => fleet().rows.filter((r) => r.status === "needs_you").length
  const projects = () => {
    const b = data()?.bloqs
    return b?.measured ? String(b.total ?? b.bloqs.length) : "—"
  }

  return (
    <Show when={data() && (data()!.beats.measured || tiles().some((t) => t.measured))}>
      <div class={`ihd ${props.class ?? ""}`}>
        <div class="ihd-hello">
          <div>
            <div class="ihd-label">
              ● Today
            </div>
            <h1 class="ihd-h1">
              {greetingOf(new Date(now()).getHours())},<br />
              <span class="ihd-grad">{sayingFor(user(), new Date(now()))}</span>
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
              <Show when={data()?.inbox.measured && data()!.inbox.unread != null}>
                <span class="ihd-i" title="Unread in your Hive inbox">
                  <Icon name="mail" />
                  {data()!.inbox.unread}
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
            <Mark />
            <div class="ihd-n">{projects()}</div>
            <div class="ihd-label">
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
            <Mark />
            <div class="ihd-n">{tile("agents")?.value ?? "—"}</div>
            <div class="ihd-label">
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
            <Mark shape="square" />
            <div class="ihd-n">{data()?.beats.measured ? beats().length : "—"}</div>
            <div class="ihd-label">
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
          <div
            class="ihd-stat"
            data-link="1"
            title={`${tile("machines")?.detail ?? ""}\nClick to open Hive › Machines`}
            role="button"
            tabIndex={0}
            onClick={openComputers}
            onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && openComputers()}
          >
            <Mark shape="square" />
            <div class="ihd-n">{hive()?.measured ? `${online().length}/${hive()!.nodes.length}` : "—"}</div>
            <div class="ihd-label">
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
            <Mark shape="square" />
            <div class="ihd-n">
              {data()?.inbox.measured && data()!.inbox.unread != null ? data()!.inbox.unread : "—"}
            </div>
            <div class="ihd-label">
              Hive inbox
            </div>
            <div class="ihd-meta">
              <span class="ihd-i">
                <Icon name="mail" />
                unread
              </span>
            </div>
          </div>
          <div
            class="ihd-stat"
            data-link="1"
            title="Sessions running on your machines, any tool\nClick to open Hive › Sessions"
            role="button"
            tabIndex={0}
            onClick={openSessions}
            onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && openSessions()}
          >
            <Show when={needsYou()}>
              <span class="ihd-flag ihd-ov" data-tone="warn" title="Waiting on you">
                <Icon name="warn" color={AMBER} />
                <b>{needsYou()}</b>
              </span>
            </Show>
            <Mark />
            <div class="ihd-n">{data()?.sessions.measured ? fleet().rows.length : "—"}</div>
            <div class="ihd-label">
              Sessions
            </div>
            <div class="ihd-meta">
              <span class="ihd-i" title="Machines with a live session">
                <Icon name="slot" />
                {fleet().machines}
              </span>
              <span class="ihd-i" title="Working now">
                <i class="ihd-live" style={{ width: "6px", height: "6px" }} />
                {fleet().rows.filter((r) => r.working || r.status === "active").length}
              </span>
            </div>
          </div>
        </div>

        <Show when={data()?.recent?.measured || written()?.text}>
          <section class="ihd-recap" aria-label="Today across your projects">
            <div class="ihd-recap-h">
              <span class="ihd-label">
                Today · across your projects
              </span>
            </div>
            <Show
              when={written()?.text}
              fallback={
            <Show
              when={(() => {
                const r = recap()
                return r.empty ? null : r
              })()}
              fallback={<p class="ihd-recap-p">Nothing has changed on your boards yet today.</p>}
            >
              {(r) => (
                <p class="ihd-recap-p">
                  <Show when={r().mine} fallback={<>You haven’t changed anything on your boards yet today. </>}>
                    You changed <b>{plural(r().mine, "item")}</b> across <b>{plural(r().mineProjects, "project")}</b>.{" "}
                    <Show when={r().top}>
                      {(t) => (
                        <>
                          Most of it was in <b>{t().name}</b>
                          <Show when={t().count > 1}> ({t().count})</Show>: {t().titles.join("; ")}.{" "}
                        </>
                      )}
                    </Show>
                  </Show>
                  <Show when={r().agents}>
                    Your agents wrote <b>{plural(r().agents, "diary or work log", "diaries and work logs")}</b> across{" "}
                    <b>{plural(r().agentProjects, "project")}</b>.
                  </Show>
                </p>
              )}
            </Show>
              }
            >
              {(text) => (
                <p
                  class="ihd-recap-p"
                  title={`Written by ${written()?.model ?? "a model"} from ${written()?.items ?? 0} board items and ${written()?.sessions ?? 0} sessions${written()?.agents?.length ? ` (${written()!.agents.join(", ")})` : ""}`}
                >
                  {text()}
                </p>
              )}
            </Show>
          </section>
        </Show>

        <Show when={data()}>
          <section class="ihd-card" aria-label="Today">
            <div class="ihd-views" role="tablist">
              <button
                type="button"
                role="tab"
                class="ihd-view"
                aria-selected={view() === "activity"}
                onClick={() => setView("activity")}
              >
                Activity
              </button>
              <button
                type="button"
                role="tab"
                class="ihd-view"
                aria-selected={view() === "agents"}
                onClick={() => setView("agents")}
              >
                Agents
                <Show when={ov().stopped || ov().failing}>
                  <i class="ihd-dot" title={`${ov().stopped} not running · ${ov().failing} failed`} />
                </Show>
              </button>
              <button
                type="button"
                role="tab"
                class="ihd-view"
                aria-selected={view() === "inbox"}
                onClick={() => setView("inbox")}
              >
                Inbox
                <Show when={data()?.inbox.unread}>{(n) => <span>{n()}</span>}</Show>
              </button>
            </div>
            <Switch>
              <Match when={view() === "activity"}>
                <Show
                  when={data()?.recent?.measured}
                  fallback={
                    <div class="ihd-empty">
                      {data()?.recent?.reason
                        ? `Recent activity could not be read — ${data()?.recent?.reason}`
                        : "Reading recent activity…"}
                    </div>
                  }
                >
                  <Show
                    when={feed().total}
                    fallback={<div class="ihd-empty">Nothing has changed on your boards yet.</div>}
                  >
                    <For each={feed().items}>
                      {(item) => (
                        <div
                          class="ihd-fr"
                          role="button"
                          tabIndex={0}
                          title={`Open in Atlas${item.bloqName ? ` — ${item.bloqName}` : ""}`}
                          onClick={() => openItem(item)}
                          onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && openItem(item)}
                        >
                          <span class="ihd-name">{item.title}</span>
                          <span class="ihd-mu ihd-where">
                            {[item.bloqName, item.listName].filter(Boolean).join(" › ")}
                          </span>
                          <span class="ihd-mu">{verbOf(item)}</span>
                          <span class="ihd-mu ihd-age">{agoOf(item.updatedAt, now())}</span>
                        </div>
                      )}
                    </For>
                    <More total={feed().total} shown={feed().items.length} open={!!open().feed} onToggle={() => toggle("feed")} />
                  </Show>
                </Show>
              </Match>
              <Match when={view() === "agents"}>
                <Show
                  when={data()?.beats.measured}
                  fallback={
                    <div class="ihd-empty">
                      Heartbeats could not be read{data()?.beats.reason ? ` — ${data()?.beats.reason}` : ""}.
                    </div>
                  }
                >
                  <p class="ihd-sum">
                    <span>
                      <b>{ov().scheduled}</b> scheduled
                    </span>
                    <span>
                      <b>{ov().healthy}</b> healthy
                    </span>
                    <Show when={ov().stopped}>
                      <span data-tone="bad">
                        <b>{ov().stopped}</b> not running
                      </span>
                    </Show>
                    <Show when={ov().failing}>
                      <span data-tone="warn">
                        <b>{ov().failing}</b> failed
                      </span>
                    </Show>
                    <Show when={ov().resting}>
                      <span>
                        <b>{ov().resting}</b> resting
                      </span>
                    </Show>
                    <Show when={ov().paused}>
                      <span>
                        <b>{ov().paused}</b> paused
                      </span>
                    </Show>
                    <span>
                      <b>{ov().runsToday}</b> runs today
                    </span>
                    <span>
                      <b>{compact(ov().tokensToday)}</b> tokens
                    </span>
                  </p>
                  <div class="ihd-tabs" role="tablist">
                    <For each={AGENT_TABS}>
                      {(t) => (
                        <button
                          type="button"
                          role="tab"
                          class="ihd-tab"
                          aria-selected={tab() === t}
                          onClick={() => pick(t)}
                        >
                          {TAB_LABEL[t]}
                          <span>{listRows(beats(), agentList(), t, now()).length}</span>
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
                  <Show
                    when={rows().total}
                    fallback={<div class="ihd-empty">{emptyText(tab(), beats().length, agentTotal())}</div>}
                  >
                    <For each={rows().items}>
                      {(r) => {
                        const a = () => r
                        const open = () => (r.indicator === "idle" ? openAgents() : openHeartbeats())
                        return (
                          <div
                            class="ihd-tr"
                            data-indicator={a().indicator}
                            title={
                              a().indicator === "idle"
                                ? `${a().why}\nClick to open Agents`
                                : `${a().why}\nClick to open in Agents › Heartbeats (Run now, Pause)`
                            }
                            role="button"
                            tabIndex={0}
                            onClick={open}
                            onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && open()}
                          >
                            <span class="ihd-st">
                              <Indicate kind={a().indicator} />
                            </span>
                            <span class="ihd-name">{a().name}</span>
                            <span class="ihd-mu">{a().every}</span>
                            <span class="ihd-hb" aria-label={`Last ${a().strip.length} runs`}>
                              <For each={Array.from({ length: Math.max(0, 12 - a().strip.length) })}>{() => <i />}</For>
                              <For each={a().strip}>{(k) => <i data-k={k} />}</For>
                            </span>
                            <span
                              class="ihd-mu"
                              data-bad={a().indicator === "stopped" || a().indicator === "late" ? "" : undefined}
                            >
                              {a().last}
                            </span>
                            <span class="ihd-mu">{a().model ?? "—"}</span>
                          </div>
                        )
                      }}
                    </For>
                  </Show>
                  <More total={rows().total} shown={rows().items.length} open={!!open().agents} onToggle={() => toggle("agents")} />
                  <div class="ihd-legend">
                    <span>
                      <i class="ihd-idle" />
                      no schedule
                    </span>
                    <span>
                      <i class="ihd-live" />
                      healthy
                    </span>
                    <span>
                      <Spinner class="ihd-spin ihd-spin--sm" />
                      running
                    </span>
                    <span>
                      <Icon name="moon" color="var(--ihd-in)" />
                      resting
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
                </Show>
              </Match>
              <Match when={view() === "inbox"}>
                <Show
                  when={data()?.inbox.measured}
                  fallback={
                    <div class="ihd-empty">
                      The Hive inbox could not be read{data()?.inbox.reason ? ` — ${data()?.inbox.reason}` : ""}.
                    </div>
                  }
                >
                  <Show when={mail().total} fallback={<div class="ihd-empty">Your Hive inbox is empty.</div>}>
                    <For each={mail().items}>
                      {(m) => (
                        <div
                          class="ihd-fr"
                          data-unread={m.read ? undefined : ""}
                          role="button"
                          tabIndex={0}
                          title="Open in Hive › Inbox"
                          onClick={openInbox}
                          onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && openInbox()}
                        >
                          <span class="ihd-name">{m.label}</span>
                          <span class="ihd-mu ihd-where">{m.from}</span>
                          <span class="ihd-mu">{m.type}</span>
                          <span class="ihd-mu ihd-age">{agoOf(m.receivedAt, now())}</span>
                        </div>
                      )}
                    </For>
                    <More total={mail().total} shown={mail().items.length} open={!!open().mail} onToggle={() => toggle("mail")} />
                  </Show>
                </Show>
              </Match>
            </Switch>
          </section>
        </Show>

        <section class="ihd-card" aria-label="On your machines">
          <div class="ihd-card-h">
            <h2>On your machines</h2>
            <Show when={data()?.sessions.measured && fleet().rows.length}>
              <p class="ihd-sum">
                <span>
                  <b>{fleet().rows.length}</b> live on <b>{fleet().machines}</b>{" "}
                  {fleet().machines === 1 ? "machine" : "machines"}
                </span>
                <Show when={fleet().rows.filter((r) => r.status === "needs_you").length}>
                  {(n) => (
                    <span data-tone="warn">
                      <b>{n()}</b> need{n() === 1 ? "s" : ""} you
                    </span>
                  )}
                </Show>
              </p>
            </Show>
            <button type="button" class="ihd-more" onClick={openSessions}>
              Hive › Sessions
            </button>
          </div>
          <Show
            when={data()?.sessions.measured}
            fallback={
              <div class="ihd-empty">
                {data()?.sessions.reason && data()?.sessions.reason !== "loading"
                  ? `Your machines' sessions could not be read — ${data()?.sessions.reason}`
                  : "Reading your machines' sessions…"}
              </div>
            }
          >
            <Show
              when={fleet().rows.length}
              fallback={<div class="ihd-empty">Nothing is running on your machines right now.</div>}
            >
              <Show when={fleet().tools.length > 1}>
                <div class="ihd-tabs" role="tablist">
                  <button
                    type="button"
                    role="tab"
                    class="ihd-tab"
                    aria-selected={tool() === null}
                    onClick={() => pickTool(null)}
                  >
                    All<span>{fleet().rows.length}</span>
                  </button>
                  <For each={fleet().tools}>
                    {(t) => (
                      <button
                        type="button"
                        role="tab"
                        class="ihd-tab"
                        aria-selected={tool() === t}
                        onClick={() => pickTool(t)}
                      >
                        <AgentMark provider={byTool(fleet().rows, t)[0]?.provider ?? t} />
                        {t}
                        <span>{byTool(fleet().rows, t).length}</span>
                      </button>
                    )}
                  </For>
                </div>
              </Show>
              <For each={fleetRows().items}>
                {(r) => (
                  <div
                    class="ihd-sr"
                    data-status={r.status}
                    role="button"
                    tabIndex={0}
                    title={`${r.tool} · ${r.machine} · ${r.working ? "working" : r.status.replace("_", " ")}\nOpen in Hive › Sessions`}
                    onClick={() => openFleetRow(r)}
                    onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && openFleetRow(r)}
                  >
                    <span class="ihd-st">
                      <Switch fallback={<Icon name="moon" color="var(--ihd-in)" />}>
                        <Match when={r.status === "needs_you"}>
                          <Icon name="warn" color={AMBER} />
                        </Match>
                        <Match when={r.working}>
                          <Spinner class="ihd-spin" />
                        </Match>
                        <Match when={r.status === "active"}>
                          <i class="ihd-live" />
                        </Match>
                      </Switch>
                    </span>
                    <span class="ihd-name">
                      {r.label}
                      <Show when={r.branch}>{(b) => <small>{b()}</small>}</Show>
                    </span>
                    <span class="ihd-mu ihd-tool">
                      <AgentMark provider={r.provider} />
                      <span class="ihd-tool-name">{r.tool}</span>
                    </span>
                    <span class="ihd-mu ihd-where">{r.machine}</span>
                    <span class="ihd-mu ihd-age">{agoOf(r.updatedAt ?? undefined, now())}</span>
                  </div>
                )}
              </For>
              <More total={fleetRows().total} shown={fleetRows().items.length} open={!!open().fleet} onToggle={() => toggle("fleet")} />
            </Show>
            <Show when={fleet().hidden}>
              <div class="ihd-hidden">
                {fleet().hidden} older, or on machines that have not reported lately — all in Hive › Sessions.
              </div>
            </Show>
          </Show>
        </section>
      </div>
    </Show>
  )
}
