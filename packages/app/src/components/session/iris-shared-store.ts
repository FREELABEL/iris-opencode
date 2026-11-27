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
let fetcher: Fetch | null = null
let timer: ReturnType<typeof setInterval> | null = null

export const sharedRooms = rooms
export const sharedOpenRequest = openRequest
export const sharedFetch = () => fetcher

export function setSharedRooms(next: SharedRoom[]) {
  setRooms(next)
}

export async function refreshSharedRooms(): Promise<void> {
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
  if (!fetcher) fetcher = doFetch
  if (timer) return
  void refreshSharedRooms()
  timer = setInterval(() => void refreshSharedRooms(), 60_000)
}

/** Open the panel on Agents › Shared, on this room. */
export function openSharedRoom(id: string | null) {
  if (id) setOpenRequest({ id, nonce: Date.now() })
  openIrisPanel({ surface: "agents", sub: "shared" })
}
