import { createEffect, createSignal, Match, on, onCleanup, Show, Switch } from "solid-js"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Icon } from "@opencode-ai/ui/icon"
import { Spinner } from "@opencode-ai/ui/spinner"
import {
  PAGE_ALLOW,
  PAGE_LOAD_TIMEOUT_MS,
  PAGE_SANDBOX,
  pageSessionState,
  pageVerdict,
  pinnedPageUrl,
  signedFrameUrl,
  SIGNIN_RETRIES,
  type FrameCheckAnswer,
  type PageSignInAnswer,
  type PageVerdict,
  PAGE_HOST,
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
  /**
   * Open the page signed in as the IRIS user (#192482): the sidecar mints a one-time code and the
   * frame loads /p/<slug>#atlas_code=<code>. A fresh code on every load and reload; one automatic
   * retry when the page reports the code refused (spent or expired before it loaded).
   */
  signIn?: boolean
}) {
  // The plain address — what the bar shows and "Open in browser" opens. Never the signed one.
  const url = () => pinnedPageUrl(props.slug)
  const [phase, setPhase] = createSignal<Phase>({ at: "checking" })
  const [reloadKey, setReloadKey] = createSignal(0)
  // What the frame loads, and a key that changes whenever a fresh code is minted.
  const [frameSrc, setFrameSrc] = createSignal(url())
  const [mintKey, setMintKey] = createSignal(0)
  const [signIn, setSignIn] = createSignal<{ state: "off" | "pending" | "signed_in" | "failed"; reason?: string }>({ state: "off" })
  let frameEl: HTMLIFrameElement | undefined
  let retries = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => clearTimeout(timer))

  // Never logged and never cached: each call is a new single-use code.
  const mint = (slug: string) =>
    props
      .doFetch(`/iris/page-signin`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ slug }),
      })
      .then((r) => (r.ok ? (r.json() as Promise<PageSignInAnswer>) : undefined))
      .catch(() => undefined)
      .then((a) => signedFrameUrl(slug, a))

  // The page tells us how its sign-in went. A refused code (it expired while the frame loaded, or
  // was spent) gets one fresh code per reload; past that the page's own gate is what shows.
  const onMessage = (e: MessageEvent) => {
    if (!props.signIn) return
    const state = pageSessionState(e, frameEl?.contentWindow, props.slug)
    if (state === "signed_in") setSignIn({ state: "signed_in" })
    if (state !== "refused") return
    if (retries >= SIGNIN_RETRIES) return setSignIn({ state: "failed", reason: "the page refused the sign-in" })
    retries++
    const slug = props.slug
    mint(slug).then((m) => {
      if (slug !== props.slug) return
      setSignIn(m.signed ? { state: "pending" } : { state: "failed", reason: m.reason })
      setFrameSrc(m.url)
      setMintKey((k) => k + 1)
    })
  }
  window.addEventListener("message", onMessage)
  onCleanup(() => window.removeEventListener("message", onMessage))

  createEffect(
    on([() => props.slug, reloadKey], ([slug, key]) => {
      clearTimeout(timer)
      setPhase({ at: "checking" })
      const q = `url=${encodeURIComponent(pinnedPageUrl(slug))}&origin=${encodeURIComponent(location.origin)}`
      props
        .doFetch(`/iris/frame-check?${q}`, { headers: { Accept: "application/json" } })
        .then((r) => (r.ok ? (r.json() as Promise<FrameCheckAnswer>) : undefined))
        .catch(() => undefined)
        .then(async (answer) => {
          if (slug !== props.slug || key !== reloadKey()) return // a later reload won the race
          const v = pageVerdict(slug, answer, location.origin)
          if (!v.show) return setPhase({ at: "error", ...v })
          retries = 0
          if (props.signIn) {
            setSignIn({ state: "pending" })
            const m = await mint(slug)
            if (slug !== props.slug || key !== reloadKey()) return
            setSignIn(m.signed ? { state: "pending" } : { state: "failed", reason: m.reason })
            setFrameSrc(m.url)
          } else {
            setSignIn({ state: "off" })
            setFrameSrc(pinnedPageUrl(slug))
          }
          setMintKey((k) => k + 1)
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
    <div
      class="iris-pinned"
      data-component="iris-pinned-page"
      data-slug={props.slug}
      data-phase={phase().at}
      data-signin={signIn().state}
    >
      <div class="iris-pinned__bar">
        <span class="iris-pinned__where" title={url()}>
          {PAGE_HOST}/p/<b>{props.slug}</b>
        </span>
        <Show when={signIn().state === "signed_in"}>
          <span class="iris-pinned__signin" data-slot="pinned-signed-in" title="Signed in with your IRIS account — no emailed code">
            signed in
          </span>
        </Show>
        <Show when={signIn().state === "failed"}>
          <span
            class="iris-pinned__signin iris-pinned__signin--off"
            data-slot="pinned-signin-failed"
            title={`Not signed in automatically: ${signIn().reason ?? "unknown"}. The page's own sign-in still works.`}
          >
            not signed in
          </span>
        </Show>
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
            <Show when={`${props.slug}#${reloadKey()}#${mintKey()}`} keyed>
              <iframe
                ref={frameEl}
                src={frameSrc()}
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
