/**
 * Has this background shell command ended, and how? (#188641)
 *
 * The engine writes one message into the chat when a background command ends —
 * `<background_shell id="…" state="completed|error|cancelled">` — whether it finished, failed or
 * was stopped. The card reads that rather than asking the engine, so it is right after a reload
 * and needs no polling: no message yet means it is still running.
 */
export type BackgroundShellEnd = "completed" | "error" | "cancelled"

type Store = {
  message: Record<string, Array<{ id: string }> | undefined>
  part: Record<string, Array<{ type: string; text?: string }> | undefined>
}

export function backgroundShellEnd(store: Store, sessionID: string | undefined, jobID: string): BackgroundShellEnd | undefined {
  if (!sessionID || !jobID) return
  const marker = `<background_shell id="${jobID}" state="`
  const messages = store.message[sessionID] ?? []
  // Newest first: the end is always after the call that started it.
  for (let i = messages.length - 1; i >= 0; i--) {
    for (const part of store.part[messages[i].id] ?? []) {
      if (part.type !== "text" || !part.text) continue
      const at = part.text.indexOf(marker)
      if (at === -1) continue
      const state = part.text.slice(at + marker.length).split('"', 1)[0]
      if (state === "completed" || state === "error" || state === "cancelled") return state
    }
  }
}
