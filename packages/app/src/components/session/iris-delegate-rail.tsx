import { createEffect, createMemo, createResource, createSignal, For, on, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import "./iris-delegate-rail.css"
import {
  agentTone,
  cardFromDrag,
  handoffPrompt,
  isImportedPerson,
  openWork,
  sessionTargets,
  sortAgents,
  type AgentTaskRow,
  type DelegateAgent,
  type DelegateSession,
  type HandoffCard,
} from "./iris-delegate-model"

/**
 * DELEGATE RAIL (#189933) — beside Atlas › Board, the way Hive › Machines sits beside the fleet:
 * the board's agents and this project's sessions, each one a place to drop a card.
 *
 * Dropping on an AGENT adds a task to the card carrying the agent (`/iris/item/:id/tasks`, the
 * same primitive as `iris agents assign --item`), so it shows in `iris agents tasks`. Dropping on a
 * SESSION sends the card to it as a prompt, queued behind whatever it is doing. The two are labelled
 * differently on purpose: one is "on its list", the other is "working on it now".
 */
type AgentsPayload = { measured: boolean; reason?: string | null; agents: DelegateAgent[] }
type TasksPayload = { measured: boolean; reason?: string | null; tasks: AgentTaskRow[] }
type Note = { ok: boolean; text: string }

export function IrisDelegateRail(props: {
  doFetch: (path: string, init?: RequestInit) => Promise<Response>
  bloqId: number | undefined
  /** The card being dragged on the board, or null. */
  dragging: () => number | null
  card: (itemId: number) => HandoffCard | undefined
  sessions: () => (DelegateSession & { title?: string })[]
  sessionBusy: (sessionID: string) => boolean
  /** Undefined when there is no session context above the panel — the section says so. */
  sendToSession?: (sessionID: string, text: string) => Promise<void>
  /** The drag ended here — the board clears its own drag state. */
  onDropped: () => void
  /** A card changed (a task was added); the board re-reads it. */
  onChanged: () => void
}) {
  const language = useLanguage()
  const [agents] = createResource(
    () => props.bloqId,
    async (b): Promise<AgentsPayload> => {
      try {
        const res = await props.doFetch(`/iris/agents/${b}?perPage=100`)
        return (await res.json()) as AgentsPayload
      } catch (e) {
        return { measured: false, reason: e instanceof Error ? e.message : String(e), agents: [] }
      }
    },
  )
  /** Open work per agent. Missing = not read yet; null = the read failed. */
  const [load, setLoad] = createSignal<Record<number, number | null>>({})
  const readLoad = async (agentId: number) => {
    try {
      const res = await props.doFetch(`/iris/agents/${agentId}/tasks`)
      const j = (await res.json()) as TasksPayload
      setLoad((cur) => ({ ...cur, [agentId]: j.measured ? openWork(j.tasks ?? []) : null }))
    } catch {
      setLoad((cur) => ({ ...cur, [agentId]: null }))
    }
  }
  // Every agent's queue, once per board — and again for one agent after a drop on it.
  createEffect(
    on(
      () => agents.latest?.agents,
      (list) => {
        setLoad({})
        for (const a of list ?? []) if (!isImportedPerson(a)) void readLoad(a.id)
      },
    ),
  )
  const openOf = (id: number) => (id in load() ? load()[id] : null)
  const sortedAgents = createMemo(() =>
    sortAgents((agents.latest?.agents ?? []).filter((a) => !isImportedPerson(a)), openOf),
  )
  const sessions = createMemo(() => sessionTargets(props.sessions()))

  const [over, setOver] = createSignal<string | null>(null)
  const [pending, setPending] = createSignal<string | null>(null)
  const [notes, setNotes] = createSignal<Record<string, Note>>({})
  const note = (key: string, n: Note) => setNotes((cur) => ({ ...cur, [key]: n }))

  const dropped = (e: DragEvent): number | null => {
    e.preventDefault()
    const id = props.dragging() ?? cardFromDrag(e.dataTransfer?.getData("text/plain"))
    setOver(null)
    props.onDropped()
    return id
  }
  const dragOver = (key: string) => (e: DragEvent) => {
    if (props.dragging() === null) return
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = "link"
    setOver(key)
  }

  async function dropOnAgent(e: DragEvent, agent: DelegateAgent) {
    const itemId = dropped(e)
    if (itemId === null) return
    const key = `a${agent.id}`
    const card = props.card(itemId)
    setPending(key)
    try {
      const res = await props.doFetch(`/iris/item/${itemId}/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: card?.title ?? `#${itemId}`, agentId: agent.id }),
      })
      const r = (await res.json().catch(() => null)) as { ok?: boolean; reason?: string } | null
      if (!res.ok || !r?.ok) throw new Error(r?.reason || `HTTP ${res.status}`)
      note(key, { ok: true, text: language.t("iris.delegate.agent.assigned", { id: String(itemId) }) })
      void readLoad(agent.id)
      props.onChanged()
    } catch (err) {
      note(key, {
        ok: false,
        text: language.t("iris.delegate.agent.failed", { reason: err instanceof Error ? err.message : String(err) }),
      })
    } finally {
      setPending(null)
    }
  }

  async function dropOnSession(e: DragEvent, sessionID: string) {
    const itemId = dropped(e)
    if (itemId === null || !props.sendToSession) return
    const key = `s${sessionID}`
    const card = props.card(itemId) ?? { id: itemId, title: `#${itemId}` }
    // Read before sending: once the prompt lands the session is busy with THIS card.
    const wasBusy = props.sessionBusy(sessionID)
    setPending(key)
    try {
      await props.sendToSession(sessionID, handoffPrompt(card))
      note(key, {
        ok: true,
        text: language.t(wasBusy ? "iris.delegate.session.queued" : "iris.delegate.session.sent", { id: String(itemId) }),
      })
    } catch (err) {
      note(key, {
        ok: false,
        text: language.t("iris.delegate.session.failed", { reason: err instanceof Error ? err.message : String(err) }),
      })
    } finally {
      setPending(null)
    }
  }

  const toneText = (agent: DelegateAgent) => {
    const open = openOf(agent.id)
    switch (agentTone(agent, open)) {
      case "off":
        return language.t("iris.delegate.agent.off")
      case "unknown":
        return agent.id in load() ? language.t("iris.delegate.agent.unread") : language.t("iris.delegate.agent.reading")
      case "free":
        return language.t("iris.delegate.agent.free")
      default:
        return language.plural("iris.delegate.agent.open", open ?? 0)
    }
  }

  return (
    <aside
      class="iris-delegate"
      classList={{ "iris-delegate--live": props.dragging() !== null }}
      aria-label={language.t("iris.delegate.title")}
      data-prevent-autofocus
    >
      <header class="iris-delegate__head">
        <h3 class="text-12-medium text-text-base">{language.t("iris.delegate.title")}</h3>
        <p class="text-11-regular text-text-weak">{language.t("iris.delegate.hint")}</p>
      </header>

      <section class="iris-delegate__group">
        <h4 class="iris-delegate__label">{language.t("iris.delegate.agents")}</h4>
        <Show when={agents.loading && !agents.latest}>
          <p class="iris-delegate__empty">{language.t("iris.delegate.agent.reading")}</p>
        </Show>
        <Show when={agents.latest && !agents.latest.measured}>
          <p class="iris-delegate__empty">
            {language.t("iris.delegate.agents.unread", { reason: agents.latest?.reason ?? "" })}
          </p>
        </Show>
        <Show when={agents.latest?.measured && sortedAgents().length === 0}>
          <p class="iris-delegate__empty">{language.t("iris.delegate.agents.none")}</p>
        </Show>
        <For each={sortedAgents()}>
          {(agent) => {
            const key = `a${agent.id}`
            const tone = () => agentTone(agent, openOf(agent.id))
            return (
              <div
                class="iris-delegate__target"
                classList={{
                  "iris-delegate__target--over": over() === key,
                  "iris-delegate__target--pending": pending() === key,
                }}
                data-tone={tone()}
                onDragOver={dragOver(key)}
                onDragLeave={() => over() === key && setOver(null)}
                onDrop={(e) => void dropOnAgent(e, agent)}
              >
                <span class="iris-delegate__dot" aria-hidden="true" />
                <div class="min-w-0 flex-1">
                  <p class="text-12-regular text-text-base truncate">{agent.name}</p>
                  <p class="text-11-regular text-text-weak truncate">
                    {agent.model ? `${agent.model} · ${toneText(agent)}` : toneText(agent)}
                  </p>
                  <Show when={notes()[key]}>
                    {(n) => (
                      <p class="iris-delegate__note" data-ok={n().ok} role="status">
                        {n().text}
                      </p>
                    )}
                  </Show>
                </div>
              </div>
            )
          }}
        </For>
      </section>

      <section class="iris-delegate__group">
        <h4 class="iris-delegate__label">{language.t("iris.delegate.sessions")}</h4>
        <Show
          when={props.sendToSession}
          fallback={<p class="iris-delegate__empty">{language.t("iris.delegate.sessions.unavailable")}</p>}
        >
          <Show when={sessions().length === 0}>
            <p class="iris-delegate__empty">{language.t("iris.delegate.sessions.none")}</p>
          </Show>
          <For each={sessions()}>
            {(s) => {
              const key = `s${s.id}`
              const busy = () => props.sessionBusy(s.id)
              return (
                <div
                  class="iris-delegate__target"
                  classList={{
                    "iris-delegate__target--over": over() === key,
                    "iris-delegate__target--pending": pending() === key,
                  }}
                  data-tone={busy() ? "busy" : "free"}
                  onDragOver={dragOver(key)}
                  onDragLeave={() => over() === key && setOver(null)}
                  onDrop={(e) => void dropOnSession(e, s.id)}
                >
                  <span class="iris-delegate__dot" aria-hidden="true" />
                  <div class="min-w-0 flex-1">
                    <p class="text-12-regular text-text-base truncate">
                      {s.title || language.t("iris.delegate.session.untitled")}
                    </p>
                    <p class="text-11-regular text-text-weak truncate">
                      {busy() ? language.t("iris.delegate.session.busy") : language.t("iris.delegate.session.idle")}
                    </p>
                    <Show when={notes()[key]}>
                      {(n) => (
                        <p class="iris-delegate__note" data-ok={n().ok} role="status">
                          {n().text}
                        </p>
                      )}
                    </Show>
                  </div>
                </div>
              )
            }}
          </For>
        </Show>
      </section>
    </aside>
  )
}
