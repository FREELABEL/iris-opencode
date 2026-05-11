import { useSync } from "@tui/context/sync"
import { createMemo, createSignal, For, Show, Switch, Match } from "solid-js"
import { createStore } from "solid-js/store"
import { useTheme } from "../../context/theme"
import { Locale } from "@/util/locale"
import path from "path"
import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import { Installation } from "@/installation"
import { useDirectory } from "../../context/directory"
import { useKV } from "../../context/kv"
import { TodoItem } from "../../component/todo-item"
import { useIrisData } from "../../iris/api"
import type { IrisAgent, IrisWorkflow, IrisWorkflowDetail, AtlasItem, IrisContact, IrisPage } from "../../iris/types"

type SidebarTab = "agents" | "workflows" | "contacts" | "pages" | "atlas" | "session"

const TAB_LABELS: Record<SidebarTab, string> = {
  agents: "Agents",
  workflows: "Flows",
  contacts: "Contacts",
  pages: "Pages",
  atlas: "Atlas",
  session: "Sess",
}

const TABS: SidebarTab[] = ["atlas", "agents", "contacts", "workflows", "pages", "session"]

export function Sidebar(props: { sessionID: string }) {
  const sync = useSync()
  const { theme } = useTheme()
  const session = createMemo(() => sync.session.get(props.sessionID)!)
  const diff = createMemo(() => sync.data.session_diff[props.sessionID] ?? [])
  const todo = createMemo(() => sync.data.todo[props.sessionID] ?? [])
  const messages = createMemo(() => sync.data.message[props.sessionID] ?? [])

  const [activeTab, setActiveTab] = createSignal<SidebarTab>("atlas")
  const iris = useIrisData()
  const [bloqPickerOpen, setBloqPickerOpen] = createSignal(false)
  const [expandedLists, setExpandedLists] = createSignal<Set<number>>(new Set())
  const [activeDoc, setActiveDoc] = createSignal<AtlasItem | null>(null)
  const [hoveredItemId, setHoveredItemId] = createSignal<number | null>(null)
  const [hoveredBloqId, setHoveredBloqId] = createSignal<number | null>(null)
  const [hoveredListId, setHoveredListId] = createSignal<number | null>(null)
  const [hoveredRowId, setHoveredRowId] = createSignal<string | null>(null)
  const [searchQuery, setSearchQuery] = createSignal("")
  let searchInput: any

  const matchesSearch = (text: string) => {
    const q = searchQuery().toLowerCase()
    if (!q) return true
    return text.toLowerCase().includes(q)
  }

  const toggleList = (listId: number) => {
    setExpandedLists((prev) => {
      const next = new Set(prev)
      if (next.has(listId)) next.delete(listId)
      else next.add(listId)
      return next
    })
  }

  // Wrap selectBloq to also reset sidebar state
  const handleSelectBloq = (bloqId: number) => {
    iris.selectBloq(bloqId)
    setExpandedLists(new Set<number>())
    setActiveDoc(null)
    setActiveContact(null)
    setActiveWorkflow(null)
    setWorkflowImported(false)
  }

  const selectedBloqName = createMemo(() => {
    const id = iris.data.selectedBloqId
    return iris.data.bloqList.find((b) => b.id === id)?.name ?? "Select BLOQ..."
  })

  const [expanded, setExpanded] = createStore({
    heartbeat: true,
    standard: false,
    diff: true,
    todo: true,
  })

  const heartbeatAgents = createMemo(() =>
    iris.data.agents.filter((a) => a.type === "heartbeat" && matchesSearch(a.name))
  )
  const standardAgents = createMemo(() =>
    iris.data.agents.filter((a) => a.type === "standard" && matchesSearch(a.name))
  )
  const filteredWorkflows = createMemo(() =>
    iris.data.workflows.filter((w) => matchesSearch(w.name))
  )
  const filteredAtlas = createMemo(() => {
    const q = searchQuery().toLowerCase()
    if (!q) return iris.data.atlas
    return iris.data.atlas
      .map((list) => ({
        ...list,
        items: list.items.filter((i) => i.title.toLowerCase().includes(q)),
      }))
      .filter((list) => list.name.toLowerCase().includes(q) || list.items.length > 0)
  })
  const filteredContacts = createMemo(() =>
    iris.data.contacts.filter((c) => matchesSearch(c.name) || matchesSearch(c.email ?? "") || matchesSearch(c.company ?? ""))
  )
  const filteredPages = createMemo(() =>
    iris.data.pages.filter((p) => matchesSearch(p.title) || matchesSearch(p.slug))
  )
  const filteredBloqs = createMemo(() =>
    iris.data.bloqList.filter((b) => matchesSearch(b.name))
  )
  const [activeContact, setActiveContact] = createSignal<IrisContact | null>(null)
  const [activeWorkflow, setActiveWorkflow] = createSignal<IrisWorkflowDetail | null>(null)
  const [workflowLoading, setWorkflowLoading] = createSignal(false)
  const [workflowImported, setWorkflowImported] = createSignal(false)
  const cost = createMemo(() => {
    const total = messages().reduce((sum, x) => sum + (x.role === "assistant" ? x.cost : 0), 0)
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(total)
  })

  const context = createMemo(() => {
    const last = messages().findLast((x) => x.role === "assistant" && x.tokens.output > 0) as AssistantMessage
    if (!last) return
    const total =
      last.tokens.input + last.tokens.output + last.tokens.reasoning + last.tokens.cache.read + last.tokens.cache.write
    const model = sync.data.provider.find((x) => x.id === last.providerID)?.models[last.modelID]
    return {
      tokens: total.toLocaleString(),
      percentage: model?.limit.context ? Math.round((total / model.limit.context) * 100) : null,
    }
  })

  const directory = useDirectory()
  const kv = useKV()

  const agentColor = (status: IrisAgent["status"]) =>
    ({ active: theme.success, idle: theme.textMuted, paused: theme.warning, error: theme.error })[status] ??
    theme.textMuted

  const workflowIcon = (status: IrisWorkflow["status"]) =>
    ({ idle: "○", running: "◎", success: "✓", error: "✗" })[status] ?? "○"

  const workflowColor = (status: IrisWorkflow["status"]) =>
    ({ idle: theme.textMuted, running: theme.info, success: theme.success, error: theme.error })[status] ??
    theme.textMuted

  return (
    <Show when={session()}>
      <box
        backgroundColor={theme.backgroundPanel}
        width={80}
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={2}
      >
        {/* IRIS brand header + bloq selector */}
        <box flexShrink={0} paddingBottom={1}>
          <text fg={theme.accent}>
            <b>◈ IRIS</b>
          </text>
          <Show when={iris.data.bloqList.length > 0}>
            <box
              onMouseDown={() => {
                setBloqPickerOpen(!bloqPickerOpen())
                if (!bloqPickerOpen()) {
                  setTimeout(() => searchInput?.focus(), 10)
                }
              }}
              flexDirection="row"
              gap={1}
            >
              <text fg={theme.accent}>◈</text>
              <text fg={theme.text}>{selectedBloqName()}</text>
              <Show when={iris.data.selectedBloqId}>
                <text fg={theme.textMuted}> #{iris.data.selectedBloqId}</text>
              </Show>
              <text fg={theme.textMuted}>{bloqPickerOpen() ? "▲" : "▼"}</text>
            </box>
            <Show when={bloqPickerOpen()}>
              <box paddingLeft={2}>
                <For each={filteredBloqs()}>
                  {(bloq) => {
                    const isSelected = () => bloq.id === iris.data.selectedBloqId
                    const isHovered = () => hoveredBloqId() === bloq.id
                    return (
                      <box
                        backgroundColor={isHovered() ? theme.backgroundElement : undefined}
                        onMouseOver={() => setHoveredBloqId(bloq.id)}
                        onMouseOut={() => hoveredBloqId() === bloq.id && setHoveredBloqId(null)}
                        onMouseDown={() => {
                          handleSelectBloq(bloq.id)
                          setBloqPickerOpen(false)
                        }}
                      >
                        <text fg={isSelected() || isHovered() ? theme.accent : theme.textMuted}>
                          {isSelected() ? "● " : "○ "}{bloq.name}
                        </text>
                      </box>
                    )
                  }}
                </For>
              </box>
            </Show>
          </Show>
          <Show when={iris.data.bloqList.length === 0 && iris.data.status === "loaded"}>
            <text fg={theme.textMuted}>No projects</text>
          </Show>
        </box>

        {/* Tab bar */}
        <box flexShrink={0} flexDirection="row" gap={2} paddingBottom={1}>
          <For each={TABS}>
            {(tab) => (
              <text
                fg={activeTab() === tab ? theme.accent : theme.textMuted}
                onMouseDown={() => {
                  setActiveTab(tab)
                  setSearchQuery("")
                }}
              >
                {activeTab() === tab ? `[${TAB_LABELS[tab]}]` : TAB_LABELS[tab]}
              </text>
            )}
          </For>
        </box>

        {/* Search */}
        <Show when={activeTab() !== "session"}>
          <box
            flexShrink={0}
            paddingBottom={2}
            onMouseDown={() => { searchInput?.focus() }}
          >
            <input
              ref={(r) => { searchInput = r }}
              onInput={(e) => { setSearchQuery(e) }}
              focusedBackgroundColor={theme.backgroundElement}
              cursorColor={theme.accent}
              focusedTextColor={theme.text}
              placeholder={`Search ${TAB_LABELS[activeTab()].toLowerCase()}...`}
            />
          </box>
        </Show>

        {/* Tab content */}
        <scrollbox flexGrow={1}>
          <box flexShrink={0} gap={1} paddingRight={1}>
            <Switch>
              {/* ── AGENTS ── */}
              <Match when={activeTab() === "agents"}>
                <Show when={iris.data.status === "loading"}>
                  <text fg={theme.textMuted}>Loading...</text>
                </Show>
                <Show when={iris.data.status === "no-auth" || iris.data.status === "error"}>
                  <box gap={1}>
                    <text fg={theme.textMuted}>Not connected</text>
                    <text fg={theme.textMuted}>Run: iris auth login</text>
                  </box>
                </Show>
                <Show when={iris.data.status === "loaded" && iris.data.agents.length === 0}>
                  <text fg={theme.textMuted}>No agents found</text>
                </Show>
                <Show when={searchQuery() && heartbeatAgents().length === 0 && standardAgents().length === 0}>
                  <text fg={theme.textMuted}>No matches for "{searchQuery()}"</text>
                </Show>
                <box gap={1}>
                  {/* Heartbeat agents */}
                  <box>
                    <box
                      flexDirection="row"
                      gap={1}
                      onMouseDown={() => setExpanded("heartbeat", !expanded.heartbeat)}
                    >
                      <text fg={theme.text}>{expanded.heartbeat ? "▼" : "▶"}</text>
                      <text fg={theme.text}>
                        <b>Heartbeat</b>
                      </text>
                      <text fg={theme.textMuted}>
                        {heartbeatAgents().filter((a) => a.status === "active").length} active
                      </text>
                    </box>
                    <Show when={expanded.heartbeat}>
                      <For each={heartbeatAgents()}>
                        {(agent) => {
                          const key = `ha-${agent.id}`
                          const hovered = () => hoveredRowId() === key
                          return (
                            <box
                              backgroundColor={hovered() ? theme.backgroundElement : undefined}
                              onMouseOver={() => setHoveredRowId(key)}
                              onMouseOut={() => hoveredRowId() === key && setHoveredRowId(null)}
                            >
                              <box flexDirection="row" justifyContent="space-between">
                                <box flexDirection="row" gap={1}>
                                  <text flexShrink={0} fg={agentColor(agent.status)}>
                                    •
                                  </text>
                                  <text fg={hovered() ? theme.accent : theme.text}>{agent.name}</text>
                                </box>
                                <Show when={agent.schedule}>
                                  <text fg={theme.textMuted}>{agent.schedule}</text>
                                </Show>
                              </box>
                              <Show when={agent.nextRun || agent.lastRun}>
                                <text fg={theme.textMuted}>
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

                  {/* Standard agents */}
                  <box>
                    <box
                      flexDirection="row"
                      gap={1}
                      onMouseDown={() => setExpanded("standard", !expanded.standard)}
                    >
                      <text fg={theme.text}>{expanded.standard ? "▼" : "▶"}</text>
                      <text fg={theme.text}>
                        <b>Agents</b>
                      </text>
                    </box>
                    <Show when={expanded.standard}>
                      <For each={standardAgents()}>
                        {(agent) => {
                          const key = `sa-${agent.id}`
                          const hovered = () => hoveredRowId() === key
                          return (
                            <box
                              flexDirection="row"
                              justifyContent="space-between"
                              backgroundColor={hovered() ? theme.backgroundElement : undefined}
                              onMouseOver={() => setHoveredRowId(key)}
                              onMouseOut={() => hoveredRowId() === key && setHoveredRowId(null)}
                            >
                              <box flexDirection="row" gap={1}>
                                <text flexShrink={0} fg={agentColor(agent.status)}>
                                  •
                                </text>
                                <text fg={hovered() ? theme.accent : theme.text}>{agent.name}</text>
                              </box>
                              <text fg={theme.textMuted}>{agent.status}</text>
                            </box>
                          )
                        }}
                      </For>
                    </Show>
                  </box>
                </box>
              </Match>

              {/* ── WORKFLOWS ── */}
              <Match when={activeTab() === "workflows"}>
                <Show when={iris.data.status === "loading"}>
                  <text fg={theme.textMuted}>Loading...</text>
                </Show>
                <Show when={iris.data.status === "no-auth" || iris.data.status === "error"}>
                  <box gap={1}>
                    <text fg={theme.textMuted}>Not connected</text>
                    <text fg={theme.textMuted}>Run: iris auth login</text>
                  </box>
                </Show>
                <Show when={iris.data.status === "loaded" && iris.data.workflows.length === 0}>
                  <text fg={theme.textMuted}>No workflows found</text>
                </Show>
                <Show when={searchQuery() && filteredWorkflows().length === 0 && iris.data.workflows.length > 0}>
                  <text fg={theme.textMuted}>No matches for "{searchQuery()}"</text>
                </Show>

                {/* Workflow detail view */}
                <Show when={activeWorkflow()}>
                  {(wf) => (
                    <box gap={1}>
                      <text fg={theme.accent} onMouseDown={() => { setActiveWorkflow(null); setWorkflowImported(false) }}>
                        ← Back
                      </text>
                      <text fg={theme.text}>
                        <b>{wf().name}</b> <span style={{ fg: theme.textMuted }}>#{wf().id}</span>
                      </text>
                      <Show when={wf().description}>
                        <text fg={theme.textMuted} wrapMode="word">{wf().description}</text>
                      </Show>
                      <box paddingTop={1} gap={1}>
                        <Show when={wf().execution_mode}>
                          <text fg={theme.textMuted}>Mode: {wf().execution_mode}</text>
                        </Show>
                        <Show when={wf().category}>
                          <text fg={theme.textMuted}>Category: {wf().category}</text>
                        </Show>
                        <text fg={theme.textMuted}>
                          Status: {wf().status} · {wf().triggerCount} runs
                          {wf().lastRun ? ` · last ${wf().lastRun}` : ""}
                        </text>
                        <Show when={wf().steps?.length}>
                          <text fg={theme.text}>{wf().steps!.length} steps</text>
                        </Show>
                        <Show when={wf().allowed_tools?.length}>
                          <text fg={theme.textMuted}>Tools: {wf().allowed_tools!.join(", ")}</text>
                        </Show>
                        <Show when={wf().dependencies?.length}>
                          <text fg={theme.textMuted}>Deps: {wf().dependencies!.join(", ")}</text>
                        </Show>
                        <Show when={wf().require_human_approval}>
                          <text fg={theme.warning}>Requires human approval</text>
                        </Show>
                        <Show when={wf().max_iterations}>
                          <text fg={theme.textMuted}>Max iterations: {wf().max_iterations}</text>
                        </Show>
                      </box>

                      {/* Import button */}
                      <box paddingTop={1}>
                        <Show when={!workflowImported()} fallback={
                          <text fg={theme.success}>✓ Imported to context</text>
                        }>
                          <box
                            backgroundColor={theme.accent}
                            paddingLeft={2}
                            paddingRight={2}
                            onMouseDown={() => {
                              iris.importWorkflowToContext(wf())
                              setWorkflowImported(true)
                            }}
                          >
                            <text fg={theme.backgroundPanel}>
                              <b>▶ Import Schema</b>
                            </text>
                          </box>
                        </Show>
                        <text fg={theme.textMuted}>
                          Loads workflow steps + schema into agent context
                        </text>
                      </box>
                    </box>
                  )}
                </Show>

                {/* Workflow list */}
                <Show when={!activeWorkflow()}>
                  <Show when={workflowLoading()}>
                    <text fg={theme.textMuted}>Loading workflow...</text>
                  </Show>
                  <box gap={1}>
                    <For each={filteredWorkflows()}>
                      {(wf) => {
                        const key = `wf-${wf.id}`
                        const hovered = () => hoveredRowId() === key
                        return (
                          <box
                            backgroundColor={hovered() ? theme.backgroundElement : undefined}
                            onMouseOver={() => setHoveredRowId(key)}
                            onMouseOut={() => hoveredRowId() === key && setHoveredRowId(null)}
                            onMouseDown={async () => {
                              setWorkflowLoading(true)
                              setWorkflowImported(false)
                              const detail = await iris.fetchWorkflowDetail(wf.id)
                              setWorkflowLoading(false)
                              if (detail) setActiveWorkflow(detail)
                            }}
                          >
                            <box flexDirection="row" gap={1}>
                              <text flexShrink={0} fg={workflowColor(wf.status)}>
                                {workflowIcon(wf.status)}
                              </text>
                              <text fg={hovered() ? theme.accent : theme.text} wrapMode="word">
                                {wf.name}
                              </text>
                            </box>
                            <text fg={theme.textMuted}>
                              {"   "}
                              {wf.status === "running" ? "running now" : wf.lastRun ? `last ran ${wf.lastRun}` : "never ran"}
                              {wf.triggerCount > 0 ? `  ·  ${wf.triggerCount} runs` : ""}
                            </text>
                          </box>
                        )
                      }}
                    </For>
                  </box>
                </Show>
              </Match>

              {/* ── CONTACTS ── */}
              <Match when={activeTab() === "contacts"}>
                <Show when={iris.data.status === "loading"}>
                  <text fg={theme.textMuted}>Loading...</text>
                </Show>
                <Show when={iris.data.status === "no-auth" || iris.data.status === "error"}>
                  <box gap={1}>
                    <text fg={theme.textMuted}>Not connected</text>
                    <text fg={theme.textMuted}>Run: iris auth login</text>
                  </box>
                </Show>
                <Show when={iris.data.status === "loaded" && iris.data.contacts.length === 0}>
                  <text fg={theme.textMuted}>No contacts in this project</text>
                </Show>
                <Show when={searchQuery() && filteredContacts().length === 0 && iris.data.contacts.length > 0}>
                  <text fg={theme.textMuted}>No matches for "{searchQuery()}"</text>
                </Show>

                {/* Contact detail view */}
                <Show when={activeContact()}>
                  {(contact) => (
                    <box gap={1}>
                      <text fg={theme.accent} onMouseDown={() => setActiveContact(null)}>
                        ← Back
                      </text>
                      <text fg={theme.text}>
                        <b>{contact().name}</b>
                      </text>
                      <Show when={contact().company}>
                        <text fg={theme.textMuted}>{contact().company}</text>
                      </Show>
                      <Show when={contact().email}>
                        <text fg={theme.text}>{contact().email}</text>
                      </Show>
                      <Show when={contact().phone}>
                        <text fg={theme.text}>{contact().phone}</text>
                      </Show>
                      <box paddingTop={1}>
                        <text fg={theme.textMuted}>Status: {contact().status ?? "None"}</text>
                        <text fg={theme.textMuted}>Source: {contact().source ?? "Unknown"}</text>
                        <text fg={theme.textMuted}>Score: {contact().leadScore}{contact().isHot ? " 🔥" : ""}</text>
                      </box>
                    </box>
                  )}
                </Show>

                {/* Contact list */}
                <Show when={!activeContact()}>
                  <box gap={1}>
                    <For each={filteredContacts()}>
                      {(contact) => {
                        const key = `ct-${contact.id}`
                        const hovered = () => hoveredRowId() === key
                        return (
                          <box
                            backgroundColor={hovered() ? theme.backgroundElement : undefined}
                            onMouseOver={() => setHoveredRowId(key)}
                            onMouseOut={() => hoveredRowId() === key && setHoveredRowId(null)}
                            onMouseDown={() => setActiveContact(contact)}
                          >
                            <box flexDirection="row" gap={1}>
                              <text flexShrink={0} fg={contact.isHot ? theme.warning : theme.success}>
                                •
                              </text>
                              <text fg={hovered() ? theme.accent : theme.text}>{contact.name} <span style={{ fg: theme.textMuted }}>#{contact.id}</span></text>
                              <Show when={contact.status}>
                                <text flexShrink={0} fg={theme.textMuted}>{contact.status}</text>
                              </Show>
                            </box>
                            <Show when={contact.email || contact.company}>
                              <text fg={theme.textMuted}>
                                {"   "}
                                {contact.company ? `${contact.company}  ·  ` : ""}
                                {contact.email ?? ""}
                              </text>
                            </Show>
                          </box>
                        )
                      }}
                    </For>
                  </box>
                </Show>
              </Match>

              {/* ── PAGES ── */}
              <Match when={activeTab() === "pages"}>
                <Show when={iris.data.pages.length === 0 && iris.data.status === "loaded"}>
                  <text fg={theme.textMuted}>No pages found</text>
                </Show>
                <Show when={searchQuery() && filteredPages().length === 0 && iris.data.pages.length > 0}>
                  <text fg={theme.textMuted}>No matches for "{searchQuery()}"</text>
                </Show>
                <box gap={1}>
                  <For each={filteredPages()}>
                    {(page) => {
                      const key = `pg-${page.id}`
                      const hovered = () => hoveredRowId() === key
                      const statusColor = () =>
                        page.status === "published" ? theme.success : theme.textMuted
                      return (
                        <box
                          backgroundColor={hovered() ? theme.backgroundElement : undefined}
                          onMouseOver={() => setHoveredRowId(key)}
                          onMouseOut={() => hoveredRowId() === key && setHoveredRowId(null)}
                        >
                          <box flexDirection="row" gap={1}>
                            <text flexShrink={0} fg={statusColor()}>
                              {page.status === "published" ? "●" : "○"}
                            </text>
                            <text fg={hovered() ? theme.accent : theme.text} wrapMode="word">
                              {page.title}
                            </text>
                          </box>
                          <text fg={theme.textMuted}>
                            {"   "}
                            /{page.slug}  ·  v{page.version}  ·  {page.updatedAt}
                          </text>
                        </box>
                      )
                    }}
                  </For>
                </box>
              </Match>

              {/* ── ATLAS (lists + items for selected bloq) ── */}
              <Match when={activeTab() === "atlas"}>
                <Show when={iris.data.status === "loading"}>
                  <text fg={theme.textMuted}>Loading...</text>
                </Show>
                <Show when={iris.data.status === "no-auth" || iris.data.status === "error"}>
                  <box gap={1}>
                    <text fg={theme.textMuted}>Not connected</text>
                    <text fg={theme.textMuted}>Run: iris auth login</text>
                  </box>
                </Show>
                <Show when={iris.data.status === "loaded" && iris.data.atlas.length === 0}>
                  <text fg={theme.textMuted}>No lists in this project</text>
                </Show>
                <Show when={searchQuery() && filteredAtlas().length === 0 && iris.data.atlas.length > 0}>
                  <text fg={theme.textMuted}>No matches for "{searchQuery()}"</text>
                </Show>

                {/* Document view — shown when an item is clicked */}
                <Show when={activeDoc()}>
                  {(doc) => (
                    <box gap={1}>
                      <box flexDirection="row" gap={1}>
                        <text fg={theme.accent} onMouseDown={() => setActiveDoc(null)}>
                          ← Back
                        </text>
                      </box>
                      <text fg={theme.text}>
                        <b>{doc().title}</b>
                      </text>
                      <Show when={doc().type}>
                        <text fg={theme.textMuted}>{doc().type}</text>
                      </Show>
                      <Show when={doc().description}>
                        <box paddingTop={1}>
                          <text fg={theme.textMuted} wrapMode="word">{doc().description}</text>
                        </box>
                      </Show>
                      <Show when={doc().content}>
                        <box paddingTop={1}>
                          <text fg={theme.text} wrapMode="word">{doc().content}</text>
                        </box>
                      </Show>
                      <Show when={!doc().content && !doc().description}>
                        <text fg={theme.textMuted}>No content</text>
                      </Show>
                    </box>
                  )}
                </Show>

                {/* List view — default */}
                <Show when={!activeDoc()}>
                  <box gap={1}>
                    <For each={filteredAtlas()}>
                      {(list) => {
                        const isOpen = () => expandedLists().has(list.id)
                        return (
                          <box>
                            <box
                              flexDirection="row"
                              gap={1}
                              backgroundColor={hoveredListId() === list.id ? theme.backgroundElement : undefined}
                              onMouseOver={() => list.items.length > 0 && setHoveredListId(list.id)}
                              onMouseOut={() => hoveredListId() === list.id && setHoveredListId(null)}
                              onMouseDown={() => list.items.length > 0 && toggleList(list.id)}
                            >
                              <text fg={hoveredListId() === list.id ? theme.accent : theme.text}>
                                {list.items.length === 0 ? " " : isOpen() ? "▼" : "▶"}
                              </text>
                              <text fg={hoveredListId() === list.id ? theme.accent : theme.text}>
                                <b>{list.name}</b>
                              </text>
                              <text fg={theme.textMuted}>{list.items.length}</text>
                            </box>
                            <Show when={isOpen() && list.items.length > 0}>
                              <box paddingLeft={2}>
                                <For each={list.items}>
                                  {(item) => (
                                    <box
                                      flexDirection="row"
                                      gap={1}
                                      backgroundColor={hoveredItemId() === item.id ? theme.backgroundElement : undefined}
                                      onMouseOver={() => setHoveredItemId(item.id)}
                                      onMouseOut={() => hoveredItemId() === item.id && setHoveredItemId(null)}
                                      onMouseDown={() => setActiveDoc(item)}
                                    >
                                      <text flexShrink={0} fg={item.status === "active" ? theme.success : theme.textMuted}>
                                        {item.status === "completed" ? "✓" : "·"}
                                      </text>
                                      <text fg={hoveredItemId() === item.id ? theme.accent : theme.text} wrapMode="word">{item.title}</text>
                                      <Show when={item.type}>
                                        <text flexShrink={0} fg={theme.textMuted}>{item.type}</text>
                                      </Show>
                                    </box>
                                  )}
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

              {/* ── SESSION ── */}
              <Match when={activeTab() === "session"}>
                <box gap={1}>
                  <box>
                    <text fg={theme.text}>
                      <b>Context</b>
                    </text>
                    <text fg={theme.textMuted}>{context()?.tokens ?? 0} tokens</text>
                    <text fg={theme.textMuted}>{context()?.percentage ?? 0}% used</text>
                    <text fg={theme.textMuted}>{cost()} spent</text>
                  </box>
                  <Show when={todo().length > 0 && todo().some((t) => t.status !== "completed")}>
                    <box>
                      <box
                        flexDirection="row"
                        gap={1}
                        onMouseDown={() => todo().length > 2 && setExpanded("todo", !expanded.todo)}
                      >
                        <Show when={todo().length > 2}>
                          <text fg={theme.text}>{expanded.todo ? "▼" : "▶"}</text>
                        </Show>
                        <text fg={theme.text}>
                          <b>Todo</b>
                        </text>
                      </box>
                      <Show when={todo().length <= 2 || expanded.todo}>
                        <For each={todo()}>
                          {(item) => <TodoItem status={item.status} content={item.content} />}
                        </For>
                      </Show>
                    </box>
                  </Show>
                  <Show when={diff().length > 0}>
                    <box>
                      <box
                        flexDirection="row"
                        gap={1}
                        onMouseDown={() => diff().length > 2 && setExpanded("diff", !expanded.diff)}
                      >
                        <Show when={diff().length > 2}>
                          <text fg={theme.text}>{expanded.diff ? "▼" : "▶"}</text>
                        </Show>
                        <text fg={theme.text}>
                          <b>Modified Files</b>
                        </text>
                      </box>
                      <Show when={diff().length <= 2 || expanded.diff}>
                        <For each={diff() || []}>
                          {(item) => {
                            const file = createMemo(() => {
                              const splits = item.file.split(path.sep).filter(Boolean)
                              const last = splits.at(-1)!
                              const rest = splits.slice(0, -1).join(path.sep)
                              if (!rest) return last
                              return Locale.truncateMiddle(rest, 30 - last.length) + "/" + last
                            })
                            return (
                              <box flexDirection="row" gap={1} justifyContent="space-between">
                                <text fg={theme.textMuted} wrapMode="char">
                                  {file()}
                                </text>
                                <box flexDirection="row" gap={1} flexShrink={0}>
                                  <Show when={item.additions}>
                                    <text fg={theme.diffAdded}>+{item.additions}</text>
                                  </Show>
                                  <Show when={item.deletions}>
                                    <text fg={theme.diffRemoved}>-{item.deletions}</text>
                                  </Show>
                                </box>
                              </box>
                            )
                          }}
                        </For>
                      </Show>
                    </box>
                  </Show>
                </box>
              </Match>
            </Switch>
          </box>
        </scrollbox>

        {/* Footer */}
        <box flexShrink={0} gap={1} paddingTop={1}>
          <text>
            <span style={{ fg: theme.textMuted }}>{directory().split("/").slice(0, -1).join("/")}/</span>
            <span style={{ fg: theme.text }}>{directory().split("/").at(-1)}</span>
          </text>
          <text fg={theme.textMuted}>
            <span style={{ fg: theme.success }}>•</span> <b>IRIS</b>
            <span style={{ fg: theme.text }}>
              <b> CLI</b>
            </span>{" "}
            <span>{Installation.VERSION}</span>
          </text>
        </box>
      </box>
    </Show>
  )
}
