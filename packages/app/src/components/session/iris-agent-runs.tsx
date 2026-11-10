import { useNavigate, useParams } from "@solidjs/router"
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { legacySessionHref, requireServerKey, sessionHref } from "@/utils/session-route"
import { showToast } from "@/utils/toast"
import "./iris-agent-runs.css"
import {
  bar,
  buildNode,
  callTime,
  elapsed,
  folded,
  money,
  recentRoots,
  RECENT_MS,
  runRoots,
  runStats,
  splitRuns,
  visibleCalls,
  type RunCall,
  type RunMessage,
  type RunNode,
  type RunSession,
} from "./iris-agent-runs-model"

/**
 * Agents › Running (#192855) — every agent working right now, as boxes joined by lines that say
 * who started whom, each listing the calls it makes. Finished runs fold into Inactive.
 *
 * Owns its pane: the live status comes from the same store as the "N working in the background"
 * chip, and each run's messages are read here, every POLL_MS while anything in it works.
 */
const POLL_MS = 2000
/** Newest messages read per agent — a long chat's earlier calls fold behind "+N earlier" anyway. */
const MESSAGE_LIMIT = 80
const MAX_DEPTH = 4
/** How often Inactive looks for runs that finished while the pane was closed. */
const DISCOVER_MS = 30000

/** Runs seen this launch, so a finished one stays in Inactive when you switch tabs and come back. */
const memory = new Map<string, RunNode>()

const ICON: Record<string, string> = {
  bash: "M3 4h10v8H3zM5 7l2 1.5L5 10M8.5 10.5H11",
  read: "M4 2.5h5.5L12.5 5.5V13.5H4zM9.5 2.5V5.5H12.5",
  write: "M3 13l1-3.5L10.5 3l2.5 2.5L6.5 12z",
  edit: "M3 13l1-3.5L10.5 3l2.5 2.5L6.5 12z",
  grep: "M7 2.8a4.2 4.2 0 1 0 0 8.4a4.2 4.2 0 1 0 0-8.4M10.2 10.2L14 14",
  glob: "M7 2.8a4.2 4.2 0 1 0 0 8.4a4.2 4.2 0 1 0 0-8.4M10.2 10.2L14 14",
  task: "M8 1.5v13M1.5 8h13M3.4 3.4l9.2 9.2M12.6 3.4l-9.2 9.2",
  webfetch: "M8 2a6 6 0 1 0 0 12a6 6 0 1 0 0-12M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12",
}
const iconFor = (tool: string) => ICON[tool] ?? "M8 6.5a1.5 1.5 0 1 0 0 3a1.5 1.5 0 1 0 0-3"

const AGENT_MARK = "M8 1.5v13M1.5 8h13M3.4 3.4l9.2 9.2M12.6 3.4l-9.2 9.2"

const modelName = (id?: string) => id?.replace(/^claude-/, "").replace(/-\d{8}$/, "")

export function IrisAgentRuns() {
  const serverSync = useServerSync()
  const serverSDK = useServerSDK()
  const navigate = useNavigate()
  const params = useParams<{ serverKey?: string; id?: string }>()
  const data = () => serverSync().session.data

  const [store, setStore] = createStore<{ runs: Record<string, RunNode> }>({ runs: Object.fromEntries(memory) })
  const [now, setNow] = createSignal(Date.now())
  const [error, setError] = createSignal<string>()
  const [openCalls, setOpenCalls] = createSignal<Set<string>>(new Set())
  const [openNodes, setOpenNodes] = createSignal<Set<string>>(new Set())
  const [allCalls, setAllCalls] = createSignal<Set<string>>(new Set())
  const toggle = (set: () => Set<string>, put: (s: Set<string>) => void, id: string) => {
    const next = new Set(set())
    next.has(id) ? next.delete(id) : next.add(id)
    put(next)
  }

  const working = createMemo(() => Object.keys(data().session_status).filter((id) => data().session_working(id)))
  const roots = createMemo(() => runRoots({ working: working(), info: (id) => serverSync().session.get(id), current: params.id }))

  const client = (directory?: string) => serverSDK().createClient({ directory, throwOnError: true })

  // Runs that finished before the pane was opened: this project's sessions from the last day.
  const [recent, setRecent] = createSignal<string[]>([])
  const listed = new Map<string, RunSession>()
  async function discover() {
    const directory = params.id ? serverSync().session.get(params.id)?.directory : undefined
    if (!directory) return
    const list = await client(directory)
      .session.list({ directory, start: Date.now() - RECENT_MS, limit: 200 })
      .then((r) => (r.data ?? []) as RunSession[])
      .catch(() => [] as RunSession[])
    for (const s of list) listed.set(s.id, { ...s, directory: s.directory ?? directory })
    setRecent(recentRoots(list, Date.now()))
  }
  const candidates = createMemo(() => [...new Set([...roots(), ...recent()])])

  async function load(session: RunSession, depth: number): Promise<RunNode> {
    const sdk = client(session.directory)
    const [messages, kids] = await Promise.all([
      sdk.session.messages({ sessionID: session.id, limit: MESSAGE_LIMIT }).then((r) => (r.data ?? []) as unknown as RunMessage[]),
      depth < MAX_DEPTH
        ? sdk.session.children({ sessionID: session.id }).then((r) => (r.data ?? []) as RunSession[]).catch(() => [])
        : Promise.resolve([] as RunSession[]),
    ])
    const children = await Promise.all(kids.map((k) => load({ ...k, directory: k.directory ?? session.directory }, depth + 1)))
    return buildNode({
      session,
      messages,
      working: data().session_working(session.id),
      retrying: data().session_status[session.id]?.type === "retry",
      children,
    })
  }

  let busy = false
  async function refresh() {
    if (busy) return
    busy = true
    try {
      for (const id of candidates()) {
        const known = store.runs[id]
        const live = known ? isLive(known) : true
        // A finished run does not change; read it once and leave it alone.
        if (known && !live && !working().includes(id)) continue
        const session = serverSync().session.get(id) ?? listed.get(id) ?? (await serverSync().session.resolve(id).catch(() => undefined))
        if (!session) continue
        const node = await load(session as RunSession, 0)
        // The open chat with no agents and nothing running is just a chat — not a run.
        if (id === params.id && !node.children.length && node.state !== "running" && !known) continue
        memory.set(id, node)
        setStore("runs", id, reconcile(node, { key: "id" }))
      }
      // Anything we were watching that is no longer working gets one last read so it lands as finished.
      for (const id of Object.keys(store.runs)) {
        if (candidates().includes(id) || !isLive(store.runs[id])) continue
        const session = serverSync().session.get(id) ?? listed.get(id)
        if (!session) continue
        const node = await load(session as RunSession, 0)
        memory.set(id, node)
        setStore("runs", id, reconcile(node, { key: "id" }))
      }
      setError(undefined)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      busy = false
    }
  }
  const isLive = (n: RunNode): boolean => n.state === "running" || n.state === "retry" || n.children.some(isLive)

  createEffect(() => {
    candidates()
    void refresh()
  })
  // Look as soon as the open chat's folder is known — on a cold start the chat loads after the pane.
  createEffect(
    on(
      () => (params.id ? serverSync().session.get(params.id)?.directory : undefined),
      (directory) => {
        if (directory) void discover()
      },
    ),
  )
  const finder = setInterval(() => void discover(), DISCOVER_MS)
  onCleanup(() => clearInterval(finder))
  const timer = setInterval(() => {
    setNow(Date.now())
    if (Object.values(store.runs).some(isLive) || working().length) void refresh()
  }, POLL_MS)
  onCleanup(() => clearInterval(timer))

  const split = createMemo(() => splitRuns(Object.values(store.runs)))

  const go = (id: string, directory?: string) => {
    navigate(params.serverKey ? sessionHref(requireServerKey(params.serverKey), id) : legacySessionHref(directory ?? "", id))
  }
  const stop = (node: RunNode) => {
    const session = serverSync().session.get(node.id)
    client(session?.directory)
      .session.abort({ sessionID: node.id })
      .catch((e: unknown) => showToast({ title: "Could not stop it", description: e instanceof Error ? e.message : String(e) }))
  }

  function CallRow(props: { call: RunCall; node: RunNode }) {
    const open = () => openCalls().has(props.call.id)
    const b = () => bar(props.call, props.node, now())
    return (
      <li class="iar-call" data-status={props.call.status}>
        <button type="button" class="iar-callrow" aria-expanded={open()} onClick={() => toggle(openCalls, setOpenCalls, props.call.id)}>
          <svg class="iar-ti" viewBox="0 0 16 16" aria-hidden="true"><path d={iconFor(props.call.tool)} /></svg>
          <span class="iar-cl" title={props.call.label}>{props.call.label}</span>
          <span class="iar-trk" aria-hidden="true"><i style={{ left: `${b().left}%`, width: `${b().width}%` }} /></span>
          <span class="iar-dur">{callTime(props.call, now())}</span>
        </button>
        <Show when={open()}>
          <div class="iar-cd">
            <div class="iar-cdh"><code>{props.call.tool}</code><span>{{ done: "Done", failed: "Failed", running: "Running", pending: "Waiting" }[props.call.status]}</span></div>
            <Show when={props.call.result}><pre class="iar-res">{props.call.result}</pre></Show>
            <Show when={props.call.args}><div class="iar-args">Called with <code>{props.call.args}</code></div></Show>
          </div>
        </Show>
      </li>
    )
  }

  function Pill(props: { state: RunNode["state"] }) {
    return (
      <span class="iar-pill" data-state={props.state}>
        <Show when={props.state === "running" || props.state === "retry"} fallback={<svg viewBox="0 0 16 16" aria-hidden="true"><path d={props.state === "failed" ? "M4.5 4.5l7 7M11.5 4.5l-7 7" : "M3.5 8.5l3 3 6-7"} /></svg>}>
          <i class="iar-spin" aria-hidden="true" />
        </Show>
        {{ running: "Running", retry: "Retrying", done: "Done", failed: "Failed" }[props.state]}
      </span>
    )
  }

  function AgentBox(props: { node: RunNode; root?: boolean }) {
    const isFolded = () => !props.root && folded(props.node, now()) && !openNodes().has(props.node.id)
    const calls = () => visibleCalls(props.node.calls, allCalls().has(props.node.id))
    const live = () => props.node.state === "running" || props.node.state === "retry"
    return (
      <Show
        when={!isFolded()}
        fallback={
          <button type="button" class="iar-fold" onClick={() => toggle(openNodes, setOpenNodes, props.node.id)} title="Show its calls">
            <Pill state={props.node.state} />
            <b>{props.node.agent}</b>
            <span class="iar-fold-task">{props.node.task}</span>
            <span class="iar-num">{elapsed(props.node.start, props.node.end, now())} · {money(props.node.cost)}</span>
          </button>
        }
      >
        <article class="iar-box" data-state={props.node.state}>
          <header class="iar-bh">
            <svg class="iar-mark" viewBox="0 0 16 16" aria-hidden="true"><path d={AGENT_MARK} /></svg>
            <div class="iar-nm">
              <b>{props.node.agent}</b>
              <Show when={props.node.model}><span>{modelName(props.node.model)}</span></Show>
            </div>
            <Pill state={props.node.state} />
          </header>
          <p class="iar-task" title={props.node.task}>{props.node.task}</p>
          <Show when={props.node.calls.length} fallback={<p class="iar-none">{live() ? "Thinking…" : "No calls"}</p>}>
            <ul class="iar-calls">
              <Show when={calls().hidden > 0}>
                <li><button type="button" class="iar-more" onClick={() => toggle(allCalls, setAllCalls, props.node.id)}>+{calls().hidden} earlier</button></li>
              </Show>
              <For each={calls().shown}>{(call) => <CallRow call={call} node={props.node} />}</For>
            </ul>
          </Show>
          <footer class="iar-bf">
            <span class="iar-num"><b>{money(props.node.cost)}</b> · {elapsed(props.node.start, props.node.end, now())}</span>
            <span class="iar-sp" />
            <button type="button" class="iar-link" onClick={() => go(props.node.id, serverSync().session.get(props.node.id)?.directory)}>Open</button>
            <Show when={live()}>
              <button type="button" class="iar-link iar-stop" onClick={() => stop(props.node)}>Stop</button>
            </Show>
          </footer>
        </article>
      </Show>
    )
  }

  function Tree(props: { node: RunNode; root?: boolean }) {
    return (
      <>
        <AgentBox node={props.node} root={props.root} />
        <Show when={props.node.children.length}>
          <ul class="iar-kids">
            <For each={props.node.children}>
              {(child) => (
                <li class="iar-kid">
                  <Tree node={child} />
                </li>
              )}
            </For>
          </ul>
        </Show>
      </>
    )
  }

  function Run(props: { run: RunNode }) {
    const s = () => runStats(props.run)
    return (
      <section class="iar-run">
        <div class="iar-rh">
          <b title={props.run.task}>{props.run.task}</b>
          <Show when={s().running}><span class="iar-running">{s().running} running</span></Show>
          <span class="iar-num iar-cost">{money(s().cost)}</span>
        </div>
        <dl class="iar-stats">
          <div><dt>Duration</dt><dd class="iar-num">{elapsed(s().start, s().end, now())}</dd></div>
          <div><dt>Agents</dt><dd class="iar-num">{s().agents}</dd></div>
          <div><dt>Calls</dt><dd class="iar-num">{s().calls}</dd></div>
          <div><dt>Errors</dt><dd class="iar-num" data-bad={s().errors ? "" : undefined}>{s().errors}</dd></div>
        </dl>
        <Tree node={props.run} root />
      </section>
    )
  }

  return (
    <div class="iar-wrap">
      <div class="iar">
        <Show when={error()}><p class="iar-warn">Could not read a run — {error()}</p></Show>
        <div class="iar-group">Active <span class="iar-num">{split().active.length}</span></div>
        <Show
          when={split().active.length}
          fallback={<p class="iar-empty">Nothing is running. When a chat starts agents, they show up here: who started whom, and every call each one makes.</p>}
        >
          <For each={split().active}>{(run) => <Run run={run} />}</For>
        </Show>
        <Show when={split().inactive.length}>
          <details class="iar-inactive" open>
            <summary class="iar-group">
              <svg class="iar-car" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4l4 4-4 4" /></svg>
              Inactive <span class="iar-num">{split().inactive.length}</span>
            </summary>
            <For each={split().inactive}>
              {(run) => (
                <details class="iar-past">
                  <summary>
                    <Pill state={run.state} />
                    <span class="iar-past-t" title={run.task}>{run.task}</span>
                    <span class="iar-num">{runStats(run).agents} agents · {money(runStats(run).cost)}</span>
                  </summary>
                  <Run run={run} />
                </details>
              )}
            </For>
          </details>
        </Show>
      </div>
    </div>
  )
}
