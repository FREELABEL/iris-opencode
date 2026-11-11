import { createEffect, createSignal, For, Match, on, onCleanup, onMount, Show, Switch } from "solid-js"
import { IconButton } from "@opencode-ai/ui/icon-button"
import type { NativeBrowser, NativeBrowserBounds, NativeBrowserState } from "@/context/platform"
import { boundsOf, OVERLAY_SELECTOR, QUICK_SITES, sameBounds } from "./native-browser-model"
import {
  answerConfirm,
  askedSite,
  browserActivity,
  browserMode,
  setBrowserMode,
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
import { loadSignedIn, shouldRedo, signInWithChrome, type SignedIn } from "./browser-import"

/** The last chat link opened, across remounts (one native view, one link history). */
let lastLink: string | undefined
/** Where the Browser forgets on quit (macOS 13), the Chrome sign-ins come back once per launch. */
let redone = false
/** Whether this computer has Chrome sign-ins to bring in: asked once per launch (cheap, no prompt). */
let chromeFound: Promise<boolean> | undefined

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
  // Sign in with Chrome (S3b): one button, then the Mac's own prompt, then done.
  const [hasChrome, setHasChrome] = createSignal(false)
  const [signedIn, setSignedIn] = createSignal<SignedIn | undefined>(loadSignedIn())
  const [chrome, setChrome] = createSignal<"idle" | "working" | "denied" | "error">("idle")
  const [notice, setNotice] = createSignal<string>()
  const signIn = async (quiet = false) => {
    if (chrome() === "working") return
    if (!quiet) setChrome("working")
    const r = await signInWithChrome(props.browser)
    if (r.ok) {
      setSignedIn(loadSignedIn())
      setChrome("idle")
      setNotice(`Signed in to ${r.sites} site${r.sites === 1 ? "" : "s"} from Chrome`)
      setTimeout(() => setNotice(undefined), 4000)
      if (opened()) void props.browser.go("reload")
      return
    }
    setChrome(quiet ? "idle" : r.reason === "denied" ? "denied" : r.reason === "none" ? "idle" : "error")
  }
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
      always: browserMode() === "always",
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
    if (props.browser.importSources) {
      chromeFound ??= props.browser
        .importSources()
        .then((l) => l.length > 0)
        .catch(() => false)
      void chromeFound.then(setHasChrome)
    }
    if (!redone && shouldRedo(signedIn())) {
      redone = true
      void signIn(true)
    }
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
        <Show when={opened() && hasChrome() && !signedIn()}>
          <button type="button" class="session-web__bar-chrome" data-slot="browser-signins" onClick={() => signIn()}>
            Sign in with Chrome
          </button>
        </Show>
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
          // The "IRIS is asking you" mark: gold, the app's attention colour (same tokens as the question dock).
          const Ask = () => (
            <svg class="session-web__agent-ask" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <path d="M8 1.6 14.6 13.4H1.4z" fill="currentColor" fill-opacity=".18" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" />
              <path d="M8 6v3.4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
              <circle cx="8" cy="11.4" r=".9" fill="currentColor" />
            </svg>
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
                  <Ask />
                  <span>
                    Let IRIS click <b>"{confirmLabel()}"</b>?
                  </span>
                  <Btn primary onClick={() => answerConfirm(true)}>Allow once</Btn>
                  <Btn onClick={() => answerConfirm(false)}>Deny</Btn>
                </Match>
                <Match when={stripState() === "ask-read"}>
                  <Ask />
                  <span>
                    Let IRIS use <b>{host()}</b>?
                  </span>
                  <Btn primary onClick={() => grantSite(o(), true)}>Allow</Btn>
                  <Btn onClick={dismissAsked}>Not now</Btn>
                  <Btn onClick={() => setBrowserMode("always")} title="IRIS won't ask on any site again. It still asks before paying, ordering, sending or deleting">
                    Always allow
                  </Btn>
                </Match>
                <Match when={stripState() === "ask-act"}>
                  <Ask />
                  <span>
                    Let IRIS use <b>{host()}</b>?
                  </span>
                  <Btn primary onClick={() => grantSite(o(), true)}>Allow</Btn>
                  <Btn onClick={dismissAsked}>Not now</Btn>
                  <Btn onClick={() => setBrowserMode("always")} title="IRIS won't ask on any site again. It still asks before paying, ordering, sending or deleting">
                    Always allow
                  </Btn>
                </Match>
                <Match when={stripState() === "taken"}>
                  <span class="session-web__agent-dot" data-paused="true" />
                  <span>
                    You're in control. IRIS is paused
                  </span>
                  <Btn primary onClick={() => handBack(o())}>Hand back</Btn>
                  <StopBtn />
                </Match>
                <Match when={stripState() === "acting"}>
                  <span class="session-web__agent-dot" data-busy="true" />
                  <span>
                    <b>IRIS is working</b> · {activityHere()?.doing}…
                  </span>
                  <Btn primary onClick={() => takeOver(o())} title="IRIS stops clicking and typing here until you hand back">
                    Take over
                  </Btn>
                  <StopBtn />
                </Match>
                <Match when={stripState() === "reading"}>
                  <span class="session-web__agent-dot" data-busy="true" />
                  <span>
                    IRIS is reading…
                  </span>
                  <StopBtn />
                </Match>
                <Match when={stripState() === "can-act" || stripState() === "can-read"}>
                  <span class="session-web__agent-dot" />
                  <span>
                    <Show when={browserMode() === "always"} fallback={<>IRIS can {stripState() === "can-act" ? "use" : "read"} <b>{host()}</b></>}>
                      IRIS can use any site
                    </Show>
                  </span>
                  <Show when={browserMode() === "always"}>
                    <button type="button" class="session-web__agent-link" onClick={() => setBrowserMode("ask")} title="Go back to asking once per site">
                      Ask first
                    </button>
                  </Show>
                  <Show when={stripState() === "can-read"}>
                    <button type="button" class="session-web__agent-link" onClick={() => grantSite(o(), true)}>
                      Let it click
                    </button>
                  </Show>
                  <StopBtn />
                </Match>
                <Match when={stripState() === "off"}>
                  <button type="button" class="session-web__agent-link" onClick={() => grantSite(o(), true)}>
                    Let IRIS use this page
                  </button>
                </Match>
              </Switch>
            </div>
          )
        }}
      </Show>
      <Show when={notice()}>
        {(n) => (
          <div class="session-web__import-notice" data-slot="browser-import-notice">
            {n()}
          </div>
        )}
      </Show>
      <div class="session-web__body" ref={body} data-slot="native-browser-body">
        <Show when={!opened()}>
          <div class="session-web__start">
            <div class="session-web__hero">Browse beside the chat</div>
            <Show when={hasChrome()}>
              <Show
                when={signedIn()}
                fallback={
                  <>
                    <button type="button" class="session-web__chrome" data-slot="chrome-sign-in" onClick={() => signIn()}>
                      <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
                        <circle cx="10" cy="10" r="8.25" fill="none" stroke="currentColor" stroke-width="1.5" />
                        <circle cx="10" cy="8" r="2.75" fill="none" stroke="currentColor" stroke-width="1.5" />
                        <path d="M4.9 15.6c1.1-2 2.9-3.1 5.1-3.1s4 1.1 5.1 3.1" fill="none" stroke="currentColor" stroke-width="1.5" />
                      </svg>
                      Sign in with Chrome
                    </button>
                    <div class="session-web__chrome-hint">
                      <Switch fallback="Your sites open already signed in.">
                        <Match when={chrome() === "denied"}>No problem, nothing was copied. Try again any time.</Match>
                        <Match when={chrome() === "error"}>That didn't work. Try again in a moment.</Match>
                      </Switch>
                    </div>
                  </>
                }
              >
                {(v) => (
                  <div class="session-web__chrome-done" data-slot="chrome-signed-in">
                    <span class="session-web__chrome-check" aria-hidden="true">✓</span>
                    Signed in from {v().from}
                    <button type="button" class="session-web__agent-link" onClick={() => signIn()}>
                      Refresh
                    </button>
                  </div>
                )}
              </Show>
            </Show>
            <div class="session-web__start-grid">
              <For each={QUICK_SITES}>
                {(s) => (
                  <button type="button" class="session-web__tile" onClick={() => open(s.url)}>
                    {s.label}
                  </button>
                )}
              </For>
            </div>
          </div>
        </Show>
        {/* While the Mac asks: a role="dialog", so an open page steps aside and this is what shows. */}
        <Show when={chrome() === "working"}>
          <div class="session-web__wait" role="dialog" aria-label="Signing in with Chrome" aria-live="polite">
            <div class="session-web__spinner" aria-hidden="true" />
            <div class="session-web__hero">Look for the Mac prompt</div>
            <div class="session-web__chrome-hint">
              Click <b>Always Allow</b>. Your Mac is asking to share your Chrome sign-ins with IRIS.
            </div>
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
