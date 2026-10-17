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
const PUSHER_KEY = process.env.IRIS_PUSHER_KEY ?? "f585d980668c9a8369ef"
const PUSHER_CLUSTER = process.env.IRIS_PUSHER_CLUSTER ?? "us2"

interface LiteItem {
  id: number
  bloq_list_id?: number
  sort_order?: number | null
  status?: string | null
  title?: string | null
  updated_at?: string | null
  deleted_at?: string | null
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
        `I${i.id}|${i.bloq_list_id ?? l.id}|${i.sort_order ?? ""}|${i.status ?? ""}|${i.updated_at ?? ""}|${i.title ?? ""}|${i.due_date ?? ""}|${i.priority ?? ""}|${i.summary ? JSON.stringify(i.summary) : ""}`,
      )
    }
  }
  return String(Bun.hash(parts.join("\n")))
}

/** `light=1` drops bodies — measured 61 KB for board 628 against 413 KB with them. */
async function fetchFingerprint(bloqId: number): Promise<string | null> {
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
    const fp = await fetchFingerprint(bloqId)
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
function connectPusher(bloqId: number, onEvent: () => void, onStatus: (s: "connected" | "refused") => void) {
  if (typeof WebSocket === "undefined") return undefined
  const channel = `private-bloq.${bloqId}`
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
    if (e.channel === channel && e.event && !e.event.startsWith("pusher")) onEvent()
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
        bloqId,
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
