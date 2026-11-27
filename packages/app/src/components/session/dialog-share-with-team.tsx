import { createResource, createSignal, For, Show } from "solid-js"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { openSharedRoom, refreshSharedRooms } from "./iris-shared-store"
import "./iris-shared-rooms.css"

/**
 * "Share with team…" (#194307): file this chat under one of your Atlas projects as a room. Everyone
 * in that project then sees it live, can type into it (editors) and stop it (owners). Only this
 * chat is shared — not the computer, not other chats.
 */
type Fetch = (path: string, init?: RequestInit) => Promise<Response>
type Bloqs = { measured?: boolean; bloqs?: { id: number; name: string }[]; reason?: string }

export function DialogShareWithTeam(props: { doFetch: Fetch; sessionId: string; title: string }) {
  const dialog = useDialog()
  // `measured: false` is "could not read your projects", which must not read as "you have none".
  const [projects, { refetch }] = createResource(async (): Promise<{ list: { id: number; name: string }[]; trouble: string | null }> => {
    try {
      const res = await props.doFetch("/iris/bloqs?per_page=100")
      const j = (await res.json()) as Bloqs
      if (j.measured === false) return { list: [], trouble: j.reason ?? "the server did not answer" }
      return { list: j.bloqs ?? [], trouble: null }
    } catch (e) {
      return { list: [], trouble: e instanceof Error ? e.message : String(e) }
    }
  })
  const [project, setProject] = createSignal<number | null>(null)
  const [name, setName] = createSignal(props.title || "Shared chat")
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)

  const share = async () => {
    const p = project()
    if (!p || busy()) return
    setBusy(true)
    setError(null)
    try {
      const res = await props.doFetch("/iris/shared-rooms/share", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: props.sessionId, projectId: p, name: name().trim() || "Shared chat" }),
      })
      const j = (await res.json()) as { ok: boolean; reason?: string; roomId?: string }
      if (!j.ok) {
        setError(j.reason ?? "That did not share.")
        return
      }
      await refreshSharedRooms()
      dialog.close()
      openSharedRoom(j.roomId ?? null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog title="Share with your team" description="Everyone in the project sees this chat as it happens.">
      <div class="sr sr-share iris-ui">
        <label class="sr-share-label" for="sr-share-name">
          Name
        </label>
        <input id="sr-share-name" class="sr-share-input" value={name()} maxLength={120} onInput={(e) => setName(e.currentTarget.value)} />

        <div class="sr-share-label">Project</div>
        <Show when={!projects.loading} fallback={<div class="sr-share-hint">Loading your projects…</div>}>
          <Show
            when={(projects()?.list ?? []).length}
            fallback={
              <Show
                when={projects()?.trouble}
                fallback={<div class="sr-share-hint">You have no projects yet. Make one in Atlas, then share this chat with it.</div>}
              >
                <div class="sr-note" data-tone="bad">
                  Your projects could not load ({projects()?.trouble}).{" "}
                  <button type="button" class="sr-link" onClick={() => void refetch()}>
                    Try again
                  </button>
                </div>
              </Show>
            }
          >
            <div class="sr-share-list" role="radiogroup">
              <For each={projects()?.list}>
                {(b) => (
                  <button
                    type="button"
                    role="radio"
                    aria-checked={project() === b.id}
                    class="sr-share-option"
                    data-on={project() === b.id ? "" : undefined}
                    onClick={() => setProject(b.id)}
                  >
                    <span class="sr-share-radio" />
                    <span>{b.name}</span>
                  </button>
                )}
              </For>
            </div>
          </Show>
        </Show>

        <ul class="sr-share-facts">
          <li>Viewers can watch it. Editors can type into it, with their name on what they type.</li>
          <li>Owners — and whoever sent the message it is working on — can stop it.</li>
          <li>Only this chat is shared: not your files, not your other chats.</li>
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
          <button type="button" class="sr-share-go" disabled={!project() || busy()} onClick={() => void share()}>
            {busy() ? "Sharing…" : "Share"}
          </button>
        </div>
      </div>
    </Dialog>
  )
}
