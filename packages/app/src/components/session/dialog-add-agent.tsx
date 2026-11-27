import { createResource, createSignal, For, Show } from "solid-js"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import "./iris-shared-rooms.css"

/**
 * "Add my agent" (#194466): bring a chat from one of YOUR computers into a shared room, so it runs
 * next to everyone else's. Listed from what your computers report (the same list the server checks
 * against), so what you can pick is what it will accept. Only the chat joins — not the computer.
 */
type Fetch = (path: string, init?: RequestInit) => Promise<Response>
type HiveSession = { sessionId: string; provider: string; label: string; status: string; updatedAt: string | null }
type HiveNode = { id: string; name: string; online: boolean; sessions: HiveSession[] }
type HivePayload = { measured: boolean; reason?: string; nodes?: HiveNode[] }

const DRIVEABLE = new Set(["claude_code", "claude-code", "opencode", "acp"])
const KIND: Record<string, string> = { claude_code: "Claude Code", "claude-code": "Claude Code", opencode: "IRIS", acp: "Codex / Gemini" }

export function DialogAddAgent(props: { doFetch: Fetch; roomId: string; roomName: string; inRoom: string[]; onAdded: () => void }) {
  const dialog = useDialog()
  const [hive] = createResource(async (): Promise<{ nodes: HiveNode[]; trouble: string | null }> => {
    try {
      const j = (await (await props.doFetch("/iris/hive/sessions")).json()) as HivePayload
      if (!j.measured) return { nodes: [], trouble: j.reason ?? "your computers did not answer" }
      return { nodes: j.nodes ?? [], trouble: null }
    } catch (e) {
      return { nodes: [], trouble: e instanceof Error ? e.message : String(e) }
    }
  })
  const choices = () =>
    (hive()?.nodes ?? [])
      .map((n) => ({
        node: n,
        sessions: n.sessions.filter((s) => DRIVEABLE.has(s.provider) && !props.inRoom.includes(s.sessionId) && s.status !== "stale"),
      }))
      .filter((g) => g.sessions.length)
  const [picked, setPicked] = createSignal<string | null>(null)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)

  const add = async () => {
    const id = picked()
    if (!id || busy()) return
    setBusy(true)
    setError(null)
    try {
      const res = await props.doFetch(`/iris/shared-rooms/${encodeURIComponent(props.roomId)}/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: id }),
      })
      const j = (await res.json()) as { ok: boolean; reason?: string }
      if (!j.ok) {
        setError(j.reason ?? "That did not go through.")
        return
      }
      props.onAdded()
      dialog.close()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog title="Add my agent" description={`Bring one of your chats into ${props.roomName}. Everyone in the room sees it work and can talk to it.`}>
      <div class="sr sr-share iris-ui" data-component="add-agent">
        <Show when={!hive.loading} fallback={<div class="sr-share-hint">Looking at your computers…</div>}>
          <Show
            when={choices().length}
            fallback={
              <Show
                when={hive()?.trouble}
                fallback={
                  <div class="sr-share-hint">
                    None of your computers has a chat open that can join. Start one in Claude Code, Codex or IRIS on your computer
                    (with IRIS running there), then try again.
                  </div>
                }
              >
                <div class="sr-note" data-tone="bad">
                  Your computers could not be read ({hive()?.trouble}).
                </div>
              </Show>
            }
          >
            <div class="sr-share-list" role="radiogroup">
              <For each={choices()}>
                {(g) => (
                  <>
                    <div class="sr-share-label">
                      {g.node.name}
                      {g.node.online ? "" : " · asleep"}
                    </div>
                    <For each={g.sessions}>
                      {(s) => (
                        <button
                          type="button"
                          role="radio"
                          aria-checked={picked() === s.sessionId}
                          class="sr-share-option"
                          data-on={picked() === s.sessionId ? "" : undefined}
                          onClick={() => setPicked(s.sessionId)}
                        >
                          <span class="sr-share-radio" />
                          <span class="sr-add-label">{s.label || "Untitled chat"}</span>
                          <span class="sr-add-kind">{KIND[s.provider] ?? s.provider}</span>
                        </button>
                      )}
                    </For>
                  </>
                )}
              </For>
            </div>
          </Show>
        </Show>

        <ul class="sr-share-facts">
          <li>What anyone types in the room reaches your agent, with their name on it.</li>
          <li>It runs on your computer, with your tools. Only this chat joins — not your files or other chats.</li>
          <li>You can take it out any time; the chat keeps running on your computer.</li>
        </ul>

        <Show when={error()}>
          <div class="sr-note" data-tone="bad">
            {error()}
          </div>
        </Show>

        <div class="sr-share-actions">
          <button type="button" class="sr-btn" onClick={() => dialog.close()}>
            Cancel
          </button>
          <button type="button" class="sr-share-go" disabled={!picked() || busy()} onClick={() => void add()}>
            {busy() ? "Adding…" : "Add to room"}
          </button>
        </div>
      </div>
    </Dialog>
  )
}
