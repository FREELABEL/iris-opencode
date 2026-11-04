import { createEffect, createSignal, Match, on, onCleanup, Show, Switch } from "solid-js"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Icon } from "@opencode-ai/ui/icon"
import { Spinner } from "@opencode-ai/ui/spinner"
import {
  PAGE_ALLOW,
  PAGE_LOAD_TIMEOUT_MS,
  PAGE_SANDBOX,
  pageVerdict,
  pinnedPageUrl,
  type FrameCheckAnswer,
  type PageVerdict,
} from "./iris-pinned-page-model"
import "./iris-pinned-page.css"

/**
 * A Genesis page pinned as a panel tab (#192480). One component, configured by a slug, so a new
 * tab that shows a page is a line in SUBVIEWS rather than a new pane. The frame is the Genesis
 * preview's (`iris-preview`, same sandbox); what this adds is knowing whether the page is there.
 *
 * Not a createResource: a resource read here would suspend the panel's pane boundary on every
 * reload. Plain signals cannot suspend (the same choice as the Browser tab, session-web-tab.tsx).
 */
type Phase = { at: "checking" } | { at: "loading" } | { at: "ready" } | ({ at: "error" } & Extract<PageVerdict, { show: false }>)

export function IrisPinnedPage(props: {
  slug: string
  label: string
  doFetch: (path: string, init?: RequestInit) => Promise<Response>
  openExternal: (url: string) => void
}) {
  const url = () => pinnedPageUrl(props.slug)
  const [phase, setPhase] = createSignal<Phase>({ at: "checking" })
  const [reloadKey, setReloadKey] = createSignal(0)
  let timer: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => clearTimeout(timer))

  createEffect(
    on([() => props.slug, reloadKey], ([slug, key]) => {
      clearTimeout(timer)
      setPhase({ at: "checking" })
      const q = `url=${encodeURIComponent(pinnedPageUrl(slug))}&origin=${encodeURIComponent(location.origin)}`
      props
        .doFetch(`/iris/frame-check?${q}`, { headers: { Accept: "application/json" } })
        .then((r) => (r.ok ? (r.json() as Promise<FrameCheckAnswer>) : undefined))
        .catch(() => undefined)
        .then((answer) => {
          if (slug !== props.slug || key !== reloadKey()) return // a later reload won the race
          const v = pageVerdict(slug, answer)
          if (!v.show) return setPhase({ at: "error", ...v })
          setPhase({ at: "loading" })
          timer = setTimeout(() => {
            if (phase().at === "loading")
              setPhase({
                at: "error",
                show: false,
                title: "The page didn't finish loading",
                detail: `Nothing arrived in ${PAGE_LOAD_TIMEOUT_MS / 1000}s. Reload, or open it in your browser.`,
              })
          }, PAGE_LOAD_TIMEOUT_MS)
        })
    }),
  )

  const reload = () => setReloadKey((k) => k + 1)
  const framed = () => phase().at === "loading" || phase().at === "ready"

  return (
    <div class="iris-pinned" data-component="iris-pinned-page" data-slug={props.slug} data-phase={phase().at}>
      <div class="iris-pinned__bar">
        <span class="iris-pinned__where" title={url()}>
          freelabel.net/p/<b>{props.slug}</b>
        </span>
        <IconButton icon="arrow-undo-down" variant="ghost" class="h-6 w-6" onClick={reload} aria-label="Reload" title="Reload" />
        <IconButton
          icon="square-arrow-top-right"
          variant="ghost"
          class="h-6 w-6"
          onClick={() => props.openExternal(url())}
          aria-label="Open in browser"
          title="Open in browser"
        />
      </div>
      <div class="iris-pinned__body">
        <Switch>
          <Match when={phase().at === "error" && (phase() as Extract<Phase, { at: "error" }>)}>
            {(e) => (
              <div class="iris-pinned__note" data-slot="pinned-error" role="alert">
                <Icon name="warning" class="iris-pinned__warn" />
                <div class="iris-pinned__title">{e().title}</div>
                <div class="iris-pinned__reason">{e().detail}</div>
                <div class="iris-pinned__actions">
                  <IconButton icon="arrow-undo-down" variant="secondary" class="h-7 w-7" onClick={reload} aria-label="Try again" title="Try again" />
                  <IconButton
                    icon="square-arrow-top-right"
                    variant="secondary"
                    class="h-7 w-7"
                    onClick={() => props.openExternal(url())}
                    aria-label="Open in browser"
                    title="Open in browser"
                  />
                </div>
              </div>
            )}
          </Match>
          <Match when={framed()}>
            <Show when={`${props.slug}#${reloadKey()}`} keyed>
              <iframe
                src={url()}
                class="iris-preview iris-pinned__frame"
                classList={{ "iris-pinned__frame--loading": phase().at === "loading" }}
                title={props.label}
                sandbox={PAGE_SANDBOX}
                allow={PAGE_ALLOW}
                referrerpolicy="strict-origin-when-cross-origin"
                data-testid="pinned-page-frame"
                onLoad={() => {
                  clearTimeout(timer)
                  if (phase().at === "loading") setPhase({ at: "ready" })
                }}
              />
            </Show>
          </Match>
        </Switch>
        <Show when={phase().at === "checking" || phase().at === "loading"}>
          <div class="iris-pinned__loading" aria-live="polite">
            <Spinner class="iris-pinned__bigspin" />
            <span>Loading {props.label}…</span>
          </div>
        </Show>
      </div>
    </div>
  )
}
