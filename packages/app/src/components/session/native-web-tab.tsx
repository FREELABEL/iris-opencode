import { createEffect, createSignal, For, Match, on, onCleanup, onMount, Show, Switch } from "solid-js"
import { IconButton } from "@opencode-ai/ui/icon-button"
import type { NativeBrowser, NativeBrowserBounds, NativeBrowserState } from "@/context/platform"
import { boundsOf, OVERLAY_SELECTOR, QUICK_SITES, sameBounds } from "./native-browser-model"
import {
  answerConfirm,
  askedSite,
  browserActivity,
  browserGrants,
  dismissAsked,
  grantSite,
  handBack,
  hostOf,
  originOf,
  revokeSite,
  stripState as computeStrip,
  takeOver,
  takenOverSites,
} from "./browser-grants"
import { webReloadKey, webUrl } from "./web-nav"

/** The last chat link opened, across remounts (one native view, one link history). */
let lastLink: string | undefined

/**
 * The Browser tab on desktop, spike #193062 (epic #193051).
 *
 * The page is NOT in this document. It is a separate native webview that Rust draws over
 * `.session-web__body`, so this component only does three things: keep that view exactly over
 * the body (and hidden whenever the body is off screen or something must draw over it), drive
 * it from the bar, and show what it reports. Everything a page could use against the app is
 * refused on the Rust side (browser.rs `ipc_allowed`), not here.
 *
 * Known limits, on purpose for a spike: one tab; back/forward are always enabled (the page owns
 * its history); the app's zoom is read from platform.webviewZoom, which desktop doesn't set yet.
 */
export function NativeWebTab(props: {
  browser: NativeBrowser
  zoom: () => number
  openExternal: (url: string) => void
}) {
  const [address, setAddress] = createSignal("")
  const [page, setPage] = createSignal<NativeBrowserState | null>(null)
  const [opened, setOpened] = createSignal(false)
  const [error, setError] = createSignal<string>()
  let body!: HTMLDivElement
  let input!: HTMLInputElement
  let last: NativeBrowserBounds | undefined
  let shown = false

  const origin = () => originOf(page()?.url)
  const stripState = () =>
    computeStrip({
      origin: origin(),
      grants: browserGrants(),
      asked: askedSite(),
      takenOver: takenOverSites(),
      activity: browserActivity(),
    })
  const activityHere = () => {
    const a = browserActivity()
    return a && a.origin === origin() ? a : undefined
  }
  const confirmLabel = () => {
    const a = askedSite()
    return a?.kind === "confirm" ? a.label : ""
  }

  const report = (s: NativeBrowserState) => {
    setPage(s)
    if (document.activeElement !== input) setAddress(s.url === "about:blank" ? "" : s.url)
  }

  /** Put the view where the body is, or hide it. Called at most once per frame. */
  const sync = () => {
    if (!opened()) return
    const b = boundsOf(body.getBoundingClientRect(), props.zoom())
    const covered = !!document.querySelector(OVERLAY_SELECTOR)
    if (!b || covered || document.hidden) {
      if (shown) {
        shown = false
        void props.browser.hide()
      }
      return
    }
    if (!shown) {
      shown = true
      last = b
      void props.browser.show(undefined, b)
      return
    }
    if (!sameBounds(b, last)) {
      last = b
      void props.browser.bounds(b)
    }
  }
  let raf = 0
  const schedule = () => {
    if (!raf) raf = requestAnimationFrame(() => ((raf = 0), sync()))
  }

  const open = (url: string) => {
    setError(undefined)
    const b = boundsOf(body.getBoundingClientRect(), props.zoom())
    if (!b) return
    props.browser
      .show(url, b)
      .then(() => {
        shown = true
        last = b
        setOpened(true)
        schedule() // an overlay may have opened while it was being created
      })
      .catch((e) => setError(String(e)))
  }
  const go = () => {
    const text = address().trim()
    if (!text) return
    if (!opened()) return open(text)
    props.browser.navigate(text).catch((e) => setError(String(e)))
  }

  // A link clicked in the chat (web-nav's history) opens here, ONCE: keyed by link + click, so
  // remounting this pane doesn't reload an old link over the page you browsed to since, and
  // clicking the same link again (same URL, new reload key) does open it again.
  createEffect(
    on([webUrl, webReloadKey], ([url, key]) => {
      const id = url ? `${url}#${key}` : undefined
      if (!url || id === lastLink) return
      lastLink = id
      open(url)
    }),
  )

  onMount(() => {
    const ro = new ResizeObserver(schedule)
    ro.observe(body)
    // Tab switches flip `hidden` on an ancestor, overlays mount anywhere under <body>: watch
    // both with one observer that only schedules a frame (the work is one rect + one query).
    const mo = new MutationObserver(schedule)
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden", "class"] })
    window.addEventListener("resize", schedule)
    document.addEventListener("visibilitychange", schedule)
    const off = props.browser.onState(report)
    // Switching products unmounts this pane but not the native view: pick its page back up
    // instead of showing the start tiles over a page that is still loaded.
    void props.browser
      .state()
      .then((s) => {
        if (!s || s.url === "about:blank") return
        report(s)
        setOpened(true)
        schedule()
      })
      .catch(() => undefined)
    // pushState (single-page apps) fires no load event: ask where it really is, once a second,
    // only while the view is on screen.
    const poll = setInterval(() => {
      if (shown) void props.browser.state().then((s) => s && report(s)).catch(() => undefined)
    }, 1000)
    onCleanup(() => {
      ro.disconnect()
      mo.disconnect()
      window.removeEventListener("resize", schedule)
      document.removeEventListener("visibilitychange", schedule)
      off()
      clearInterval(poll)
      cancelAnimationFrame(raf)
      if (shown) void props.browser.hide()
    })
  })

  return (
    <div data-component="session-web-tab" data-native="true" class="session-web">
      <div class="session-web__bar">
        <IconButton
          icon="chevron-left"
          variant="ghost"
          class="h-6 w-6"
          disabled={!opened()}
          onClick={() => props.browser.go("back")}
          aria-label="Back"
        />
        <IconButton
          icon="chevron-right"
          variant="ghost"
          class="h-6 w-6"
          disabled={!opened()}
          onClick={() => props.browser.go("forward")}
          aria-label="Forward"
        />
        <IconButton
          icon="arrow-undo-down"
          variant="ghost"
          class="h-6 w-6"
          disabled={!opened()}
          onClick={() => props.browser.go("reload")}
          aria-label="Reload"
        />
        <input
          ref={input}
          class="session-web__address"
          data-slot="web-address"
          value={address()}
          spellcheck={false}
          placeholder="Search or type an address"
          onInput={(e) => setAddress(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") go()
            if (e.key === "Escape") setAddress(page()?.url ?? "")
          }}
          onFocus={(e) => e.currentTarget.select()}
        />
        <IconButton
          icon="square-arrow-top-right"
          variant="ghost"
          class="h-6 w-6"
          disabled={!page()?.url || page()?.url === "about:blank"}
          onClick={() => {
            const u = page()?.url
            if (u) props.openExternal(u)
          }}
          aria-label="Open in browser"
          title="Open in your browser"
        />
      </div>
      {/* The agent strip (#193145 read, #193186 act): what IRIS may do here, what it is doing, and
          the person's controls. Most urgent state first (browser-grants stripState). */}
      <Show when={origin() && stripState()}>
        {(_) => {
          const o = () => origin()!
          const host = () => hostOf(o())
          const Btn = (p: { primary?: boolean; onClick: () => void; title?: string; children: any }) => (
            <button
              type="button"
              class="session-web__agent-btn"
              data-primary={p.primary ? "true" : undefined}
              onClick={p.onClick}
              title={p.title}
            >
              {p.children}
            </button>
          )
          const StopBtn = () => (
            <Btn onClick={() => revokeSite(o())} title="IRIS can't read or click on this site until you allow it again">
              Stop
            </Btn>
          )
          return (
            <div class="session-web__agent" data-slot="browser-agent-strip" data-state={stripState()}>
              <Switch>
                <Match when={stripState() === "confirm"}>
                  <span>
                    IRIS wants to click <b>"{confirmLabel()}"</b> on <b>{host()}</b>
                  </span>
                  <Btn primary onClick={() => answerConfirm(true)}>Allow once</Btn>
                  <Btn onClick={() => answerConfirm(false)}>Deny</Btn>
                </Match>
                <Match when={stripState() === "ask-read"}>
                  <span>
                    IRIS asked to read <b>{host()}</b>
                  </span>
                  <Btn primary onClick={() => grantSite(o())}>Allow</Btn>
                  <Btn onClick={dismissAsked}>Not now</Btn>
                </Match>
                <Match when={stripState() === "ask-act"}>
                  <span>
                    IRIS wants to click and type on <b>{host()}</b>
                  </span>
                  <Btn primary onClick={() => grantSite(o(), true)}>Allow clicking</Btn>
                  <Btn onClick={dismissAsked}>Not now</Btn>
                </Match>
                <Match when={stripState() === "taken"}>
                  <span class="session-web__agent-dot" data-paused="true" />
                  <span>
                    You have control of <b>{host()}</b>: IRIS won't click or type here
                  </span>
                  <Btn primary onClick={() => handBack(o())}>Hand back</Btn>
                  <StopBtn />
                </Match>
                <Match when={stripState() === "acting"}>
                  <span class="session-web__agent-dot" data-busy="true" />
                  <span>
                    <b>Agent is in control</b> · {activityHere()?.doing}…
                  </span>
                  <Btn primary onClick={() => takeOver(o())} title="IRIS stops clicking and typing here until you hand back">
                    Take over
                  </Btn>
                  <StopBtn />
                </Match>
                <Match when={stripState() === "reading"}>
                  <span class="session-web__agent-dot" data-busy="true" />
                  <span>
                    IRIS is reading <b>{host()}</b>…
                  </span>
                  <StopBtn />
                </Match>
                <Match when={stripState() === "can-act" || stripState() === "can-read"}>
                  <span class="session-web__agent-dot" />
                  <span>
                    IRIS can {stripState() === "can-act" ? "use" : "read"} <b>{host()}</b>
                  </span>
                  <Show when={stripState() === "can-read"}>
                    <button type="button" class="session-web__agent-link" onClick={() => grantSite(o(), true)}>
                      Allow clicking
                    </button>
                  </Show>
                  <StopBtn />
                </Match>
                <Match when={stripState() === "off"}>
                  <button type="button" class="session-web__agent-link" onClick={() => grantSite(o())}>
                    Let IRIS use this page
                  </button>
                </Match>
              </Switch>
            </div>
          )
        }}
      </Show>
      <div class="session-web__body" ref={body} data-slot="native-browser-body">
        <Show when={!opened()}>
          <div class="session-web__start">
            <div class="session-web__note-title">Browse beside the chat</div>
            <div class="session-web__start-grid">
              <For each={QUICK_SITES}>
                {(s) => (
                  <button type="button" class="session-web__tile" onClick={() => open(s.url)}>
                    {s.label}
                  </button>
                )}
              </For>
            </div>
            <div class="session-web__reason">Sign-ins here stay here: this browser has its own cookies, separate from IRIS.</div>
          </div>
        </Show>
        <Show when={error()}>
          {(e) => (
            <div class="session-web__note" data-slot="web-refused">
              <div class="session-web__reason">{e()}</div>
            </div>
          )}
        </Show>
      </div>
    </div>
  )
}
