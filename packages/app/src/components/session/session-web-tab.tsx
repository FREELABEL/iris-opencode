import { createEffect, createMemo, createSignal, Match, on, Show, Switch } from "solid-js"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { useServerSDK } from "@/context/server-sdk"
import { usePlatform } from "@/context/platform"
import { useSessionParams } from "@/context/session-pane"
import { needsSystemBrowser,
  addressToUrl,
  knownEmbeddable,
  navigateWeb,
  webBack,
  webCanBack,
  webCanForward,
  webForward,
  webReload,
  webReloadKey,
  webUrl,
} from "./web-nav"
import { GithubPrView } from "./github-pr-view"
import { NativeBrowserTabs } from "./native-browser-tabs"
import { nativeBrowserEnabled } from "./native-browser-model"
import { irisPageSlug, signedFrameUrl, type PageSignInAnswer } from "./iris-pinned-page-model"
import { isGithubPrUrl } from "./github-pr-model"
import "./session-web-tab.css"

/**
 * The side panel's Browser tab (#187864): a link from the chat, shown beside the chat.
 *
 * A frame cannot tell you it was refused — a blocked cross-origin frame fires `load` like one
 * that worked — so before showing a page that is not heyiris.io, the sidecar reads its framing
 * headers (/iris/frame-check). A refused page gets a message and "Open in browser", never a
 * white pane. When the check itself cannot answer (an older sidecar, no network) the page is
 * shown anyway: an unanswered check says nothing about the page.
 *
 * Not a createResource. A resource read inside the side panel suspends the panel's <Suspense>,
 * which is the bug that blanked every tab switch (bf98ec65c4). Plain signals cannot suspend.
 *
 * Known limit: links clicked INSIDE the framed page navigate the frame, and a cross-origin
 * frame's location is unreadable, so the address bar keeps the page you opened.
 */

/** The live sandbox, the same rule as Genesis › Artifacts' live frame (LIVE_SANDBOX): the page
 * gets its OWN origin, never the app's (linkAction never sends an app-origin URL here), and
 * top navigation is not granted, so a page cannot replace the app. */
const WEB_SANDBOX = "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"

type Check =
  | { state: "checking" }
  | { state: "embeddable" }
  | { state: "refused"; reason: string; opened?: boolean }
  | { state: "unknown" }
  | { state: "github-pr" }

export function SessionWebTab() {
  const platform = usePlatform()
  // Desktop: the native Browser (#193062). Decided once per mount, not reactively: switching
  // engines under a loaded page would drop it.
  const native = platform.nativeBrowser
  const params = useSessionParams()
  if (native && nativeBrowserEnabled(globalThis.localStorage, true)) {
    // Each chat its own tabs (2026-11-11: one page shared by every chat meant changing it in one
    // changed it in all; #193328: several pages per chat). Switching chats remounts on that chat's.
    return (
      <Show when={params.id ?? "new"} keyed>
        {(chat) => (
          <NativeBrowserTabs
            chat={chat}
            native={native}
            zoom={() => platform.webviewZoom?.() ?? 1}
            openExternal={(u) => platform.openExternal(u)}
            onNewTab={platform.onBrowserNewTab}
          />
        )}
      </Show>
    )
  }
  return <FramedWebTab />
}

/** The iframe Browser (#187864): the web build, and desktop with iris.browser.native=0. */
function FramedWebTab() {
  const serverSDK = useServerSDK()
  const platform = usePlatform()
  const base = createMemo(() => serverSDK().url.replace(/\/$/, ""))
  const [check, setCheck] = createSignal<Check>({ state: "checking" })
  const [address, setAddress] = createSignal("")

  createEffect(
    on([webUrl, webReloadKey], ([url]) => {
      setAddress(url ?? "")
      if (!url) return
      // github.com refuses every frame (X-Frame-Options: DENY). A PR is drawn from the GitHub API
      // instead of bouncing to the system browser (#192937).
      if (isGithubPrUrl(url)) return setCheck({ state: "github-pr" })
      if (knownEmbeddable(url)) return setCheck({ state: "embeddable" })
      // A sign-in page that reached the panel some other way (typed, pasted, opened by an agent)
      // goes to the browser too — it cannot complete in a frame (#188639).
      if (needsSystemBrowser(url)) {
        platform.openExternal(url)
        return setCheck({ state: "refused", reason: "sign-in pages open in your browser", opened: true })
      }
      setCheck({ state: "checking" })
      const q = `url=${encodeURIComponent(url)}&origin=${encodeURIComponent(location.origin)}`
      ;(platform.fetch ?? globalThis.fetch)(`${base()}/iris/frame-check?${q}`, {
        headers: { Accept: "application/json" },
      })
        .then((r) => (r.ok ? r.json() : undefined))
        .then((body: { state?: string; reason?: string } | undefined) => {
          if (webUrl() !== url) return // a later link won the race
          // A page that forbids framing is opened in the browser once, automatically: the only
          // thing the user could do from the refusal screen was click "Open in browser" (#188639).
          if (body?.state === "refused") {
            platform.openExternal(url)
            return setCheck({ state: "refused", reason: body.reason ?? "the site refuses", opened: true })
          }
          if (body?.state === "embeddable") return setCheck({ state: "embeddable" })
          setCheck({ state: "unknown" })
        })
        .catch(() => {
          if (webUrl() === url) setCheck({ state: "unknown" })
        })
    }),
  )

  const host = createMemo(() => {
    try {
      return new URL(webUrl() ?? "").host
    } catch {
      return ""
    }
  })
  // YOUR OWN IRIS PAGES OPEN SIGNED IN (#194350). A person's app opened here showed "Sign in to open
  // it": the frame is another origin, so the page's cookie cannot ride along. The pinned-page frame
  // already solves this with a one-time code (page-signin, #192482); the Browser tab now asks for
  // one too when the address is an IRIS page. No code (not a member, engine away) = the plain page,
  // exactly as before — a failed sign-in never blocks the page.
  const [signedSrc, setSignedSrc] = createSignal<{ for: string; url: string } | undefined>()
  // While a code is being minted the frame waits (≤ 4 s), so the page loads once, signed in, instead
  // of flashing its sign-in card and reloading.
  const [signing, setSigning] = createSignal<string | undefined>()
  createEffect(
    on(webUrl, (url) => {
      const slug = irisPageSlug(url)
      if (!url || !slug) {
        setSigning(undefined)
        return setSignedSrc(undefined)
      }
      setSigning(url)
      ;(platform.fetch ?? globalThis.fetch)(`${base()}/iris/page-signin`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ slug }),
        signal: AbortSignal.timeout(4000),
      })
        .then((r) => (r.ok ? (r.json() as Promise<PageSignInAnswer>) : undefined))
        .catch(() => undefined)
        .then((a) => {
          if (webUrl() !== url) return // a later address won the race
          const m = signedFrameUrl(slug, a)
          setSignedSrc(m.signed ? { for: url, url: m.url } : undefined)
          setSigning(undefined)
        })
    }),
  )
  const frameSrc = (url: string) => (signedSrc()?.for === url ? signedSrc()!.url : url)

  const openOutside = () => {
    const url = webUrl()
    if (url) platform.openExternal(url)
  }
  const go = () => {
    const url = addressToUrl(address())
    if (url) navigateWeb(url)
  }

  return (
    <div data-component="session-web-tab" class="session-web">
      <div class="session-web__bar">
        <IconButton
          icon="chevron-left"
          variant="ghost"
          class="h-6 w-6"
          disabled={!webCanBack()}
          onClick={webBack}
          aria-label="Back"
        />
        <IconButton
          icon="chevron-right"
          variant="ghost"
          class="h-6 w-6"
          disabled={!webCanForward()}
          onClick={webForward}
          aria-label="Forward"
        />
        <IconButton
          icon="arrow-undo-down"
          variant="ghost"
          class="h-6 w-6"
          disabled={!webUrl()}
          onClick={webReload}
          aria-label="Reload"
        />
        <input
          class="session-web__address"
          data-slot="web-address"
          value={address()}
          spellcheck={false}
          placeholder="Type an address, or click a link in the chat"
          onInput={(e) => setAddress(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") go()
            if (e.key === "Escape") setAddress(webUrl() ?? "")
          }}
          onFocus={(e) => e.currentTarget.select()}
        />
        <IconButton
          icon="square-arrow-top-right"
          variant="ghost"
          class="h-6 w-6"
          disabled={!webUrl()}
          onClick={openOutside}
          aria-label="Open in browser"
          title="Open in browser"
        />
      </div>
      <div class="session-web__body">
        <Switch>
          <Match when={!webUrl()}>
            <div class="session-web__note">
              Links you click in the chat open here. Cmd-click opens them in your browser.
            </div>
          </Match>
          <Match when={check().state === "github-pr" && webUrl()}>
            {(url) => <GithubPrView url={url()} base={base()} reloadKey={webReloadKey()} />}
          </Match>
          <Match when={check().state === "checking"}>
            <div class="session-web__note">Loading {host()}…</div>
          </Match>
          <Match when={check().state === "refused" && (check() as { reason: string })}>
            {(refused) => (
              <div class="session-web__note" data-slot="web-refused">
                <div class="session-web__note-title">
                  {(refused() as { opened?: boolean }).opened ? `Opened ${host()} in your browser` : `${host()} can't be shown inside IRIS`}
                </div>
                <div>The site doesn't allow other apps to show it{(refused() as { opened?: boolean }).opened ? ", so it opened there instead." : "."}</div>
                <div class="session-web__reason">{refused().reason}</div>
                <button type="button" class="session-web__open" onClick={openOutside}>
                  {(refused() as { opened?: boolean }).opened ? "Open it again" : "Open in browser"}
                </button>
              </div>
            )}
          </Match>
          <Match when={webUrl()}>
            {(url) => (
              <Show when={signing() !== url() && `${frameSrc(url())}#${webReloadKey()}`} keyed>
                <iframe
                  class="session-web__frame"
                  title={host()}
                  src={frameSrc(url())}
                  sandbox={WEB_SANDBOX}
                  referrerpolicy="strict-origin-when-cross-origin"
                  data-testid="web-frame"
                />
              </Show>
            )}
          </Match>
        </Switch>
      </div>
    </div>
  )
}
