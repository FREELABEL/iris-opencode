import { createEffect, createMemo, createSignal, on, onCleanup, onMount, Show } from "solid-js"
import { BasicTool } from "@opencode-ai/session-ui/basic-tool"
import { ToolRegistry } from "@opencode-ai/session-ui/message-part"
import { useLayout } from "@/context/layout"
import { useSessionLayout } from "@/pages/session/session-layout"
import { renderMarkdown } from "./iris-item"
import {
  ARTIFACT_SANDBOX,
  INLINE_DEFAULT_HEIGHT,
  inlineDocument,
  inlineHeight,
  markdownDocument,
  sandboxedDocument,
} from "./iris-artifacts-model"
import type { Bindings } from "@opencode-ai/core/util/iris-bindings"
import { specDocument, type UiNode } from "@opencode-ai/core/util/iris-ui-catalog"
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

/**
 * INLINE (#188930): the answer IS the interface. Drawn full width inside the message and live —
 * the user filters, drags and clicks there, and the page runs without calling the model again.
 * Same sandbox and CSP as the thumbnail (ADR-01); its data is only what the tool bound.
 */
function InlineArtifact(props: {
  title: string
  kind: Kind
  content: string
  bindings?: Bindings
  revision?: number
  onOpen?: () => void
}) {
  let frame: HTMLIFrameElement | undefined
  const [height, setHeight] = createSignal(INLINE_DEFAULT_HEIGHT)
  const doc = createMemo(() =>
    props.kind === "markdown"
      ? inlineDocument(markdownDocument(renderMarkdown(props.content)))
      : inlineDocument(props.content, props.bindings),
  )
  const bound = createMemo(() =>
    Object.entries(props.bindings ?? {})
      .map(([n, b]) => `${n} · ${b.meta.rows}`)
      .join("  "),
  )
  onMount(() => {
    const listen = (e: MessageEvent) => {
      // Only this frame's own window, only a clamped number. Any other message is ignored.
      if (!frame || e.source !== frame?.contentWindow) return
      const h = inlineHeight(e.data)
      if (h !== undefined) setHeight(h)
    }
    window.addEventListener("message", listen)
    onCleanup(() => window.removeEventListener("message", listen))
  })
  return (
    <div class="genesis-artifact-inline" data-kind={props.kind}>
      <div class="genesis-artifact-inline__bar">
        <span class="genesis-artifact-inline__title">{props.title}</span>
        <Show when={bound()}>
          <span class="genesis-artifact-inline__bound" title="Data bound by reference — not retyped by the model">
            {bound()}
          </span>
        </Show>
        <Show when={props.revision && props.revision > 1}>
          <span class="genesis-artifact-inline__rev">rev {props.revision}</span>
        </Show>
        <Show when={props.onOpen}>
          <button type="button" class="genesis-artifact-inline__open" onClick={() => props.onOpen?.()}>
            Open in Genesis ›
          </button>
        </Show>
      </div>
      <iframe
        ref={frame}
        class="genesis-artifact-inline__frame"
        title={props.title}
        style={{ height: `${height()}px` }}
        sandbox={ARTIFACT_SANDBOX}
        referrerpolicy="no-referrer"
        srcdoc={doc()}
      />
    </div>
  )
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
    // A components answer (#188930 gap #1) has no content: build the same document the tool
    // stored, with the same core function, so the card and the artifact cannot disagree.
    const content = createMemo(() =>
      Array.isArray(props.input?.components)
        ? specDocument(props.input.components as UiNode[], String(props.input?.title ?? "Untitled"))
        : typeof props.input?.content === "string"
          ? (props.input.content as string)
          : "",
    )
    const isWrite = createMemo(() => action() === "create" || action() === "update")
    const conflict = createMemo(() => meta().conflict === true)
    // Inline once the call has finished: a half-streamed page is not worth running.
    const inline = createMemo(
      () => meta().display === "inline" && !pending() && (kind() === "html" || kind() === "markdown"),
    )

    // Spring open once, for a create that completes while this card is mounted.
    createEffect(
      on(
        () => props.status,
        (now, before) => {
          // Not for inline: the answer is already in the message; opening the pane would cover it.
          if (
            now === "completed" &&
            before &&
            before !== "completed" &&
            meta().created &&
            id() &&
            meta().display !== "inline"
          )
            open(id()!)
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
        <Show
          when={!inline()}
          fallback={
            <InlineArtifact
              title={title()}
              kind={kind()}
              content={content()}
              bindings={meta().bindings as Bindings | undefined}
              revision={meta().revision}
              onOpen={id() ? () => open(id()!) : undefined}
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
      </Show>
    )
  },
})
