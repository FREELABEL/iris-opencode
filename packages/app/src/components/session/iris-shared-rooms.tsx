import { createMemo, createResource, createSignal, For, onCleanup, Show, createEffect, on, Switch, Match } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import "./iris-shared-rooms.css"
import {
  ago,
  canStopNow,
  chatTrouble,
  composerHint,
  firstName,
  groupByProject,
  initials,
  mergeTimeline,
  sayNote,
  sessionLine,
  type SayResult,
  type SessionState,
  type SharedMessage,
  type SharedRoom,
  type TranscriptEntry,
} from "./iris-shared-rooms-model"
import { setSharedRooms, sharedOpenRequest } from "./iris-shared-store"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { DialogJoinTeam } from "./dialog-join-team"

/**
 * Agents › Shared (#194307) — the live chats your team shared with your Atlas projects.
 *
 * List ⇄ room, like Hive › Sessions. A room follows itself every 3 s while it is open (the server
 * authorises the live channel too; polling keeps this pane self-contained). What you can do is the
 * server's answer, read from the room (`you`): a viewer gets no composer, Stop shows only to the
 * people who may press it. Words are for people: "Alex's chat", "asleep for 40 min".
 */

type Fetch = (path: string, init?: RequestInit) => Promise<Response>
type ListPayload = { measured: boolean; reason?: string; rooms: SharedRoom[] }
type RoomPayload = { measured: boolean; reason?: string; room: SharedRoom | null; messages: SharedMessage[]; sessions: SessionState[] }
type SayPayload = { ok: boolean; reason?: string; result?: SayResult }
type ActionPayload = { ok: boolean; reason?: string; message?: string }
type TranscriptPayload = { measured: boolean; reason?: string; entries: TranscriptEntry[]; offset: number | null; incremental: boolean; reset: boolean; ranOn: string | null }

const OPEN_KEY = "iris.shared.open"
// Matches the server's shared-read window (ROOM_TRANSCRIPT_SHARE_SECONDS): a faster poll would only
// re-read the same shared answer.
const FOLLOW_MS = 4000
const ACTIVE_MS = 10 * 60 * 1000

/** A stable, gentle hue per name, so a person is the same colour everywhere in the pane. */
function hue(name: string): number {
  let h = 0
  for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) % 360
  return h
}

function Avatar(props: { name: string; size?: "sm" | "md" }) {
  return (
    <span class="sr-avatar" data-size={props.size ?? "md"} style={{ "--sr-hue": String(hue(props.name)) }} aria-hidden="true">
      {initials(props.name)}
    </span>
  )
}

export function IrisSharedRooms(props: { doFetch: Fetch; myId?: number | null }) {
  const json = async <T,>(path: string, init?: RequestInit, fallback?: T): Promise<T> => {
    try {
      const res = await props.doFetch(path, init)
      return (await res.json()) as T
    } catch (e) {
      if (fallback !== undefined) return { ...(fallback as object), reason: e instanceof Error ? e.message : String(e) } as T
      throw e
    }
  }
  const post = <T,>(path: string, body: unknown, fallback: T) =>
    json<T>(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, fallback)

  const dialog = useDialog()
  const [list, { refetch }] = createResource(() => json<ListPayload>("/iris/shared-rooms", undefined, { measured: false, rooms: [] }))
  const listTimer = setInterval(() => void refetch(), 30_000)
  onCleanup(() => clearInterval(listTimer))

  const [open, setOpen] = createSignal<string | null>((() => {
    try {
      return localStorage.getItem(OPEN_KEY)
    } catch {
      return null
    }
  })())
  const choose = (id: string | null) => {
    setOpen(id)
    try {
      id ? localStorage.setItem(OPEN_KEY, id) : localStorage.removeItem(OPEN_KEY)
    } catch {}
  }

  // Keep the app-wide list (titlebar pill, chat markers) in step with what this pane read.
  createEffect(() => {
    const l = list()
    if (l?.measured) setSharedRooms(l.rooms ?? [])
  })
  // "Open this room" from anywhere else in the app (a chat's Shared marker, the share dialog).
  createEffect(
    on(sharedOpenRequest, (req) => {
      if (req) choose(req.id)
    }),
  )

  const groups = createMemo(() => groupByProject(list()?.rooms ?? []))
  const total = createMemo(() => (list()?.rooms ?? []).length)

  return (
    <div class="sr iris-ui">
      <Show
        when={open()}
        fallback={
          <div class="sr-list">
            <header class="sr-head">
              <div>
                <div class="sr-eyebrow">Shared with your team</div>
                <h2 class="sr-title">
                  Live chats
                  <Show when={total() > 0}>
                    <span class="sr-count">{total()}</span>
                  </Show>
                </h2>
              </div>
              <button class="sr-btn sr-join-btn" onClick={() => dialog.show(() => <DialogJoinTeam doFetch={props.doFetch} />)}>
                Join a team…
              </button>
              <button class="sr-iconbtn" title="Refresh" aria-label="Refresh" onClick={() => void refetch()}>
                <Icon name="refresh" size="small" />
              </button>
            </header>

            <Show when={list()?.reason && !(list()?.rooms ?? []).length}>
              <div class="sr-empty">
                <p class="sr-empty-title">Shared chats could not load</p>
                <p class="sr-empty-body">{list()?.reason}</p>
                <button class="sr-btn" onClick={() => void refetch()}>
                  Try again
                </button>
              </div>
            </Show>

            <Show when={!list.loading && !list()?.reason && total() === 0}>
              <div class="sr-empty">
                <div class="sr-empty-mark" aria-hidden="true">
                  <span /> <span /> <span />
                </div>
                <p class="sr-empty-title">Nothing shared with you yet</p>
                <p class="sr-empty-body">
                  When someone shares a chat with one of your projects, it shows up here — live, as it happens.
                </p>
                <p class="sr-empty-hint">Share one of yours from its ⋯ menu → Share with team.</p>
              </div>
            </Show>

            <For each={groups()}>
              {(g) => (
                <section class="sr-group">
                  <div class="sr-group-head">
                    <span class="sr-proj-dot" style={{ "--sr-hue": String(hue(g.project.name)) }} aria-hidden="true" />
                    <span class="sr-group-name">{g.project.name}</span>
                    <span class="sr-group-n">{g.rooms.length}</span>
                  </div>
                  <For each={g.rooms}>
                    {(r) => {
                      const active = () => !!r.updatedAt && Date.now() - new Date(r.updatedAt).getTime() < ACTIVE_MS
                      return (
                        <button class="sr-row" onClick={() => choose(r.id)}>
                          <Avatar name={r.ownerName ?? "?"} />
                          <span class="sr-row-main">
                            <span class="sr-row-name">{r.name}</span>
                            <span class="sr-row-sub">
                              {r.you.isOwner ? "Your chat" : `${firstName(r.ownerName)}'s chat`}
                              {r.sessionIds.length > 1 ? ` · ${r.sessionIds.length} chats` : ""}
                            </span>
                          </span>
                          <span class="sr-row-side">
                            <Show when={active()}>
                              <span class="sr-live" title="Active in the last 10 minutes">
                                <span class="sr-pulse" /> active
                              </span>
                            </Show>
                            <span class="sr-time">{ago(r.updatedAt ?? "")}</span>
                            <Icon name="chevron-right" size="small" />
                          </span>
                        </button>
                      )
                    }}
                  </For>
                </section>
              )}
            </For>
          </div>
        }
      >
        {(id) => <Room id={id()} json={json} post={post} myId={props.myId ?? null} onBack={() => { choose(null); void refetch() }} />}
      </Show>
    </div>
  )
}

function Room(props: {
  id: string
  myId: number | null
  json: <T>(path: string, init?: RequestInit, fallback?: T) => Promise<T>
  post: <T>(path: string, body: unknown, fallback: T) => Promise<T>
  onBack: () => void
}) {
  const empty: RoomPayload = { measured: false, room: null, messages: [], sessions: [] }
  const [data, setData] = createSignal<RoomPayload | null>(null)
  const [now, setNow] = createSignal(new Date())
  const [draft, setDraft] = createSignal("")
  const [busy, setBusy] = createSignal<"send" | "stop" | null>(null)
  const [note, setNote] = createSignal<{ tone: "good" | "warn" | "bad"; text: string } | null>(null)
  const [chat, setChat] = createSignal<TranscriptEntry[]>([])
  const [chatReason, setChatReason] = createSignal<string | null>(null)
  const [chatLoaded, setChatLoaded] = createSignal(false)
  let scroller: HTMLDivElement | undefined
  let lastCount = 0
  let cursor: number | null = null
  let following: string | null = null

  const stickToBottom = (n: number) => {
    if (n !== lastCount && scroller) {
      const near = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120
      if (near || lastCount === 0) queueMicrotask(() => scroller && (scroller.scrollTop = scroller.scrollHeight))
    }
    lastCount = n
  }

  /** The agent's side: the first session's transcript, followed from a byte cursor. */
  const readChat = async (sessionId: string) => {
    if (following !== sessionId) {
      following = sessionId
      cursor = null
      setChat([])
      setChatLoaded(false)
    }
    const q = cursor !== null ? `?since=${cursor}` : ""
    const t = await props.json<TranscriptPayload>(
      `/iris/shared-rooms/${encodeURIComponent(props.id)}/sessions/${encodeURIComponent(sessionId)}/transcript${q}`,
      undefined,
      { measured: false, entries: [], offset: null, incremental: false, reset: false, ranOn: null },
    )
    setChatLoaded(true)
    if (!t.measured) {
      setChatReason(t.reason ?? "The computer running this chat did not answer.")
      return
    }
    setChatReason(null)
    setChat((prev) => (t.incremental && !t.reset && cursor !== null ? [...prev, ...t.entries] : t.entries))
    if (t.offset !== null) cursor = t.offset
  }

  const load = async () => {
    const d = await props.json<RoomPayload>(`/iris/shared-rooms/${encodeURIComponent(props.id)}`, undefined, empty)
    setData(d)
    setNow(new Date())
    const first = d.room?.sessionIds[0]
    if (first) await readChat(first)
    stickToBottom(timeline().length)
  }
  createEffect(
    on(
      () => props.id,
      () => {
        let alive = true
        lastCount = 0
        void load()
        const t = setInterval(() => alive && void load(), FOLLOW_MS)
        onCleanup(() => {
          alive = false
          clearInterval(t)
        })
      },
    ),
  )

  const room = () => data()?.room ?? null
  const messages = () => data()?.messages ?? []
  /** The chat when we can read it; what people typed in the room when we cannot. */
  const timeline = createMemo(() =>
    chat().length || (chatLoaded() && !chatReason())
      ? mergeTimeline(chat(), messages(), room()?.ownerName ?? null)
      : messages().map((m) => ({
          key: m.id,
          kind: (m.kind === "event" ? "event" : m.kind === "agent" ? "agent" : "person") as "event" | "agent" | "person",
          speaker: m.senderName,
          text: m.text,
          at: m.at,
        })),
  )
  const stopVisible = createMemo(() => !!room() && canStopNow(room()!, messages(), props.myId))

  const send = async () => {
    const text = draft().trim()
    if (!text || busy()) return
    setBusy("send")
    setNote(null)
    const r = await props.post<SayPayload>(`/iris/shared-rooms/${encodeURIComponent(props.id)}/say`, { text }, { ok: false })
    setBusy(null)
    if (!r.ok || !r.result) {
      setNote({ tone: "bad", text: r.reason ?? "That did not send." })
      return
    }
    setDraft("")
    const tone = r.result.outcome === "delivered" ? "good" : "warn"
    setNote({ tone, text: sayNote(r.result, room()?.ownerName ?? null) + (r.result.agentsNote ? ` ${r.result.agentsNote}` : "") })
    void load()
  }

  const stop = async () => {
    if (busy()) return
    setBusy("stop")
    const r = await props.post<ActionPayload>(`/iris/shared-rooms/${encodeURIComponent(props.id)}/stop`, {}, { ok: false })
    setBusy(null)
    setNote(r.ok ? { tone: r.message?.startsWith("Nothing") ? "warn" : "good", text: r.message || "Stopped." } : { tone: "bad", text: r.reason ?? "Stop did not go through." })
    void load()
  }

  return (
    <div class="sr-room">
      <header class="sr-room-head">
        <button class="sr-iconbtn" aria-label="Back to shared chats" title="Back" onClick={props.onBack}>
          <Icon name="arrow-left" size="small" />
        </button>
        <div class="sr-room-title">
          <h2>{room()?.name ?? ""}</h2>
          <div class="sr-room-meta" style={{ visibility: room() ? "visible" : "hidden" }}>
            <Show when={room()?.project}>
              {(p) => (
                <span class="sr-chip">
                  <span class="sr-proj-dot" style={{ "--sr-hue": String(hue(p().name)) }} aria-hidden="true" />
                  {p().name}
                </span>
              )}
            </Show>
            <span class="sr-room-owner">{room()?.you.isOwner ? "Your chat" : `${firstName(room()?.ownerName ?? null)}'s chat`}</span>
            <Show when={room() && !room()!.you.canPost}>
              <span class="sr-chip" data-tone="info">
                <Icon name="eye" size="small" /> watching
              </span>
            </Show>
          </div>
        </div>
        <Show when={stopVisible()}>
          <button class="sr-stop" disabled={busy() === "stop"} onClick={() => void stop()} title="Stop what this chat is doing right now">
            <Icon name="stop" size="small" />
            {busy() === "stop" ? "Stopping…" : "Stop"}
          </button>
        </Show>
      </header>

      <div class="sr-sessions">
        {/* Only say "no live chat" once the room has answered — a loading room is not an empty one. */}
        <Show
          when={(data()?.sessions ?? []).length}
          fallback={
            <div class="sr-session" data-tone="gone">
              <span class="sr-dot" />
              {data() ? "No live chat is connected to this room" : "Connecting…"}
            </div>
          }
        >
          <For each={data()?.sessions ?? []}>
            {(s) => {
              const l = () => sessionLine(s, now())
              return (
                <div class="sr-session" data-tone={l().tone}>
                  <span class="sr-dot" />
                  <span class="sr-session-text">{l().text}</span>
                  <span class="sr-session-detail">{l().detail}</span>
                </div>
              )
            }}
          </For>
        </Show>
      </div>

      <div class="sr-timeline" ref={scroller}>
        <Show when={chatReason() && room()?.sessionIds.length}>
          <div class="sr-chat-note">
            <Icon name="warning" size="small" />
            <span>
              {chatTrouble(chatReason(), room()?.ownerName ?? null)} Showing what people typed in the room until it is back.
            </span>
          </div>
        </Show>
        <Show when={data() && !timeline().length}>
          <div class="sr-empty sr-empty-inline">
            <p class="sr-empty-title">Quiet so far</p>
            <p class="sr-empty-body">Messages typed here go straight into the live chat, with your name on them.</p>
          </div>
        </Show>
        <For each={timeline()}>
          {(m, i) => {
            const prev = () => timeline()[i() - 1]
            const grouped = () => !!prev() && prev()!.kind === m.kind && prev()!.speaker === m.speaker && (m.kind === "person" || m.kind === "agent")
            return (
              <Switch>
                <Match when={m.kind === "event"}>
                  <div class="sr-event">
                    <Icon name="stop" size="small" />
                    <span>{m.text}</span>
                    <span class="sr-time">{ago(m.at, now())}</span>
                  </div>
                </Match>
                <Match when={m.kind === "tool"}>
                  <div class="sr-tool">
                    <span class="sr-tool-dot" />
                    {m.text}
                  </div>
                </Match>
                <Match when={m.kind === "note"}>
                  <div class="sr-msg" data-kind="note">
                    <Avatar name={m.speaker} size="sm" />
                    <div class="sr-msg-body">
                      <div class="sr-msg-head">
                        <span class="sr-msg-name">{m.speaker}</span>
                        <span class="sr-time">{ago(m.at, now())}</span>
                        <span class="sr-held">only in the room</span>
                      </div>
                      <div class="sr-bubble">{m.text}</div>
                    </div>
                  </div>
                </Match>
                <Match when={true}>
                  <div class="sr-msg" data-grouped={grouped() ? "" : undefined} data-kind={m.kind}>
                    <Show when={!grouped()} fallback={<span class="sr-avatar-gap" />}>
                      <Show when={m.kind === "agent"} fallback={<Avatar name={m.speaker} size="sm" />}>
                        <span class="sr-agent-mark" aria-hidden="true">
                          <span />
                          <span />
                          <span />
                          <span />
                        </span>
                      </Show>
                    </Show>
                    <div class="sr-msg-body">
                      <Show when={!grouped()}>
                        <div class="sr-msg-head">
                          <span class="sr-msg-name">{m.kind === "agent" ? "Agent" : m.speaker}</span>
                          <Show when={m.kind === "person" && (m as { viaRoom?: boolean }).viaRoom}>
                            <span class="sr-delivered">from the room</span>
                          </Show>
                          <span class="sr-time">{ago(m.at, now())}</span>
                        </div>
                      </Show>
                      <div class="sr-bubble">{m.text}</div>
                    </div>
                  </div>
                </Match>
              </Switch>
            )
          }}
        </For>
      </div>

      <footer class="sr-compose-wrap">
        <Show when={note()}>
          {(n) => (
            <div class="sr-note" data-tone={n().tone}>
              {n().text}
            </div>
          )}
        </Show>
        <Show
          when={room()?.you.canPost}
          fallback={
            <div class="sr-watch-only">
              <Icon name="eye" size="small" />
              <span>{room() ? composerHint(room()!) : ""}</span>
            </div>
          }
        >
          <div class="sr-compose">
            <textarea
              rows="1"
              placeholder={room() ? composerHint(room()!) : ""}
              value={draft()}
              maxLength={16000}
              onInput={(e) => {
                setDraft(e.currentTarget.value)
                e.currentTarget.style.height = "auto"
                e.currentTarget.style.height = Math.min(e.currentTarget.scrollHeight, 160) + "px"
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault()
                  void send()
                }
              }}
            />
            <button class="sr-send" disabled={!draft().trim() || busy() === "send"} onClick={() => void send()} aria-label="Send">
              <Icon name="send" size="small" />
            </button>
          </div>
        </Show>
      </footer>
    </div>
  )
}
