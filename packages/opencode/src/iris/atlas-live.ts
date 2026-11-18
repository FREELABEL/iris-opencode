/**
 * Atlas, live (#189767) — the board moves when someone else moves it.
 *
 * WHY POLLING IS THE FLOOR, NOT PUSHER. fl-api does broadcast `activity.created` on
 * `private-bloq.{id}`, but (measured 2026-10-17 against raichu) two things keep it from being
 * enough on its own:
 *   1. `/api/broadcasting/auth` — the only auth route that takes a Bearer token — authorises
 *      `private-user.*` and program chats, and answers 403 for `private-bloq.*`. No token client
 *      can subscribe to a board today.
 *   2. Only some fl-api write paths call `trackItemCreated/Updated/Deleted`. An agent writing
 *      through another service changes the board without a broadcast.
 * A board that updates for some writers and not others reads as broken. So the truth is a
 * FINGERPRINT of the board, checked on an interval; a Pusher event only makes the next check
 * happen now. When fl-api authorises board channels, updates become instant with no release.
 *
 * One watcher per board, shared by every open panel, stopped when the last one leaves — two
 * windows on the same board must not double the requests.
 */
import { irisFetch, resolveUserId, resolveToken, FL_API } from "./platform"

export const ATLAS_POLL_MS = 10_000
/*
 * The key fl-api SIGNS with, not the one in the web app's config. Elon's nuxt.config falls
 * back to f585d980…, an older Pusher app: a socket on that app with a signature for this one is
 * a pusher:error, and the board silently stays on polling. Measured 2026-10-19 — fl-api's auth
 * returns `e7fd19c0…:<sig>`, that key subscribes on us2 (4001 "not in this cluster" on mt1, us3,
 * eu, ap1), and a write reaches the socket in ~2 s.
 */
const PUSHER_KEY = process.env.IRIS_PUSHER_KEY ?? "e7fd19c071bd376122c1"
const PUSHER_CLUSTER = process.env.IRIS_PUSHER_CLUSTER ?? "us2"

interface LiteItem {
  id: number
  bloq_list_id?: number
  sort_order?: number | null
  status?: string | null
  title?: string | null
  updated_at?: string | null
  deleted_at?: string | null
  start_date?: string | null
  due_date?: string | null
  priority?: string | null
  /** fl-api's card summary (#189793) — a new attachment or a ticked subtask may not move updated_at. */
  summary?: unknown
}
interface LiteList {
  id: number
  name?: string
  sort_order?: number | null
  updated_at?: string | null
  items?: LiteItem[]
}

/**
 * Everything a person could SEE change on Lists or Board: a list's name and order, and each
 * card's list, position, status, title and edit time. Order-independent per list, so the same
 * board served in a different order is the same board.
 */
export function atlasFingerprint(lists: LiteList[]): string {
  const parts: string[] = []
  for (const l of [...lists].sort((a, b) => a.id - b.id)) {
    parts.push(`L${l.id}|${l.name ?? ""}|${l.sort_order ?? ""}`)
    for (const i of [...(l.items ?? [])].sort((a, b) => a.id - b.id)) {
      if (i.deleted_at) continue
      parts.push(
        `I${i.id}|${i.bloq_list_id ?? l.id}|${i.sort_order ?? ""}|${i.status ?? ""}|${i.updated_at ?? ""}|${i.title ?? ""}|${i.start_date ?? ""}|${i.due_date ?? ""}|${i.priority ?? ""}|${i.summary ? JSON.stringify(i.summary) : ""}`,
      )
    }
  }
  return String(Bun.hash(parts.join("\n")))
}

/*
 * THE CHECK ASKS FOR A VERSION, NOT THE BOARD (#190231 phase 3). fl-api versions a board:
 * `?if_version=V` answers `unchanged` in a few bytes, and only a changed board sends its skeleton
 * (ids + revs). The fingerprint below — the whole light board, ~0.8 MB on a 90-card board, every
 * 10 s — stays as the fallback for an fl-api that predates versions, rechecked every 10 minutes.
 */
let versionsUnsupportedUntil = 0
const VERSION_RECHECK_MS = 10 * 60_000

/** Tests only. */
export function resetVersionSupport() {
  versionsUnsupportedUntil = 0
}

/** The board's version as a fingerprint (`v:` + fl-api's version), or null when it cannot be had. */
async function fetchVersion(bloqId: number, last: string | undefined): Promise<string | null | "unsupported"> {
  const userId = await resolveUserId()
  if (!userId) return null
  try {
    const held = last?.startsWith("v:") ? last.slice(2) : undefined
    const q = held ? `if_version=${encodeURIComponent(held)}` : "skeleton=1"
    const res = await irisFetch(`/api/v1/user/${userId}/bloqs/${bloqId}?${q}`)
    if (!res.ok) return null
    const json = (await res.json()) as any
    const raw = json?.data ?? json
    if (typeof raw?.version !== "string") return "unsupported"
    return `v:${raw.version}`
  } catch {
    return null
  }
}

export async function fetchFingerprint(bloqId: number, last?: string): Promise<string | null> {
  if (Date.now() >= versionsUnsupportedUntil) {
    const v = await fetchVersion(bloqId, last)
    if (v !== "unsupported") return v
    versionsUnsupportedUntil = Date.now() + VERSION_RECHECK_MS
  }
  return fetchLightFingerprint(bloqId)
}

/** `light=1` drops bodies — measured 61 KB for board 628 against 413 KB with them. */
async function fetchLightFingerprint(bloqId: number): Promise<string | null> {
  const userId = await resolveUserId()
  if (!userId) return null
  try {
    const res = await irisFetch(`/api/v1/user/${userId}/bloqs/${bloqId}?light=1&summary=1`)
    if (!res.ok) return null
    const json = (await res.json()) as any
    const raw = json?.data ?? json
    return atlasFingerprint((raw?.lists ?? []) as LiteList[])
  } catch {
    return null
  }
}

export type AtlasLiveEvent =
  | { type: "change"; at: string }
  | { type: "status"; pusher: "connected" | "refused" | "off" }

type Listener = (e: AtlasLiveEvent) => void

interface Watcher {
  listeners: Set<Listener>
  last?: string
  timer?: ReturnType<typeof setTimeout>
  inFlight: boolean
  again: boolean
  stopped: boolean
  pusher?: { close(): void }
}

const watchers = new Map<number, Watcher>()

function emit(w: Watcher, e: AtlasLiveEvent) {
  for (const l of w.listeners) {
    try {
      l(e)
    } catch {}
  }
}

async function check(bloqId: number, w: Watcher) {
  if (w.stopped) return
  // A Pusher event during a slow fetch must not be lost, nor start a second fetch.
  if (w.inFlight) {
    w.again = true
    return
  }
  w.inFlight = true
  if (w.timer) clearTimeout(w.timer)
  try {
    const fp = await fetchFingerprint(bloqId, w.last)
    // An unreachable check is NOT a change — it keeps the last known fingerprint.
    if (fp && !w.stopped) {
      if (w.last !== undefined && fp !== w.last) emit(w, { type: "change", at: new Date().toISOString() })
      w.last = fp
    }
  } finally {
    w.inFlight = false
    if (!w.stopped) {
      if (w.again) {
        w.again = false
        void check(bloqId, w)
      } else w.timer = setTimeout(() => void check(bloqId, w), ATLAS_POLL_MS)
    }
  }
}

/**
 * The Pusher protocol, by hand: connect, auth the socket against fl-api with the same Bearer
 * token every other call uses, subscribe, answer pings. No dependency for ~40 lines. Any
 * failure leaves the poll running and says so once.
 */
function connectPusher(
  channel: string,
  onEvent: (event: string, data: unknown) => void,
  onStatus: (s: "connected" | "refused") => void,
  onClose?: () => void,
) {
  if (typeof WebSocket === "undefined") return undefined
  let closed = false
  let ws: WebSocket
  try {
    ws = new WebSocket(`wss://ws-${PUSHER_CLUSTER}.pusher.com/app/${PUSHER_KEY}?protocol=7&client=js&version=8.4.0&flash=false`)
  } catch {
    return undefined
  }
  ws.onmessage = async (m) => {
    let e: { event?: string; data?: unknown; channel?: string }
    try {
      e = JSON.parse(String(m.data))
    } catch {
      return
    }
    if (e.event === "pusher:ping") return ws.send(JSON.stringify({ event: "pusher:pong", data: {} }))
    if (e.event === "pusher:connection_established") {
      try {
        const socketId = JSON.parse(String(e.data)).socket_id
        const res = await irisFetch(`/api/broadcasting/auth`, FL_API, {
          method: "POST",
          body: JSON.stringify({ socket_id: socketId, channel_name: channel }),
        })
        if (!res.ok) {
          onStatus("refused")
          return ws.close()
        }
        const { auth } = (await res.json()) as { auth: string }
        ws.send(JSON.stringify({ event: "pusher:subscribe", data: { channel, auth } }))
      } catch {
        onStatus("refused")
        ws.close()
      }
      return
    }
    if (e.event === "pusher_internal:subscription_succeeded") return onStatus("connected")
    // A wrong key, a signature for another app, a cluster mismatch: Pusher answers with an error
    // and nothing else. Say "refused" so the panel's indicator does not claim an instant board.
    if (e.event === "pusher:error") {
      onStatus("refused")
      return ws.close()
    }
    if (e.channel === channel && e.event && !e.event.startsWith("pusher")) onEvent(e.event, e.data)
  }
  ws.onclose = () => {
    if (!closed) onClose?.()
  }
  return {
    close() {
      if (closed) return
      closed = true
      try {
        ws.close()
      } catch {}
    },
  }
}

/** Subscribe to one board. Returns the unsubscribe. */
export function watchAtlas(bloqId: number, listener: Listener): () => void {
  let w = watchers.get(bloqId)
  if (!w) {
    w = { listeners: new Set(), inFlight: false, again: false, stopped: false }
    watchers.set(bloqId, w)
    const ww = w
    void check(bloqId, ww)
    if (resolveToken()) {
      ww.pusher = connectPusher(
        `private-bloq.${bloqId}`,
        () => void check(bloqId, ww),
        (s) => emit(ww, { type: "status", pusher: s }),
      )
    }
  }
  w.listeners.add(listener)
  return () => {
    const cur = watchers.get(bloqId)
    if (!cur) return
    cur.listeners.delete(listener)
    if (cur.listeners.size > 0) return
    cur.stopped = true
    if (cur.timer) clearTimeout(cur.timer)
    cur.pusher?.close()
    watchers.delete(bloqId)
  }
}

/** For tests. */
export const _watcherCount = () => watchers.size

// ─── A person's own channel (#189799) ───────────────────────────────────────

/**
 * Something on an Atlas card that is about YOU — assigned to you, mentioning you, due tomorrow
 * on your card. fl-api sends `card.notification` on private-user.{you}; on a board marked
 * contains_phi it carries no title and no excerpt, so neither can reach the OS notification.
 */
export interface CardNotice {
  kind: "assign" | "mention" | "due"
  text: string
  excerpt?: string
  bloqId: number
  itemId: number
  title?: string
  by?: string
}

/** Pusher's `data` is a JSON string of {notification: {...}}. Anything else is not a notice. */
export function readCardNotice(data: unknown): CardNotice | undefined {
  let d: any = data
  if (typeof d === "string") {
    try {
      d = JSON.parse(d)
    } catch {
      return undefined
    }
  }
  const n = d?.notification
  if (!n || !["assign", "mention", "due"].includes(n.kind) || typeof n.text !== "string") return undefined
  const bloqId = Number(n.bloq_id)
  const itemId = Number(n.item_id)
  if (!Number.isFinite(bloqId) || !Number.isFinite(itemId)) return undefined
  return {
    kind: n.kind,
    text: n.text,
    bloqId,
    itemId,
    ...(typeof n.excerpt === "string" && n.excerpt ? { excerpt: n.excerpt } : {}),
    ...(typeof n.title === "string" && n.title ? { title: n.title } : {}),
    ...(typeof n.by === "string" && n.by ? { by: n.by } : {}),
  }
}

export type MeLiveEvent = { type: "notice"; notice: CardNotice } | { type: "status"; pusher: "connected" | "refused" | "off" }

const meListeners = new Set<(e: MeLiveEvent) => void>()
let meConn: { close(): void } | undefined
let meRetry: ReturnType<typeof setTimeout> | undefined
let meStatus: "connected" | "refused" | "off" = "off"

function meEmit(e: MeLiveEvent) {
  if (e.type === "status") meStatus = e.pusher
  for (const l of meListeners) {
    try {
      l(e)
    } catch {}
  }
}

async function meConnect() {
  if (meConn || meListeners.size === 0) return
  const userId = resolveToken() ? await resolveUserId() : undefined
  if (!userId || meListeners.size === 0) {
    meEmit({ type: "status", pusher: "off" })
    meRetry = setTimeout(() => void meConnect(), 60_000)
    return
  }
  meConn = connectPusher(
    `private-user.${userId}`,
    (event, data) => {
      if (event !== "card.notification") return
      const notice = readCardNotice(data)
      if (notice) meEmit({ type: "notice", notice })
    },
    (s) => meEmit({ type: "status", pusher: s }),
    // A dropped socket (sleep, network change) comes back by itself; a refusal waits longer.
    () => {
      meConn = undefined
      if (meListeners.size === 0) return
      meRetry = setTimeout(() => void meConnect(), meStatus === "refused" ? 60_000 : 5_000)
    },
  )
}

/** Hear about your own cards. One connection, shared, closed when the last listener leaves. */
export function watchMe(listener: (e: MeLiveEvent) => void): () => void {
  meListeners.add(listener)
  // Joining a connection that is already up: say so now. Status is only sent when it CHANGES,
  // so a listener that arrives after "connected" — a reconnecting window, a second one, a stream
  // whose predecessor the server has not released yet — otherwise hears nothing at all.
  if (meConn && meStatus !== "off") {
    try {
      listener({ type: "status", pusher: meStatus })
    } catch {}
  }
  void meConnect()
  return () => {
    meListeners.delete(listener)
    if (meListeners.size > 0) return
    if (meRetry) clearTimeout(meRetry)
    meRetry = undefined
    const c = meConn
    meConn = undefined
    c?.close()
  }
}
