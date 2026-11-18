/**
 * Agents gallery › Chat → the composer's agent (#192931).
 *
 * The IRIS panel is owned by the app shell (iris-shell.tsx) even while it is drawn beside a chat, so
 * it cannot reach the composer's agent state (LocalProvider lives under the chat's directory). The
 * panel asks over a window event instead, and every composer that is open answers for itself:
 *
 *   ask(id) → a composer selected it, and here is the agent's name
 *           → null:      a composer is open, and its picker does not hold that agent
 *           → undefined: nobody answered — no chat is open
 *
 * `refresh` (after the engine added the agent): a composer that does not hold it re-reads its agent
 * list. The app caches agent lists for good (staleTime Infinity), so without this an agent added
 * mid-session never appears until the app restarts.
 *
 * A synced agent's description carries "(IRIS agent #<id>)" (iris agents desktop-sync); that is how
 * an IRIS id finds its entry in the picker.
 */
export const CHAT_WITH = "iris:chat-with"

export type ChatWithDetail = { id: number; refresh?: boolean; reply: (name: string | null) => void }

export function agentForIrisId<T extends { name: string; description?: string }>(agents: readonly T[], id: number): T | undefined {
  const mark = `(IRIS agent #${id})`
  return agents.find((a) => a.description?.includes(mark))
}

export function askComposer(
  id: number,
  opts: { refresh?: boolean; target?: EventTarget; waitMs?: number } = {},
): Promise<string | null | undefined> {
  const target = opts.target ?? window
  return new Promise((resolve) => {
    let answered: string | null | undefined
    const reply = (name: string | null) => {
      // The first composer that holds the agent wins; "not here" from one does not cancel that.
      if (answered === undefined || (answered === null && name)) answered = name
    }
    target.dispatchEvent(new CustomEvent<ChatWithDetail>(CHAT_WITH, { detail: { id, refresh: opts.refresh, reply } }))
    setTimeout(() => resolve(answered), opts.waitMs ?? 300)
  })
}
