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
import { MOCK_AGENTS, MOCK_WORKFLOWS, MOCK_BLOCS } from "../../iris/mock"
import type { IrisAgent, IrisWorkflow } from "../../iris/mock"

type SidebarTab = "agents" | "workflows" | "blocs" | "session"

const TAB_LABELS: Record<SidebarTab, string> = {
  agents: "Agents",
  workflows: "Flows",
  blocs: "BLOQs",
  session: "Sess",
}

const TABS: SidebarTab[] = ["agents", "workflows", "blocs", "session"]

export function Sidebar(props: { sessionID: string }) {
  const sync = useSync()
  const { theme } = useTheme()
  const session = createMemo(() => sync.session.get(props.sessionID)!)
  const diff = createMemo(() => sync.data.session_diff[props.sessionID] ?? [])
  const todo = createMemo(() => sync.data.todo[props.sessionID] ?? [])
  const messages = createMemo(() => sync.data.message[props.sessionID] ?? [])

  const [activeTab, setActiveTab] = createSignal<SidebarTab>("agents")

  const [expanded, setExpanded] = createStore({
    heartbeat: true,
    standard: false,
    diff: true,
    todo: true,
  })

  const heartbeatAgents = createMemo(() => MOCK_AGENTS.filter((a) => a.type === "heartbeat"))
  const standardAgents = createMemo(() => MOCK_AGENTS.filter((a) => a.type === "standard"))
  const activeBlocs = createMemo(() => MOCK_BLOCS.filter((b) => b.status === "active"))
  const archivedBlocs = createMemo(() => MOCK_BLOCS.filter((b) => b.status === "archived"))

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

  const fmtMsgs = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`)

  return (
    <Show when={session()}>
      <box
        backgroundColor={theme.backgroundPanel}
        width={42}
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={2}
      >
        {/* IRIS brand header */}
        <box flexShrink={0} paddingBottom={1}>
          <text fg={theme.accent}>
            <b>◈ IRIS</b>
          </text>
          <text fg={theme.textMuted}>{session().title}</text>
        </box>

        {/* Tab bar */}
        <box flexShrink={0} flexDirection="row" gap={2} paddingBottom={1}>
          <For each={TABS}>
            {(tab) => (
              <text
                fg={activeTab() === tab ? theme.accent : theme.textMuted}
                onMouseDown={() => setActiveTab(tab)}
              >
                {activeTab() === tab ? `[${TAB_LABELS[tab]}]` : TAB_LABELS[tab]}
              </text>
            )}
          </For>
        </box>

        {/* Tab content */}
        <scrollbox flexGrow={1}>
          <box flexShrink={0} gap={1} paddingRight={1}>
            <Switch>
              {/* ── AGENTS ── */}
              <Match when={activeTab() === "agents"}>
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
                        {(agent) => (
                          <box>
                            <box flexDirection="row" justifyContent="space-between">
                              <box flexDirection="row" gap={1}>
                                <text flexShrink={0} fg={agentColor(agent.status)}>
                                  •
                                </text>
                                <text fg={theme.text}>{agent.name}</text>
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
                        )}
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
                        {(agent) => (
                          <box flexDirection="row" justifyContent="space-between">
                            <box flexDirection="row" gap={1}>
                              <text flexShrink={0} fg={agentColor(agent.status)}>
                                •
                              </text>
                              <text fg={theme.text}>{agent.name}</text>
                            </box>
                            <text fg={theme.textMuted}>{agent.status}</text>
                          </box>
                        )}
                      </For>
                    </Show>
                  </box>
                </box>
              </Match>

              {/* ── WORKFLOWS ── */}
              <Match when={activeTab() === "workflows"}>
                <box gap={1}>
                  <For each={MOCK_WORKFLOWS}>
                    {(wf) => (
                      <box>
                        <box flexDirection="row" gap={1}>
                          <text flexShrink={0} fg={workflowColor(wf.status)}>
                            {workflowIcon(wf.status)}
                          </text>
                          <text fg={theme.text} wrapMode="word">
                            {wf.name}
                          </text>
                        </box>
                        <text fg={theme.textMuted}>
                          {"   "}
                          {wf.status === "running" ? "running..." : wf.lastRun ?? "never"}
                          {wf.status !== "running" ? `  ×${wf.triggerCount}` : ""}
                        </text>
                      </box>
                    )}
                  </For>
                </box>
              </Match>

              {/* ── BLOQs ── */}
              <Match when={activeTab() === "blocs"}>
                <box gap={1}>
                  <Show when={activeBlocs().length > 0}>
                    <box>
                      <text fg={theme.text}>
                        <b>Active</b>
                      </text>
                      <For each={activeBlocs()}>
                        {(bloq) => (
                          <box paddingTop={1}>
                            <box flexDirection="row" justifyContent="space-between">
                              <box flexDirection="row" gap={1}>
                                <text flexShrink={0} fg={theme.accent}>
                                  ◈
                                </text>
                                <text fg={theme.text}>{bloq.name}</text>
                              </box>
                              <Show when={bloq.context}>
                                <text fg={theme.textMuted}>{bloq.context}</text>
                              </Show>
                            </box>
                            <text fg={theme.textMuted}>
                              {"   "}
                              {bloq.leadCount} leads  ·  {fmtMsgs(bloq.messageCount)} msgs
                            </text>
                            <text fg={theme.textMuted}>{"   "}{bloq.lastActivity}</text>
                          </box>
                        )}
                      </For>
                    </box>
                  </Show>
                  <Show when={archivedBlocs().length > 0}>
                    <box>
                      <text fg={theme.textMuted}>
                        <b>Archived</b>
                      </text>
                      <For each={archivedBlocs()}>
                        {(bloq) => (
                          <box paddingTop={1}>
                            <box flexDirection="row" justifyContent="space-between">
                              <box flexDirection="row" gap={1}>
                                <text flexShrink={0} fg={theme.textMuted}>
                                  ◈
                                </text>
                                <text fg={theme.textMuted}>{bloq.name}</text>
                              </box>
                              <Show when={bloq.context}>
                                <text fg={theme.textMuted}>{bloq.context}</text>
                              </Show>
                            </box>
                            <text fg={theme.textMuted}>
                              {"   "}
                              {bloq.leadCount} leads  ·  {fmtMsgs(bloq.messageCount)} msgs
                            </text>
                          </box>
                        )}
                      </For>
                    </box>
                  </Show>
                </box>
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
