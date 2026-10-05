import { createEffect, createMemo, createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import type { ResourceFetcherInfo } from "solid-js"
import { callLine, control, fmtSeconds, stepLabel, verdict, type LiveRun } from "./iris-agent-live-model"

/**
 * Agents › Live (#187921): is it stuck? A live view of an agent's run you can take over.
 *
 * Polls the sidecar (which holds the token) every two seconds for the picked agent's current run:
 * the step it is on and for how long, and its last tool calls with status and duration. Argument
 * values never reach this pane — the server sends argument names and sizes only.
 *
 * "Take over" asks the agent to stop after the step it is on (never mid-tool). "Hand back" resumes
 * the same run; whatever is typed in the box is what the agent is told when it continues.
 */

type Fetch = (path: string, init?: RequestInit) => Promise<Response>
type LivePayload = { measured: boolean; reason?: string; run: LiveRun | null }
type ControlPayload = { ok: boolean; reason?: string; message?: string }
type BoardAgent = { id: number; name: string }

const POLL_MS = 2_000
const LIMIT = 10
const SELECTED_KEY = "iris.live.agent"
const remembered = () => {
  try {
    const v = Number(localStorage.getItem(SELECTED_KEY))
    return Number.isFinite(v) && v > 0 ? v : undefined
  } catch {
    return undefined
  }
}

export function IrisAgentLive(props: { doFetch: Fetch; bloqId?: number }) {
  const json = async <T,>(path: string, init?: RequestInit): Promise<T> =>
    (await (await props.doFetch(path, init)).json()) as T
  const post = <T,>(path: string, body: unknown) =>
    json<T>(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })

  const [agents] = createResource(
    () => props.bloqId,
    (b) => json<{ agents: BoardAgent[] }>(`/iris/agents/${b}?perPage=100`),
  )
  const [agentId, setAgentId] = createSignal<number | undefined>(remembered())
  const choose = (id: number | undefined) => {
    setAgentId(id)
    try {
      if (id) localStorage.setItem(SELECTED_KEY, String(id))
    } catch {}
  }
  createEffect(() => {
    const list = agents.latest?.agents
    if (list?.length && !list.some((a) => a.id === agentId())) choose(list[0].id)
  })

  // Poll. A failed read keeps the last one on screen (titlebar-iris-pills' rule: a throwing poll
  // must not take the window down, and a blink to empty would read as "nothing running").
  const [tick, setTick] = createSignal(0)
  onMount(() => {
    const timer = setInterval(() => setTick((t) => t + 1), POLL_MS)
    onCleanup(() => clearInterval(timer))
  })
  const key = createMemo(() => {
    const id = agentId()
    return id ? ([id, tick()] as const) : undefined
  })
  const [live, { refetch }] = createResource(
    key,
    async ([id]: readonly [number, number], info: ResourceFetcherInfo<LivePayload | undefined>) => {
      try {
        return await json<LivePayload>(`/iris/agents/${id}/live?limit=${LIMIT}`)
      } catch {
        return info.value
      }
    },
  )
  const run = createMemo(() => live.latest?.run ?? null)
  const v = createMemo(() => verdict(run()))
  const action = createMemo(() => control(run()))

  const [message, setMessage] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [note, setNote] = createSignal<string | null>(null)

  async function act(kind: "take-over" | "hand-back" | "withdraw") {
    const r = run()
    if (!r || busy()) return
    setBusy(true)
    setNote(null)
    try {
      const path = `/iris/runs/${encodeURIComponent(r.runId)}/${kind === "take-over" ? "take-over" : "hand-back"}`
      const out = await post<ControlPayload>(path, kind === "hand-back" && message().trim() ? { message: message().trim() } : {})
      setNote(out.ok ? (out.message ?? null) : `Could not ${kind.replace("-", " ")} — ${out.reason ?? "unknown error"}`)
      if (out.ok && kind === "hand-back") setMessage("")
      refetch()
    } catch (e) {
      setNote(`Could not ${kind.replace("-", " ")} — ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div class="iris-live" data-component="iris-agent-live">
      <div class="iris-live__bar">
        <select
          class="iris-live__picker"
          value={agentId() ?? ""}
          onChange={(e) => choose(Number(e.currentTarget.value) || undefined)}
          aria-label="Agent to watch"
        >
          <For each={agents.latest?.agents ?? []}>{(a) => <option value={a.id}>{a.name}</option>}</For>
        </select>
        <Show when={action() === "take-over"}>
          <button class="iris-card__linkbtn iris-card__linkbtn--primary" disabled={busy()} onClick={() => act("take-over")}>
            Take over
          </button>
        </Show>
        <Show when={action() === "withdraw"}>
          <button class="iris-card__linkbtn" disabled={busy()} onClick={() => act("withdraw")}>
            Cancel take-over
          </button>
        </Show>
      </div>

      <Show when={props.bloqId !== undefined} fallback={<div class="iris-live__empty">Pick a board to see its agents.</div>}>
        <Show when={live.latest?.measured !== false} fallback={<div class="iris-live__error">Could not read the run — {live.latest?.reason}</div>}>
          <div class={`iris-live__verdict iris-live__verdict--${v().tone}`} role="status">
            {v().text}
          </div>

          <Show when={run()}>
            {(r) => (
              <div class="iris-live__meta">
                <span>{stepLabel(r())}</span>
                <span>last activity {fmtSeconds(r().secondsSinceLastEvent)} ago</span>
              </div>
            )}
          </Show>

          <Show when={action() === "hand-back"}>
            <div class="iris-live__handback">
              <textarea
                class="iris-live__message"
                placeholder="Optional: tell the agent what to do differently when it continues"
                value={message()}
                onInput={(e) => setMessage(e.currentTarget.value)}
                rows={3}
              />
              <button class="iris-card__linkbtn iris-card__linkbtn--primary" disabled={busy()} onClick={() => act("hand-back")}>
                Hand back
              </button>
            </div>
          </Show>

          <Show when={note()}>
            <div class="iris-live__note">{note()}</div>
          </Show>

          <Show when={(run()?.toolCalls.length ?? 0) > 0}>
            <div class="iris-live__heading">Last {run()!.toolCalls.length} tool calls (newest last)</div>
            <ol class="iris-live__calls">
              <For each={run()!.toolCalls}>
                {(c) => (
                  <li class={`iris-live__call iris-live__call--${c.status}`} title={c.error ?? ""}>
                    <span class="iris-live__step">#{c.iteration}</span> {callLine(c)}
                    <Show when={c.error}>
                      <div class="iris-live__callerr">{c.error}</div>
                    </Show>
                  </li>
                )}
              </For>
            </ol>
          </Show>
        </Show>
      </Show>
    </div>
  )
}
