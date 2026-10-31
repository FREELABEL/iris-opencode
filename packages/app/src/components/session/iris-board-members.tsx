/**
 * Board members, from the board itself (#189795).
 *
 * Who is on the board, invite by email, change a member between viewer and editor, remove them.
 * Everything here already existed in the sidecar for a card's Share tab; a board's people were
 * just only reachable from inside a card. Members are also who a card can be assigned to
 * (#189796) — fl-api refuses to assign anyone who is not on the board.
 */
import { Dialog } from "@opencode-ai/ui/dialog"
import { createResource, createSignal, For, Show } from "solid-js"
import { initials } from "./iris-atlas-view"

type Fetch = (path: string, init?: RequestInit) => Promise<Response>
export interface BoardMembers {
  measured: boolean
  reason?: string
  ownerId: number | null
  youAreOwner: boolean
  members: { userId: number; name: string; email: string; permission: string; scope?: string }[]
}

export async function readMembers(doFetch: Fetch, bloqId: number): Promise<BoardMembers> {
  try {
    const res = await doFetch(`/iris/atlas/${bloqId}/members`)
    const j = (await res.json()) as BoardMembers
    return j && Array.isArray(j.members) ? j : { measured: false, reason: `HTTP ${res.status}`, ownerId: null, youAreOwner: false, members: [] }
  } catch (e) {
    return { measured: false, reason: e instanceof Error ? e.message : String(e), ownerId: null, youAreOwner: false, members: [] }
  }
}

export function IrisBoardMembers(props: { bloqId: number; boardName?: string; doFetch: Fetch; onChanged?: () => void }) {
  const [data, { refetch }] = createResource(() => props.bloqId, (b) => readMembers(props.doFetch, b))
  const [email, setEmail] = createSignal("")
  const [perm, setPerm] = createSignal<"viewer" | "editor">("editor")
  const [busy, setBusy] = createSignal(false)
  const [note, setNote] = createSignal<{ ok: boolean; text: string } | null>(null)
  const [armed, setArmed] = createSignal<number | null>(null)

  async function call(path: string, method: string, body?: unknown, done?: string) {
    setBusy(true)
    setNote(null)
    try {
      const res = await props.doFetch(path, {
        method,
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; reason?: string }
      if (!res.ok || j.ok === false) setNote({ ok: false, text: j.reason ?? `request failed (${res.status})` })
      else {
        if (done) setNote({ ok: true, text: done })
        await refetch()
        props.onChanged?.()
      }
    } catch (e) {
      setNote({ ok: false, text: e instanceof Error ? e.message : String(e) })
    }
    setBusy(false)
  }

  const invite = () => {
    const e = email().trim()
    if (!e || busy()) return
    void call(`/iris/atlas/${props.bloqId}/members/invite`, "POST", { email: e, permission: perm() }, `Invited ${e}`).then(() =>
      setEmail(""),
    )
  }

  return (
    <Dialog title="Members" description={props.boardName}>
      <div class="iris-members">
        <Show when={data.latest && !data.latest.measured}>
          <p class="text-12-regular text-text-weak">Could not read members — {data.latest!.reason}.</p>
        </Show>
        <Show when={data.latest?.measured}>
          <ul class="iris-members__list">
            <li class="iris-members__row">
              <span class="iris-avatar">{data.latest!.youAreOwner ? "ME" : "OW"}</span>
              <span class="iris-members__who">{data.latest!.youAreOwner ? "You" : "Board owner"}</span>
              <span class="iris-members__perm text-11-regular text-text-weak">owner</span>
            </li>
            <For each={data.latest!.members}>
              {(m) => (
                <li class="iris-members__row">
                  <span class="iris-avatar">{initials(m.name || m.email)}</span>
                  <span class="iris-members__who">
                    {m.name || m.email}
                    <Show when={m.name && m.email}>
                      <span class="text-11-regular text-text-weaker"> · {m.email}</span>
                    </Show>
                    <Show when={m.scope}>
                      <span class="iris-card__chip ms-1" title="Their access is limited">
                        {m.scope === "assigned" ? "assigned cards only" : `${m.scope} only`}
                      </span>
                    </Show>
                  </span>
                  <Show
                    when={data.latest!.youAreOwner}
                    fallback={<span class="iris-members__perm text-11-regular text-text-weak">{m.permission}</span>}
                  >
                    <select
                      class="iris-field__input iris-members__perm"
                      aria-label={`Permission for ${m.name || m.email}`}
                      value={m.permission}
                      disabled={busy()}
                      onChange={(e) =>
                        void call(`/iris/atlas/${props.bloqId}/members/${m.userId}`, "POST", { permission: e.currentTarget.value }, "Permission changed")
                      }
                    >
                      <option value="viewer">viewer</option>
                      <option value="editor">editor</option>
                    </select>
                    <button
                      type="button"
                      class="iris-card__x"
                      classList={{ "iris-card__x--armed": armed() === m.userId }}
                      disabled={busy()}
                      title={armed() === m.userId ? "Click again to remove" : "Remove from board"}
                      onClick={() => {
                        if (armed() !== m.userId) {
                          setArmed(m.userId)
                          setTimeout(() => setArmed((a) => (a === m.userId ? null : a)), 2500)
                          return
                        }
                        setArmed(null)
                        void call(`/iris/atlas/${props.bloqId}/members/${m.userId}`, "DELETE", undefined, "Removed")
                      }}
                    >
                      {armed() === m.userId ? "sure?" : "×"}
                    </button>
                  </Show>
                </li>
              )}
            </For>
          </ul>
          <Show when={data.latest!.members.length === 0}>
            <p class="text-12-regular text-text-weak">Only you, so far.</p>
          </Show>

          <Show
            when={data.latest!.youAreOwner}
            fallback={<p class="text-11-regular text-text-weaker">Only the board's owner can invite or remove people.</p>}
          >
            <form
              class="iris-members__invite"
              onSubmit={(e) => {
                e.preventDefault()
                invite()
              }}
            >
              <input
                class="iris-field__input"
                type="email"
                placeholder="Invite by email"
                aria-label="Email to invite"
                value={email()}
                onInput={(e) => setEmail(e.currentTarget.value)}
              />
              <select class="iris-field__input" aria-label="Permission" value={perm()} onChange={(e) => setPerm(e.currentTarget.value as any)}>
                <option value="editor">editor</option>
                <option value="viewer">viewer</option>
              </select>
              <button type="submit" class="iris-card__linkbtn iris-card__linkbtn--primary" disabled={!email().trim() || busy()}>
                {busy() ? "…" : "Invite"}
              </button>
            </form>
            <p class="text-11-regular text-text-weaker">
              An editor can add and edit cards; a viewer can read. They get an email. To give someone just one card, assign them
              to it by email from the card instead.
            </p>
          </Show>
        </Show>
        <Show when={note()}>
          {(n) => (
            <p class="text-11-regular" classList={{ "text-text-weak": n().ok, "text-text-strong": !n().ok }}>
              {n().ok ? n().text : `Not done — ${n().text}`}
            </p>
          )}
        </Show>
      </div>
    </Dialog>
  )
}
