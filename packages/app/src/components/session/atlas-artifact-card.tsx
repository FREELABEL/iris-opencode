import { createEffect, createMemo, on, Show } from "solid-js"
import { BasicTool } from "@opencode-ai/session-ui/basic-tool"
import { ToolRegistry } from "@opencode-ai/session-ui/message-part"
import { useLayout } from "@/context/layout"
import { useSessionLayout } from "@/pages/session/session-layout"
import { LIVE_SANDBOX } from "./iris-artifacts-model"
import { atlasNoteUrl } from "./iris-atlas-artifacts-model"
import { focusAtlasNote, requestIrisNav } from "./iris-nav"
import "./genesis-artifact-card.css"

/**
 * The chat's side of Atlas › Artifacts (#187717) — the Atlas twin of genesis-artifact-card.
 *
 * An `atlas_artifact` call is a CARD: the live note as a thumbnail, its title, its URL. Clicking
 * it opens the side panel on Atlas › Artifacts with that note loaded. A call that completes while
 * the card is on screen opens the panel by itself, once; reopening an old session does not.
 *
 * The thumbnail is the REAL page (heyiris.io/n/… allows tauri://localhost as a frame ancestor),
 * not a re-render — so what the card shows is what anyone with the link sees. Only a URL that
 * passes atlasNoteUrl is ever framed, and it is framed with the LIVE sandbox, which is for
 * heyiris.io and nothing else.
 */

function useOpenAtlasNote() {
  const layout = useLayout()
  const { tabs, view } = useSessionLayout()
  return (url: string) => {
    requestIrisNav({ surface: "atlas", sub: "artifacts" })
    focusAtlasNote(url)
    // Same three steps as genesis-artifact-card — see the comment there.
    view().reviewPanel.open("other")
    if (layout.fileTree.opened() && layout.fileTree.tab() !== "all") layout.fileTree.setTab("all")
    void tabs().open("iris")
    tabs().setActive("iris")
  }
}

ToolRegistry.register({
  name: "atlas_artifact",
  render(props) {
    const open = useOpenAtlasNote()
    const pending = createMemo(() => props.status === "pending" || props.status === "running")
    const meta = createMemo(() => (props.metadata ?? {}) as Record<string, any>)
    // The metadata URL is the canonical one the tool checked; the input is only a fallback while
    // the call is still running, and it is re-validated either way.
    const url = createMemo(() => atlasNoteUrl(meta().url ?? props.input?.url))
    const title = createMemo(() => String(meta().title ?? props.input?.title ?? "Atlas note"))
    const summary = createMemo(() => (typeof meta().summary === "string" ? (meta().summary as string) : undefined))
    const done = createMemo(() => props.status === "completed" && !!meta().url)

    createEffect(
      on(
        () => props.status,
        (now, before) => {
          if (now === "completed" && before && before !== "completed" && url()) open(url()!)
        },
      ),
    )

    return (
      <Show
        when={(pending() || done()) && url()}
        fallback={
          <BasicTool
            {...props}
            hideDetails
            icon="window-cursor"
            trigger={{ title: "Atlas note", subtitle: String(props.input?.url ?? "") }}
          />
        }
      >
        <button
          type="button"
          class="genesis-artifact-card"
          data-kind="atlas"
          disabled={!done()}
          onClick={() => done() && open(url()!)}
          aria-label={`Open Atlas note ${title()}`}
        >
          <div class="genesis-artifact-card__thumb" aria-hidden="true">
            <Show when={done()}>
              <iframe
                class="genesis-artifact-card__frame"
                title=""
                tabIndex={-1}
                loading="lazy"
                sandbox={LIVE_SANDBOX}
                referrerpolicy="strict-origin-when-cross-origin"
                src={url()}
              />
            </Show>
          </div>
          <div class="genesis-artifact-card__meta">
            <span class="genesis-artifact-card__eyebrow">{pending() ? "Opening Atlas note…" : "Atlas note"}</span>
            <span class="genesis-artifact-card__title">{pending() ? url() : title()}</span>
            <Show when={summary()}>
              <span class="genesis-artifact-card__cta">{summary()}</span>
            </Show>
            <span class="genesis-artifact-card__cta">{pending() ? "checking it resolves" : "Open in Atlas ›"}</span>
          </div>
        </button>
      </Show>
    )
  },
})
