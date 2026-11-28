import { createEffect, createMemo, createSignal, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { LIVE_SANDBOX } from "./iris-artifacts-model"
import { atlasNoteUrl, fallbackTitle, type AtlasNote } from "./iris-atlas-artifacts-model"
import { clearAtlasFocus, irisAtlasFocus } from "./iris-nav"
import { IrisArtifactHistory, type HistoryRow } from "./iris-artifact-history"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"

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
/** What /iris/atlas-note said about a note. Absent while it is being asked. */
type NoteCheck = { state: "public" | "unavailable" | "unreachable" | "invalid"; title?: string }

export function IrisAtlasArtifacts(props: {
  sessionId?: string
  doFetch?: (path: string, init?: RequestInit) => Promise<Response>
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

  const language = useLanguage()
  const [openUrl, setOpenUrl] = createSignal<string | undefined>()
  /** The list view (#194583): every note this chat made, as rows — the same list Genesis uses. */
  const [listView, setListView] = createSignal(false)
  const [listOpen, setListOpen] = createSignal(false)
  const [reload, setReload] = createSignal(0)

  // Newest by default; keep the user's choice while it still exists.
  createEffect(() => {
    const list = notes()
    if (list.some((n) => n.url === openUrl())) return
    setOpenUrl(list[0]?.url)
  })
  const open = createMemo(() => notes().find((n) => n.url === openUrl()))

  // Ask the engine about each note once: its real title (a note found in Shell output has none
  // yet), and whether it is private — a private note framed here is a blank 404 with no reason.
  const [checks, setChecks] = createStore<Record<string, NoteCheck>>({})
  const asked = new Set<string>()
  const check = (url: string) => {
    const fetcher = props.doFetch
    if (!fetcher) return
    asked.add(url)
    fetcher(`/iris/atlas-note?url=${encodeURIComponent(url)}`, { headers: { Accept: "application/json" } })
      .then((r) => (r.ok ? (r.json() as Promise<NoteCheck>) : undefined))
      .then((c) => c && setChecks(url, c))
      .catch(() => asked.delete(url))
  }
  createEffect(() => {
    for (const n of notes()) if (!asked.has(n.url)) check(n.url)
  })
  // The note's own title wins over what the session recorded: a model's guess, or a uuid.
  const titleOf = (n: AtlasNote) => checks[n.url]?.title ?? n.title
  const unavailable = (n: AtlasNote) => checks[n.url]?.state === "unavailable"
  const rows = createMemo<HistoryRow[]>(() =>
    notes().map((n) => ({
      key: n.url,
      title: titleOf(n),
      kind: "note" as const,
      author: n.source === "tool" ? language.t("iris.atlasNotes.sharedInChat") : language.t("iris.atlasNotes.publishedHere"),
      when: n.at,
      status: unavailable(n)
        ? { label: language.t("iris.artifacts.status.notPublic"), tone: "warning" as const }
        : checks[n.url]?.state === "public"
          ? { label: language.t("iris.artifacts.status.public"), tone: "success" as const }
          : undefined,
      shareUrl: unavailable(n) ? undefined : n.url,
      selected: n.url === openUrl(),
    })),
  )
  const share = (r: HistoryRow) => {
    if (!r.shareUrl) return
    void navigator.clipboard
      ?.writeText(r.shareUrl)
      .then(() => showToast({ variant: "success", icon: "check", description: language.t("iris.artifacts.history.shared") }))
      .catch(() => showToast({ description: r.shareUrl }))
  }

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
      {/* The list (#194583): what this chat made, when, and whether it is public — and the empty
          state when there is nothing yet, with the next step. */}
      <Show when={listView() || notes().length === 0}>
        <IrisArtifactHistory
          rows={rows()}
          empty={{
            title: language.t(props.sessionId ? "iris.atlasNotes.empty.title" : "iris.atlasNotes.noChat.title"),
            body: language.t(props.sessionId ? "iris.atlasNotes.empty.body" : "iris.atlasNotes.noChat.body"),
          }}
          onOpen={(r) => {
            setOpenUrl(r.key)
            setListView(false)
          }}
          onShare={share}
        />
      </Show>

      <Show when={!listView() && open()}>
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
                            <span class="iris-artifacts__title">{titleOf(n)}</span>
                            <span class="iris-artifacts__kind">note</span>
                            <span class="iris-artifacts__by">{unavailable(n) ? "not public" : n.source === "tool" ? "shared in chat" : "published here"}</span>
                          </button>
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
              </div>
              <button type="button" class="iris-card__linkbtn iris-artifacts__histbtn" data-action="atlas-notes-list" onClick={() => setListView(true)}>
                {language.t("iris.atlasNotes.list")}
              </button>
              <span class="iris-artifacts__sep" />
              <strong class="iris-artifacts__tbtitle">{titleOf(note())}</strong>
              <span class="iris-artifacts__tbmeta iris-atlas-note__url" data-testid="atlas-note-url" title={note().url}>
                {note().url.replace(/^https:\/\//, "")}
              </span>
              <button type="button" class="iris-card__linkbtn" onClick={() => {
                  check(note().url)
                  setReload((n) => n + 1)
                }}>
                Reload
              </button>
              <Show when={props.openExternal}>
                <button type="button" class="iris-card__linkbtn" onClick={() => props.openExternal!(note().url)}>
                  Open in browser
                </button>
              </Show>
              <Show when={!unavailable(note())}>
                <button
                  type="button"
                  class="iris-card__linkbtn"
                  onClick={() => share({ key: note().url, title: titleOf(note()), kind: "note", shareUrl: note().url })}
                >
                  {language.t("iris.artifacts.history.share")}
                </button>
              </Show>
            </div>
            <Show when={unavailable(note())}>
              <p class="iris-artifacts__note" data-testid="atlas-note-private">
                This note isn't public, or the link is wrong, so there is nothing to show. Ask your agent to make it
                public, then press Reload.
              </p>
            </Show>
            <div class="iris-artifacts__preview" hidden={unavailable(note())}>
              {/* Keyed on url + reload so either one gives a fresh load of the live page. */}
              <For each={[`${note().url}#${reload()}`]}>
                {() => (
                  <iframe
                    class="iris-artifacts__frame"
                    title={`${titleOf(note())} — Atlas`}
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
