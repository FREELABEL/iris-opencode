import { createResource, createSignal, For, Show } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import { IrisAgentEditor } from "./iris-agent-editor"
import { modelLabel } from "./iris-shared-rooms-model"
import "./iris-shared-rooms.css"

/**
 * Room agents (#194496) — the side of a room where its agents are set up, next to the chat.
 *
 * Which of your cloud agents are in the room, on which model, and how each takes part: the LEAD
 * gets a person's message first and hands parts out; a teammate answers everything or only when
 * @mentioned. Add one of your agents, or create one here with the agents editor — each can run a
 * different model, which is the point: different models working one request together.
 */
type Fetch = (path: string, init?: RequestInit) => Promise<Response>
export type CloudAgent = { id: string; name: string; model: string | null; role: string; autoRespond: boolean }
type Mine = { measured: boolean; reason?: string; agents?: { id: number; name: string }[] }

export function RoomAgentsDrawer(props: {
  doFetch: Fetch
  roomId: string
  project: { id: number; name: string } | null
  agents: CloudAgent[]
  canManage: boolean
  onChanged: () => void
  onClose: () => void
}) {
  const [mode, setMode] = createSignal<"list" | "add" | "create">("list")
  const [open, setOpen] = createSignal<string | null>(null)
  const [busy, setBusy] = createSignal(false)
  const [note, setNote] = createSignal<{ tone: "good" | "bad"; text: string } | null>(null)
  const base = () => `/iris/shared-rooms/${encodeURIComponent(props.roomId)}/agents`
  const post = async (path: string, body: unknown) => {
    setBusy(true)
    setNote(null)
    try {
      const r = (await (
        await props.doFetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      ).json()) as { ok: boolean; reason?: string }
      if (!r.ok) setNote({ tone: "bad", text: r.reason ?? "That did not go through." })
      else props.onChanged()
      return r.ok
    } catch (e) {
      setNote({ tone: "bad", text: e instanceof Error ? e.message : String(e) })
      return false
    } finally {
      setBusy(false)
    }
  }
  const [mine] = createResource(
    () => mode() === "add",
    async (on) => {
      if (!on) return null
      try {
        return (await (await props.doFetch("/iris/agents-mine")).json()) as Mine
      } catch (e) {
        return { measured: false, reason: e instanceof Error ? e.message : String(e) } as Mine
      }
    },
  )
  const addable = () => (mine()?.agents ?? []).filter((a) => !props.agents.some((x) => x.id === String(a.id)))
  const lead = () => props.agents.find((a) => a.role === "lead")

  return (
    <aside class="sr-agents-drawer" data-component="room-agents" aria-label="Agents in this room">
      <header class="sr-agents-head">
        <div>
          <div class="sr-eyebrow">Room agents</div>
          <h3 class="sr-agents-title">{props.agents.length ? `${props.agents.length} in this room` : "No agents yet"}</h3>
        </div>
        <button class="sr-iconbtn" aria-label="Close" title="Close" onClick={() => props.onClose()}>
          <Icon name="close" size="small" />
        </button>
      </header>

      <Show when={mode() === "create"}>
        <div class="sr-agents-editor">
          <IrisAgentEditor
            doFetch={props.doFetch}
            bloqId={props.project?.id ?? null}
            bloqName={props.project?.name}
            boards={() => (props.project ? [props.project] : [])}
            onClose={() => setMode("list")}
            onSaved={(a) => {
              if (!a.created) return
              // A new agent joins the room as soon as it exists — the lead if the room has none.
              void post(base(), { agentId: a.id, role: lead() ? "participant" : "lead", autoRespond: false }).then(() => setMode("list"))
            }}
          />
        </div>
      </Show>

      <Show when={mode() !== "create"}>
        <div class="sr-agents-body">
          <p class="sr-agents-how">
            A message to the room goes to the <b>lead</b>{lead() ? ` (${lead()!.name})` : ""}, which hands parts to the others by
            @mention. @mention any agent to reach only it. Agents can hand work on up to 3 times and 6 replies per message, then
            the room waits for you.
          </p>

          <For each={props.agents}>
            {(a) => (
              <div class="sr-agent-card" data-open={open() === a.id ? "" : undefined}>
                <button class="sr-agent-card-row" onClick={() => setOpen(open() === a.id ? null : a.id)} aria-expanded={open() === a.id}>
                  <span class="sr-agent-card-name">{a.name}</span>
                  <Show when={a.role === "lead"}>
                    <span class="sr-chip" data-tone="good">Lead</span>
                  </Show>
                  <span class="sr-agent-card-model">{a.model ? modelLabel(a.model) : "default model"}</span>
                  <span class="sr-agent-card-mode">{a.role === "lead" ? "gets every message" : a.autoRespond ? "answers everything" : "when @mentioned"}</span>
                </button>
                <Show when={open() === a.id && props.canManage}>
                  <div class="sr-agent-card-actions">
                    <Show when={a.role !== "lead"}>
                      <button class="sr-btn" disabled={busy()} onClick={() => void post(`${base()}/${a.id}`, { role: "lead" })}>
                        Make lead
                      </button>
                      <button class="sr-btn" disabled={busy()} onClick={() => void post(`${base()}/${a.id}`, { autoRespond: !a.autoRespond })}>
                        {a.autoRespond ? "Only when @mentioned" : "Answer everything"}
                      </button>
                    </Show>
                    <Show when={a.role === "lead"}>
                      <button class="sr-btn" disabled={busy()} onClick={() => void post(`${base()}/${a.id}`, { role: "participant" })}>
                        No longer lead
                      </button>
                    </Show>
                    <button class="sr-btn" data-tone="bad" disabled={busy()} onClick={() => void post(`${base()}/${a.id}/remove`, {})}>
                      Remove
                    </button>
                  </div>
                </Show>
              </div>
            )}
          </For>

          <Show when={props.canManage}>
            <Show
              when={mode() === "add"}
              fallback={
                <div class="sr-agents-adds">
                  <button class="sr-share-go" onClick={() => setMode("add")}>
                    Add one of my agents
                  </button>
                  <button class="sr-btn" disabled={!props.project} title={props.project ? "" : "Share the room with a project first"} onClick={() => setMode("create")}>
                    Create a new agent
                  </button>
                </div>
              }
            >
              <div class="sr-agents-pick">
                <div class="sr-share-label">Your agents</div>
                <Show when={!mine.loading} fallback={<div class="sr-share-hint">Loading your agents…</div>}>
                  <Show
                    when={addable().length}
                    fallback={
                      <div class="sr-share-hint">
                        {mine()?.measured === false ? `Your agents could not load (${mine()?.reason}).` : "All your agents are already here."}
                      </div>
                    }
                  >
                    <For each={addable()}>
                      {(a) => (
                        <div class="sr-agents-pick-row">
                          <span class="sr-add-label">{a.name}</span>
                          <button class="sr-btn" disabled={busy()} onClick={() => void post(base(), { agentId: a.id, role: lead() ? "participant" : "lead", autoRespond: false })}>
                            {lead() ? "Add" : "Add as lead"}
                          </button>
                        </div>
                      )}
                    </For>
                  </Show>
                </Show>
                <button class="sr-btn" onClick={() => setMode("list")}>
                  Done
                </button>
              </div>
            </Show>
          </Show>
          <Show when={!props.canManage}>
            <p class="sr-share-hint">Only the room's owner adds and sets up its agents.</p>
          </Show>

          <Show when={note()}>
            {(n) => (
              <div class="sr-note" data-tone={n().tone}>
                {n().text}
              </div>
            )}
          </Show>
        </div>
      </Show>
    </aside>
  )
}
