import { createEffect, createMemo, on, Show } from "solid-js"
import { BasicTool } from "@opencode-ai/session-ui/basic-tool"
import { ToolRegistry } from "@opencode-ai/session-ui/message-part"
import { useLayout } from "@/context/layout"
import { useSessionLayout } from "@/pages/session/session-layout"
import { renderMarkdown } from "./iris-item"
import { ARTIFACT_SANDBOX, markdownDocument, sandboxedDocument } from "./iris-artifacts-model"
import { focusArtifact, requestIrisNav } from "./iris-nav"
import "./genesis-artifact-card.css"

/**
 * The chat's side of Genesis › Artifacts: a `genesis_artifact` create/update is a CARD — a live
 * thumbnail, the title, who made it — not the generic "Called `genesis_artifact` content=<!DOCTYPE…"
 * row. Clicking it opens the side panel on Genesis › Artifacts with that artifact selected.
 *
 * A NEW artifact also opens the panel by itself, once, as the tool finishes — only for a call
 * that completes while this card is on screen. Reopening an old session draws the cards without
 * springing the panel open for every artifact in the history.
 *
 * Registered from the app (not session-ui) because opening the panel needs the app's layout
 * contexts; imported once for its side effect by message-timeline.tsx.
 */

type Kind = "html" | "markdown" | "csv" | "code"

function thumbnailDoc(kind: Kind, content: string): string | undefined {
  if (kind === "html") return sandboxedDocument(content)
  if (kind === "markdown") return sandboxedDocument(markdownDocument(renderMarkdown(content)))
  return undefined
}

function useOpenArtifact() {
  const layout = useLayout()
  const { tabs, view } = useSessionLayout()
  return (id: string) => {
    requestIrisNav({ surface: "pages", sub: "artifacts", artifactId: id })
    focusArtifact(id)
    // Same three steps as the header's IRIS button (session-header.tsx) — the tab only renders
    // once it is in the list, and "other" is the source that does not close the panel again.
    view().reviewPanel.open("other")
    if (layout.fileTree.opened() && layout.fileTree.tab() !== "all") layout.fileTree.setTab("all")
    void tabs().open("iris")
    tabs().setActive("iris")
  }
}

ToolRegistry.register({
  name: "genesis_artifact",
  render(props) {
    const open = useOpenArtifact()
    const action = createMemo(() => String(props.input?.action ?? ""))
    const pending = createMemo(() => props.status === "pending" || props.status === "running")
    const meta = createMemo(() => (props.metadata ?? {}) as Record<string, any>)
    const id = createMemo(() => (typeof meta().id === "string" ? (meta().id as string) : undefined))
    const kind = createMemo<Kind>(() => (meta().kind ?? props.input?.kind ?? "html") as Kind)
    const title = createMemo(() => String(meta().title ?? props.input?.title ?? "Untitled"))
    const content = createMemo(() => (typeof props.input?.content === "string" ? (props.input.content as string) : ""))
    const isWrite = createMemo(() => action() === "create" || action() === "update")
    const conflict = createMemo(() => meta().conflict === true)

    // Spring open once, for a create that completes while this card is mounted.
    createEffect(
      on(
        () => props.status,
        (now, before) => {
          if (now === "completed" && before && before !== "completed" && meta().created && id()) open(id()!)
        },
      ),
    )

    return (
      <Show
        when={isWrite() && !conflict()}
        fallback={
          <BasicTool
            {...props}
            hideDetails
            icon="window-cursor"
            trigger={{
              title:
                action() === "list"
                  ? "Genesis artifacts"
                  : conflict()
                    ? "Genesis artifact — changed by someone else"
                    : "Genesis artifact",
              subtitle: action() === "list" ? "listed this session's artifacts" : ((props.input?.id as string) ?? ""),
            }}
          />
        }
      >
        <button
          type="button"
          class="genesis-artifact-card"
          data-kind={kind()}
          disabled={!id()}
          onClick={() => id() && open(id()!)}
          aria-label={`Open Genesis artifact ${title()}`}
        >
          <div class="genesis-artifact-card__thumb" aria-hidden="true">
            <Show
              when={thumbnailDoc(kind(), content())}
              fallback={<pre class="genesis-artifact-card__text">{content().split("\n").slice(0, 8).join("\n")}</pre>}
            >
              {(doc) => (
                <iframe
                  class="genesis-artifact-card__frame"
                  title=""
                  tabIndex={-1}
                  sandbox={ARTIFACT_SANDBOX}
                  referrerpolicy="no-referrer"
                  srcdoc={doc()}
                />
              )}
            </Show>
          </div>
          <div class="genesis-artifact-card__meta">
            <span class="genesis-artifact-card__eyebrow">
              {pending()
                ? "Making Genesis artifact…"
                : action() === "update"
                  ? "Genesis artifact updated"
                  : "Genesis artifact"}
              <Show when={meta().revision}> · rev {meta().revision}</Show>
            </span>
            <span class="genesis-artifact-card__title">{title()}</span>
            <span class="genesis-artifact-card__cta">{pending() ? kind() : `${kind()} · Open in Genesis ›`}</span>
          </div>
        </button>
      </Show>
    )
  },
})
