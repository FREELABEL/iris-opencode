/**
 * Live follow of a session on another machine (epic #192964, W1).
 *
 * Before this, `iris hive ask` read the transcript through the cloud every 2 s, and every read was a
 * `sessions.history` NodeTask on the machine holding the session. Measured 2026-11-09: 20 tasks a
 * minute for one follower, with words arriving 1.7 s (p50) to 3.3 s (max) after they were typed.
 *
 * Now the follower asks the platform to follow (`POST /sessions/{id}/follow`), and the daemon on that
 * machine pushes what is appended to `private-hive-session.{node}.{session}`. Only members of that
 * node's Hive can subscribe there. The follower reads the stream. If the socket is down, it says
 * "live paused — polling" and falls back to the transcript poll until the socket returns.
 *
 * Three parts, all here so the protocol has one reader:
 *   applyEnvelope  pure: what one envelope does to what the follower has (cursors, gaps, snapshots)
 *   PusherSocket   the Pusher wire protocol over the runtime's own WebSocket, with no dependency
 *   followLive     the follow: subscribe, renew, detect gaps, fall back, recover
 */

import type { TranscriptMessage } from "./hive-chat-follow"

// ─── The envelope (ADR-02) ─────────────────────────────────────────────────────────────────────

export type Envelope = {
  v: number
  kind: "snapshot" | "delta" | "ping"
  node_id: string
  session_id: string
  seq: number
  /** Byte cursors into the transcript: this flush covers [from, to). */
  from: number
  to: number
  /** "none" today. #833 phase 2.2 puts a cipher id here and ciphertext in `body`. */
  enc: string
  body: string
  final?: boolean
}

export type LiveState = {
  /** Cursor after the last complete flush applied, or null before the first snapshot. */
  to: number | null
  messages: TranscriptMessage[]
  /** Inside a multi-envelope snapshot. */
  snapshotOpen: boolean
  /** Saw a gap: ignore deltas until a snapshot (or a fetch) puts us back on a cursor. */
  needsResync: boolean
}

export const newLiveState = (): LiveState => ({ to: null, messages: [], snapshotOpen: false, needsResync: false })

export type Applied = {
  /** New messages, in order. On `reset` these are ALL the messages. */
  appended: TranscriptMessage[]
  /** The follower's view was replaced (first snapshot, or a resync). */
  reset: boolean
  /** A gap was detected: ask for a snapshot. */
  resync: boolean
  /** A message was too big to push; read [since, …) through the API. */
  fetchSince?: number
}

function decode(env: Envelope): TranscriptMessage[] | null {
  // An encoding this client does not know is NOT an empty message list: say nothing, ask again.
  if (env.enc !== "none") return null
  try {
    const v = JSON.parse(env.body || "[]")
    return Array.isArray(v) ? v : null
  } catch {
    return null
  }
}

/**
 * Apply one envelope. Pure. Envelopes from one flush share `from`/`to`, and only the last has
 * `final`, so the cursor moves on `final` and a chunk in the middle is checked against the SAME
 * cursor as the first.
 */
export function applyEnvelope(state: LiveState, env: Envelope): Applied {
  const none: Applied = { appended: [], reset: false, resync: false }
  if (!env || env.v !== 1) return none

  if (env.kind === "snapshot") {
    // A snapshot sent for ANOTHER follower is noise to one already on the cursor.
    const accepting = state.to === null || state.needsResync || state.snapshotOpen
    if (!accepting) return none
    const msgs = decode(env)
    if (!msgs) return { ...none, resync: true }
    const first = !state.snapshotOpen
    if (first) state.messages = []
    state.messages.push(...msgs)
    state.snapshotOpen = !env.final
    if (env.final) {
      state.to = env.to
      state.needsResync = false
    }
    return { appended: first ? [...state.messages] : msgs, reset: first, resync: false }
  }

  // delta / ping: needs a base, and must continue from exactly where we are.
  if (state.to === null || state.needsResync) return none
  if (env.from < state.to) return none // already have it (a duplicate, or a snapshot overtook it)
  if (env.from > state.to) {
    state.needsResync = true
    return { ...none, resync: true }
  }

  if (env.kind === "ping") {
    if (env.final) state.to = env.to
    return { ...none, fetchSince: env.from }
  }

  const msgs = decode(env)
  if (!msgs) {
    state.needsResync = true
    return { ...none, resync: true }
  }
  state.messages.push(...msgs)
  if (env.final) state.to = env.to
  return { appended: msgs, reset: false, resync: false }
}

// ─── Pusher, the wire protocol ────────────────────────────────────────────────────────────────

type WSLike = {
  send(data: string): void
  close(): void
  onopen: ((ev: any) => void) | null
  onmessage: ((ev: { data: any }) => void) | null
  onclose: ((ev: any) => void) | null
  onerror: ((ev: any) => void) | null
}
export type WSFactory = (url: string) => WSLike

/**
 * The part of Pusher a follower needs: connect, subscribe to ONE private channel, receive events,
 * answer pings. It is about 80 lines, and the compiled CLI ships no extra dependency for it.
 * Reconnects with backoff, and tells the owner every time it goes up or down.
 */
export class PusherSocket {
  private ws: WSLike | null = null
  private closed = false
  private backoff = 500
  private socketId: string | null = null
  private pingTimer: ReturnType<typeof setTimeout> | null = null
  private idleMs = 120_000

  constructor(
    private o: {
      url: string
      channel: string
      authorize: (socketId: string, channel: string) => Promise<string>
      onEvent: (event: string, data: any) => void
      onUp: () => void
      onDown: (why: string) => void
      ws?: WSFactory
    },
  ) {}

  open() {
    this.closed = false
    const make: WSFactory = this.o.ws ?? ((u) => new (globalThis as any).WebSocket(u))
    let ws: WSLike
    try {
      ws = make(this.o.url)
    } catch (e: any) {
      this.down(`cannot open a socket: ${e?.message ?? e}`)
      return
    }
    this.ws = ws
    ws.onmessage = (ev) => this.message(String(ev.data))
    ws.onclose = () => this.down("socket closed")
    ws.onerror = () => {} // onclose follows and says it
  }

  close() {
    this.closed = true
    if (this.pingTimer) clearTimeout(this.pingTimer)
    try {
      this.ws?.close()
    } catch {}
    this.ws = null
  }

  private send(event: string, data: any) {
    this.ws?.send(JSON.stringify({ event, data }))
  }

  /** Pusher closes an idle socket; a ping before its activity timeout keeps ours. */
  private armPing() {
    if (this.pingTimer) clearTimeout(this.pingTimer)
    this.pingTimer = setTimeout(() => this.send("pusher:ping", {}), this.idleMs)
  }

  private async message(raw: string) {
    let m: any
    try {
      m = JSON.parse(raw)
    } catch {
      return
    }
    this.armPing()
    const data = typeof m.data === "string" ? safeJson(m.data) : m.data
    switch (m.event) {
      case "pusher:connection_established": {
        this.socketId = data?.socket_id ?? null
        if (data?.activity_timeout) this.idleMs = Math.max(5, Number(data.activity_timeout) - 5) * 1000
        try {
          const auth = await this.o.authorize(this.socketId!, this.o.channel)
          this.send("pusher:subscribe", { channel: this.o.channel, auth })
        } catch (e: any) {
          this.down(`not allowed to follow: ${e?.message ?? e}`)
          this.close()
        }
        return
      }
      case "pusher_internal:subscription_succeeded":
        this.backoff = 500
        this.o.onUp()
        return
      case "pusher:ping":
        this.send("pusher:pong", {})
        return
      case "pusher:error":
        // 4000–4099: do not reconnect (Pusher's own rule); others: the close that follows retries.
        if (data?.code >= 4000 && data?.code < 4100) this.closed = true
        this.o.onDown(`pusher error ${data?.code ?? ""} ${data?.message ?? ""}`.trim())
        return
      default:
        if (m.channel === this.o.channel && typeof m.event === "string" && !m.event.startsWith("pusher")) this.o.onEvent(m.event, data)
    }
  }

  private down(why: string) {
    if (this.pingTimer) clearTimeout(this.pingTimer)
    this.ws = null
    this.o.onDown(why)
    if (this.closed) return
    const wait = this.backoff
    this.backoff = Math.min(this.backoff * 2, 15_000)
    setTimeout(() => !this.closed && this.open(), wait)
  }
}

function safeJson(s: string) {
  try {
    return JSON.parse(s)
  } catch {
    return s
  }
}

export function pusherUrl(key: string, cluster: string) {
  return `wss://ws-${cluster}.pusher.com/app/${key}?protocol=7&client=iris-cli&version=1.0&flash=false`
}

// ─── The follow ────────────────────────────────────────────────────────────────────────────────

export type FollowMode = "connecting" | "live" | "polling"

export type FollowOptions = {
  sessionId: string
  machine: string
  provider: string
  /** hiveFetch, injected so tests drive a fake platform. */
  fetch: (path: string, init?: RequestInit) => Promise<Response>
  /** New messages. On `reset`, `appended` is the whole current view. */
  onMessages: (appended: TranscriptMessage[], reset: boolean) => void
  onMode: (mode: FollowMode, why?: string) => void
  ws?: WSFactory
  /** Poll gap while the socket is down. Today's Desktop gap. */
  pollMs?: number
  /** How long to wait for the socket before polling. */
  connectTimeoutMs?: number
}

/**
 * Follow until `stop()` is called. Live when the socket is up; while it is down it polls the
 * transcript (each poll IS a NodeTask on the remote machine, which is why polling is only the
 * fallback) and says so through onMode.
 */
export function followLive(o: FollowOptions): { stop: () => void; state: LiveState } {
  const state = newLiveState()
  const pollMs = o.pollMs ?? 5000
  let mode: FollowMode = "connecting"
  let stopped = false
  let socket: PusherSocket | null = null
  let renewTimer: ReturnType<typeof setInterval> | null = null
  let pollTimer: ReturnType<typeof setTimeout> | null = null
  let connectTimer: ReturnType<typeof setTimeout> | null = null

  const setMode = (m: FollowMode, why?: string) => {
    if (m === mode) return
    mode = m
    o.onMode(m, why)
  }

  /**
   * `notify:false` only asks WHERE to listen. The daemon is told after the subscription succeeds,
   * because its snapshot is published at once, and a snapshot sent before we listen is lost.
   */
  const follow = async (snapshot: boolean, notify = true) => {
    const r = await o.fetch(`/api/v6/nodes/sessions/${encodeURIComponent(o.sessionId)}/follow`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ machine: o.machine, provider: o.provider, snapshot, notify }),
    })
    const body = (await r.json().catch(() => ({}))) as any
    if (!r.ok || !body.success) throw new Error(body.error || `follow: HTTP ${r.status}`)
    return body
  }

  const transcript = async (since?: number) => {
    const q = new URLSearchParams({ machine: o.machine, provider: o.provider, limit: "40" })
    if (since !== undefined) q.set("since", String(since))
    const r = await o.fetch(`/api/v6/nodes/sessions/${encodeURIComponent(o.sessionId)}/transcript?${q}`)
    const body = (await r.json().catch(() => ({}))) as any
    if (!r.ok || !body.success) throw new Error(body.error || `HTTP ${r.status}`)
    return body as { messages?: TranscriptMessage[]; offset?: number | null; incremental?: boolean; reset?: boolean }
  }

  const applyPage = (page: Awaited<ReturnType<typeof transcript>>) => {
    const msgs = page.messages ?? []
    if (page.incremental && state.to !== null) {
      state.messages.push(...msgs)
      if (msgs.length) o.onMessages(msgs, false)
    } else {
      state.messages = [...msgs]
      o.onMessages(state.messages, true)
    }
    if (typeof page.offset === "number") state.to = page.offset
    state.needsResync = false
  }

  // A function, not an inline comparison: `mode` changes across the await below, and TypeScript's
  // narrowing would otherwise "prove" the second check can never be true.
  const isLive = () => mode === "live"
  const poll = async () => {
    pollTimer = null
    if (stopped || isLive()) return
    try {
      applyPage(await transcript(state.to ?? undefined))
    } catch {
      /* the next poll tries again; the mode line already says we are degraded */
    }
    if (!stopped && !isLive()) pollTimer = setTimeout(poll, pollMs)
  }

  const startPolling = (why: string) => {
    if (stopped || mode === "polling") return
    setMode("polling", why)
    if (!pollTimer) pollTimer = setTimeout(poll, 0)
  }

  const onEnvelope = (env: Envelope) => {
    const r = applyEnvelope(state, env)
    if (r.appended.length || r.reset) o.onMessages(r.appended, r.reset)
    if (r.resync) follow(true).catch(() => {})
    if (r.fetchSince !== undefined) {
      // One message too big for a push: read just that range. The one NodeTask on the live path.
      const at = r.fetchSince
      transcript(at)
        .then((p) => {
          const msgs = p.messages ?? []
          state.messages.push(...msgs)
          if (msgs.length) o.onMessages(msgs, false)
        })
        .catch(() => follow(true).catch(() => {}))
    }
  }

  ;(async () => {
    let info: any
    try {
      info = await follow(false, false)
    } catch (e: any) {
      return startPolling(`live unavailable: ${e?.message ?? e}`)
    }
    if (stopped) return
    renewTimer = setInterval(() => follow(false).catch(() => {}), Math.max(5, Number(info.renew_s) || 30) * 1000)

    socket = new PusherSocket({
      url: pusherUrl(info.pusher?.key, info.pusher?.cluster || "us2"),
      channel: info.channel,
      ws: o.ws,
      authorize: async (socketId, channel) => {
        const r = await o.fetch(info.auth_endpoint || "/api/v6/nodes/sessions/broadcasting/auth", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ socket_id: socketId, channel_name: channel }),
        })
        const b = (await r.json().catch(() => ({}))) as any
        if (!r.ok || !b.auth) throw new Error(b.error || `HTTP ${r.status}`)
        return b.auth
      },
      onEvent: (event, data) => {
        if (event === (info.event || "session.stream")) onEnvelope(data as Envelope)
      },
      onUp: () => {
        if (connectTimer) clearTimeout(connectTimer)
        if (pollTimer) clearTimeout(pollTimer)
        pollTimer = null
        setMode("live")
        // Every time we (re)subscribe: tell the daemon, and take a snapshot. After an outage the
        // stream has moved on; a snapshot puts us back on its cursor without a NodeTask.
        if (state.to !== null) state.needsResync = true
        follow(true).catch((e) => startPolling(`live unavailable: ${e?.message ?? e}`))
      },
      onDown: (why) => startPolling(`live paused — ${why}`),
    })
    socket.open()
    connectTimer = setTimeout(() => mode === "connecting" && startPolling("live paused — no socket after " + (o.connectTimeoutMs ?? 5000) / 1000 + " s"), o.connectTimeoutMs ?? 5000)
  })()

  return {
    state,
    stop: () => {
      stopped = true
      socket?.close()
      if (renewTimer) clearInterval(renewTimer)
      if (pollTimer) clearTimeout(pollTimer)
      if (connectTimer) clearTimeout(connectTimer)
    },
  }
}
