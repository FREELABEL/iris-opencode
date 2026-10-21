/**
 * The offline copy of Atlas (#190231 phase 1): whether this machine keeps a copy of each board
 * you open, so the board draws at once and is still there with no connection. Saved by the local
 * IRIS server to ~/.iris/atlas/local-copy.json, so the CLI and an admin can change it too.
 * Each switch saves the moment it flips.
 */
import { Dialog } from "@opencode-ai/ui/dialog"
import { createResource, createSignal, Show } from "solid-js"

interface LocalCopy {
  enabled: boolean
  includePhi: boolean
  maxBoards: number
  maxMB: number
}

export function IrisLocalCopySettings(props: {
  doFetch: (path: string, init?: RequestInit) => Promise<Response>
  /** Called after a change, so the board can be re-read under the new setting. */
  onChanged?: () => void
}) {
  const [data, { mutate }] = createResource(async () => {
    const res = await props.doFetch(`/iris/atlas-local-copy`)
    if (!res.ok) throw new Error(`request failed (${res.status})`)
    return (await res.json()) as LocalCopy
  })
  const [note, setNote] = createSignal<string | null>(null)
  async function flip(key: "enabled" | "includePhi", on: boolean) {
    const before = data.latest
    if (!before) return
    setNote(null)
    mutate({ ...before, [key]: on })
    try {
      const res = await props.doFetch(`/iris/atlas-local-copy`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ [key]: on }),
      })
      if (!res.ok) throw new Error(`request failed (${res.status})`)
      mutate((await res.json()) as LocalCopy)
      props.onChanged?.()
    } catch (e) {
      mutate(before)
      setNote(`Not saved — ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return (
    <Dialog title="Offline copy" description="Boards you open, kept on this machine">
      <div class="iris-notify" data-slot="iris-local-copy">
        <Show when={data.error}>
          <p class="text-12-regular text-text-weak">Could not read the setting — {String(data.error?.message ?? data.error)}.</p>
        </Show>
        <Show when={data.latest}>
          <label class="iris-notify__row">
            <input type="checkbox" checked={data.latest!.enabled} onChange={(e) => void flip("enabled", e.currentTarget.checked)} />
            <span>
              <span class="iris-notify__label">Keep a copy of Atlas on this machine</span>
              <span class="iris-notify__hint">
                Boards open at once from the copy, then update. With no connection you still see them. Turning this off deletes every copy.
              </span>
            </span>
          </label>
          <label class="iris-notify__row">
            <input
              type="checkbox"
              checked={data.latest!.includePhi}
              disabled={!data.latest!.enabled}
              onChange={(e) => void flip("includePhi", e.currentTarget.checked)}
            />
            <span>
              <span class="iris-notify__label">Include boards marked as holding health information</span>
              <span class="iris-notify__hint">
                Off by default: a copy on disk is not encrypted. Turning this off deletes the copies of those boards.
              </span>
            </span>
          </label>
          <p class="iris-notify__hint">
            Keeps the {data.latest!.maxBoards} boards you opened most recently, up to {data.latest!.maxMB} MB, in ~/.iris/atlas. Card text is
            not kept — only what the board shows — so searching a board still needs a connection.
          </p>
        </Show>
        <Show when={note()}>
          <p class="iris-quick__note" role="status">
            {note()}
          </p>
        </Show>
      </div>
    </Dialog>
  )
}
