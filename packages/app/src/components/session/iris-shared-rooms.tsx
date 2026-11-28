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
  agentLabel,
  facepile,
  mergeRoomTimeline,
  chainLine,
  modelLabel,
  type Chain,
  sayNote,
  typingLine,
  type Presence,
  sessionLine,
  type SayResult,
  type SessionState,
  type SharedMessage,
  type SharedRoom,
  type TranscriptEntry,
} from "./iris-shared-rooms-model"
import { canOpenRoomTab, openSharedRoom, setSharedRooms, sharedOpenRequest } from "./iris-shared-store"
import { DialogAddAgent } from "./dialog-add-agent"
import { RoomAgentsDrawer, type CloudAgent } from "./iris-room-agents"
import { insertMention, mentionQuery, mentionSuggestions, recipientsLine } from "./iris-rooms-model"
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
type RoomPayload = {
  measured: boolean
  reason?: string
  room: SharedRoom | null
  messages: SharedMessage[]
  sessions: SessionState[]
  present?: Presence[]
  agents?: CloudAgent[]
  chain?: Chain | null
}
type PresencePayload = { measured: boolean; reason?: string; present: Presence[] }
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
      if (req && !canOpenRoomTab()) choose(req.id)
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
                        <button class="sr-row" onClick={() => (canOpenRoomTab() ? openSharedRoom(r.id, r.name) : choose(r.id))}>
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
        {(id) => (
          <SharedRoomView
            id={id()}
            doFetch={props.doFetch}
            myId={props.myId ?? null}
            layout="panel"
            onBack={() => {
              choose(null)
              void refetch()
            }}
          />
        )}
      </Show>
    </div>
  )
}

/**
 * One shared room (#194463, #194465, #194466) — every person and every agent in it, live.
 *
 * `pane`: its own tab in the main chat area, like any chat. `panel`: inside the side panel (the old
 * place, kept for the layout without tabs). Each agent in the room is followed from the computer
 * that runs it and labelled with whose it is; what people type in the room reaches every agent,
 * and is shown once. Who is here is a facepile; who is typing says so above the composer.
 */
export function SharedRoomView(props: {
  id: string
  doFetch: Fetch
  myId: number | null
  layout: "pane" | "panel"
  onBack?: () => void
  /** Told the room's name once it loads — the tab shows it. */
  onRoom?: (name: string) => void
}) {
  const dialog = useDialog()
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
  const base = () => `/iris/shared-rooms/${encodeURIComponent(props.id)}`

  const empty: RoomPayload = { measured: false, room: null, messages: [], sessions: [], present: [] }
  const [data, setData] = createSignal<RoomPayload | null>(null)
  const [now, setNow] = createSignal(new Date())
  const [draft, setDraft] = createSignal("")
  const [busy, setBusy] = createSignal<"send" | "stop" | null>(null)
  const [note, setNote] = createSignal<{ tone: "good" | "warn" | "bad"; text: string } | null>(null)
  const [chats, setChats] = createSignal<Record<string, TranscriptEntry[]>>({})
  const [troubles, setTroubles] = createSignal<Record<string, string>>({})
  const [chatLoaded, setChatLoaded] = createSignal(false)
  const [present, setPresent] = createSignal<Presence[]>([])
  const [drawer, setDrawer] = createSignal(false)
  const [caret, setCaret] = createSignal(0)
  let composer: HTMLTextAreaElement | undefined
  let scroller: HTMLDivElement | undefined
  let lastCount = 0
  const cursors = new Map<string, number>()

  // Follow the conversation while you are at the bottom of it. Whether you are is read when YOU
  // scroll, not after new messages render: a burst of agent replies (#194493) is taller than any
  // "near the bottom" margin, so measuring afterwards left the newest replies out of view.
  let pinned = true
  const onScroll = () => {
    if (scroller) pinned = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 160
  }
  const stickToBottom = (n: number, force = false) => {
    if (n !== lastCount && scroller && (pinned || force || lastCount === 0)) {
      queueMicrotask(() => {
        if (!scroller) return
        scroller.scrollTop = scroller.scrollHeight
        pinned = true
      })
    }
    lastCount = n
  }

  /** One agent's side, followed from its byte cursor, on the computer that runs it. */
  const readChat = async (sessionId: string) => {
    const since = cursors.get(sessionId)
    const t = await json<TranscriptPayload>(
      `${base()}/sessions/${encodeURIComponent(sessionId)}/transcript${since !== undefined ? `?since=${since}` : ""}`,
      undefined,
      { measured: false, entries: [], offset: null, incremental: false, reset: false, ranOn: null },
    )
    if (!t.measured) {
      setTroubles((p) => ({ ...p, [sessionId]: t.reason ?? "did not answer" }))
      return
    }
    setTroubles((p) => {
      if (!(sessionId in p)) return p
      const { [sessionId]: _, ...rest } = p
      return rest
    })
    setChats((p) => ({
      ...p,
      [sessionId]: t.incremental && !t.reset && since !== undefined ? [...(p[sessionId] ?? []), ...t.entries] : t.entries,
    }))
    if (t.offset !== null) cursors.set(sessionId, t.offset)
  }

  const load = async () => {
    const d = await json<RoomPayload>(base(), undefined, empty)
    setData(d)
    if (d.room?.name) props.onRoom?.(d.room.name)
    if (d.present) setPresent(d.present)
    setNow(new Date())
    await Promise.all((d.room?.sessionIds ?? []).map(readChat))
    setChatLoaded(true)
    stickToBottom(timeline().length)
  }

  // "I am here": every 10 s, at once when typing starts, and as "background" when not in front.
  let typingSent = 0
  const lookingNow = () => typeof document !== "undefined" && document.visibilityState === "visible" && document.hasFocus()
  const checkIn = async (typing = false) => {
    const r = await post<PresencePayload>(`${base()}/presence`, { state: lookingNow() ? "active" : "background", typing }, { measured: false, present: [] })
    if (r.measured) setPresent(r.present)
  }

  createEffect(
    on(
      () => props.id,
      () => {
        let alive = true
        lastCount = 0
        cursors.clear()
        setChats({})
        setTroubles({})
        setChatLoaded(false)
        void load()
        void checkIn()
        const t = setInterval(() => alive && void load(), FOLLOW_MS)
        const p = setInterval(() => alive && void checkIn(), 10_000)
        const onVis = () => alive && void checkIn()
        window.addEventListener("focus", onVis)
        window.addEventListener("blur", onVis)
        document.addEventListener("visibilitychange", onVis)
        onCleanup(() => {
          alive = false
          clearInterval(t)
          clearInterval(p)
          window.removeEventListener("focus", onVis)
          window.removeEventListener("blur", onVis)
          document.removeEventListener("visibilitychange", onVis)
        })
      },
    ),
  )

  const room = () => data()?.room ?? null
  const messages = () => data()?.messages ?? []
  const sessions = () => data()?.sessions ?? []
  /** The platform's cloud agents in the room (#194496), each on its own model. */
  const cloud = () => data()?.agents ?? []
  const chain = () => data()?.chain ?? null
  const modelOf = (lane?: string) => (lane?.startsWith("cloud:") ? (cloud().find((a) => `cloud:${a.id}` === lane)?.model ?? null) : null)
  // The @ picker (#194492): the cloud agents by the name they answer to.
  const mentionables = () => cloud().map((a) => ({ id: a.id, name: a.name, role: a.role, autoRespond: a.autoRespond }))
  const query = createMemo(() => mentionQuery(draft().slice(0, caret())))
  const suggestions = createMemo(() => {
    const q = query()
    return q === undefined ? [] : mentionSuggestions(q, mentionables())
  })
  const pick = (name: string) => {
    const next = insertMention(draft(), caret(), name)
    setDraft(next.text)
    setCaret(next.caret)
    queueMicrotask(() => {
      composer?.focus()
      composer?.setSelectionRange(next.caret, next.caret)
    })
  }
  const recipients = createMemo(() => (cloud().length && draft().trim() ? recipientsLine(draft(), mentionables()).text : null))
  const labelOf = (s: SessionState) => agentLabel(s, room()?.ownerName ?? null, props.myId)
  const lanes = createMemo(() =>
    sessions().map((s) => ({ sessionId: s.sessionId, label: labelOf(s), host: s.hostName ?? room()?.ownerName ?? null, entries: chats()[s.sessionId] ?? [] })),
  )
  const anyChat = () => lanes().some((l) => l.entries.length > 0)
  const allTrouble = () => sessions().length > 0 && sessions().every((s) => troubles()[s.sessionId])
  /** Every agent's chat when we can read them; what people typed in the room when we cannot. */
  const timeline = createMemo(() =>
    anyChat() || (chatLoaded() && !allTrouble())
      ? mergeRoomTimeline(lanes(), messages(), room()?.ownerName ?? null, cloud().length > 0)
      : messages().map((m) => ({
          key: m.id,
          kind: (m.kind === "event" ? "event" : m.kind === "agent" ? "agent" : "person") as "event" | "agent" | "person",
          speaker: m.senderName,
          text: m.text,
          at: m.at,
          lane: undefined as string | undefined,
        })),
  )
  const laneHue = (lane?: string) => {
    const l = lanes().find((x) => x.sessionId === lane)
    return String(hue(l?.label ?? "agent"))
  }
  const stopVisible = createMemo(() => !!room() && canStopNow(room()!, messages(), props.myId))
  const pile = createMemo(() => facepile(present(), 5))
  const typing = createMemo(() => typingLine(present(), props.myId))
  const firstTrouble = () => {
    const id = Object.keys(troubles())[0]
    if (!id) return null
    const s = sessions().find((x) => x.sessionId === id)
    return { reason: troubles()[id], who: s?.hostName ?? room()?.ownerName ?? null }
  }

  const send = async () => {
    const text = draft().trim()
    if (!text || busy()) return
    setBusy("send")
    setNote(null)
    const r = await post<SayPayload>(`${base()}/say`, { text }, { ok: false })
    setBusy(null)
    if (!r.ok || !r.result) {
      setNote({ tone: "bad", text: r.reason ?? "That did not send." })
      return
    }
    setDraft("")
    pinned = true
    typingSent = 0
    void checkIn(false)
    const tone = r.result.outcome === "delivered" ? "good" : "warn"
    const shown = { tone, text: sayNote(r.result, room()?.ownerName ?? null) + (r.result.agentsNote ? ` ${r.result.agentsNote}` : "") } as const
    setNote(shown)
    // A confirmation is a moment, not a fixture (#194566): it clears itself once read.
    if (tone === "good" || (r.result.agentsAnswered ?? 0) > 0) setTimeout(() => setNote((cur) => (cur === shown ? null : cur)), 4000)
    void load()
  }

  const stop = async () => {
    if (busy()) return
    setBusy("stop")
    const r = await post<ActionPayload>(`${base()}/stop`, {}, { ok: false })
    setBusy(null)
    setNote(r.ok ? { tone: r.message?.startsWith("Nothing") ? "warn" : "good", text: r.message || "Stopped." } : { tone: "bad", text: r.reason ?? "Stop did not go through." })
    void load()
  }

  const removeAgent = async (s: SessionState) => {
    const r = await post<ActionPayload>(`${base()}/sessions/${encodeURIComponent(s.sessionId)}/remove`, {}, { ok: false })
    setNote(r.ok ? { tone: "good", text: `${labelOf(s)} left the room. Its chat keeps running on ${s.machine ?? "its computer"}.` } : { tone: "bad", text: r.reason ?? "That did not go through." })
    void load()
  }

  const addAgent = () =>
    dialog.show(() => (
      <DialogAddAgent
        doFetch={props.doFetch}
        roomId={props.id}
        roomName={room()?.name ?? "this room"}
        inRoom={sessions().map((s) => s.sessionId)}
        onAdded={() => void load()}
      />
    ))

  return (
    <div class="sr-room-wrap" data-layout={props.layout}>
    <div class="sr-room" data-layout={props.layout}>
      <header class="sr-room-head">
        <Show when={props.onBack}>
          <button class="sr-iconbtn" aria-label="Back to shared chats" title="Back" onClick={() => props.onBack?.()}>
            <Icon name="arrow-left" size="small" />
          </button>
        </Show>
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
            <span class="sr-room-owner">{room()?.you.isOwner ? "Your room" : `${firstName(room()?.ownerName ?? null)}'s room`}</span>
            <Show when={room() && !room()!.you.canPost}>
              <span class="sr-chip" data-tone="info">
                <Icon name="eye" size="small" /> watching
              </span>
            </Show>
          </div>
        </div>
        <Show when={pile().shown.length}>
          <div class="sr-pile" role="group" aria-label={`In the room: ${present().map((p) => p.name).join(", ")}`}>
            <For each={pile().shown}>
              {(p) => (
                <span
                  class="sr-pile-face"
                  data-state={p.state}
                  title={`${p.userId === props.myId ? "You" : p.name} — ${p.state === "active" ? "here now" : "has it open"}`}
                  style={{ "--sr-hue": String(hue(p.name)) }}
                >
                  {initials(p.name)}
                </span>
              )}
            </For>
            <Show when={pile().more}>
              <span class="sr-pile-face sr-pile-more">+{pile().more}</span>
            </Show>
          </div>
        </Show>
        <Show when={props.layout === "pane"}>
          <button
            class="sr-btn sr-agents-toggle"
            aria-pressed={drawer()}
            onClick={() => setDrawer(!drawer())}
            title="Set up the agents in this room"
          >
            Agents{cloud().length ? ` · ${cloud().length}` : ""}
          </button>
        </Show>
        <Show when={(sessions().length > 0 && stopVisible()) || (chain() && (room()?.you.canStop || room()?.you.isOwner))}>
          <button class="sr-stop" disabled={busy() === "stop"} onClick={() => void stop()} title="Stop what the agents in this room are doing right now">
            <Icon name="stop" size="small" />
            {busy() === "stop" ? "Stopping…" : "Stop"}
          </button>
        </Show>
      </header>

      <div class="sr-sessions">
        {/* Only say "no live chat" once the room has answered — a loading room is not an empty one. */}
        <Show
          when={sessions().length}
          fallback={
            // Cloud agents are listed just below; only an empty room says it is empty.
            <Show when={!cloud().length}>
              <div class="sr-session" data-tone="gone">
                <span class="sr-dot" />
                {data() ? "No agent is in this room yet" : "Connecting…"}
              </div>
            </Show>
          }
        >
          <For each={sessions()}>
            {(s) => {
              const l = () => sessionLine(s, now())
              const mine = () => props.myId !== null && s.hostUserId === props.myId
              return (
                <div class="sr-session sr-agent" data-tone={l().tone}>
                  <span class="sr-dot" />
                  <span class="sr-agent-name" style={{ "--sr-hue": laneHue(s.sessionId) }}>{labelOf(s)}</span>
                  <span class="sr-session-detail">
                    {s.machine ? `on ${s.machine} · ` : ""}
                    {l().detail}
                  </span>
                  <Show when={mine() || room()?.you.isOwner}>
                    <button class="sr-agent-remove" title={`Take ${labelOf(s)} out of the room`} aria-label={`Take ${labelOf(s)} out of the room`} onClick={() => void removeAgent(s)}>
                      <Icon name="close" size="small" />
                    </button>
                  </Show>
                </div>
              )
            }}
          </For>
        </Show>
        <For each={cloud()}>
          {(a) => (
            <div class="sr-session sr-agent" data-tone="live">
              <span class="sr-dot" />
              <span class="sr-agent-name" style={{ "--sr-hue": laneHue(`cloud:${a.id}`) }}>{a.name}</span>
              <Show when={a.role === "lead" && a.name.trim().toLowerCase() !== "lead"}>
                <span class="sr-chip" data-tone="good">Lead</span>
              </Show>
              <span class="sr-session-detail">
                {a.model ? modelLabel(a.model) : "cloud agent"} · {a.role === "lead" ? "gets every message" : a.autoRespond ? "answers everything" : "when @mentioned"}
              </span>
            </div>
          )}
        </For>
        <Show when={room()?.you.canPost}>
          <button class="sr-add-agent" onClick={addAgent} title="Bring a chat from your computer into this room">
            + Add my agent
          </button>
        </Show>
      </div>

      <div class="sr-timeline" ref={scroller} onScroll={onScroll}>
        <Show when={firstTrouble() && sessions().length}>
          <div class="sr-chat-note">
            <Icon name="warning" size="small" />
            <span>
              {chatTrouble(firstTrouble()!.reason, firstTrouble()!.who)}{" "}
              {allTrouble() ? "Showing what people typed in the room until it is back." : "The other agents are still shown."}
            </span>
          </div>
        </Show>
        <Show when={data() && !timeline().length}>
          <div class="sr-empty sr-empty-inline">
            <p class="sr-empty-title">Quiet so far</p>
            <p class="sr-empty-body">What you type here reaches every agent in the room, with your name on it.</p>
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
                  <div class="sr-tool" style={{ "--sr-hue": laneHue(m.lane) }}>
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
                  <div class="sr-msg" data-grouped={grouped() ? "" : undefined} data-kind={m.kind} style={{ "--sr-hue": m.kind === "agent" ? laneHue(m.lane) : String(hue(m.speaker)) }}>
                    <Show when={!grouped()} fallback={<span class="sr-avatar-gap" />}>
                      <Show when={m.kind === "agent"} fallback={<Avatar name={m.speaker} size="sm" />}>
                        <span class="sr-agent-mark" aria-hidden="true">
                          {initials(m.speaker).slice(0, 1)}
                        </span>
                      </Show>
                    </Show>
                    <div class="sr-msg-body">
                      <Show when={!grouped()}>
                        <div class="sr-msg-head">
                          <span class="sr-msg-name">{m.speaker}</span>
                          <Show when={m.kind === "agent" && modelOf(m.lane)}>
                            <span class="sr-model-tag">{modelLabel(modelOf(m.lane))}</span>
                          </Show>
                          <Show when={m.kind === "person" && (m as { viaRoom?: boolean }).viaRoom}>
                            <span class="sr-delivered">in the room</span>
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
        <Show when={chainLine(chain())}>
          {(line) => (
            <div class="sr-chain" aria-live="polite">
              <span class="sr-pulse" aria-hidden="true" />
              {line()}
            </div>
          )}
        </Show>
        <div class="sr-typing" aria-live="polite">
          {typing() ?? ""}
        </div>
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
          <Show when={suggestions().length}>
            <div class="sr-mentions" role="listbox" aria-label="Agents to address">
              <For each={suggestions()}>
                {(a, i) => (
                  <button
                    type="button"
                    role="option"
                    aria-selected={i() === 0}
                    class="sr-mention"
                    onMouseDown={(e) => {
                      e.preventDefault()
                      pick(a.name)
                    }}
                  >
                    <span>@{a.name}</span>
                    <span class="sr-mention-model">{modelLabel(cloud().find((c) => c.id === a.id)?.model)}</span>
                  </button>
                )}
              </For>
            </div>
          </Show>
          <Show when={recipients()}>
            <div class="sr-recipients">{recipients()}</div>
          </Show>
          <div class="sr-compose">
            <textarea
              ref={composer}
              onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
              onKeyUp={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
              rows="1"
              placeholder={
                sessions().length > 1 || (cloud().length && sessions().length)
                  ? "Message everyone in the room — people and agents…"
                  : cloud().length
                    ? "Message the room — the lead takes it from here, or @mention an agent…"
                    : room()
                      ? composerHint(room()!)
                      : ""
              }
              value={draft()}
              maxLength={16000}
              onInput={(e) => {
                setDraft(e.currentTarget.value)
                setCaret(e.currentTarget.selectionStart ?? e.currentTarget.value.length)
                e.currentTarget.style.height = "auto"
                e.currentTarget.style.height = Math.min(e.currentTarget.scrollHeight, 160) + "px"
                // Tell the room you are typing — at most every 4 s, so a long message is one signal.
                if (e.currentTarget.value.trim() && Date.now() - typingSent > 4000) {
                  typingSent = Date.now()
                  void checkIn(true)
                }
              }}
              onKeyDown={(e) => {
                // The @ picker takes Enter / Tab while it is open.
                if ((e.key === "Enter" || e.key === "Tab") && suggestions().length) {
                  e.preventDefault()
                  pick(suggestions()[0].name)
                  return
                }
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
    <Show when={drawer() && props.layout === "pane"}>
      <RoomAgentsDrawer
        doFetch={props.doFetch}
        roomId={props.id}
        project={room()?.project ?? null}
        agents={cloud()}
        canManage={!!room()?.you.isOwner}
        onChanged={() => void load()}
        onClose={() => setDrawer(false)}
      />
    </Show>
    </div>
  )
}
