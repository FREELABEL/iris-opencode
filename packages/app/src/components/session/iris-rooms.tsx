import { createEffect, createMemo, createResource, createSignal, For, Show } from "solid-js"
import { renderMarkdown } from "./iris-item"
import {
  insertMention,
  mentionQuery,
  mentionSuggestions,
  recipientsLine,
  sentToLine,
  sortMessages,
  type Room,
  type RoomAgent,
  type RoomMessage,
} from "./iris-rooms-model"

/**
 * Agents › Rooms (#186511): threaded multi-agent chat with @mention.
 *
 * A room is an iris-api thread — the same one `iris agents thread` and Elon read — so a
 * conversation here continues there. The pane never keeps its own copy of the thread: after a
 * send it re-reads the room, so what you see is exactly what a reload would show.
 *
 * Addressing is visible at both ends. Before sending, the line under the composer says who the
 * draft reaches — including the zero-@mention default ("Patty will answer (room default)") or a
 * warning when nobody would. After sending, each message shows who the SERVER resolved it to,
 * and each reply says which message it answers.
 */

type Fetch = (path: string, init?: RequestInit) => Promise<Response>
type RoomsPayload = { measured: boolean; reason?: string; rooms: Room[] }
type RoomPayload = { measured: boolean; reason?: string; room: Room | null; messages: RoomMessage[] }
type BoardAgent = { id: number; name: string }

const SELECTED_KEY = "iris.rooms.selected"
const remembered = () => {
  try {
    return localStorage.getItem(SELECTED_KEY) ?? undefined
  } catch {
    return undefined
  }
}

export function IrisRooms(props: { doFetch: Fetch; bloqId?: number }) {
  const json = async <T,>(path: string, init?: RequestInit): Promise<T> => {
    const res = await props.doFetch(path, init)
    return (await res.json()) as T
  }
  const post = <T,>(path: string, body: unknown) =>
    json<T>(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })

  const [rooms, { refetch: refetchRooms }] = createResource(() => json<RoomsPayload>("/iris/rooms"))
  const [selected, setSelected] = createSignal<string | undefined>(remembered())
  const choose = (id: string | undefined) => {
    setSelected(id)
    try {
      if (id) localStorage.setItem(SELECTED_KEY, id)
      else localStorage.removeItem(SELECTED_KEY)
    } catch {}
  }
  // A remembered room that no longer exists falls back to the newest one, not to an empty pane.
  createEffect(() => {
    const list = rooms.latest?.rooms
    if (!list) return
    if (list.length && !list.some((r) => r.id === selected())) choose(list[0].id)
  })

  const [thread, { refetch: refetchThread }] = createResource(selected, (id) =>
    json<RoomPayload>(`/iris/rooms/${encodeURIComponent(id)}`),
  )
  const room = createMemo(() => thread.latest?.room ?? rooms.latest?.rooms.find((r) => r.id === selected()))
  const agents = createMemo<RoomAgent[]>(() => room()?.agents ?? [])
  const messages = createMemo(() => sortMessages(thread.latest?.messages ?? []))
  const byId = createMemo(() => new Map(messages().map((m) => [m.id, m])))

  // ── composer ───────────────────────────────────────────────────────────
  const [text, setText] = createSignal("")
  const [caret, setCaret] = createSignal(0)
  const [pending, setPending] = createSignal<{ text: string; waitingOn: string } | null>(null)
  const [note, setNote] = createSignal<string | null>(null)
  let input: HTMLTextAreaElement | undefined
  let scroller: HTMLDivElement | undefined

  const query = createMemo(() => mentionQuery(text().slice(0, caret())))
  const suggestions = createMemo(() => {
    const q = query()
    return q === undefined ? [] : mentionSuggestions(q, agents())
  })
  const recipients = createMemo(() => recipientsLine(text(), agents()))

  createEffect(() => {
    messages().length
    pending()
    if (scroller) scroller.scrollTop = scroller.scrollHeight
  })

  function pick(a: RoomAgent) {
    const r = insertMention(text(), caret(), a.name)
    setText(r.text)
    setCaret(r.caret)
    queueMicrotask(() => {
      input?.focus()
      input?.setSelectionRange(r.caret, r.caret)
    })
  }

  async function send() {
    const id = selected()
    const body = text().trim()
    if (!id || !body || pending()) return
    setNote(null)
    // Say who we are waiting on — N addressees is N model calls, answered in one response.
    setPending({ text: body, waitingOn: recipientsLine(body, agents()).text })
    setText("")
    setCaret(0)
    try {
      const out = await post<{ ok: boolean; reason?: string; replies: RoomMessage[] }>(
        `/iris/rooms/${encodeURIComponent(id)}/messages`,
        { text: body },
      )
      if (!out.ok) {
        setText(body)
        setNote(out.reason ?? "not sent")
      } else if (out.replies.length === 0) {
        setNote("sent — no agent answered")
      }
    } catch (e) {
      setText(body)
      setNote(e instanceof Error ? e.message : String(e))
    }
    // Re-read, never append: the room as the server stores it IS the thread a reload shows.
    await refetchThread()
    setPending(null)
    void refetchRooms()
  }

  // ── new room ───────────────────────────────────────────────────────────
  const [creating, setCreating] = createSignal(false)
  const [newName, setNewName] = createSignal("")
  const [picked, setPicked] = createSignal<string[]>([])
  const [boardAgents] = createResource(
    () => (creating() && props.bloqId ? props.bloqId : undefined),
    (b) => json<{ agents: BoardAgent[] }>(`/iris/agents/${b}?perPage=100`),
  )
  const togglePick = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]))

  async function create() {
    if (!picked().length) return setNote("pick at least one agent")
    const out = await post<{ ok: boolean; reason?: string; room?: Room }>(`/iris/rooms`, {
      name: newName().trim() || "Room",
      agentIds: picked(),
    })
    if (!out.ok || !out.room) return setNote(out.reason ?? "could not create the room")
    setCreating(false)
    setNewName("")
    setPicked([])
    await refetchRooms()
    choose(out.room.id)
  }

  return (
    <div class="iris-rooms">
      <div class="iris-rooms__bar">
        <select
          class="iris-field__input"
          aria-label="Room"
          value={selected() ?? ""}
          onChange={(e) => choose(e.currentTarget.value || undefined)}
        >
          <Show when={!rooms.latest?.rooms.length}>
            <option value="">No rooms yet</option>
          </Show>
          <For each={rooms.latest?.rooms ?? []}>{(r) => <option value={r.id}>{r.name}</option>}</For>
        </select>
        <button type="button" class="iris-card__linkbtn" onClick={() => setCreating((c) => !c)}>
          {creating() ? "Cancel" : "New room"}
        </button>
        <button
          type="button"
          class="iris-card__linkbtn"
          title="Re-read the thread"
          onClick={() => void refetchThread()}
        >
          ↻
        </button>
      </div>

      <Show when={rooms.latest && !rooms.latest.measured}>
        <p class="iris-rooms__note">Could not read rooms — {rooms.latest?.reason}</p>
      </Show>

      <Show when={creating()}>
        <div class="iris-rooms__create">
          <input
            class="iris-field__input"
            placeholder="Room name"
            aria-label="Room name"
            value={newName()}
            onInput={(e) => setNewName(e.currentTarget.value)}
          />
          <p class="iris-rooms__hint">
            The first agent you pick is the room's primary: it answers any message that @mentions nobody.
          </p>
          <Show
            when={props.bloqId}
            fallback={<p class="iris-rooms__note">Pick a board first — its agents are the ones you can add.</p>}
          >
            <div class="iris-rooms__picks">
              <For each={boardAgents.latest?.agents ?? []}>
                {(a) => (
                  <label class="iris-rooms__pick">
                    <input
                      type="checkbox"
                      checked={picked().includes(String(a.id))}
                      onChange={() => togglePick(String(a.id))}
                    />
                    <span>{a.name}</span>
                    <Show when={picked()[0] === String(a.id)}>
                      <span class="iris-rooms__tag">primary</span>
                    </Show>
                  </label>
                )}
              </For>
            </div>
          </Show>
          <button
            type="button"
            class="iris-card__linkbtn iris-card__linkbtn--primary"
            disabled={!picked().length}
            onClick={() => void create()}
          >
            Create room
          </button>
        </div>
      </Show>

      <Show when={room()}>
        {(r) => (
          <p class="iris-rooms__members">
            <For each={r().agents}>
              {(a, i) => (
                <>
                  {i() > 0 ? " · " : ""}
                  {a.name}
                  <Show when={a.role === "primary"}> (primary)</Show>
                  <Show when={a.autoRespond}> (always on)</Show>
                </>
              )}
            </For>
          </p>
        )}
      </Show>

      <div class="iris-card__msgs iris-rooms__msgs" ref={scroller}>
        <Show when={thread.latest?.measured && messages().length === 0 && !pending()}>
          <p class="iris-rooms__hint">No messages yet. Type @ to address an agent.</p>
        </Show>
        <Show when={thread.latest && !thread.latest.measured}>
          <p class="iris-rooms__note">Could not read this room — {thread.latest?.reason}</p>
        </Show>
        <For each={messages()}>
          {(m) => {
            const parent = () => (m.inReplyTo ? byId().get(m.inReplyTo) : undefined)
            return (
              <div
                class="iris-card__msg"
                classList={{ "iris-card__msg--me": m.sender === "user" }}
                data-message-id={m.id}
              >
                <span class="iris-card__msgwho">
                  {m.sender === "user" ? "you" : m.senderName}
                  <Show when={sentToLine(m, agents())}>{(line) => <span class="iris-rooms__to"> {line()}</span>}</Show>
                </span>
                <Show when={parent()}>
                  {(p) => (
                    <span class="iris-rooms__re">
                      ↳ reply to {p().sender === "user" ? "you" : p().senderName}: {p().text.slice(0, 60)}
                      {p().text.length > 60 ? "…" : ""}
                    </span>
                  )}
                </Show>
                <div class="iris-card__msgtext iris-markdown" innerHTML={renderMarkdown(m.text)} />
              </div>
            )
          }}
        </For>
        <Show when={pending()}>
          {(p) => (
            <>
              <div class="iris-card__msg iris-card__msg--me">
                <span class="iris-card__msgwho">you</span>
                <div class="iris-card__msgtext">{p().text}</div>
              </div>
              <div class="iris-card__msg">
                <span class="iris-card__msgwho">waiting</span>
                <div class="iris-card__msgtext text-text-weak">{p().waitingOn}…</div>
              </div>
            </>
          )}
        </Show>
      </div>

      <Show when={note()}>
        <p class="iris-rooms__note">{note()}</p>
      </Show>

      <Show when={selected()}>
        <div class="iris-rooms__composer">
          <Show when={suggestions().length}>
            <ul class="iris-rooms__suggest" role="listbox" aria-label="Mention an agent">
              <For each={suggestions()}>
                {(a) => (
                  <li>
                    <button type="button" role="option" onMouseDown={(e) => (e.preventDefault(), pick(a))}>
                      @{a.name}
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </Show>
          <form
            class="iris-card__compose"
            onSubmit={(e) => {
              e.preventDefault()
              void send()
            }}
          >
            <textarea
              ref={input}
              class="iris-field__input iris-card__composetext"
              rows={2}
              placeholder="Message the room — @ to address an agent"
              aria-label="Message"
              value={text()}
              onInput={(e) => {
                setText(e.currentTarget.value)
                setCaret(e.currentTarget.selectionStart ?? e.currentTarget.value.length)
              }}
              onClick={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
              onKeyDown={(e) => {
                if (e.key === "Tab" && suggestions().length) {
                  e.preventDefault()
                  pick(suggestions()[0])
                  return
                }
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault()
                  void send()
                }
              }}
            />
            <button
              type="submit"
              class="iris-card__linkbtn iris-card__linkbtn--primary"
              disabled={!text().trim() || !!pending()}
            >
              {pending() ? "…" : "Send"}
            </button>
          </form>
          <p
            class="iris-rooms__recipients"
            classList={{ "iris-rooms__recipients--warn": recipients().warn }}
            data-testid="room-recipients"
          >
            {text().trim() ? recipients().text : recipientsLine("", agents()).text}
          </p>
        </div>
      </Show>
    </div>
  )
}
