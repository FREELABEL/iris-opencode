import { createSignal } from "solid-js"
import { openIrisPanel } from "./iris-nav"
import type { SharedRoom } from "./iris-shared-rooms-model"

/**
 * Shared rooms, app-wide (#194307). One list, read once a minute by the titlebar (always mounted),
 * so the titlebar pill and a chat's "Shared" marker agree without each asking the server. The panel's
 * Shared pane writes here too when it reads the list, so all three show the same thing.
 */
type Fetch = (path: string, init?: RequestInit) => Promise<Response>

const [rooms, setRooms] = createSignal<SharedRoom[]>([])
const [openRequest, setOpenRequest] = createSignal<{ id: string; nonce: number } | null>(null)
const [fetcherSig, setFetcher] = createSignal<Fetch | null>(null)
const [me, setMe] = createSignal<number | null>(null)
let timer: ReturnType<typeof setInterval> | null = null

export const sharedRooms = rooms
export const sharedOpenRequest = openRequest
/** Reactive: null until the titlebar (always mounted) has handed over how to reach the engine. */
export const sharedFetch = () => fetcherSig()
/** Who is signed in here — "You" on your agent, Stop for the turn you sent. */
export const sharedMe = me

export function setSharedRooms(next: SharedRoom[]) {
  setRooms(next)
}

export async function refreshSharedRooms(): Promise<void> {
  const fetcher = fetcherSig()
  if (!fetcher) return
  try {
    const res = await fetcher("/iris/shared-rooms")
    const j = (await res.json()) as { measured?: boolean; rooms?: SharedRoom[] }
    if (j?.measured) setRooms(Array.isArray(j.rooms) ? j.rooms : [])
  } catch {
    // keep what we had — a missed refresh is not "nothing is shared"
  }
}

/** Start the once-a-minute read. Idempotent: the first caller's fetch is the one used. */
export function watchSharedRooms(doFetch: Fetch) {
  if (!fetcherSig()) setFetcher(() => doFetch)
  if (timer) return
  void refreshSharedRooms()
  void doFetch("/iris/me")
    .then((r) => r.json())
    .then((j: { id?: number | null }) => setMe(typeof j?.id === "number" ? j.id : null))
    .catch(() => {})
  timer = setInterval(() => void refreshSharedRooms(), 60_000)
}

let roomOpener: ((roomId: string, title?: string) => void) | null = null

/** The titlebar registers how to open a room as a tab (#194463); without it, the side panel. */
export function setSharedRoomOpener(fn: ((roomId: string, title?: string) => void) | null) {
  roomOpener = fn
}
export const canOpenRoomTab = () => roomOpener !== null

/**
 * Open a shared room. With a room: its own tab in the main pane, like any chat — the side panel
 * keeps the list and the settings. Without one (or with no tab strip): the panel's Shared list.
 */
export function openSharedRoom(id: string | null, title?: string) {
  if (id && roomOpener) {
    const name = title ?? rooms().find((r) => r.id === id)?.name
    roomOpener(id, name)
    return
  }
  if (id) setOpenRequest({ id, nonce: Date.now() })
  openIrisPanel({ surface: "agents", sub: "shared" })
}
