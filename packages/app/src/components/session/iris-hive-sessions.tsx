import { createEffect, createMemo, createResource, createSignal, For, on, onCleanup, Show } from "solid-js"
import { Icon, type IconProps } from "@opencode-ai/ui/icon"
import "./iris-hive-scripts.css"
import "./iris-hive-sessions.css"
import {
  ago,
  isWorking,
  mergeTranscript,
  needsYou,
  providerWord,
  replyAfter,
  replyMode,
  shortAge,
  reportLine,
  sortNodes,
  visibleSessions,
  STATUS_WORD,
  summaryOf,
  type HiveSession,
  type HiveSessionNode,
  type RetiredRecord,
  type TranscriptMessage,
  type WaitingQuestion,
} from "./iris-hive-sessions-model"

/**
 * Hive › Sessions (epic #189446, #191171): every AI session on every machine you can reach — the
 * same rows `iris hive sessions` prints — with a status that is true, a transcript you can open, a
 * message box that gets the session's reply back here (`iris hive ask`), and the question a session
 * is waiting on with its choices (`iris hive answer`). Providers that cannot take input say why.
 *
 * Nothing here decides freshness. The sidecar hands over the server's verdict; a machine whose
 * report is old arrives with its sessions `unknown` and is drawn dashed, because that is what its
 * list is: a memory, not a reading.
 */
type IconName = IconProps["name"]
type SessionsPayload = { measured: boolean; reason?: string | null; nodes: HiveSessionNode[]; retired?: RetiredRecord[] }
type AnswerPayload = {
  measured: boolean
  reason?: string | null
  taskId: string | null
  status: string
  via: string | null
  answers: { question: string; answer: string }[]
  error: string | null
}
type TranscriptPayload = {
  measured: boolean
  reason?: string | null
  ranOn: string | null
  offset: number | null
  incremental: boolean
  messages: TranscriptMessage[]
}

/** A transcript read is a task on the remote machine. One at a time, a pause between. */
const FOLLOW_GAP_MS = 5_000

function Ic(props: { name: IconName; title?: string; class?: string }) {
  return (
    <span class={`hsc-ic ${props.class ?? ""}`} title={props.title} aria-hidden={props.title ? undefined : "true"}>
      <Icon name={props.name} size="small" />
    </span>
  )
}

export function IrisHiveSessions(props: {
  doFetch: (path: string, init?: RequestInit) => Promise<Response>
  openExternal?: (url: string) => void
  now?: () => number
}) {
  const now = () => props.now?.() ?? Date.now()
  const getJson = async <T,>(path: string, fallback: T, init?: RequestInit): Promise<T> => {
    try {
      const res = await props.doFetch(path, init)
      return (await res.json()) as T
    } catch (e) {
      return { ...fallback, reason: e instanceof Error ? e.message : String(e) }
    }
  }

  const [data, { refetch }] = createResource(() => getJson<SessionsPayload>("/iris/hive/sessions", { measured: false, nodes: [] }))
  const timer = setInterval(() => void refetch(), 30_000)
  onCleanup(() => clearInterval(timer))
  const [refreshing, setRefreshing] = createSignal(false)
  const refresh = async () => {
    if (refreshing()) return
    setRefreshing(true)
    try {
      await refetch()
    } finally {
      setRefreshing(false)
    }
  }

  const nodes = createMemo(() => sortNodes(data.latest?.nodes ?? []))
  const summary = createMemo(() => summaryOf(nodes()))

  // Collapsed machines are local view state — not a second request per expand.
  const [collapsed, setCollapsed] = createSignal<Record<string, boolean>>({})
  const isOpen = (n: HiveSessionNode) => collapsed()[n.id] ?? n.report === "fresh"
  const toggle = (n: HiveSessionNode) => setCollapsed({ ...collapsed(), [n.id]: !isOpen(n) })
  const [older, setOlder] = createSignal<Record<string, boolean>>({})

  const [picked, setPicked] = createSignal<{ nodeId: string; sessionId: string } | undefined>()
  const selected = createMemo(() => {
    const p = picked()
    if (!p) return undefined
    const node = nodes().find((n) => n.id === p.nodeId)
    const session = node?.sessions.find((s) => s.sessionId === p.sessionId)
    return node && session ? { node, session } : undefined
  })

  return (
    <div class="hsc-wrap">
      <div class="hss" data-open={selected() ? "1" : undefined}>
        <section class="hss-main" aria-label="Sessions on your machines">
          <header class="hss-top">
            <div class="hss-topbar">
              <Show
                when={data.latest?.measured}
                fallback={
                  <Show when={data.latest}>
                    <p class="hsc-warn">Could not read your sessions{data.latest!.reason ? ` — ${data.latest!.reason}` : ""}</p>
                  </Show>
                }
              >
                <p class="hss-sum">
                  <b class="hsc-num">{summary().sessions}</b> sessions on <b class="hsc-num">{summary().machines}</b> machines
                  <Show when={summary().working}>
                    <span class="hss-sep">·</span>
                    <b class="hsc-num">{summary().working}</b> working
                  </Show>
                  <Show when={summary().needs}>
                    <span class="hss-sep">·</span>
                    <span class="hsc-amber">
                      <b class="hsc-num">{summary().needs}</b> need{summary().needs === 1 ? "s" : ""} you
                    </span>
                  </Show>
                </p>
              </Show>
              <span class="hsc-spacer" />
              <button
                class="hsc-ib hsc-ib--bare hss-refresh"
                type="button"
                title="Reload sessions"
                aria-label="Reload sessions"
                aria-busy={refreshing()}
                disabled={refreshing()}
                onClick={() => void refresh()}
              >
                <span class="hsc-ic" classList={{ "hsc-spin": refreshing() }} aria-hidden="true">
                  ↻
                </span>
              </button>
            </div>
            <Show when={data.latest?.measured}>
              <Show when={summary().staleMachines}>
                <p class="hss-note">
                  <b class="hsc-num">{summary().staleMachines}</b> machine{summary().staleMachines === 1 ? " has" : "s have"} not
                  reported recently — their sessions show as unknown.
                </p>
              </Show>
              <For each={data.latest?.retired ?? []}>
                {(r) => (
                  <p class="hss-note hss-retired">
                    {r.name}: an older record last reported {shortAge(r.at, now())} ago — its <b class="hsc-num">{r.rows}</b> sessions are not shown.
                  </p>
                )}
              </For>
            </Show>
          </header>

          <Show when={data.latest?.measured && nodes().length === 0}>
            <p class="hsc-muted hss-empty">
              No machines on this account yet. Run <code class="hsc-mono">iris hive connect</code> on one to add it.
            </p>
          </Show>

          <ul class="hss-nodes">
            <For each={nodes()}>
              {(n) => {
                const line = () => reportLine(n, now())
                const vis = () => visibleSessions(n, !!older()[n.id])
                return (
                  <li class="hss-node" data-report={n.report}>
                    <button
                      type="button"
                      class="hss-nodehead"
                      aria-expanded={isOpen(n)}
                      onClick={() => toggle(n)}
                    >
                      <i
                        class="hss-dot"
                        classList={{
                          "hss-dot--on": n.online && n.report === "fresh",
                          "hss-dot--stale": n.report !== "fresh",
                          "hss-dot--work": isWorking(n),
                        }}
                        title={n.online ? "online" : "offline"}
                      />
                      <span class="hss-nodename">{n.name}</span>
                      <span class="hss-report" data-tone={line().tone}>
                        {line().text}
                      </span>
                      <span class="hsc-spacer" />
                      <Show when={needsYou(n)}>
                        <span class="hss-pill hss-pill--needs hsc-num">{needsYou(n)} need you</span>
                      </Show>
                      <span class="hsc-num hss-count" title={n.incomplete.length ? `At least — not all of ${n.incomplete.join(", ")} could be listed` : undefined}>
                        {n.sessions.length}
                        {n.incomplete.length ? "+" : ""}
                      </span>
                      <Ic name={isOpen(n) ? "chevron-down" : "chevron-right"} />
                    </button>
                    <Show when={isOpen(n)}>
                      <ul class="hss-sessions">
                        <Show when={n.sessions.length === 0}>
                          <li class="hsc-muted hss-none">No sessions reported.</li>
                        </Show>
                        <For each={vis().shown}>
                          {(s) => (
                            <li>
                              <button
                                type="button"
                                class="hss-row"
                                aria-pressed={picked()?.sessionId === s.sessionId && picked()?.nodeId === n.id}
                                onClick={() => setPicked({ nodeId: n.id, sessionId: s.sessionId })}
                              >
                                <i
                                  class="hss-sdot"
                                  data-status={s.status}
                                  classList={{ "hss-sdot--work": !!s.activity }}
                                  title={s.activity ?? STATUS_WORD[s.status] ?? s.status}
                                />
                                <span class="hss-label" title={s.label}>
                                  {s.label}
                                  <Show when={s.branch}>
                                    <span class="hss-branch"> ({s.branch})</span>
                                  </Show>
                                </span>
                                <span class="hss-status" data-status={s.status}>
                                  {STATUS_WORD[s.status] ?? s.status}
                                </span>
                                <span class="hss-prov" data-provider={s.provider}>
                                  {providerWord(s.provider)}
                                </span>
                                <span class="hsc-mono hss-model" title={s.model ?? "model not reported"}>
                                  {s.model ?? "—"}
                                </span>
                                <span class="hsc-num hss-age" title={s.updatedAt ? ago(s.updatedAt, now()) : undefined}>
                                  {shortAge(s.updatedAt, now())}
                                </span>
                              </button>
                            </li>
                          )}
                        </For>
                        <Show when={vis().hidden || older()[n.id]}>
                          <li>
                            <button type="button" class="hss-older" onClick={() => setOlder({ ...older(), [n.id]: !older()[n.id] })}>
                              {older()[n.id] ? "Hide older sessions" : `Show ${vis().hidden} older (untouched for over a day)`}
                            </button>
                          </li>
                        </Show>
                      </ul>
                    </Show>
                  </li>
                )
              }}
            </For>
          </ul>
        </section>

        <Show when={selected()}>
          {(sel) => (
            <SessionDetail
              node={sel().node}
              session={sel().session}
              doFetch={props.doFetch}
              getJson={getJson}
              openExternal={props.openExternal}
              now={now}
              onClose={() => setPicked(undefined)}
            />
          )}
        </Show>
      </div>
    </div>
  )
}

function SessionDetail(props: {
  node: HiveSessionNode
  session: HiveSession
  doFetch: (path: string, init?: RequestInit) => Promise<Response>
  getJson: <T>(path: string, fallback: T, init?: RequestInit) => Promise<T>
  openExternal?: (url: string) => void
  now: () => number
  onClose: () => void
}) {
  const [messages, setMessages] = createSignal<TranscriptMessage[]>([])
  const [reason, setReason] = createSignal<string | null>(null)
  const [loading, setLoading] = createSignal(true)
  const [ranOn, setRanOn] = createSignal<string | null>(null)
  let listEl: HTMLOListElement | undefined

  // Follow the session: read, wait, read only what was appended. Restarts when the session changes.
  createEffect(
    on(
      () => `${props.node.id}|${props.session.sessionId}`,
      () => {
        let alive = true
        let cursor: number | null = null
        let wait: ReturnType<typeof setTimeout> | undefined
        setMessages([])
        setReason(null)
        setLoading(true)
        const read = async () => {
          const q = new URLSearchParams({ machine: props.node.name, provider: props.session.provider, limit: "40" })
          if (cursor !== null) q.set("since", String(cursor))
          const r = await props.getJson<TranscriptPayload>(
            `/iris/hive/sessions/${encodeURIComponent(props.session.sessionId)}/transcript?${q}`,
            { measured: false, ranOn: null, offset: null, incremental: false, messages: [] },
          )
          if (!alive) return
          setLoading(false)
          if (!r.measured) {
            setReason(r.reason ?? "the machine did not answer")
          } else {
            setReason(null)
            setRanOn(r.ranOn)
            const stick = listEl ? listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < 40 : true
            setMessages((prev) => mergeTranscript(prev, r.messages, cursor !== null && r.incremental))
            if (typeof r.offset === "number") cursor = r.offset
            if (stick) queueMicrotask(() => listEl && (listEl.scrollTop = listEl.scrollHeight))
          }
          // An old report means nothing new will arrive; read once and stop.
          if (props.node.report === "fresh") wait = setTimeout(() => void read(), FOLLOW_GAP_MS)
        }
        void read()
        onCleanup(() => {
          alive = false
          if (wait) clearTimeout(wait)
        })
      },
    ),
  )

  const mode = () => replyMode(props.session, props.node)
  const [draft, setDraft] = createSignal("")
  const [sending, setSending] = createSignal(false)
  const [sent, setSent] = createSignal<{ ok: boolean; text: string } | null>(null)
  // What we asked, and when — the reply is read off the transcript the way `iris hive ask` reads it.
  const [asked, setAsked] = createSignal<{ text: string; at: number } | null>(null)
  const reply = createMemo(() => {
    const a = asked()
    return a ? replyAfter(messages(), a.text) : null
  })
  createEffect(on(() => `${props.node.id}|${props.session.sessionId}`, () => (setAsked(null), setSent(null), setDraft(""))))

  const send = async () => {
    const message = draft().trim()
    if (!message || sending()) return
    setSending(true)
    setSent(null)
    const r = await props.getJson<{ measured: boolean; reason?: string | null; taskId: string | null }>(
      `/iris/hive/sessions/${encodeURIComponent(props.session.sessionId)}/reply`,
      { measured: false, taskId: null },
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nodeId: props.node.id,
          provider: props.session.provider,
          label: props.session.label,
          message,
        }),
      },
    )
    setSending(false)
    if (r.measured) {
      setDraft("")
      setAsked({ text: message, at: props.now() })
      setSent({ ok: true, text: `Sent to ${props.node.name}. Its reply appears below as it is written.` })
    } else {
      setSent({ ok: false, text: `Not sent — ${r.reason ?? "unknown error"}` })
    }
  }

  // One choice per question: an option label, or free text typed under it.
  const questions = () => props.session.questions ?? []
  const [choices, setChoices] = createSignal<Record<number, string>>({})
  const [answering, setAnswering] = createSignal(false)
  const [answered, setAnswered] = createSignal<{ ok: boolean; text: string } | null>(null)
  createEffect(on(() => `${props.session.sessionId}|${props.session.question ?? ""}`, () => (setChoices({}), setAnswered(null))))
  const ready = () => questions().length > 0 && questions().every((_, i) => (choices()[i] ?? "").trim() !== "")
  const answer = async () => {
    if (!ready() || answering()) return
    setAnswering(true)
    setAnswered(null)
    const r = await props.getJson<AnswerPayload>(
      `/iris/hive/sessions/${encodeURIComponent(props.session.sessionId)}/answer`,
      { measured: false, taskId: null, status: "pending", via: null, answers: [], error: null },
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nodeId: props.node.id,
          provider: props.session.provider,
          choices: questions().map((_, i) => choices()[i]!.trim()),
        }),
      },
    )
    setAnswering(false)
    if (!r.measured) setAnswered({ ok: false, text: `Not sent — ${r.reason ?? "unknown error"}` })
    else if (r.status === "answered")
      setAnswered({
        ok: true,
        text: `Answered ${r.via === "hook" ? "through the waiting hook" : "with a keystroke in its terminal"} on ${props.node.name}.`,
      })
    else if (r.status === "refused") setAnswered({ ok: false, text: `Not answered — ${r.error ?? "the machine gave no reason"}` })
    else setAnswered({ ok: false, text: `No result from ${props.node.name} after 45 s (task ${r.taskId ?? "?"}).` })
  }

  return (
    <aside class="hss-detail" aria-label="Session">
      <header class="hss-dhead">
        <div class="hss-dtitle">
          <b title={props.session.label}>{props.session.label}</b>
          <span class="hss-dmeta">
            {providerWord(props.session.provider)} · {props.node.name}
            <Show when={props.session.model}> · {props.session.model}</Show>
            <Show when={props.session.branch}> · {props.session.branch}</Show>
          </span>
        </div>
        <button type="button" class="hss-x" title="Close" onClick={() => props.onClose()}>
          <Ic name="close" />
        </button>
      </header>

      <Show when={questions().length > 0}>
        <section class="hss-ask" aria-label="Waiting on you">
          <For each={questions()}>
            {(q, i) => (
              <QuestionBlock
                q={q}
                choice={choices()[i()] ?? ""}
                disabled={mode() !== "talk" || answering()}
                onChoose={(v) => setChoices({ ...choices(), [i()]: v })}
              />
            )}
          </For>
          <Show
            when={mode() === "talk"}
            fallback={<p class="hss-hint">{props.session.readOnly ?? "This machine's report is not current, so an answer may reach nobody."}</p>}
          >
            <div class="hss-replybar">
              <span class="hsc-muted">One answer per question</span>
              <span class="hsc-spacer" />
              <button type="button" class="hss-send hss-answerbtn" disabled={!ready() || answering()} onClick={() => void answer()}>
                {answering() ? "Answering…" : "Answer"}
              </button>
            </div>
          </Show>
          <Show when={answered()}>
            <p classList={{ "hss-sent": true, "hsc-warn": !answered()!.ok }}>{answered()!.text}</p>
          </Show>
        </section>
      </Show>
      <Show when={questions().length === 0 && props.session.question}>
        <p class="hss-question">
          <Ic name="warning" /> Waiting on you: {props.session.question}
        </p>
      </Show>

      <ol class="hss-transcript" ref={listEl} aria-live="polite">
        <Show when={loading()}>
          <li class="hsc-muted">Asking {props.node.name}…</li>
        </Show>
        <Show when={reason()}>
          <li class="hsc-warn">Could not read it — {reason()}</li>
        </Show>
        <Show when={!loading() && !reason() && messages().length === 0}>
          <li class="hsc-muted">No messages yet.</li>
        </Show>
        <For each={messages()}>
          {(m) => (
            <li class="hss-msg" data-role={m.role} data-type={m.type}>
              <Show when={m.type === "text"} fallback={<span class="hss-tool hsc-mono">{m.tool ?? m.type}</span>}>
                <span class="hss-text">{m.text}</span>
              </Show>
            </li>
          )}
        </For>
      </ol>
      <Show when={ranOn() && props.node.report === "fresh"}>
        <p class="hss-follow hsc-muted">Following on {ranOn()} — new messages appear here.</p>
      </Show>

      <footer class="hss-reply">
        <Show when={asked()}>
          <div class="hss-answer" aria-live="polite">
            <p class="hss-answerhead hsc-muted">
              Reply to “{asked()!.text.length > 60 ? asked()!.text.slice(0, 59) + "…" : asked()!.text}”
            </p>
            <Show
              when={reply()?.answered}
              fallback={
                <p class="hsc-muted hss-answerwait">
                  {reply()?.anchored
                    ? `${props.session.label} is working on it…`
                    : props.now() - asked()!.at > 300_000
                      ? `The message has not shown up in this session's transcript after 5 min.`
                      : `Waiting for the message to land on ${props.node.name}…`}
                </p>
              }
            >
              <For each={reply()!.parts}>
                {(p) =>
                  p.kind === "tool" ? <span class="hss-tool hsc-mono">{p.text}</span> : <p class="hss-text hss-answertext">{p.text}</p>
                }
              </For>
            </Show>
          </div>
        </Show>
        <Show when={mode() === "talk"}>
          <textarea
            class="hss-input"
            rows={2}
            placeholder={`Message this session on ${props.node.name} — it takes a turn and answers here`}
            value={draft()}
            onInput={(e) => setDraft(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send()
            }}
          />
          <div class="hss-replybar">
            <span class="hsc-muted">⌘↵ to send</span>
            <span class="hsc-spacer" />
            <button type="button" class="hss-send" disabled={!draft().trim() || sending()} onClick={() => void send()}>
              {sending() ? "Sending…" : "Send"}
            </button>
          </div>
        </Show>
        <Show when={mode() === "stale"}>
          <p class="hss-hint">This machine's report is not current, so a message may reach nobody. Check the machine first.</p>
        </Show>
        <Show when={mode() === "readonly"}>
          <p class="hss-hint hss-readonly">Read-only — {props.session.readOnly}.</p>
        </Show>
        <Show when={sent()}>
          <p classList={{ "hss-sent": true, "hsc-warn": !sent()!.ok }}>{sent()!.text}</p>
        </Show>
      </footer>
    </aside>
  )
}

function QuestionBlock(props: { q: WaitingQuestion; choice: string; disabled: boolean; onChoose: (v: string) => void }) {
  const picked = (label: string) => props.choice === label
  const typed = () => (props.q.options.some((o) => o.label === props.choice) ? "" : props.choice)
  return (
    <div class="hss-q">
      <p class="hss-question">
        <Ic name="warning" />
        <span>
          <Show when={props.q.header}>
            <b>{props.q.header}: </b>
          </Show>
          {props.q.question}
        </span>
      </p>
      <div class="hss-opts" role="radiogroup" aria-label={props.q.question}>
        <For each={props.q.options}>
          {(o) => (
            <button
              type="button"
              role="radio"
              class="hss-opt"
              aria-checked={picked(o.label)}
              disabled={props.disabled}
              onClick={() => props.onChoose(o.label)}
            >
              <span class="hsc-num hss-optn">{o.n}</span>
              {o.label}
            </button>
          )}
        </For>
      </div>
      <input
        class="hss-input hss-other"
        placeholder={props.q.options.length ? "…or type another answer" : "Type your answer"}
        value={typed()}
        disabled={props.disabled}
        onInput={(e) => props.onChoose(e.currentTarget.value)}
      />
    </div>
  )
}
