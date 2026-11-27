/**
 * Names the panel has already read, by id, so the chat can say "Moved Mia Novak to Contacted"
 * instead of "iris leads update 32349" (#194362). Filled as the side panel reads Atlas boards and
 * leads; nothing is fetched for it. Unknown ids stay ids.
 */
import { createSignal } from "solid-js"

const leads = new Map<number, string>()
const lists = new Map<number, string>()
const boards = new Map<number, string>()
/** Moves when a name is learned, so a card drawn before the panel read its board updates. */
const [version, setVersion] = createSignal(0)
let changed = false

type Named = { id: number | string; name?: string | null }
const put = (m: Map<number, string>, rows?: Named[]) => {
  for (const r of rows ?? []) {
    const id = Number(r?.id)
    if (!Number.isFinite(id) || !r?.name || m.get(id) === String(r.name)) continue
    m.set(id, String(r.name))
    changed = true
  }
}

export function rememberIrisNames(x: { leads?: Named[]; lists?: Named[]; boards?: Named[] }) {
  changed = false
  put(leads, x.leads)
  put(lists, x.lists)
  put(boards, x.boards)
  if (changed) setVersion((v) => v + 1)
}

export const irisNames = {
  lead: (id: number) => (version(), leads.get(id)),
  list: (id: number) => (version(), lists.get(id)),
  board: (id: number) => (version(), boards.get(id)),
}
