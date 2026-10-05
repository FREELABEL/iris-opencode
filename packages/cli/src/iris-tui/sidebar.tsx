// IRIS sidebar for the opencode v2 TUI — a port of the v1 sidebar tabs
// (iris-v1/cli/cmd/tui/routes/session/sidebar.tsx) onto v2's plugin slot API.
//
// It PREPENDS to `sidebar.content` rather than replacing it, so v2's own Context, MCP and
// footer sections still render underneath. Those cover what v1's "Sess" tab showed, which is
// why that tab is not ported. The data hooks are the v1 ones, unchanged.
import { Plugin } from "@opencode/plugin/tui"
import { createMemo, createSignal, For, Match, Show, Switch } from "solid-js"
import { createStore } from "solid-js/store"
import { useIrisData } from "../iris-v1/cli/cmd/tui/iris/api"
import type { IrisPlaybook } from "../iris-v1/cli/cmd/tui/iris/api"
import type { AtlasItem, IrisAgent, IrisContact } from "../iris-v1/cli/cmd/tui/iris/types"
import { useHiveInbox } from "../iris-v1/cli/cmd/tui/iris/hive-inbox"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

type Tab = "atlas" | "agents" | "hive" | "contacts" | "playbooks" | "pages"

const LABELS: Record<Tab, string> = {
  atlas: "Atlas",
  agents: "Agents",
  hive: "Hive",
  contacts: "Contacts",
  playbooks: "Playbooks",
  pages: "Pages",
}
const TABS: Tab[] = ["atlas", "agents", "hive", "contacts", "playbooks", "pages"]

/** A persisted tab from an older build (or v1's removed "session") must not render nothing. */
const normalizeTab = (value: unknown): Tab => (TABS.includes(value as Tab) ? (value as Tab) : "atlas")

export function IrisSidebar(props: { context: Plugin.Context; sessionID: string }) {
  const t = props.context.theme
  // v1 theme names → v2 tokens, in one place so the markup below reads like the v1 file.
  const c = {
    text: () => t.text.base,
    muted: () => t.text.muted,
    accent: () => t.hue.accent[200],
    hover: () => t.background.raised.high,
    success: () => t.text.feedback.success.base,
    warning: () => t.text.feedback.warning.base,
    error: () => t.text.feedback.error.base,
    field: () => t.background.formfield.focused,
  }

  // Persisted the same way v1 used kv("sidebar_tab"): the tab you were last on.
  const [view, updateView] = props.context.storage.store("iris-sidebar", {
    initial: { tab: "atlas" as Tab, open: true },
  })
  const tab = () => normalizeTab(view.tab)
  const setTab = (next: Tab) =>
    void updateView((d) => {
      d.tab = next
    }).catch(() => {})

  const iris = useIrisData()
  const inbox = useHiveInbox()
  const firstUnread = createMemo(() => inbox().items.find((i) => !i.read)?.index ?? 1)

  const [pickerOpen, setPickerOpen] = createSignal(false)
  const [expandedLists, setExpandedLists] = createSignal<Set<number>>(new Set())
  const [activeDoc, setActiveDoc] = createSignal<AtlasItem | null>(null)
  const [activeContact, setActiveContact] = createSignal<IrisContact | null>(null)
  const [hovered, setHovered] = createSignal<string | null>(null)
  const [query, setQuery] = createSignal("")
  const [expanded, setExpanded] = createStore({ heartbeat: true, standard: false })
  let searchInput: any

  const hoverProps = (key: string) => ({
    backgroundColor: hovered() === key ? c.hover() : undefined,
    onMouseOver: () => setHovered(key),
    onMouseOut: () => hovered() === key && setHovered(null),
  })
  const isHover = (key: string) => hovered() === key

  const matches = (text: string | undefined | null) => {
    const q = query().toLowerCase()
    return !q || (text ?? "").toLowerCase().includes(q)
  }

  const selectBloq = (id: number) => {
    iris.selectBloq(id)
    setExpandedLists(new Set<number>())
    setActiveDoc(null)
    setActiveContact(null)
  }
  const toggleList = (id: number) =>
    setExpandedLists((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })

  const bloqName = createMemo(
    () => iris.data.bloqList.find((b) => b.id === iris.data.selectedBloqId)?.name ?? "Select project…",
  )
  const heartbeat = createMemo(() => iris.data.agents.filter((a) => a.type === "heartbeat" && matches(a.name)))
  const standard = createMemo(() => iris.data.agents.filter((a) => a.type === "standard" && matches(a.name)))
  const playbooks = createMemo(() => iris.data.playbooks.filter((p) => matches(p.name) || matches(p.description)))
  const attached = createMemo(() => playbooks().filter((p) => p.attached))
  const others = createMemo(() => playbooks().filter((p) => !p.attached))
  const atlas = createMemo(() => {
    const q = query().toLowerCase()
    if (!q) return iris.data.atlas
    return iris.data.atlas
      .map((l) => ({ ...l, items: l.items.filter((i) => i.title.toLowerCase().includes(q)) }))
      .filter((l) => l.name.toLowerCase().includes(q) || l.items.length > 0)
  })
  const contacts = createMemo(() =>
    iris.data.contacts.filter((x) => matches(x.name) || matches(x.email) || matches(x.company)),
  )
  const pages = createMemo(() => iris.data.pages.filter((p) => matches(p.title) || matches(p.slug)))
  const bloqs = createMemo(() => iris.data.bloqList.filter((b) => matches(b.name)))

  const agentColor = (status: IrisAgent["status"]) =>
    ({ active: c.success(), idle: c.muted(), paused: c.warning(), error: c.error() })[status] ?? c.muted()

  /** The same three states every tab shows; an error must never look like an empty list. */
  const StatusLines = (p: { empty: boolean; emptyText: string; filteredEmpty: boolean }) => (
    <>
      <Show when={iris.data.status === "loading"}>
        <text fg={c.muted()}>Loading…</text>
      </Show>
      <Show when={iris.data.status === "no-auth" || iris.data.status === "error"}>
        <box>
          <text fg={c.muted()}>Not connected</text>
          <text fg={c.muted()}>Run: iris auth login</text>
        </box>
      </Show>
      <Show when={iris.data.status === "loaded" && p.empty}>
        <text fg={c.muted()}>{p.emptyText}</text>
      </Show>
      <Show when={query() && p.filteredEmpty && !p.empty}>
        <text fg={c.muted()}>No matches for "{query()}"</text>
      </Show>
    </>
  )

  const playbookRow = (pb: IrisPlaybook) => {
    const key = `pb-${pb.name}`
    return (
      <box {...hoverProps(key)}>
        <box flexDirection="row" gap={1}>
          <text flexShrink={0} fg={pb.attached ? c.accent() : c.muted()}>
            {pb.attached ? "*" : "-"}
          </text>
          <text fg={isHover(key) ? c.accent() : c.text()} wrapMode="word">
            {pb.name}
          </text>
        </box>
        <Show when={pb.description}>
          <text fg={c.muted()} wrapMode="word">
            {pb.description}
          </text>
        </Show>
      </box>
    )
  }

  return (
    <box flexShrink={0} paddingBottom={1}>
      {/* Header + collapse. The whole IRIS panel folds so v2's own sections are reachable. */}
      <box
        flexDirection="row"
        gap={1}
        {...hoverProps("hdr")}
        onMouseDown={() =>
          void updateView((d) => {
            d.open = !d.open
          }).catch(() => {})
        }
      >
        <text fg={c.accent()}>
          <b>◈ IRIS</b>
        </text>
        <box flexGrow={1} />
        {/* Hide lives here; resizing is the drag handle on the left edge (or ctrl+p → Widen /
            Narrow sidebar). The ‹ › strip on the right edge brings a hidden sidebar back. */}
        <box
          paddingLeft={1}
          paddingRight={1}
          {...hoverProps("sz-hide")}
          onMouseDown={(e: any) => e?.stopPropagation?.()}
          onMouseUp={(e: any) => {
            e?.stopPropagation?.()
            props.context.keymap.dispatch("session.sidebar.toggle")
          }}
        >
          <text fg={isHover("sz-hide") ? c.accent() : c.muted()}>hide</text>
        </box>
        <text fg={c.muted()}>{view.open ? "▼" : "▶"}</text>
      </box>

      <Show when={view.open}>
        {/* Project (bloq) picker */}
        <Show when={iris.data.bloqList.length > 0}>
          <box
            flexDirection="row"
            gap={1}
            onMouseDown={() => {
              setPickerOpen(!pickerOpen())
              if (pickerOpen()) setTimeout(() => searchInput?.focus(), 10)
            }}
          >
            <text fg={c.accent()}>◈</text>
            <text fg={c.text()} wrapMode="none" truncate flexShrink={1} minWidth={0}>
              {bloqName()}
            </text>
            <Show when={iris.data.selectedBloqId}>
              <text flexShrink={0} fg={c.muted()}>
                #{iris.data.selectedBloqId}
              </text>
            </Show>
            <text flexShrink={0} fg={c.muted()}>
              {pickerOpen() ? "▲" : "▼"}
            </text>
          </box>
          <Show when={pickerOpen()}>
            <box paddingLeft={2}>
              <For each={bloqs()}>
                {(bloq) => {
                  const key = `bq-${bloq.id}`
                  const selected = () => bloq.id === iris.data.selectedBloqId
                  return (
                    <box
                      {...hoverProps(key)}
                      onMouseDown={() => {
                        selectBloq(bloq.id)
                        setPickerOpen(false)
                      }}
                    >
                      <text fg={selected() || isHover(key) ? c.accent() : c.muted()} wrapMode="none" truncate>
                        {selected() ? "● " : "○ "}
                        {bloq.name}
                      </text>
                    </box>
                  )
                }}
              </For>
            </box>
          </Show>
        </Show>
        <Show when={iris.data.bloqList.length === 0 && iris.data.status === "loaded"}>
          <text fg={c.muted()}>No projects</text>
        </Show>

        {/* Tab bar. Wraps on the narrow v2 sidebar instead of running off the edge. */}
        <box flexDirection="row" flexWrap="wrap" columnGap={1} paddingTop={1}>
          <For each={TABS}>
            {(name) => (
              <text
                fg={tab() === name ? c.accent() : c.muted()}
                onMouseDown={() => {
                  setTab(name)
                  setQuery("")
                  setActiveDoc(null)
                  setActiveContact(null)
                }}
              >
                {tab() === name ? `[${LABELS[name]}]` : LABELS[name]}
              </text>
            )}
          </For>
        </box>

        {/* Search */}
        <box paddingTop={1} paddingBottom={1} onMouseDown={() => searchInput?.focus()}>
          <input
            ref={(r: any) => {
              searchInput = r
            }}
            onInput={(e: string) => setQuery(e)}
            focusedBackgroundColor={c.field()}
            cursorColor={c.accent()}
            focusedTextColor={c.text()}
            placeholder={`Search ${LABELS[tab()].toLowerCase()}…`}
          />
        </box>

        <box gap={1}>
          <Switch>
            {/* ── ATLAS ── */}
            <Match when={tab() === "atlas"}>
              <StatusLines
                empty={iris.data.atlas.length === 0}
                emptyText="No lists in this project"
                filteredEmpty={atlas().length === 0}
              />
              <Show when={activeDoc()}>
                {(doc) => (
                  <box gap={1}>
                    <text fg={c.accent()} onMouseDown={() => setActiveDoc(null)}>
                      ← Back
                    </text>
                    <text fg={c.text()} wrapMode="word">
                      <b>{doc().title}</b>
                    </text>
                    <Show when={doc().type}>
                      <text fg={c.muted()}>{doc().type}</text>
                    </Show>
                    <Show when={doc().description}>
                      <text fg={c.muted()} wrapMode="word">
                        {doc().description}
                      </text>
                    </Show>
                    <Show when={doc().content}>
                      <text fg={c.text()} wrapMode="word">
                        {doc().content}
                      </text>
                    </Show>
                    <Show when={!doc().content && !doc().description}>
                      <text fg={c.muted()}>No content</text>
                    </Show>
                  </box>
                )}
              </Show>
              <Show when={!activeDoc()}>
                <box gap={1}>
                  <For each={atlas()}>
                    {(list) => {
                      const key = `ls-${list.id}`
                      const open = () => expandedLists().has(list.id) || (!!query() && list.items.length > 0)
                      return (
                        <box>
                          <box
                            flexDirection="row"
                            gap={1}
                            {...hoverProps(key)}
                            onMouseDown={() => list.items.length > 0 && toggleList(list.id)}
                          >
                            <text fg={isHover(key) ? c.accent() : c.text()}>
                              {list.items.length === 0 ? " " : open() ? "▼" : "▶"}
                            </text>
                            <text fg={isHover(key) ? c.accent() : c.text()} wrapMode="none" truncate flexShrink={1}>
                              <b>{list.name}</b>
                            </text>
                            <text flexShrink={0} fg={c.muted()}>
                              {list.items.length}
                            </text>
                          </box>
                          <Show when={open() && list.items.length > 0}>
                            <box paddingLeft={2}>
                              <For each={list.items}>
                                {(item) => {
                                  const ik = `it-${item.id}`
                                  return (
                                    <box flexDirection="row" gap={1} {...hoverProps(ik)} onMouseDown={() => setActiveDoc(item)}>
                                      <text flexShrink={0} fg={item.status === "active" ? c.success() : c.muted()}>
                                        {item.status === "completed" ? "✓" : "·"}
                                      </text>
                                      <text fg={isHover(ik) ? c.accent() : c.text()} wrapMode="word">
                                        {item.title}
                                      </text>
                                    </box>
                                  )
                                }}
                              </For>
                            </box>
                          </Show>
                        </box>
                      )
                    }}
                  </For>
                </box>
              </Show>
            </Match>

            {/* ── AGENTS ── */}
            <Match when={tab() === "agents"}>
              <StatusLines
                empty={iris.data.agents.length === 0}
                emptyText="No agents found"
                filteredEmpty={heartbeat().length === 0 && standard().length === 0}
              />
              <box>
                <box flexDirection="row" gap={1} onMouseDown={() => setExpanded("heartbeat", !expanded.heartbeat)}>
                  <text fg={c.text()}>{expanded.heartbeat ? "▼" : "▶"}</text>
                  <text fg={c.text()}>
                    <b>Heartbeat</b>
                  </text>
                  <text fg={c.muted()}>{heartbeat().filter((a) => a.status === "active").length} active</text>
                </box>
                <Show when={expanded.heartbeat}>
                  <For each={heartbeat()}>
                    {(agent) => {
                      const key = `ha-${agent.id}`
                      return (
                        <box {...hoverProps(key)}>
                          <box flexDirection="row" gap={1}>
                            <text flexShrink={0} fg={agentColor(agent.status)}>
                              •
                            </text>
                            <text fg={isHover(key) ? c.accent() : c.text()} wrapMode="none" truncate flexGrow={1} flexShrink={1}>
                              {agent.name}
                            </text>
                            <Show when={agent.schedule}>
                              <text flexShrink={0} fg={c.muted()}>
                                {agent.schedule}
                              </text>
                            </Show>
                          </box>
                          <Show when={agent.nextRun || agent.lastRun}>
                            <text fg={c.muted()} wrapMode="word">
                              {"   "}
                              {agent.nextRun ? `next ${agent.nextRun}` : ""}
                              {agent.nextRun && agent.lastRun ? "  ·  " : ""}
                              {agent.lastRun ?? ""}
                            </text>
                          </Show>
                        </box>
                      )
                    }}
                  </For>
                </Show>
              </box>
              <box>
                <box flexDirection="row" gap={1} onMouseDown={() => setExpanded("standard", !expanded.standard)}>
                  <text fg={c.text()}>{expanded.standard ? "▼" : "▶"}</text>
                  <text fg={c.text()}>
                    <b>Agents</b>
                  </text>
                  <text fg={c.muted()}>{standard().length}</text>
                </box>
                <Show when={expanded.standard}>
                  <For each={standard()}>
                    {(agent) => {
                      const key = `sa-${agent.id}`
                      return (
                        <box flexDirection="row" gap={1} {...hoverProps(key)}>
                          <text flexShrink={0} fg={agentColor(agent.status)}>
                            •
                          </text>
                          <text fg={isHover(key) ? c.accent() : c.text()} wrapMode="none" truncate flexGrow={1} flexShrink={1}>
                            {agent.name}
                          </text>
                          <text flexShrink={0} fg={c.muted()}>
                            {agent.status}
                          </text>
                        </box>
                      )
                    }}
                  </For>
                </Show>
              </box>
            </Match>

            {/* ── HIVE ── inbox first: work someone sent YOU is what nobody was seeing. */}
            <Match when={tab() === "hive"}>
              <box>
                <box flexDirection="row" gap={1}>
                  <text fg={c.text()}>
                    <b>Inbox</b>
                  </text>
                  <Switch>
                    {/* unreadable ≠ empty: rendering it as 0 would look like a healthy inbox. */}
                    <Match when={inbox().unreadable}>
                      <text fg={c.error()}>unreadable</text>
                    </Match>
                    <Match when={(inbox().unread ?? 0) > 0}>
                      <text fg={c.warning()}>{inbox().unread} unread</text>
                    </Match>
                    <Match when={true}>
                      <text fg={c.muted()}>nothing waiting</text>
                    </Match>
                  </Switch>
                </box>
                <Show when={(inbox().unread ?? 0) > 0}>
                  <text fg={c.muted()}>
                    {"  read: iris hive inbox read "}
                    {firstUnread()}
                  </text>
                </Show>
                <Show when={inbox().items.length > 6}>
                  <text fg={c.muted()}>
                    {"  showing 6 of "}
                    {inbox().items.length}
                  </text>
                </Show>
                <For each={inbox().items.slice(0, 6)}>
                  {(item) => (
                    <box paddingLeft={2}>
                      <box flexDirection="row" gap={1}>
                        <text flexShrink={0} fg={item.read ? c.muted() : c.warning()}>
                          {item.read ? " " : "●"}
                        </text>
                        <text flexShrink={0} fg={c.muted()}>
                          {item.index}
                        </text>
                        <text fg={item.read ? c.muted() : c.text()} wrapMode="none" truncate flexGrow={1} flexShrink={1}>
                          {item.from}
                        </text>
                        <text flexShrink={0} fg={c.muted()}>
                          {item.age}
                        </text>
                      </box>
                      <text fg={c.muted()} wrapMode="word">
                        {"  "}
                        {item.label}
                      </text>
                    </box>
                  )}
                </For>
              </box>
              <box>
                <box flexDirection="row" gap={1}>
                  <text fg={c.text()}>
                    <b>Machines</b>
                  </text>
                  <Switch>
                    {/* An errored fetch must never render as "0 online". */}
                    <Match when={iris.data.hiveStatus === "loading"}>
                      <text fg={c.muted()}>checking…</text>
                    </Match>
                    <Match when={iris.data.hiveStatus === "no-auth"}>
                      <text fg={c.muted()}>not connected</text>
                    </Match>
                    <Match when={iris.data.hiveStatus === "error"}>
                      <text fg={c.error()}>unreachable</text>
                    </Match>
                    <Match when={true}>
                      <text fg={c.muted()}>
                        {iris.data.hiveNodes.filter((n) => n.online).length}/{iris.data.hiveNodes.length} online
                      </text>
                    </Match>
                  </Switch>
                </box>
                <For each={iris.data.hiveNodes}>
                  {(node) => (
                    <box paddingLeft={2}>
                      <box flexDirection="row" gap={1}>
                        <text flexShrink={0} fg={node.online ? c.success() : c.muted()}>
                          {node.online ? "●" : "○"}
                        </text>
                        <text fg={c.text()} wrapMode="none" truncate flexShrink={1}>
                          {node.name}
                        </text>
                        <Show when={node.isLocal}>
                          <text flexShrink={0} fg={c.success()}>
                            {node.localUncertain ? "(you?)" : "(you)"}
                          </text>
                        </Show>
                      </box>
                      <text fg={c.muted()} wrapMode="word">
                        {"  "}
                        {node.activeTasks}/{node.maxConcurrent} tasks
                        {node.sessions > 0 ? ` · ${node.sessions} sessions` : ""}
                        {node.lastHeartbeat ? ` · ${node.lastHeartbeat}` : " · never seen"}
                      </text>
                    </box>
                  )}
                </For>
                <Show when={iris.data.hiveStatus === "loaded" && iris.data.hiveNodes.length === 0}>
                  <text fg={c.muted()}>{"  "}no machines registered</text>
                </Show>
              </box>
              <Show when={iris.data.hivePeers.length > 0 || iris.data.hivePendingInvites > 0}>
                <box>
                  <box flexDirection="row" gap={1}>
                    <text fg={c.text()}>
                      <b>Peers</b>
                    </text>
                    <text fg={c.muted()}>{iris.data.hivePeers.filter((p) => p.active).length} active</text>
                  </box>
                  <For each={iris.data.hivePeers}>
                    {(peer) => (
                      <box paddingLeft={2} flexDirection="row" gap={1}>
                        <text flexShrink={0} fg={peer.active ? c.success() : c.muted()}>
                          {peer.active ? "●" : "○"}
                        </text>
                        <text fg={c.text()} wrapMode="none" truncate flexShrink={1}>
                          {peer.name}
                        </text>
                        <Show when={peer.permissions}>
                          <text flexShrink={0} fg={c.muted()}>
                            {peer.permissions}
                          </text>
                        </Show>
                      </box>
                    )}
                  </For>
                  <Show when={iris.data.hivePendingInvites > 0}>
                    <text fg={c.muted()}>
                      {"  "}◌ {iris.data.hivePendingInvites} invite{iris.data.hivePendingInvites === 1 ? "" : "s"} pending
                    </text>
                  </Show>
                </box>
              </Show>
            </Match>

            {/* ── CONTACTS ── */}
            <Match when={tab() === "contacts"}>
              <StatusLines
                empty={iris.data.contacts.length === 0}
                emptyText="No contacts in this project"
                filteredEmpty={contacts().length === 0}
              />
              <Show when={activeContact()}>
                {(ct) => (
                  <box gap={1}>
                    <text fg={c.accent()} onMouseDown={() => setActiveContact(null)}>
                      ← Back
                    </text>
                    <text fg={c.text()}>
                      <b>{ct().name}</b>
                    </text>
                    <Show when={ct().company}>
                      <text fg={c.muted()}>{ct().company}</text>
                    </Show>
                    <Show when={ct().email}>
                      <text fg={c.text()}>{ct().email}</text>
                    </Show>
                    <Show when={ct().phone}>
                      <text fg={c.text()}>{ct().phone}</text>
                    </Show>
                    <box>
                      <text fg={c.muted()}>Status: {ct().status ?? "None"}</text>
                      <text fg={c.muted()}>Source: {ct().source ?? "Unknown"}</text>
                      <text fg={c.muted()}>
                        Score: {ct().leadScore}
                        {ct().isHot ? " 🔥" : ""}
                      </text>
                    </box>
                  </box>
                )}
              </Show>
              <Show when={!activeContact()}>
                <box gap={1}>
                  <For each={contacts()}>
                    {(ct) => {
                      const key = `ct-${ct.id}`
                      return (
                        <box {...hoverProps(key)} onMouseDown={() => setActiveContact(ct)}>
                          <box flexDirection="row" gap={1}>
                            <text flexShrink={0} fg={ct.isHot ? c.warning() : c.success()}>
                              •
                            </text>
                            <text fg={isHover(key) ? c.accent() : c.text()} wrapMode="none" truncate flexGrow={1} flexShrink={1}>
                              {ct.name} <span style={{ fg: c.muted() }}>#{ct.id}</span>
                            </text>
                            <Show when={ct.status}>
                              <text flexShrink={0} fg={c.muted()}>
                                {ct.status}
                              </text>
                            </Show>
                          </box>
                          <Show when={ct.email || ct.company}>
                            <text fg={c.muted()} wrapMode="none" truncate>
                              {"   "}
                              {ct.company ? `${ct.company}  ·  ` : ""}
                              {ct.email ?? ""}
                            </text>
                          </Show>
                        </box>
                      )
                    }}
                  </For>
                </box>
              </Show>
            </Match>

            {/* ── PLAYBOOKS ── two sections, never a fallback: scope belongs on every row. */}
            <Match when={tab() === "playbooks"}>
              <StatusLines
                empty={iris.data.playbooks.length === 0}
                emptyText="No playbooks found"
                filteredEmpty={playbooks().length === 0}
              />
              <Show when={attached().length > 0}>
                <box gap={1}>
                  <box flexDirection="row" gap={1}>
                    <text fg={c.text()}>
                      <b>This project</b>
                    </text>
                    <text fg={c.muted()}>{attached().length}</text>
                  </box>
                  <For each={attached()}>{playbookRow}</For>
                </box>
              </Show>
              <Show when={others().length > 0}>
                <box gap={1}>
                  <box flexDirection="row" gap={1}>
                    <text fg={c.text()}>
                      <b>All playbooks</b>
                    </text>
                    <text fg={c.muted()}>{others().length}</text>
                  </box>
                  <Show when={attached().length === 0}>
                    <text fg={c.muted()}>none attached to this project</text>
                  </Show>
                  <For each={others()}>{playbookRow}</For>
                </box>
              </Show>
            </Match>

            {/* ── PAGES ── */}
            <Match when={tab() === "pages"}>
              <StatusLines
                empty={iris.data.pages.length === 0}
                emptyText="No pages in this project"
                filteredEmpty={pages().length === 0}
              />
              <box gap={1}>
                <For each={pages()}>
                  {(page) => {
                    const key = `pg-${page.id}`
                    return (
                      <box {...hoverProps(key)}>
                        <box flexDirection="row" gap={1}>
                          <text flexShrink={0} fg={page.status === "published" ? c.success() : c.muted()}>
                            {page.status === "published" ? "●" : "○"}
                          </text>
                          <text fg={isHover(key) ? c.accent() : c.text()} wrapMode="word">
                            {page.title}
                          </text>
                        </box>
                        <text fg={c.muted()} wrapMode="none" truncate>
                          {"   "}/{page.slug} · v{page.version} · {page.updatedAt}
                        </text>
                      </box>
                    )
                  }}
                </For>
              </box>
            </Match>
          </Switch>
        </box>
      </Show>
    </box>
  )
}

/** `✉ N Hive` beside the prompt — v1 put it in the session footer. Silent at zero on purpose:
 *  a badge that is always present stops being read. Unreadable is shown, never as 0. */
function HiveBadge(props: { context: Plugin.Context }) {
  const t = props.context.theme
  const inbox = useHiveInbox()
  return (
    <Switch>
      <Match when={inbox().unreadable}>
        <text flexShrink={0} fg={t.text.feedback.error.base}>
          ✉ Hive inbox unreadable
        </text>
      </Match>
      <Match when={(inbox().unread ?? 0) > 0}>
        <text flexShrink={0} fg={t.text.feedback.warning.base}>
          ✉ {inbox().unread} Hive<span style={{ fg: t.text.muted }}> · hive inbox read</span>
        </text>
      </Match>
    </Switch>
  )
}

/** v1's sidebar footer brand line. v2's footer still renders the directory above it. */
function IrisFooter(props: { context: Plugin.Context }) {
  const t = props.context.theme
  return (
    <text fg={t.text.muted}>
      <span style={{ fg: t.text.feedback.success.base }}>•</span> <b>IRIS</b>
      <span style={{ fg: t.text.base }}>
        <b> CLI</b>
      </span>{" "}
      <span>{props.context.app.version}</span>
    </text>
  )
}

/**
 * v2's sidebar shows a "Getting started — OpenCode includes free models / Connect provider" card
 * until a provider is CONNECTED. The IRIS provider comes from config, not a connection, so the
 * card never goes away and tells IRIS users to connect a provider they do not need. Mark it
 * dismissed once, in the file v2's own storage reads (state/<app>/<channel>/tui/), and never
 * overwrite a choice already recorded.
 */
function dismissOpenCodeOnboarding(channel: string) {
  try {
    const state = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state")
    const dir = path.join(state, "iris", channel || "iris", "tui")
    const file = path.join(dir, "plugin.opencode.sidebar.footer.getting-started.json")
    if (existsSync(file)) return
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, JSON.stringify({ dismissed: true }))
  } catch {
    // Cosmetic only — never block the TUI over it.
  }
}

export default Plugin.define({
  id: "iris.sidebar",
  setup(context) {
    dismissOpenCodeOnboarding(context.app.channel)
    context.ui.slot({
      prepend: "sidebar.content",
      render: (props) => <IrisSidebar context={context} sessionID={props.sessionID} />,
    })
    context.ui.slot({ append: "sidebar.footer", render: () => <IrisFooter context={context} /> })
    context.ui.slot({ append: "prompt.footer.status", render: () => <HiveBadge context={context} /> })
  },
})
