/**
 * Which chats are on screen (#193492, #191774). A chat counts while any column of the split view
 * shows it: each mounted session page marks its own chat, so two columns showing one chat count
 * twice and it stays on screen until both are gone.
 *
 * Kept apart from use-panel-control so the app shell (pages/layout.tsx, the approval toasts) can ask
 * without importing the side panel.
 */
const onScreen = new Map<string, number>()

export function chatOnScreen(chat: string): boolean {
  return (onScreen.get(chat) ?? 0) > 0
}

export function markOnScreen(chat: string): () => void {
  onScreen.set(chat, (onScreen.get(chat) ?? 0) + 1)
  return () => {
    const n = (onScreen.get(chat) ?? 1) - 1
    if (n > 0) onScreen.set(chat, n)
    else onScreen.delete(chat)
  }
}
