import { createSignal, Match, Show, Switch } from "solid-js"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { openSharedRoom, refreshSharedRooms } from "./iris-shared-store"
import { roleWords } from "./iris-shared-rooms-model"
import "./iris-shared-rooms.css"

/**
 * "Join a team" (#194307): paste the invite link someone sent you. You see what it is for (the
 * project, who sent it, what you will be able to do) before joining, then every chat that team
 * shares shows up on Home and under Shared — on this computer, as you.
 */
type Fetch = (path: string, init?: RequestInit) => Promise<Response>
type Join = {
  ok: boolean
  reason?: string
  outcome?: "preview" | "joined" | "member" | "check_email"
  projectId?: number
  projectName?: string
  ownerName?: string | null
  role?: string | null
}

export function DialogJoinTeam(props: { doFetch: Fetch; initial?: string }) {
  const dialog = useDialog()
  const [link, setLink] = createSignal(props.initial ?? "")
  const [preview, setPreview] = createSignal<Join | null>(null)
  const [done, setDone] = createSignal<Join | null>(null)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)

  const ask = async (previewOnly: boolean): Promise<Join> => {
    const res = await props.doFetch("/iris/shared-rooms/join", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ invite: link().trim(), preview: previewOnly }),
    })
    return (await res.json()) as Join
  }

  const look = async () => {
    if (!link().trim() || busy()) return
    setBusy(true)
    setError(null)
    try {
      const j = await ask(true)
      if (!j.ok) setError(j.reason ?? "That invite could not be read.")
      else setPreview(j)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const join = async () => {
    if (busy()) return
    setBusy(true)
    setError(null)
    try {
      const j = await ask(false)
      if (!j.ok) {
        setError(j.reason ?? "That did not go through.")
        return
      }
      setDone({ ...preview(), ...j, projectName: j.projectName ?? preview()?.projectName })
      await refreshSharedRooms()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog title="Join a team" description="Paste the invite link someone sent you.">
      <div class="sr sr-share iris-ui" data-component="join-team">
        <Switch>
          <Match when={done()}>
            {(d) => (
              <>
                <Switch>
                  <Match when={d().outcome === "check_email"}>
                    <p class="sr-join-big">Check your email</p>
                    <p class="sr-share-hint">
                      We sent a sign-in link to the address on your account. Open it to finish joining{" "}
                      {d().projectName ?? "the project"}.
                    </p>
                  </Match>
                  <Match when={true}>
                    <p class="sr-join-big">
                      {d().outcome === "member" ? "You are already in" : "You're in"} — {d().projectName ?? "the project"}
                    </p>
                    <p class="sr-share-hint">
                      Chats your team shares there show up on Home under Shared, live. You can {roleWords(d().role ?? null)}.
                    </p>
                  </Match>
                </Switch>
                <div class="sr-share-actions">
                  <button type="button" class="sr-btn" onClick={() => dialog.close()}>
                    Close
                  </button>
                  <button
                    type="button"
                    class="sr-share-go"
                    onClick={() => {
                      dialog.close()
                      openSharedRoom(null)
                    }}
                  >
                    See shared chats
                  </button>
                </div>
              </>
            )}
          </Match>
          <Match when={true}>
            <label class="sr-share-label" for="sr-join-link">
              Invite link
            </label>
            <input
              id="sr-join-link"
              class="sr-share-input"
              placeholder="https://heyiris.io/invite/…"
              value={link()}
              autofocus
              onInput={(e) => {
                setLink(e.currentTarget.value)
                setPreview(null)
                setError(null)
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") void (preview() ? join() : look())
              }}
            />
            <Show when={preview()}>
              {(p) => (
                <div class="sr-join-card">
                  <div class="sr-join-name">{p().projectName}</div>
                  <div class="sr-share-hint">
                    <Show when={p().ownerName}>From {p().ownerName}. </Show>
                    You will be able to {roleWords(p().role ?? null)}.
                  </div>
                </div>
              )}
            </Show>
            <Show when={error()}>
              <div class="sr-note" data-tone="bad">
                {error()}
              </div>
            </Show>
            <div class="sr-share-actions">
              <button type="button" class="sr-btn" onClick={() => dialog.close()}>
                Cancel
              </button>
              <Show
                when={preview()}
                fallback={
                  <button type="button" class="sr-share-go" disabled={!link().trim() || busy()} onClick={() => void look()}>
                    {busy() ? "Checking…" : "Continue"}
                  </button>
                }
              >
                <button type="button" class="sr-share-go" disabled={busy()} onClick={() => void join()}>
                  {busy() ? "Joining…" : "Join"}
                </button>
              </Show>
            </div>
          </Match>
        </Switch>
      </div>
    </Dialog>
  )
}
