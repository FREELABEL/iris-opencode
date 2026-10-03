import { createEffect, createMemo, createSignal, For, Show } from "solid-js"
import { LIVE_SANDBOX } from "./iris-artifacts-model"
import { atlasNoteUrl, fallbackTitle, type AtlasNote } from "./iris-atlas-artifacts-model"
import { clearAtlasFocus, irisAtlasFocus } from "./iris-nav"

/**
 * Atlas › Artifacts (epic #187717): the Atlas notes this session produced, each shown LIVE — the
 * real heyiris.io/n/… page in the panel's frame, its URL on the toolbar, one click to the browser.
 *
 * Same shape as Genesis › Artifacts on purpose (one toolbar row, "N notes ▾" opens the list), so
 * the two read as one feature in two places. The difference is where the content lives: a Genesis
 * artifact is a draft on disk; an Atlas note is already public, so there is nothing to draft or
 * publish here — only to look at and hand out.
 *
 * The list is derived from the session (iris-atlas-artifacts-model), so it is live with the
 * transcript and needs no poll.
 */
export function IrisAtlasArtifacts(props: {
  sessionId?: string
  notes: () => AtlasNote[]
  openExternal?: (url: string) => void
}) {
  // A note a card asked for that the list does not have (yet) — still shown, never dropped.
  const [extra, setExtra] = createSignal<AtlasNote | undefined>()
  const notes = createMemo(() => {
    const list = props.notes()
    const x = extra()
    return x && !list.some((n) => n.url === x.url) ? [x, ...list] : list
  })

  const [openUrl, setOpenUrl] = createSignal<string | undefined>()
  const [listOpen, setListOpen] = createSignal(false)
  const [reload, setReload] = createSignal(0)

  // Newest by default; keep the user's choice while it still exists.
  createEffect(() => {
    const list = notes()
    if (list.some((n) => n.url === openUrl())) return
    setOpenUrl(list[0]?.url)
  })
  const open = createMemo(() => notes().find((n) => n.url === openUrl()))

  createEffect(() => {
    const want = irisAtlasFocus()
    if (!want) return
    const url = atlasNoteUrl(want.url)
    if (url) {
      if (!props.notes().some((n) => n.url === url))
        setExtra({ url, title: fallbackTitle(url), source: "tool", order: Number.MAX_SAFE_INTEGER })
      setOpenUrl(url)
    }
    clearAtlasFocus()
  })

  return (
    <div class="iris-artifacts">
      <Show when={!props.sessionId}>
        <p class="iris-artifacts__note">Open a session — these are the Atlas notes the conversation produced.</p>
      </Show>
      <Show when={props.sessionId && notes().length === 0}>
        <p class="iris-artifacts__note">
          No Atlas notes yet. When an agent in this session publishes an Atlas item (a plan, an epic, a brief) or shows
          one with the atlas_artifact tool, it opens here — the live page, with its link.
        </p>
      </Show>

      <Show when={open()}>
        {(note) => (
          <>
            <div class="iris-artifacts__toolbar">
              <div class="iris-artifacts__all">
                <button
                  type="button"
                  class="iris-artifacts__allbtn"
                  classList={{ "iris-artifacts__allbtn--open": listOpen() }}
                  aria-haspopup="listbox"
                  aria-expanded={listOpen()}
                  onClick={() => setListOpen((v) => !v)}
                >
                  {notes().length} {notes().length === 1 ? "note" : "notes"} ▾
                </button>
                <Show when={listOpen()}>
                  <ul
                    class="iris-artifacts__list iris-artifacts__menu"
                    aria-label="Atlas notes"
                    onMouseLeave={() => setListOpen(false)}
                  >
                    <For each={notes()}>
                      {(n) => (
                        <li>
                          <button
                            type="button"
                            class="iris-artifacts__row"
                            classList={{ "iris-artifacts__row--open": n.url === openUrl() }}
                            data-atlas-note={n.url}
                            title={n.url}
                            onClick={() => {
                              setOpenUrl(n.url)
                              setListOpen(false)
                            }}
                          >
                            <span class="iris-artifacts__title">{n.title}</span>
                            <span class="iris-artifacts__kind">note</span>
                            <span class="iris-artifacts__by">{n.source === "tool" ? "shown by agent" : "from shell"}</span>
                          </button>
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
              </div>
              <span class="iris-artifacts__sep" />
              <strong class="iris-artifacts__tbtitle">{note().title}</strong>
              <span class="iris-artifacts__tbmeta iris-atlas-note__url" data-testid="atlas-note-url" title={note().url}>
                {note().url.replace(/^https:\/\//, "")}
              </span>
              <button type="button" class="iris-card__linkbtn" onClick={() => setReload((n) => n + 1)}>
                Reload
              </button>
              <Show when={props.openExternal}>
                <button type="button" class="iris-card__linkbtn" onClick={() => props.openExternal!(note().url)}>
                  Open in browser
                </button>
              </Show>
            </div>
            <div class="iris-artifacts__preview">
              {/* Keyed on url + reload so either one gives a fresh load of the live page. */}
              <For each={[`${note().url}#${reload()}`]}>
                {() => (
                  <iframe
                    class="iris-artifacts__frame"
                    title={`${note().title} — Atlas`}
                    sandbox={LIVE_SANDBOX}
                    referrerpolicy="strict-origin-when-cross-origin"
                    src={note().url}
                    data-testid="atlas-note-frame"
                  />
                )}
              </For>
            </div>
          </>
        )}
      </Show>
    </div>
  )
}
